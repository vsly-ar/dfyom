// The app host: project lifecycle commands, unsaved changes, recovery, sessions, library follow.
// Spec: docs/architecture/llm-api.md#app-scope-and-project-scope, #sessions-and-sources
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { flat6 } from '../../core/plan/plan.fixture'
import { len } from '../../core/library/library.fixture'
import type { Source } from '../../core/commands/context'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { buildSmallPlan, tempDir, testHost } from './host.fixture'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup(dir?: string) {
  const t = tempDir()
  cleanups.push(t.cleanup)
  const host = await testHost(dir ?? t.dir)
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

  it('draft plans follow library changes (system source)', async () => {
    const { host, call } = await setup()
    const ids = await buildSmallPlan(call)
    const tools = (await call('library.tool.list')) as { items: { id: string; revision: number }[] }
    const tool = tools.items[0]!
    await call('library.tool.update', {
      id: tool.id,
      revision: tool.revision,
      values: { ...flat6(), overallLength: len('70') },
    })
    const d = host.project(ids.key).unwrap()
    await expect
      .poll(() => d.log.since(0, { names: ['plan.libraryItem.update'] }).map((e) => e.source.kind))
      .toEqual(['system'])
  })

  it('shutdown closes every project and leaves unsaved changes recoverable', async () => {
    const { host, call, dir } = await setup()
    await call('project.create', { name: 'A', unitSystem: 'mm' })
    await buildSmallPlan(call)
    expect(host.list()).toHaveLength(2)
    await host.shutdown()
    expect(host.list()).toEqual([])
    const again = await testHost(dir)
    cleanups.push(() => again.shutdown())
    const r = expectOk(await again.listRecovery())
    expect(r).toHaveLength(1) // the unchanged untitled project was removed, the edited one kept
  })
})
