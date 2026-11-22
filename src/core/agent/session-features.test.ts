// The feature model (v0.4 F1) headless through an agent session, the layer MCP `tools/call` and
// `dfyom batch` lines share: a test-only `probe` feature (two owned operations) added, refused
// edits of an owned operation (`design.featureOwned`, CLI exit 6), move, undo, remove, list.
// Spec: docs/modes/design-v0.4.md#implementation-f1, docs/architecture/llm-api.md#testing
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { None, Some } from '../../shared/result'
import { createDispatcher } from '../commands/dispatcher'
import { inProcessWorkers } from '../commands/jobs'
import {
  createAppScopeRegistry,
  createRegistry,
  PROJECT_COMMANDS,
  PROJECT_QUERIES,
} from '../commands/registry'
import { agentSource, fakeClock, fakeIds } from '../commands/testing'
import { testStock } from '../design/design.fixture'
import { PROBE_COMMANDS } from '../design/feature.fixture'
import { Library } from '../library/library'
import { createMemoryLibraryStorage } from '../library/memory-storage'
import { newProjectDoc } from '../project/document'
import { EXIT, exitCodeOf } from './exit-codes'
import { toToolResult } from './results'
import { AgentSession, SESSION_TOOLS, type SessionHost } from './session'
import { buildAgentTools, fromMcpName, toMcpName } from './tools'

async function setup() {
  const library = expectOk(await Library.open(createMemoryLibraryStorage()))
  const services = { workers: inProcessWorkers, library }
  const projectRegistry = expectOk(
    createRegistry({
      commands: [...PROJECT_COMMANDS, ...PROBE_COMMANDS],
      queries: PROJECT_QUERIES,
    }),
  )
  const project = createDispatcher({
    registry: projectRegistry,
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
  const registries = { app: appRegistry, project: projectRegistry }
  const host: SessionHost = {
    app,
    registries,
    project: (key) => (key === 'p1' ? Some(project) : None),
    sessionChanged: () => {},
  }
  const session = new AgentSession(host, { source: agentSource('mcp-1') })
  expectOk(session.bind('p1'))
  /** A `tools/call` by MCP name, as the MCP adapter and a batch line make it. */
  const call = (mcpName: string, args: object) => session.call(fromMcpName(mcpName), args)
  const ok = async (mcpName: string, args: object) => expectOk((await call(mcpName, args)).result)
  return { project, registries, call, ok }
}

describe('features through an agent session (MCP and batch)', () => {
  it('lists the shared feature tools', async () => {
    const t = await setup()
    const tools = expectOk(buildAgentTools(t.registries, SESSION_TOOLS)).map((x) => x.mcpName)
    for (const name of ['design.feature.remove', 'design.feature.move', 'design.feature.list'])
      expect(tools).toContain(toMcpName(name))
    expect(tools).not.toContain('design_feature_get')
  })

  it('add, refuse, move, undo, remove', async () => {
    const t = await setup()
    const stock = (await t.ok('library_stock_add', { values: testStock() })).value as { id: string }
    await t.ok('design_part_list', {}) // the agent's baseline revision
    const { partId } = (
      await t.ok('design_part_add', { name: 'Bracket', stockLibraryItemId: stock.id })
    ).value as { partId: string }
    await t.ok('design_pocket_add', {
      partId,
      shape: { kind: 'circle', center: ['80', '30'], diameter: '6' },
      depth: '1',
    })
    const added = await t.ok('design_probe_add', {
      partId,
      center: ['30', '30'],
      diameter: '10',
      depth: '3',
      drillDiameter: '5',
    })
    expect(added.value).toMatchObject({
      featureId: 'probe1',
      operationIds: ['probe1_pocket', 'probe1_drill'],
    })
    // an owned operation's geometry, order and life go through its feature
    const refused = await t.call('design_drilling_update', {
      partId,
      operationId: 'probe1_drill',
      diameter: '4',
    })
    const result = toToolResult(refused)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      error: { code: 'design.featureOwned' },
    })
    expect(exitCodeOf('design.featureOwned')).toBe(EXIT.other)
    const remove = await t.call('design_operation_remove', { partId, operationId: 'probe1_pocket' })
    expect(remove.result.isErr() && remove.result.unwrapErr().code).toBe('design.featureOwned')
    // its name is still the operation's own (A4)
    await t.ok('design_drilling_update', { partId, operationId: 'probe1_drill', name: 'Pilot' })

    const order = () => t.project.doc.parts[partId]!.operations.map((o) => o.id)
    await t.ok('design_feature_move', { partId, featureId: 'probe1', toIndex: 0 })
    expect(order()).toEqual(['probe1_pocket', 'probe1_drill', 'pocket1'])
    await t.ok('history_undo', {})
    expect(order()).toEqual(['pocket1', 'probe1_pocket', 'probe1_drill'])

    const list = await t.ok('design_feature_list', { partId })
    expect(list.value).toMatchObject({
      features: [{ feature: { id: 'probe1', kind: 'probe' }, index: 1 }],
    })
    await t.ok('design_feature_remove', { partId, featureId: 'probe1' })
    expect(order()).toEqual(['pocket1'])
    expect(t.project.doc.parts[partId]!.features).toBeUndefined()
    await t.ok('history_undo', {})
    expect(order()).toEqual(['pocket1', 'probe1_pocket', 'probe1_drill'])
    expect(t.project.doc.parts[partId]!.operations[2]!.name).toBe('Pilot')
  })
})
