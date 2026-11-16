# 0011 – MCP server and CLI as the first agent transports

Status: accepted · Date: 2026-11-16

## Context

[Principle 1](../principles.md#1-llm-first) requires agent parity, headless operation and attaching to a visible window. Candidates: MCP, own WebSocket API, CLI only.

## Decision

Agents reach the app through an **MCP server** – stdio for headless instances, local HTTP for attaching to a running instance – and a **CLI**. Both are adapters over the [command layer](../architecture/commands.md); MCP tool schemas are generated from command Zod schemas ([ADR 0004](0004-zod-for-shape-validation.md)).

## Consequences

- Works with existing agent clients without custom glue.
- The action log (user actions streamed to an attached agent) must map onto MCP notifications/resources – design in [llm-api.md](../architecture/llm-api.md).
- Other transports can be added later over the same command layer.
