// Spike S7: measures `tools/list` (chars, tools) and the chamfer tools' share, for the draft's
// Agent API budget (docs/modes/edge-chamfers.md). Run with the spike's vitest config.
import { expect, it } from 'vitest'
import { expectOk } from '../../src/shared/testing/result'
import { createAppScopeRegistry, createProjectRegistry } from '../../src/core/commands/registry'
import { SESSION_TOOLS } from '../../src/core/agent/session'
import { buildAgentTools, mcpToolList, TOOLS_LIST_BUDGET_CHARS } from '../../src/core/agent/tools'

it('tools/list size', () => {
  const tools = expectOk(
    buildAgentTools(
      { app: expectOk(createAppScopeRegistry()), project: expectOk(createProjectRegistry()) },
      SESSION_TOOLS,
    ),
  )
  const list = mcpToolList(tools)
  const size = JSON.stringify({ tools: list }).length
  const chamfer = list.filter((t) => /chamfer/i.test(t.name))
  console.log(
    `tools/list ${size} chars, ${list.length} tools, budget ${TOOLS_LIST_BUDGET_CHARS};`,
    chamfer.map((t) => `${t.name} ${JSON.stringify(t).length}`).join(', '),
  )
  expect(size).toBeLessThan(TOOLS_LIST_BUDGET_CHARS)
})
