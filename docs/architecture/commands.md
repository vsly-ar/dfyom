# Command layer

Status: stub · Decision: [ADR 0005](../decisions/0005-shared-command-layer.md)

## Requirements (to be designed)

- A command is defined once in `src/core`: name, Zod argument schema, handler returning `AppResult`, metadata (undoable, affects real machine, long-running).
- Adapters: UI ([overview.md#ipc](overview.md#ipc)), agent API ([llm-api.md](llm-api.md)), CLI. Adapters contain no domain logic.
- **Undo/redo** across all command sources, in one history per project. Model: each command records forward and inverse **state patches** (e.g. Immer patches); commands contain no undo code, and the patches also feed the action log.
- **Action log**: every dispatched command (source, arguments, result) is observable, so an attached agent receives the user's actions.
- **Permissions**: commands that affect a real machine go through one policy check ([modes/run.md#safety](../modes/run.md#safety)).
- **Gestures**: while dragging or typing, the UI shows a live preview only; one command is dispatched when the gesture ends (release, blur, Enter). One gesture = one command = one undo step.
- Long-running commands report progress and support pause/abort ([overview.md#threading](overview.md#threading)).

## Open questions

- How queries (reads) are exposed to agents alongside commands.
