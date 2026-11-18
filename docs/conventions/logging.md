# Logging

Status: implemented · Principle: [principles.md §6](../principles.md#6-performance-and-stability) · Decision: [ADR 0009](../decisions/0009-pino-for-logging.md) · Errors: [boundaries.md](error-handling/boundaries.md#entry-points-ui-agent-cli-automation)

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

- Default level: `info` in packaged builds, `debug` in unpackaged runs (`npm run dev`, `npm run preview`). Override: `DFYOM_LOG_LEVEL` env var or `--log-level` (app and CLI); the flag wins over the env var; an invalid value is ignored and logged once as `warn`. Applies to all processes of the instance (renderers get it as a window argument). Implementation: `resolveLogLevel`.
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
| `entry`    | `logAppError`               | `{ kind: 'ui', name: 'design.chamfer.apply' }`                                             |
| `dropped`  | Forwarder, forward receiver | Entries dropped by a rate or size limit in the last second                                 |
| `from`     | Forward receiver            | Origin of dropped entries: `{ proc: 'renderer', win: 1 }`                                  |
| `fwd`      | Forward receiver            | All fields of a forwarded entry ([forwarding](#forwarding))                                |

Names are fixed here; add a row before using a new cross-cutting top-level field. Event-specific data (`count`, `file`, …) may use other names, but never pino's own (`level`, `time`, `msg`, `pid`) or a name from this table with another meaning – pino would write the key twice.

## Port and helpers

`src/shared` stays environment-neutral: it holds only types and pure helpers. Each process has its own implementation.

| File                                                   | Contents                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/logging.ts`                                | `Logger` (`trace`…`fatal(obj?, msg)`, `child(bindings)`, `isLevelEnabled`) – a structural subset of pino's logger; `LogFields`; `resolveLogLevel`; `timed(log, msg, fn)`; `logAppError(log, err, entry)`; `createLogReporter`; `serializeErr`; `noopLogger`; `LogRecord` (forwarding wire format); `createEntryLogger` and `createLogForwarder` (batching and drop limit, for every forwarding process) |
| `src/shared/testing/logger.ts`                         | `createTestLogger()`: records entries in memory for assertions                                                                                                                                                                                                                                                                                                                                          |
| `src/main/logging/logger.ts`                           | Root pino logger, file sink, redaction, uncaught-error hooks; no Electron import (reused by CLI/headless)                                                                                                                                                                                                                                                                                               |
| `src/main/logging/retention.ts`                        | Age and size cleanup of the log folder                                                                                                                                                                                                                                                                                                                                                                  |
| `src/main/logging/forward.ts`                          | Receives forwarded batches from renderers and the utility process and writes them through the root logger                                                                                                                                                                                                                                                                                               |
| `src/main/logging/electron.ts`                         | Electron wiring: log folder, level, dev pretty output, renderer IPC channel, boundary reporter                                                                                                                                                                                                                                                                                                          |
| `src/renderer/src/logging.ts`                          | pino browser build; `transmit` batches to main via the preload API (contract in `src/shared/preload-api.ts`)                                                                                                                                                                                                                                                                                            |
| Utility process entry (not yet)                        | pino writing to a stream that posts batches from `createLogForwarder` to main over its `MessagePort`                                                                                                                                                                                                                                                                                                    |
| Worker entry (compute workers; renderer workers later) | `createEntryLogger` + `createLogForwarder` posting batches over the [worker protocol](../architecture/workers.md#logging-from-workers) to its owner, which forwards them                                                                                                                                                                                                                                |
| CLI / headless entry (`src/main/cli/runtime.ts`)       | `createMainLogging` from `src/main/logging/logger.ts` with the `<data-dir>/logs/` folder and a `warn`+ copy on stderr                                                                                                                                                                                                                                                                                   |

- `timed(log, msg, fn)` logs `msg` with `ms` at `debug` (`warn` above a given budget) and returns `fn`'s result unchanged.
- The dispatcher logs one `debug` line per dispatch (`cmd`, `source`, `rev`, `ms`, `ok`); failures are logged by the boundary, not here.

### Forwarding

Only the main process (or the headless/CLI process) writes the file; every other process forwards. Renderers forward every entry at or above the instance level, so the file is the one place to look. Renderers also write to the DevTools console in unpackaged runs only.

Compute workers and the machine host (a utility process in the app, a `worker_threads` worker headless) forward through their message protocol (`log` messages, [workers.md](../architecture/workers.md#logging-from-workers), [run-v0.1.md](../modes/run-v0.1.md#logging)); main writes them with origin `worker` or `utility`.

- **Sender side** (`createLogForwarder`): batches entries (≤ 100 ms or 50 entries) and drops beyond 1 000 entries/s per process, logging one `warn` (`dropped`) when the second ends.
- **Main side** (`createForwardReceiver`): the sender is untrusted (a compromised renderer), so main enforces its own limits and does not rely on the sender's.
  - IPC is accepted only from a window's main frame (`event.senderFrame` is `event.sender.mainFrame`); main sets `proc` and `win` from the sender.
  - The forwarded fields are written **nested under `fwd`**, never at the top level, so a sender can't forge `scope`, `entry`, `err`, `proc` or any other top-level field. Top level: pino's fields, `proc`, `instance`, `app`, `win`, `fwd`, `msg`.
  - Per entry: fields cut at 3 nesting levels (deeper values → `'[depth]'`); fields over 16 KB serialized → `fwd: { truncated: true, bytes }`; `msg` cut at 1 000 characters (`…`).
  - Per batch: at most 1 000 entries and 256 KB of serialized fields; later entries are dropped.
  - Per sender: token bucket of 1 000 entries/s (burst 2 000). A malformed batch costs one token and is reported as `input.malformed` through the boundary reporter; with no tokens left, batches are dropped without parsing.
  - Drops of any kind are summarized in one `warn` per sender and second (`dropped`, `from`), not logged one by one.
- `time` is when main writes the entry (≤ 100 ms after it was logged).

## AppError

- The boundary reporter ([`atBoundary`](../../src/shared/boundary.ts)) calls `logAppError(log, err, entry)`, which logs at `err.severity` with `{ err: err.toJSON(), entry: { kind, name } }` and `err.message` as `msg`. Args are already in the entry frame, summarized by `summarizeArgs`.
- Every logger registers `serializeErr` for the `err` key: `AppError` → `toJSON()` ([serialization](error-handling/app-error.md#serialization)); other `Error` → pino's standard serializer.
- Uncaught exceptions and unhandled rejections become `internal.unexpected` and are logged at `fatal` (main, utility, CLI; then flushed and the process exits with code 1) or `error` (renderer, worker; the process keeps running).

## Redaction

- Applied in the writing process with pino `redact` (censor `[redacted]`), so forwarded entries are covered too: keys `token`, `password`, `secret`, `authorization`, `cookie`, `apiKey`, `api_key`, each as written, lower-case, Capitalized and UPPER-CASE (`Authorization`, `COOKIE`; pino matches case-sensitively), at the top level and up to 4 levels deep (explicit paths `token`, `*.token` … `*.*.*.*.token`; pino has no recursive wildcard, so deeper keys are not censored). 4 levels cover everything inside a forwarded `fwd`, whose fields are cut at 3 levels.
- Frames and fields must not contain secrets in the first place ([app-error.md](error-handling/app-error.md)); redaction is the safety net.
- File paths (including the home directory) are logged as they are in v0.1. Later: an "Export logs" action that redacts them for sharing.

## Files and rotation

- Folder: Electron `app.getPath('logs')` (macOS `~/Library/Logs/DFYOM/`, Windows `%APPDATA%\DFYOM\logs\`, Linux `~/.config/DFYOM/logs/`), or `<data-dir>/logs/` headless.
- File: `<startedAt>-<instance>.<n>.log` (`startedAt` in UTC as `2026-11-16T10-20-30Z`; `n` = 1, 2, … per rotation, numbered by pino-roll), JSON lines, one series per instance; rotated with **pino-roll** (MIT) by size; rotate at **10 MB**; at startup and on rotation delete own log files older than **14 days** (by modification time), then oldest first until they total ≤ **200 MB** (fixed in v0.1).
- Retention only considers regular files (checked with `lstat`, so no symlinks or folders) whose name matches the pattern above with a UUID instance id; anything else in the folder is neither deleted nor counted. It never deletes the file being written, nor any file modified in the last **10 minutes**, so another running instance's open file survives.
- If the folder can't be opened, the process logs to stderr only and logs that at `error`.
- The file sink runs **in-process** (pino-roll's `SonicBoom` stream as destination), not as a `pino.transport` worker, so bundling stays simple; revisit if logging shows up in profiles.

## Development

- Unpackaged runs additionally pretty-print to the terminal (stderr) with **pino-pretty** (dev dependency, externalized in `electron.vite.config.ts` and loaded only then); the file stays JSON.
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
- Main-logger tests write to a temp folder and check JSON lines, redaction and the `AppError` serializer; forwarding tests check batching and the drop counter on the sender side, and the receiver's limits (`fwd` nesting, size and depth caps, token bucket, drop summary); retention tests use a temp folder (own vs. foreign names, symlinks, recent files).
