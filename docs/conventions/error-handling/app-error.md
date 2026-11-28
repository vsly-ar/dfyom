# AppError

Status: implemented · Part of [error handling](README.md)

The single error type: shape, error-code registry, enrichment rules, serialization.

## Shape

| Field                     | Purpose                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `code: ErrorCode`         | Classification from the central registry ([below](#error-code-registry)). Drives severity, user message, retry, CLI exit code.           |
| `message: string`         | Developer/LLM-facing English text, specific (`"total chamfer size 6 mm exceeds 5 mm"`).                                                  |
| `issues: Issue[]`         | Rule violations, each `{ path, rule, message, params? }` – field-level, machine-readable (forms highlight `path`; agents read `params`). |
| `frames: ContextFrame[]`  | Enrichment, **innermost first**: `{ where, data? }`.                                                                                     |
| `cause?: unknown`         | Original error (third-party exception, `InvariantViolation`, nested `AppError`).                                                         |
| `stack`                   | Captured where the error was **first created**; preserved by enrichment.                                                                 |
| `severity`, `userMessage` | Derived getters from the registry.                                                                                                       |

`AppError extends Error`, so stack traces, `cause`, React error boundaries and logging libraries work natively. It is immutable: `withContext()`, `prefixIssues()` and `mapIssues()` (rewrites issues, e.g. an owned operation's path back to its feature field) return copies.

Implementation: [`src/shared/errors/app-error.ts`](../../../src/shared/errors/app-error.ts) · tests: [`app-error.test.ts`](../../../src/shared/errors/app-error.test.ts)

## Error code registry

One `as const` object is the **single list of codes**. Codes are `area.reason`, stable (agents and tests depend on them), and added here before use – never invented inline.

Implementation: [`src/shared/errors/codes.ts`](../../../src/shared/errors/codes.ts)

Run mode added `machine.error`, `machine.alarm` and `run.*` ([run-v0.1.md](../../modes/run-v0.1.md#stop-errors-and-alarms)). Hardening added `machine.reset` (the controller restarted by itself while the link works, DF87, [run.md](../../modes/run.md#5-watchdogs)), `run.travel` (a jog that would leave the machine travel, [run.md](../../modes/run.md#machine-coordinates-and-the-homing-corner-df33)), `plan.alignment` (a refused alignment point or work zero edit, [alignment.md](../../modes/alignment.md#commands)), `plan.aid` (a refused or uncuttable alignment aid, [alignment.md](../../modes/alignment.md#alignment-aids)) `plan.workholding` (an automatic workholding arrangement that cannot be made: no toolpaths, no room, a vise; v0.4-llm-first W6, [workholding.md](../../modes/workholding.md#automatic-arrangement-w6)) `run.surfaceMap` (a surface map that cannot be followed for a run: incomplete, another work zero, its range over the limit, the program outside it; v0.5 RV10, [run-surface.md](../../modes/run-surface.md#refusals)) and `job.notPausable` (`job.pause` of a job that cannot be paused, such as homing, DF82, [commands.md](../../architecture/commands.md#pausing-a-job)). Expected future areas (add when the feature's doc is written): more `machine.*` (limit), `device.*` (MCU/sensor), `plan.*` (collision, unreachable, tool not found), `geometry.*`, `script.*`, `agent.*` (permission denial is `permission.denied`, [commands.md](../../architecture/commands.md#dispatcher-pipeline)).

## Enrichment rules

- **Create** at the lowest level that detects the problem, with `where` = `Module.function` and the data needed to understand it.
- **Enrich** only with information the lower level did not have (ids, the user's intent, which item in a loop). Don't add a frame that just repeats the function name with no data.
- **Data must be small and serializable** – ids, numbers, short strings. No geometry blobs, no class instances. `atBoundary` truncates args above 2 000 chars.
- **No secrets** in frames (credentials, tokens).
- **Change the code only when the meaning changes** (e.g. `persist.io` "file not found" while loading a library may become a domain-specific code). Keep the original as `cause`.

## Serialization

`AppError.toJSON()` → `AppErrorData` (plain object, `structuredClone`- and JSON-safe). Results crossing a boundary use a wire union:

Implementation: `ResultWire`, `toWire`, `fromWire` in [`src/shared/result.ts`](../../../src/shared/result.ts) · tests: [`result.test.ts`](../../../src/shared/result.test.ts) (including the oxide cloning pitfall)

Used for: IPC handlers (main ↔ renderer), worker messages, the agent API response, CLI `--json` output.

**No stack outside the app.** Data that leaves the app or is kept as data – agent and CLI results, job outcomes (`job.get`/`job.wait`), the action log, per-operation failures of `plan.toolpath.generate`, the evaluation status of `design.part.evaluate` – carries `AppError.toWireData()` / `toDataWire(result)`: `toJSON()` without `stack` at every level of `cause` (stacks hold install paths and are noise for a model). Logs, IPC to the renderer and worker messages keep the stack; a toolpath worker logs a failed generation whole, since the job keeps it only as data. `T` itself must be a DTO, not a model instance (see [migrations.md](migrations.md) for `toDTO()`).
