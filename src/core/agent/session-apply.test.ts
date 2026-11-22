// Agents, MCP and CLI under Apply (task P1): auto-apply per call, `apply: false` batching,
// windows never auto-apply, undo of the Apply entry, `applied` in tool results, the reserved key.
// Spec: docs/architecture/apply.md#agents-mcp-and-cli
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { None, Ok, Some } from '../../shared/result'
import type { ApplyOutcome } from '../commands/apply'
import type { Source } from '../commands/context'
import type { ApplyHook } from '../commands/define'
import { createDispatcher, type CommandOutcome } from '../commands/dispatcher'
import { inProcessWorkers } from '../commands/jobs'
import {
  createAppScopeRegistry,
  createProjectRegistry,
  createRegistry,
  PROJECT_COMMANDS,
  PROJECT_QUERIES,
} from '../commands/registry'
import { agentSource, fakeClock, fakeIds, uiSource } from '../commands/testing'
import { testStock } from '../design/design.fixture'
import { Library } from '../library/library'
import { createMemoryLibraryStorage } from '../library/memory-storage'
import { newProjectDoc } from '../project/document'
import { toToolResult } from './results'
import { AgentSession, type SessionHost } from './session'
import { APPLY_KEY, buildAgentTools } from './tools'
import { SESSION_TOOLS } from './session'

const rect = {
  kind: 'rectangle',
  center: ['50', '30'],
  length: '40',
  width: '25',
  cornerRadius: '3',
}

/** Renames the project on every Apply (derived document work that no pending key tracks). */
function countingHook(): ApplyHook {
  let runs = 0
  return {
    name: 'test.count',
    apply(draft) {
      draft.name = `applied #${++runs}`
      return Ok(undefined)
    },
  }
}

async function setup() {
  const library = expectOk(await Library.open(createMemoryLibraryStorage()))
  const services = { workers: inProcessWorkers, library }
  const project = createDispatcher({
    registry: expectOk(
      createRegistry({
        commands: PROJECT_COMMANDS,
        queries: PROJECT_QUERIES,
        applyHooks: [countingHook()],
      }),
    ),
    doc: newProjectDoc({ name: 'Bracket', unitSystem: 'mm' }),
    ids: fakeIds(),
    clock: fakeClock(),
    services,
  })
  const appRegistry = expectOk(createAppScopeRegistry())
  const app = createDispatcher({
    registry: appRegistry,
    doc: newProjectDoc({ name: '', unitSystem: 'mm' }),
    services,
  })
  const host: SessionHost = {
    app,
    registries: { app: appRegistry, project: expectOk(createProjectRegistry()) },
    project: (key) => (key === 'p1' ? Some(project) : None),
    sessionChanged: () => {},
  }
  const session = (source: Source) => {
    const s = new AgentSession(host, { source })
    expectOk(s.bind('p1'))
    return s
  }
  const ui = session(uiSource('win-1'))
  const call = async (s: AgentSession, name: string, args: object) =>
    expectOk((await s.call(name, args)).result)
  // the window builds the part and applies it
  const stock = (await call(ui, 'library.stock.add', { values: testStock() })).value as {
    id: string
  }
  const { partId } = (
    await call(ui, 'design.part.add', { name: 'Bracket', stockLibraryItemId: stock.id })
  ).value as { partId: string }
  await call(ui, 'design.pocket.add', { partId, shape: rect, depth: '5' })
  await call(ui, 'project.apply', {})
  const pendingCount = () =>
    (
      expectOk(project.query('project.pending.get', {}, uiSource('win-1'))).value as {
        count: number
      }
    ).count
  const depth = (v: string, extra: object = {}) => ({
    partId,
    operationId: 'pocket1',
    depth: v,
    ...extra,
  })
  return { project, session, ui, call, pendingCount, depth, partId }
}

describe('auto-apply per call', () => {
  it('an agent edit is applied in the same turn and the result has applied', async () => {
    const t = await setup()
    const a = t.session(agentSource('mcp-1'))
    await t.call(a, 'design.part.get', { partId: t.partId })
    const out = (await t.call(a, 'design.pocket.update', t.depth('8'))) as CommandOutcome
    expect(out.applied).toMatchObject({ changes: 1, toolChanges: [], plans: [], jobIds: [] })
    expect(out.revision).toBe(t.project.revision)
    expect(t.pendingCount()).toBe(0)
    expect(t.project.doc.name).toBe('applied #2')
    // undo once reverts the automation and leaves the edit pending; twice reverts the edit
    await t.call(a, 'history.undo', {})
    expect(t.project.doc.name).toBe('applied #1')
    expect(t.pendingCount()).toBe(1)
    await t.call(a, 'history.undo', {})
    expect(t.pendingCount()).toBe(0)
  })

  it('apply: false batches edits for one project.apply', async () => {
    const t = await setup()
    const cli = t.session({ kind: 'cli', id: 'run-1' })
    await t.call(cli, 'design.part.get', { partId: t.partId })
    const first = (await t.call(
      cli,
      'design.pocket.update',
      t.depth('8', { apply: false }),
    )) as CommandOutcome
    expect(first.applied).toBeUndefined()
    await t.call(cli, 'design.pocket.update', t.depth('8', { apply: false, floorRadius: '1' }))
    expect(t.pendingCount()).toBe(2)
    const applied = (await t.call(cli, 'project.apply', {})).value as ApplyOutcome
    expect(applied.changes).toBe(2)
    expect(t.project.history.undoable.at(-1)).toMatchObject({
      title: 'Apply 2 changes',
      source: cli.source,
    })
  })

  it('a window never auto-applies; an agent’s auto-apply applies the user’s pending edits too', async () => {
    const t = await setup()
    const out = (await t.call(t.ui, 'design.pocket.update', t.depth('8'))) as CommandOutcome
    expect(out.applied).toBeUndefined()
    expect(t.pendingCount()).toBe(1)
    const a = t.session(agentSource('mcp-1'))
    const applied = (await t.call(a, 'library.stock.add', {
      values: { ...testStock(), name: 'Other' },
    })) as CommandOutcome
    expect(applied.applied).toMatchObject({ changes: 1 })
    expect(t.pendingCount()).toBe(0)
  })

  it('rejects a non-boolean apply and puts applied into the tool result', async () => {
    const t = await setup()
    const a = t.session(agentSource('mcp-1'))
    await t.call(a, 'design.part.get', { partId: t.partId })
    const bad = await a.call('design.pocket.update', t.depth('8', { apply: 'yes' }))
    expect(bad.result.isErr() && bad.result.unwrapErr().code).toBe('input.malformed')
    const ok = await a.call('design.pocket.update', t.depth('8'))
    expect(toToolResult(ok).structuredContent).toMatchObject({ applied: { changes: 1 } })
  })
})

describe('the reserved apply key', () => {
  it('is on every project-scope document tool and no command has an arg of that name', () => {
    const tools = expectOk(
      buildAgentTools(
        { app: expectOk(createAppScopeRegistry()), project: expectOk(createProjectRegistry()) },
        SESSION_TOOLS,
      ),
    )
    for (const t of tools) {
      const props = (t.inputSchema['properties'] ?? {}) as Record<string, unknown>
      expect(APPLY_KEY in props, t.name).toBe(t.scope === 'project' && t.kind === 'document')
    }
    for (const reg of [createAppScopeRegistry(), createProjectRegistry()])
      for (const c of expectOk(reg).commands) {
        const shape = (c.args as { shape?: Record<string, unknown> }).shape ?? {}
        expect(APPLY_KEY in shape, c.name).toBe(false)
      }
  })
})
