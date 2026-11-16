# Logging

Status: accepted · Principle: [principles.md §6](../principles.md#6-performance-and-stability) · Decision: [ADR 0009](../decisions/0009-pino-for-logging.md) · Errors: [boundaries.md](error-handling/boundaries.md#entry-points-ui-agent-cli-automation)

Diagnostic logs for developers, support and agents debugging the app: structured JSON via **pino** (v10, MIT), one file per app instance, on by default at `info`.

## Rules

1. Code logs through the `Logger` port from `src/shared/logging.ts`, never `console.*` and never by importing `pino` outside the per-process implementations below.
2. Get a logger by injection (`ctx.services.log` in commands, a constructor/function parameter elsewhere) and scope it with `child()`. No global logger in `src/core` or `src/shared`.
3. Message: short English, constant per call site (`'project saved'`); variable data goes into fields, not into the string.
4. **Errors are logged once**, by the boundary reporter ([below](#apperror)). Lower layers return errors; they don't log them.
5. Never log document content, patches, geometry or toolpaths – log ids, counts, sizes, durations.
6. Never write logs to stdout: in headless runs stdout carries MCP stdio and CLI output ([ADR 0011](../decisions/0011-mcp-and-cli-agent-api.md)).

## Levels

| Level   | Use                                                                                       | Default visible |
| ------- | ----------------------------------------------------------------------------------------- | --------------- |
| `fatal` | Process can't continue or a safety stop was triggered; logged before exit.                | yes             |
| `error` | An action failed and the user/agent was told (`AppError` with `error` severity).          | yes             |
| `warn`  | Degraded but working: stale lock taken over, working-folder write failed, retry needed.   | yes             |
| `info`  | Lifecycle milestones: app/process start and stop, project open/save/close, job start/end. | yes             |
| `debug` | Every dispatched command, timings, IPC/worker messages, decisions inside a module.        | dev only        |
| `trace` | High-volume detail (per progress tick, per file in an archive). Never on by default.      | no              |

- Default level: `info` in packaged builds, `debug` in `npm run dev`. Override: `DFYOM_LOG_LEVEL` env var or `--log-level` (app and CLI); applies to all processes of the instance.
- `AppError` uses the code's `severity` from [the registry](error-handling/app-error.md#error-code-registry); both share the names `debug`…`fatal`.

## Fields

pino's own fields (`level`, `time`, `msg`, `pid`) plus:

| Field      | Set by                      | Example                                                                                    |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------ |
| `proc`     | Root logger of each process | `main`, `utility`, `renderer`, `worker`, `cli`                                             |
| `instance` | Root logger                 | Instance id (same as in the [lock](../architecture/persistence.md#lock))                   |
| `app`      | Root logger                 | App version                                                                                |
| `scope`    | `child({ scope })`          | `persist.save`, `commands.dispatcher`                                                      |
| `win`      | Renderer root               | Window id                                                                                  |
| `source`   | Dispatcher child            | `{ kind: 'agent', id: 'mcp-3' }` ([commands.md](../architecture/commands.md#stale-writes)) |
| `cmd`      | Dispatcher child            | `design.pocket.add`                                                                        |
| `project`  | Dispatcher child            | Project id                                                                                 |
| `rev`      | Dispatcher child            | Revision after the command                                                                 |
| `jobId`    | Job context child           | Job id                                                                                     |
| `ms`       | `timed()` helper            | Duration in milliseconds                                                                   |
| `err`      | Error serializer            | `AppError.toJSON()`                                                                        |

Names are fixed here; add a row before using a new top-level field.

## Port and helpers

`src/shared` stays environment-neutral: it holds only types and pure helpers. Each process has its own implementation.

| File                           | Contents                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/logging.ts`        | `Logger` (`trace`…`fatal(obj?, msg)`, `child(bindings)`, `isLevelEnabled`) – a structural subset of pino's logger; `LogFields`; `timed(log, msg, fn)`; `logAppError(log, err, entry)`; `serializeErr`; `noopLogger` |
| `src/shared/testing/logger.ts` | `createTestLogger()`: records entries in memory for assertions                                                                                                                                                      |
| `src/main/logging/logger.ts`   | Root pino logger, file sink, redaction, uncaught-error hooks                                                                                                                                                        |
| `src/main/logging/forward.ts`  | Receives forwarded batches from renderers and the utility process and writes them through the root logger                                                                                                           |
| `src/renderer/logging.ts`      | pino browser build; `transmit` batches to main via the preload API (contract in `src/shared/preload-api.ts`)                                                                                                        |
| Utility process entry          | pino writing to a stream that posts batches to main over its `MessagePort`                                                                                                                                          |
| Worker entry (both kinds)      | Logger posting entries over the [worker protocol](../decisions/0008-threading-split-by-job.md) to its owner, which forwards them                                                                                    |
| CLI / headless entry           | Same root logger as main, with `--data-dir` log folder and a `warn`+ copy on stderr                                                                                                                                 |

- Only the main process (or the headless/CLI process) writes the file; every other process forwards. Renderers forward every entry at or above the instance level, so the file is the one place to look. Forwarding batches entries (≤ 100 ms or 50 entries) and drops beyond 1 000 entries/s per process, logging one `warn` with the drop count.
- `timed(log, msg, fn)` logs `msg` with `ms` at `debug` (`warn` above a given budget) and returns `fn`'s result unchanged.
- The dispatcher logs one `debug` line per dispatch (`cmd`, `source`, `rev`, `ms`, `ok`); failures are logged by the boundary, not here.

## AppError

- The boundary reporter ([`atBoundary`](../../src/shared/boundary.ts)) calls `logAppError(log, err, entry)`, which logs at `err.severity` with `{ err: err.toJSON(), entry: { kind, name } }` and `err.message` as `msg`. Args are already in the entry frame, summarized by `summarizeArgs`.
- Every logger registers `serializeErr` for the `err` key: `AppError` → `toJSON()` ([serialization](error-handling/app-error.md#serialization)); other `Error` → pino's standard serializer.
- Uncaught exceptions and unhandled rejections become `internal.unexpected` and are logged at `fatal` (main, utility, CLI) or `error` (renderer, worker), then flushed before exit.

## Redaction

- Applied in the writing process with pino `redact` (censor `[redacted]`), so forwarded entries are covered too: keys `token`, `password`, `secret`, `authorization`, `cookie`, `apiKey` at the top level and up to 3 levels deep (explicit wildcard paths such as `*.token`; pino has no recursive wildcard).
- Frames and fields must not contain secrets in the first place ([app-error.md](error-handling/app-error.md)); redaction is the safety net.
- File paths (including the home directory) are logged as they are in v0.1. Later: an "Export logs" action that redacts them for sharing.

## Files and rotation

- Folder: Electron `app.getPath('logs')` (macOS `~/Library/Logs/DFYOM/`, Windows `%APPDATA%\DFYOM\logs\`, Linux `~/.config/DFYOM/logs/`), or `<data-dir>/logs/` headless.
- File: `<startedAt>-<instance>.log`, JSON lines, one per instance; rotated with **pino-roll** (MIT) by size; rotate at **10 MB**; at startup and on rotation delete files older than **14 days**, then oldest first until the folder is ≤ **200 MB** (fixed in v0.1).
- The file sink runs **in-process** (pino-roll's `SonicBoom` stream as destination), not as a `pino.transport` worker, so bundling stays simple; revisit if logging shows up in profiles.

## Development

- `npm run dev` additionally pretty-prints to the terminal with **pino-pretty** (dev dependency); the file stays JSON.
- Read a log file pretty with `npx pino-pretty < file.log`; agents read the JSON directly.

## Logs vs. action log

|           | Diagnostic log (this doc)            | [Action log](../architecture/commands.md#action-log)   |
| --------- | ------------------------------------ | ------------------------------------------------------ |
| Purpose   | Debugging the app                    | Observing what users and agents did, for agents and UI |
| Content   | Free-form events, errors, timings    | Typed `ActionEvent`s, one per dispatch                 |
| Consumers | Developers, support, agents via file | Subscribers via API/MCP                                |
| Storage   | Rotating files                       | In-memory ring buffer                                  |

Never reconstruct project state or user actions from logs, and never feed the action log from logs (or vice versa).

## Testing

- Unit tests inject `createTestLogger()` and assert on fields (`level`, `scope`, `err.code`), never on message text. Default for code under test without an explicit logger: `noopLogger`.
- Boundary tests assert an error is logged **exactly once** at its severity.
- Main-logger tests write to a temp folder and check JSON lines, redaction and the `AppError` serializer; forwarding tests check batching and the drop counter.
