// The v0.1–v0.4 and v0.4-llm-first exit criteria headless, through the CLI: `dfyom batch` (the
// bundled CLI, temp data dir) runs the same exit-criteria flows as the MCP variant
// (exit-criteria.fixture.ts, exit-criteria.v02.fixture.ts, exit-criteria.v03.fixture.ts,
// exit-criteria.v04.fixture.ts, exit-criteria.llm-first.fixture.ts), one JSON line per call,
// answered line by line; the same goldens.
// Spec: docs/plans/v0.1.md#exit-criteria, docs/plans/v0.2.md#exit-criteria,
// docs/plans/v0.3.md#exit-criteria, docs/plans/v0.4.md#exit-criteria,
// docs/plans/v0.4-llm-first.md#exit-criteria,
// docs/architecture/llm-api.md#testing, docs/conventions/testing.md#end-to-end
import { afterAll, describe, expect, it } from 'vitest'
import { tempDir } from '../host/host.fixture'
import { spawnCli } from './cli.fixture'
import { type CallResult, exitCriteriaFlow } from './exit-criteria.fixture'
import { exitCriteriaV02Flow } from './exit-criteria.v02.fixture'
import {
  exitCriteriaV03Flow,
  expectEvaluated,
  type FlowV03Result,
} from './exit-criteria.v03.fixture'
import { CALL_BUDGET, exitCriteriaV04Flow } from './exit-criteria.v04.fixture'
import { EXIT_NUMBERS, exitCriteriaLlmFirstFlow } from './exit-criteria.llm-first.fixture'

const t = tempDir('dfyom-e2e-batch-')
// the v0.2 flow in its own data dir: a fresh library, so its auto tool choice sees only its tools
const t2 = tempDir('dfyom-e2e-batch-v02-')
const t3 = tempDir('dfyom-e2e-batch-v03-')
const t4 = tempDir('dfyom-e2e-batch-v04-')
const t5 = tempDir('dfyom-e2e-batch-llm-first-')
let v03: FlowV03Result | undefined
afterAll(() => {
  t.cleanup()
  t2.cleanup()
  t3.cleanup()
  t4.cleanup()
  t5.cleanup()
})

describe('exit criteria headless: dfyom batch', { timeout: 180_000 }, () => {
  it('runs the v0.1 flow as JSON lines in one session', async () => {
    const cli = spawnCli(['batch'], t.dir)
    const call = async (name: string, args: object = {}): Promise<CallResult> => {
      cli.send({ name, args })
      return (await cli.next()) as unknown as CallResult
    }
    await exitCriteriaFlow(call, t.dir)
    cli.end()
    // nothing left unsaved (that would be exit 6 and a stderr notice); the exit code is the first
    // failing line's: the flow's one expected failure, a design query after the close (code 2)
    expect(await cli.exited).toMatchObject({ code: 2, stderr: '' })
  })

  it('runs the v0.2 flow (reference, three faces, a program per setup) in one session', async () => {
    const cli = spawnCli(['batch'], t2.dir)
    const call = async (name: string, args: object = {}): Promise<CallResult> => {
      cli.send({ name, args })
      return (await cli.next()) as unknown as CallResult
    }
    await exitCriteriaV02Flow(call, t2.dir)
    cli.end()
    // every line succeeded and nothing is left unsaved
    expect(await cli.exited).toMatchObject({ code: 0, stderr: '' })
  })

  it('runs the v0.3 flow (SVG shapes, Shape Editor, shape operations, two setups) in one session', async () => {
    const cli = spawnCli(['batch'], t3.dir)
    const call = async (name: string, args: object = {}): Promise<CallResult> => {
      cli.send({ name, args })
      return (await cli.next()) as unknown as CallResult
    }
    v03 = await exitCriteriaV03Flow(call, t3.dir)
    cli.end()
    // nothing is left unsaved; the exit code is the first failing line's: a fillet radius the
    // cavity refused (model.invariant, code 2) while the agent looked for the largest that fits
    expect(await cli.exited).toMatchObject({ code: 2, stderr: '' })
  })

  it('runs the v0.4 flow (holes, Clones, chamfers, the lid) in one session', async () => {
    const cli = spawnCli(['batch'], t4.dir)
    const call = async (name: string, args: object = {}): Promise<CallResult> => {
      cli.send({ name, args })
      return (await cli.next()) as unknown as CallResult
    }
    const { stats } = await exitCriteriaV04Flow(call, t4.dir)
    cli.end()
    // every line succeeded and nothing is left unsaved
    expect(await cli.exited).toMatchObject({ code: 0, stderr: '' })
    // the budget of the LLM-first criteria (≤ 100 calls besides job polling, no result over 64 KB)
    expect(stats.calls - stats.polls).toBeLessThanOrEqual(CALL_BUDGET.calls)
    expect(stats.largest.bytes, stats.largest.name).toBeLessThanOrEqual(CALL_BUDGET.resultBytes)
  })

  // v0.4-llm-first X1 (docs/plans/v0.4-llm-first.md#exit-criteria)
  it('runs the v0.4-llm-first flow (the enclosure base from its STL, toe clamps) in one session', async () => {
    const cli = spawnCli(['batch'], t5.dir)
    const call = async (name: string, args: object = {}): Promise<CallResult> => {
      cli.send({ name, args })
      return (await cli.next()) as unknown as CallResult
    }
    const { stats } = await exitCriteriaLlmFirstFlow(call, t5.dir)
    cli.end()
    // every line succeeded and nothing is left unsaved
    expect(await cli.exited).toMatchObject({ code: 0, stderr: '' })
    expect(stats.calls).toBeLessThanOrEqual(EXIT_NUMBERS.calls)
    expect(stats.largest.bytes, stats.largest.name).toBeLessThanOrEqual(EXIT_NUMBERS.resultBytes)
  })

  // the solid tabs of the imported enclosure outline (tab bands on its fitted arcs, geometry/tab-bands.ts)
  it('evaluates the v0.3 part with tabs on the imported outline', () => {
    expect(v03).toBeDefined()
    expectEvaluated(v03!.evaluation)
  })
})
