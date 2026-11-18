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

`AppError extends Error`, so stack traces, `cause`, React error boundaries and logging libraries work natively. It is immutable: `withContext()` and `prefixIssues()` return copies.

Implementation: [`src/shared/errors/app-error.ts`](../../../src/shared/errors/app-error.ts) · tests: [`app-error.test.ts`](../../../src/shared/errors/app-error.test.ts)

## Error code registry

One `as const` object is the **single list of codes**. Codes are `area.reason`, stable (agents and tests depend on them), and added here before use – never invented inline.

Implementation: [`src/shared/errors/codes.ts`](../../../src/shared/errors/codes.ts)

Run mode added `machine.error`, `machine.alarm` and `run.*` ([run-v0.1.md](../../modes/run-v0.1.md#stop-errors-and-alarms)). Expected future areas (add when the feature's doc is written): more `machine.*` (limit), `device.*` (MCU/sensor), `plan.*` (collision, unreachable, tool not found), `geometry.*`, `script.*`, `agent.*` (permission denial is `permission.denied`, [commands.md](../../architecture/commands.md#dispatcher-pipeline)).

## Enrichment rules

- **Create** at the lowest level that detects the problem, with `where` = `Module.function` and the data needed to understand it.
- **Enrich** only with information the lower level did not have (ids, the user's intent, which item in a loop). Don't add a frame that just repeats the function name with no data.
- **Data must be small and serializable** – ids, numbers, short strings. No geometry blobs, no class instances. `atBoundary` truncates args above 2 000 chars.
- **No secrets** in frames (credentials, tokens).
- **Change the code only when the meaning changes** (e.g. `persist.io` "file not found" while loading a library may become a domain-specific code). Keep the original as `cause`.

## Serialization

`AppError.toJSON()` → `AppErrorData` (plain object, `structuredClone`- and JSON-safe). Results crossing a boundary use a wire union:

Implementation: `ResultWire`, `toWire`, `fromWire` in [`src/shared/result.ts`](../../../src/shared/result.ts) · tests: [`result.test.ts`](../../../src/shared/result.test.ts) (including the oxide cloning pitfall)

Used for: IPC handlers (main ↔ renderer), worker messages, the agent API response, CLI `--json` output. `T` itself must be a DTO, not a model instance (see [migrations.md](migrations.md) for `toDTO()`).
