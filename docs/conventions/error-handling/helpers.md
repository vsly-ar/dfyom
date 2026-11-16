# Helpers

Status: implemented · Part of [error handling](README.md)

Ready-made functions for Results, Options, AppErrors, parsing untrusted data, wrapping throwing code, and tests.

All in `src/shared/result.ts` (Result/Option/AppError helpers), `src/shared/parse.ts` (Zod), `src/shared/model.ts` (invariant helpers), `src/shared/boundary.ts` (entry points). Re-exports: `Ok`, `Err`, `Some`, `None`, `Option`, `Result` from oxide.ts.

| Helper                                        | Signature                                  | Use when                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppResult<T>` / `AsyncAppResult<T>`          | types                                      | Every fallible return type.                                                                                                                          |
| `fail(code, message, opts?)`                  | `→ Result<never, AppError>`                | Returning a new error: `return fail('persist.io', 'cannot read', { cause, data: { path } })`.                                                        |
| `ctx(where, data?)`                           | `→ (e) => AppError`                        | Enriching: `.mapErr(ctx('Plan.addSetup', { planId }))`.                                                                                              |
| `tryCatch(fn, code, message)`                 | `→ AppResult<T>`                           | Calling throwing sync code (`JSON.parse`, third-party libs). Thrown `AppError`s pass through.                                                        |
| `tryAsync(fn, code, message)`                 | `→ AsyncAppResult<T>`                      | Same for promises; `AbortError` → `op.aborted`.                                                                                                      |
| `collect(results)`                            | `AppResult<T>[] → AppResult<T[]>`          | Validating many inputs: merges **all** `model.invariant` issues (forms). Other codes short-circuit. Use `Result.all` when the first error is enough. |
| `parseWith(schema, raw, where)`               | `→ AppResult<z.output<S>>`                 | Shape-checking untrusted data with Zod ([below](#parsing-untrusted-data-zod)).                                                                       |
| `toWire` / `fromWire`                         | [app-error.md](app-error.md#serialization) | Crossing a process/thread/JSON boundary.                                                                                                             |
| `invariants(model, c => …)`                   | throws `InvariantViolation`                | Inside private constructors only.                                                                                                                    |
| `construct(model, () => new M(…))`            | `→ AppResult<M>`                           | The body of every `static create()`.                                                                                                                 |
| `atBoundary(entry, run, report)`              | `→ Promise<AppResult<T>>`                  | Top of every chain ([boundaries.md](boundaries.md#entry-points-ui-agent-cli-automation)).                                                            |
| `summarizeArgs(args)`                         | `→ unknown`                                | Used by `atBoundary`; reusable for logs.                                                                                                             |
| Test: `expectOk(r)`, `expectErrCode(r, code)` | [below](#testing)                          | Tests.                                                                                                                                               |

Implementation: [`src/shared/result.ts`](../../../src/shared/result.ts) · tests: [`result.test.ts`](../../../src/shared/result.test.ts)

## Parsing untrusted data (Zod)

Decision: [ADR 0004](../../decisions/0004-zod-for-shape-validation.md). Every value from outside the process – files, IPC payloads, agent tool arguments, MCU messages – is shape-checked with a Zod schema before use.

**Shape vs. invariants:** the schema checks _structure and types_ (required fields, number vs. string, enums). Domain rules (angle < 90°, total chamfer ≤ max) live **only** in the model's invariants ([models.md](models.md)) – don't duplicate them in schemas. Parse first, then `Model.create(dto)`.

Implementation: [`src/shared/parse.ts`](../../../src/shared/parse.ts) · tests: [`parse.test.ts`](../../../src/shared/parse.test.ts)

- Zod issues become `AppError.issues` with full paths (`chamfer.angleDeg`), so forms, agents and logs read them the same way as invariant issues.
- DTO types are derived from schemas (`type ChamferDTO = z.infer<typeof ChamferDTO>`) – the schema is the contract.
- The same schemas generate the agent API's JSON Schemas via `z.toJSONSchema()` ([llm-api.md](../../architecture/llm-api.md)).

## Wrapping throwing code

```ts
const parsed = tryCatch(
  () => JSON.parse(text) as unknown,
  'input.malformed',
  'file is not valid JSON',
)
const data = await tryAsync(
  () => fs.readFile(path, 'utf8'),
  'persist.io',
  'cannot read project file',
)
```

Wrap **at the call site** of the throwing API (so `where`/data are specific), not in a generic adapter far away.

## Testing

- Assert on **codes, issue paths and rules**, never on message text.
- Every model gets tests for each invariant (valid boundary, invalid boundary, multiple issues at once).
- Every migration step gets a fixture test; plus "newer version refused" and "malformed" tests.
- Test helpers (`src/shared/testing/result.ts`): `expectOk(r): T` (fails the test with the full `AppErrorData` if `Err`) and `expectErrCode(r, code): AppError`.
