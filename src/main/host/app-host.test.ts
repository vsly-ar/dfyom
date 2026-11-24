// The app host: project lifecycle commands, unsaved changes, recovery, sessions, library follow on Apply.
// Spec: docs/architecture/llm-api.md#app-scope-and-project-scope, #sessions-and-sources
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { flat6 } from '../../core/plan/plan.fixture'
import { libraryInput } from '../../core/library/library.fixture'
import { testStock } from '../../core/design/design.fixture'
import type { Source } from '../../core/commands/context'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { ENCLOSURE_STL, ENCLOSURE_TRIANGLES } from '../../core/design/stl.testing'
import { isIncompatibleProject } from '../../core/project/layout'
import { readArchive, writeArchive } from '../persistence/archive'
import { testFs } from '../persistence/fs.testing'
import { nodeFiles } from '../workers/files'
import { buildSmallPlan, tempDir, testHost } from './host.fixture'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup(dir?: string) {
  const t = tempDir()
  cleanups.push(t.cleanup)
  const host = await testHost(dir ?? t.dir, { files: nodeFiles })
  cleanups.push(() => host.shutdown())
  const session = host.openSession({ kind: 'agent', id: 'stdio-1' })
  const call = async (name: string, args: object = {}) =>
    expectOk((await session.call(name, args)).result).value
  return { host, session, call, dir: dir ?? t.dir }
}

