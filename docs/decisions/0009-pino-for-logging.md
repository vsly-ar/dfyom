# 0009 – pino for structured logging

Status: accepted · Date: 2026-11-16

## Context

[logging.md](../conventions/logging.md) requires structured, scoped logs across main, renderer, workers and headless runs, with `AppError` support. Candidates: pino, electron-log, an own logger.

## Decision

Use **pino**: JSON logs, child loggers per scope, usable in Node, workers and the browser. Electron-specific sinks (file per app instance, forwarding from renderers) are thin adapters.

## Consequences

- Same logging API in every process and in headless/CLI runs.
- File rotation and renderer forwarding are small adapters we own.
- Usage: [logging.md](../conventions/logging.md).
