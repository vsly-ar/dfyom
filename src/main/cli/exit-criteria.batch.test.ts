// The v0.1 exit criteria headless, through the CLI: `dfyom batch` (the bundled CLI, temp data
// dir) runs the same exit-criteria flow as the MCP variant (exit-criteria.fixture.ts), one JSON
// line per call, answered line by line; the same golden gCode.
// Spec: docs/plans/v0.1.md#exit-criteria, docs/architecture/llm-api.md#testing,
// docs/conventions/testing.md#end-to-end
import { afterAll, describe, expect, it } from 'vitest'
import { tempDir } from '../host/host.fixture'
import { spawnCli } from './cli.fixture'
import { type CallResult, exitCriteriaFlow } from './exit-criteria.fixture'

const t = tempDir('dfyom-e2e-batch-')
afterAll(() => t.cleanup())

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
})
