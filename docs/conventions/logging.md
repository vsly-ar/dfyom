# Logging

Status: stub · Principle: [principles.md §6](../principles.md#6-performance-and-stability)

## Requirements

- On by default, not too verbose by default; level configurable.
- Structured (JSON) and organized by module/scope so they are useful for debugging by humans and LLMs.
- Implemented with a library (candidates: `pino`, `electron-log` – decide in an ADR).
- Works across main, renderer, workers; one sink/file per app instance.
- First-class `AppError` support: errors are logged with their full enrichment context ([error-handling.md](error-handling.md)).
- Prepared helpers (scoped loggers, timing) documented here.
