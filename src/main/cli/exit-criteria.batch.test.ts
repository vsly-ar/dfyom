// The v0.1, v0.2 and v0.3 exit criteria headless, through the CLI: `dfyom batch` (the bundled CLI,
// temp data dir) runs the same exit-criteria flows as the MCP variant (exit-criteria.fixture.ts,
// exit-criteria.v02.fixture.ts, exit-criteria.v03.fixture.ts), one JSON line per call, answered
// line by line; the same goldens.
// Spec: docs/plans/v0.1.md#exit-criteria, docs/plans/v0.2.md#exit-criteria,
// docs/plans/v0.3.md#exit-criteria,
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

const t = tempDir('dfyom-e2e-batch-')
// the v0.2 flow in its own data dir: a fresh library, so its auto tool choice sees only its tools
const t2 = tempDir('dfyom-e2e-batch-v02-')
const t3 = tempDir('dfyom-e2e-batch-v03-')
let v03: FlowV03Result | undefined
afterAll(() => {
  t.cleanup()
  t2.cleanup()
  t3.cleanup()
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

  // the solid tabs of the imported enclosure outline (tab bands on its fitted arcs, geometry/tab-bands.ts)
  it('evaluates the v0.3 part with tabs on the imported outline', () => {
    expect(v03).toBeDefined()
    expectEvaluated(v03!.evaluation)
  })
})