describe('app host', () => {
  it('project.create opens and binds, reports the opener; project.list; save makes it clean', async () => {
    const { host, session, call, dir } = await setup()
    const opened: [string, Source][] = []
    host.onProjectOpened((key, source) => opened.push([key, source]))
    const { key } = (await call('project.create', { name: 'P', unitSystem: 'mm' })) as {
      key: string
    }
    expect(opened).toEqual([[key, { kind: 'agent', id: 'stdio-1' }]])
    expect(session.boundKey).toBe(key)
    expect(host.list()).toEqual([
      {
        key,
        projectId: expect.any(String),
        name: 'P',
        dirty: false,
        file: null,
        revision: 0,
        sources: [{ source: 'agent:stdio-1' }],
      },
    ])
    expect((await call('project.list')) as unknown).toEqual({ projects: host.list() })
    const file = join(dir, 'p.dfyom')
    await call('project.save', { target: file })
    expect(host.list()[0]).toMatchObject({ dirty: false, file: expect.stringMatching(/p\.dfyom$/) })
    expectErrCode((await session.call('project.close', { key: 'nope' })).result, 'input.malformed')
  })

  it('closing a dirty project, recovery and persist.recovery on open', async () => {
    const { host, session, call, dir } = await setup()
    const ids = await buildSmallPlan(call)
    const file = join(dir, 'small.dfyom')
    await call('project.save', { target: file })
    expect(host.list()[0]?.dirty).toBe(false)
    await call('design.facing.add', { partId: ids.partId, depth: '1' })
    expect(host.list()[0]?.dirty).toBe(true)
    const refused = expectErrCode(
      (await session.call('project.close', { key: ids.key })).result,
      'input.malformed',
    )
    expect(refused.issues[0]?.rule).toBe('unsavedChanges')
    await call('project.close', { key: ids.key, confirm: true })
    expect(session.boundKey).toBeUndefined()
    expect(host.list()).toEqual([])
    const reopen = expectErrCode(
      (await session.call('project.open', { file })).result,
      'persist.recovery',
    )
    expect(reopen.frames[0]?.data).toMatchObject({ key: ids.key })
    const recoverable = (await call('project.recovery.list')) as { projects: { key: string }[] }
    expect(recoverable.projects.map((p) => p.key)).toEqual([ids.key])
    const restored = (await call('project.recovery.resolve', {
      key: ids.key,
      action: 'restore',
    })) as { key: string }
    expect(restored.key).toBe(ids.key)
    expect(session.boundKey).toBe(ids.key)
    expect(host.list()[0]?.dirty).toBe(true)
  })

  it('draft plans follow library changes on Apply: pending in the project, applied by an agent write', async () => {
    const { host, session, call } = await setup()
    const ids = await buildSmallPlan(call)
    const d = host.project(ids.key).unwrap()
    const tool = async () =>
      ((await call('library.tool.list')) as { items: { id: string; revision: number }[] }).items[0]!
    // a window's library edit: pending in the project, nothing dispatched
    const ui = { kind: 'ui' as const, id: 'w' }
    const first = await tool()
    expectOk(
      await host.app.dispatch(
        'library.tool.update',
        {
          id: first.id,
          revision: first.revision,
          values: { ...libraryInput(flat6()), overallLength: '70' },
        },
        ui,
      ),
    )
    expect(d.applyState.pending()).toEqual([
      expect.objectContaining({ kind: 'library', libraryItemId: first.id }),
    ])
    // an agent's library write auto-applies its bound project: the draft follows in the Apply
    const second = await tool()
    const r = expectOk(
      (
        await session.call('library.tool.update', {
          id: second.id,
          revision: second.revision,
          values: { ...libraryInput(flat6()), overallLength: '72' },
        })
      ).result,
    ) as { applied?: { plans: unknown[] } }
    expect(r.applied?.plans).toEqual([{ planId: ids.planId, status: 'followed' }])
    expect(d.applyState.pending()).toEqual([])
    expect(d.history.undoable.at(-1)).toMatchObject({ command: 'project.apply' })
    expect(d.log.since(0, { names: ['plan.libraryItem.update'] })).toEqual([])
  })

  it('X2 F6: library tools that arrive re-choose generalized tools on open and in a library write', async () => {
    const { host, session, call, dir } = await setup()
    const stock = ((await call('library.stock.add', { values: testStock() })) as { id: string }).id
    const created = (await call('project.create', { name: 'F6', unitSystem: 'mm' })) as {
      key: string
    }
    const { partId } = (await call('design.part.add', {
      name: 'F6',
      stockLibraryItemId: stock,
    })) as { partId: string }
    const pocket = { kind: 'rectangle', center: ['50', '30'], length: '40', width: '25' }
    await call('design.pocket.add', { partId, shape: pocket, depth: '3' })
    await call('design.pocket.add', {
      partId,
      shape: { ...pocket, center: ['20', '20'], length: '10', width: '10' },
      depth: '2',
    })
    const file = join(dir, 'f6.dfyom')
    await call('project.save', { target: file })
    await call('project.close', { key: created.key })
    // a window adds a fitting tool while the project is closed
    const ui = { kind: 'ui' as const, id: 'w' }
    expectOk(await host.app.dispatch('library.tool.add', { values: libraryInput(flat6()) }, ui))
    const opened = expectOk((await session.call('project.open', { file })).result) as {
      value: { key: string }
      revision: number
      applied?: { toolChanges: { operationId: string; reason: string }[] }
    }
    expect(opened.applied?.toolChanges).toEqual([
      expect.objectContaining({ operationId: 'pocket1', reason: 'libraryFits' }),
      expect.objectContaining({ operationId: 'pocket2', reason: 'libraryFits' }),
    ])
    const d = host.project(opened.value.key).unwrap()
    expect(d.revision).toBe(opened.revision)
    expect(d.applyState.pending()).toEqual([])
    // saved again: the next open has nothing to re-choose and applies nothing
    await call('project.save', {})
    await call('project.close', { key: opened.value.key })
    const again = expectOk((await session.call('project.open', { file })).result) as {
      value: { key: string }
      applied?: unknown
    }
    expect(again.applied).toBeUndefined()
    // a corner the 6 mm tool does not fit gets a generalized 4 mm; the agent adds a 4 mm tool
    await call('design.pocket.update', {
      partId,
      operationId: 'pocket2',
      shape: { ...pocket, center: ['20', '20'], length: '10', width: '10', cornerRadius: '2' },
    })
    const tool2 = () =>
      host.project(again.value.key).unwrap().doc.parts[partId]!.operations[1]!.tool
    expect(tool2()).toMatchObject({ kind: 'generalized' })
    const added = expectOk(
      (
        await session.call('library.tool.add', {
          values: { ...libraryInput(flat6()), name: 'Flat 4', diameter: '4' },
        })
      ).result,
    ) as { applied?: { toolChanges: { operationId: string; reason: string }[] } }
    expect(added.applied?.toolChanges).toEqual([
      expect.objectContaining({ operationId: 'pocket2', reason: 'libraryFits' }),
    ])
    expect(tool2()).toMatchObject({ kind: 'specific' })
  })

  it('shutdown closes every project and leaves unsaved changes recoverable', async () => {
    const { host, call, dir } = await setup()
    await call('project.create', { name: 'A', unitSystem: 'mm' })
    await buildSmallPlan(call)
    expect(host.list()).toHaveLength(2)
    const unsaved = await host.shutdown()
    expect(unsaved.map((p) => p.name)).toEqual(['Small'])
    expect(host.list()).toEqual([])
    const again = await testHost(dir)
    cleanups.push(() => again.shutdown())
    const r = expectOk(await again.listRecovery())
    expect(r).toHaveLength(1) // the unchanged untitled project was removed, the edited one kept
  })

  it('an edit queued while project.close runs cannot bypass the unsaved-changes confirmation', async () => {
    const { host, call, dir } = await setup()
    const ids = await buildSmallPlan(call)
    await call('project.save', { target: join(dir, 'race.dfyom') })
    const d = host.project(ids.key).unwrap()
    const ui = { kind: 'ui' as const, id: 'w' }
    const closing = host.app.dispatch('project.close', { key: ids.key }, ui)
    const edit = d.dispatch('design.part.update', { partId: ids.partId, name: 'Racy' }, ui)
    const [closed, edited] = await Promise.all([closing, edit])
    expectOk(edited)
    expect(expectErrCode(closed, 'input.malformed').issues[0]?.rule).toBe('unsavedChanges')
    // the refused close resumed the project; a confirmed close works
    expectOk(await d.dispatch('design.part.update', { partId: ids.partId, name: 'After' }, ui))
    expectOk(await host.app.dispatch('project.close', { key: ids.key, confirm: true }, ui))
    expect(host.list()).toEqual([])
  })

  it('reports runtime changes (windows re-follow their project)', async () => {
    const { host, call } = await setup()
    let changes = 0
    host.onProjectsChanged(() => changes++)
    const { key } = (await call('project.create', { name: 'C', unitSystem: 'mm' })) as {
      key: string
    }
    await call('project.close', { key })
    expect(changes).toBe(2)
  })

  it('openKey finds a file open in this instance; reopening it reports no second opener', async () => {
    const { host, call, dir } = await setup()
    const { key } = (await call('project.create', { name: 'K', unitSystem: 'mm' })) as {
      key: string
    }
    const file = join(dir, 'k.dfyom')
    expect(await host.openKey(file)).toBeUndefined() // not saved there yet
    await call('project.save', { target: file })
    expect(await host.openKey(file)).toBe(key)
    expect(await host.openKey(join(dir, '.', 'k.dfyom'))).toBe(key)
    expect(await host.openKey(join(dir, 'missing.dfyom'))).toBeUndefined()
    const opened: string[] = []
    host.onProjectOpened((k) => opened.push(k))
    const other = host.openSession({ kind: 'ui', id: 'win-2' })
    const again = expectOk((await other.call('project.open', { file })).result).value
    expect(again).toMatchObject({ key, alreadyOpen: true })
    expect(opened).toEqual([]) // no second window for an agent's or window's reopen
    other.end()
  })

  it('a project saved before D45 asks for a reset; project.open { reset } replaces it (B6)', async () => {
    const { host, session, call, dir } = await setup()
    const ids = await buildSmallPlan(call)
    await call('design.drilling.add', { partId: ids.partId, center: ['20', '20'], diameter: '6' })
    await call('design.chamfer.add', { partId: ids.partId, edgeOf: 'drill1' })
    const file = join(dir, 'old.dfyom')
    await call('project.save', { target: file })
    await call('project.close', { key: ids.key })
    // Fixture: the same file as a pre-D45 build wrote it (chamfer `diameter`, no `width`).
    const a = expectOk(await readArchive(testFs, file))
    const files = new Map(a.files)
    const partPath = [...files.keys()].find((p) => p.startsWith('parts/'))!
    const part = JSON.parse(files.get(partPath)!) as { operations: Record<string, unknown>[] }
    const c = part.operations.find((o) => o['kind'] === 'chamfer')!
    c['diameter'] = c['width']
    delete c['width']
    files.set(partPath, JSON.stringify(part))
    const { projectId, appVersion, savedAt, revision } = a.manifest
    expectOk(
      await writeArchive(testFs, file, files, [], { projectId, appVersion, savedAt, revision }),
    )

    const refused = expectErrCode(
      (await session.call('project.open', { file })).result,
      'input.malformed',
    )
    expect(isIncompatibleProject(refused)).toBe(true)
    expect(refused.frames.find((f) => f.where === 'project.incompatible')?.data).toEqual({
      name: 'Small',
      unitSystem: 'mm',
    })
    expect(host.list()).toEqual([])

    const reset = (await call('project.open', { file, reset: true })) as { key: string }
    expect(reset).toMatchObject({ alreadyOpen: false })
    expect(session.boundKey).toBe(reset.key)
    expect(host.list()[0]).toMatchObject({
      name: 'Small',
      dirty: false,
      file: expect.stringMatching(/old\.dfyom$/),
    })
    expect(((await call('design.part.list')) as { parts: unknown[] }).parts).toEqual([])
    // the file now holds the empty project: it opens without reset
    await call('project.close', { key: reset.key })
    const again = (await call('project.open', { file })) as { key: string }
    expect(again.key).toBe(reset.key)
  })

  it('reset does nothing to a file that loads; other open errors are never reset (B6)', async () => {
    const { host, session, call, dir } = await setup()
    const ids = await buildSmallPlan(call)
    const file = join(dir, 'good.dfyom')
    await call('project.save', { target: file })
    await call('project.close', { key: ids.key })
    await call('project.open', { file, reset: true })
    expect(host.list()).toHaveLength(1)
    expect(((await call('design.part.list')) as { parts: unknown[] }).parts).toHaveLength(1)
    const missing = expectErrCode(
      (await session.call('project.open', { file: join(dir, 'none.dfyom'), reset: true })).result,
      'persist.io',
    )
    expect(isIncompatibleProject(missing)).toBe(false)
  })

  it("reads a reference's triangles for the window ghost (task R3)", async () => {
    const { host, session, call } = await setup()
    const { key, partId } = await buildSmallPlan(call)
    const { referenceId } = (await call('design.reference.import', {
      partId,
      path: fileURLToPath(ENCLOSURE_STL),
    })) as { referenceId: string }
    const mesh = expectOk(await host.referenceMesh(key, referenceId))
    expect(mesh.positions).toBeInstanceOf(Float32Array)
    expect(mesh.positions.length).toBe(ENCLOSURE_TRIANGLES * 9)
    const unknown = expectErrCode(await host.referenceMesh(key, 'nope'), 'input.malformed')
    expect(unknown.issues[0]?.rule).toBe('unknownReference')
    expectErrCode(await host.referenceMesh('no-project', referenceId), 'input.malformed')
    expect(session.boundKey).toBe(key)
  })
})
