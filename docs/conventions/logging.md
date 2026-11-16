# Logging

Status: stub · Principle: [principles.md §6](../principles.md#6-performance-and-stability)

## Requirements

- On by default, not too verbose by default; level configurable.
- Structured (JSON) and organized by module/scope so they are useful for debugging by humans and LLMs.
- Implemented with a library (candidates: `pino`, `electron-log` – decide in an ADR).
- Works across main, renderer, workers; one sink/file per app instance.
- First-class `AppError` support: errors are logged **once**, by the boundary reporter, as `AppError.toJSON()` at the level given by the code's `severity` ([boundaries](error-handling/boundaries.md#entry-points-ui-agent-cli-automation), [error codes](error-handling/app-error.md#error-code-registry)).
- Prepared helpers (scoped loggers, timing) documented here.
