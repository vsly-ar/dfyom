# LLM / agent API

Status: stub · Principle: [principles.md §1](../principles.md#1-llm-first)

Transports: MCP server (stdio + local HTTP) and CLI – [ADR 0011](../decisions/0011-mcp-and-cli-agent-api.md).

## Requirements (to be designed)

- Parity: every user action is available to agents (likely via one command layer – [overview.md#ipc](overview.md#ipc)).
- Headless operation (no window) and **multiple app instances**.
- Multi-agent workflows.
- When a window is visible with an agent attached, user actions are streamed to the agent.
- Run mode: agent-authored automation scripts (JS/TS/Python/Lua) and live agent supervision with hooks and periodic checks ([modes/run.md](../modes/run.md)).

## Open questions

- Permission model for actions that affect a real machine.
