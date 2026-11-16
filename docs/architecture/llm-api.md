# LLM / agent API

Status: stub · Principle: [principles.md §1](../principles.md#1-llm-first)

## Requirements (to be designed)

- Parity: every user action is available to agents (likely via one command layer – [overview.md#ipc](overview.md#ipc)).
- Headless operation (no window) and **multiple app instances**.
- Multi-agent workflows.
- When a window is visible with an agent attached, user actions are streamed to the agent.
- Run mode: agent-authored automation scripts (JS/TS/Python/Lua) and live agent supervision with hooks and periodic checks ([modes/run.md](../modes/run.md)).

## Open questions

- Transport: MCP server, local HTTP/WebSocket, CLI – or all of them over the same command layer.
- Permission model for actions that affect a real machine.
