# Command layer

Status: stub · Decision: [ADR 0005](../decisions/0005-shared-command-layer.md)

## Requirements (to be designed)

- A command is defined once in `src/core`: name, Zod argument schema, handler returning `AppResult`, metadata (undoable, affects real machine, long-running).
- Adapters: UI ([overview.md#ipc](overview.md#ipc)), agent API ([llm-api.md](llm-api.md)), CLI. Adapters contain no domain logic.
- **Undo/redo** across all command sources, in one history per project.
- **Action log**: every dispatched command (source, arguments, result) is observable, so an attached agent receives the user's actions.
- **Permissions**: commands that affect a real machine go through one policy check ([modes/run.md#safety](../modes/run.md#safety)).
- Long-running commands report progress and support pause/abort ([overview.md#threading](overview.md#threading)).

## Open questions

- Undo model: inverse commands vs. state snapshots vs. patches.
- Granularity: how UI gestures (dragging, typing) are merged into one undo step.
- How queries (reads) are exposed to agents alongside commands.
