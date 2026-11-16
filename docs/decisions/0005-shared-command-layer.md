# 0005 – One shared command layer for UI, agents and CLI

Status: accepted · Date: 2026-11-16

## Context

[Principle 1](../principles.md#1-llm-first) requires that everything a user can do, an agent can do too: headless, from multiple instances, and while observing a user's actions in a visible window. Wiring UI handlers, agent tools and CLI commands separately would let them drift apart and would make undo/redo, action logging and permission checks inconsistent.

## Decision

Every state-changing or privileged action is a **command** defined once in `src/core`. The UI, the agent API ([llm-api.md](../architecture/llm-api.md)) and the CLI are thin **adapters** that dispatch commands; none of them change state any other way.

## Consequences

- Parity between user and agent comes from the structure itself, not from discipline.
- Command arguments are Zod schemas ([ADR 0004](0004-zod-for-shape-validation.md)), so agent tool JSON Schemas are generated, not hand-written.
- Undo/redo, the action log that agents subscribe to, and permission checks for real-machine actions are implemented once, in the dispatcher.
- Design: [architecture/commands.md](../architecture/commands.md).
