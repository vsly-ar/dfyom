# oxide.ts: research findings

Status: implemented · Part of [error handling](README.md)

What `oxide.ts@1.1.0` offers, how it behaves, its risks, and performance guidance. Source: the published package (`dist/*.d.ts`, `dist/*.js`) and runtime experiments.

## API we use

| Area               | Members                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Construct          | `Ok(v)`, `Err(e)`, `Some(v)`, `None`, `Option.nonNull(v)`, `Result.nonNull(v)`                                                               |
| Inspect            | `isOk()`, `isErr()`, `isSome()`, `isNone()` (type guards)                                                                                    |
| Transform          | `map`, `mapErr`, `andThen`, `orElse`, `mapOr`, `mapOrElse`, `filter`, `flatten`, `ok()` (Result→Option), `okOr` / `okOrElse` (Option→Result) |
| Extract            | `unwrap`, `unwrapErr`, `unwrapOr`, `unwrapOrElse`, `expect`, `intoTuple()` (`[null, T] \| [E, null]`)                                        |
| Combine            | `Result.all(...rs)` / `Option.all` (short-circuit on first Err/None), `Result.any`                                                           |
| Wrap throwing code | `Result.safe(fn, ...args)` / `Result.safe(promise)` → `Result<T, Error>` (non-Error throws become `new Error(String(x))`)                    |
| Pattern matching   | `match(value, { Ok: …, Err: … })` (also nested patterns)                                                                                     |

## Verified behaviours

Verified against `oxide.ts@1.1.0` with TypeScript 7.0.2 on 2026-11-16. The pitfalls we guard against at runtime (cloning, `Option.from(0)`) are pinned by tests in [`result.test.ts`](../../../src/shared/result.test.ts), so a library upgrade that changes them fails CI.

| Behaviour                                                                                  | Consequence for us                                                                                                     |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Early return `if (r.isErr()) return r` typechecks even when the function's Ok type differs | The main propagation style ([boundaries.md](boundaries.md#call-chain-enrichment)).                                     |
| `intoTuple()` destructuring narrows (`if (e !== null) return Err(e)`)                      | Allowed alternative; prefer `isErr()` for consistency.                                                                 |
| `andThen` requires the **same** `E`                                                        | Fine: we always use `AppError`.                                                                                        |
| `Option.from(0)` → `None`, `Result.from('')` → `Err` (falsy = missing)                     | **Banned** for numbers/strings – a 0 mm depth is valid data. Use `Some`, `Option.nonNull`.                             |
| `JSON.stringify(Some(5))` → `"{}"`; `structuredClone(Ok(1))` → `{}`, **silently**          | Never send Result/Option over IPC, `postMessage`, JSON. Use `ResultWire` ([app-error.md](app-error.md#serialization)). |
| Identity uses module-local `Symbol('T')` (not `Symbol.for`)                                | Two bundled copies of oxide.ts in one realm would not recognize each other's values → keep a single import site.       |
| No async combinators (`mapAsync`, `ResultAsync`)                                           | Use `async` functions returning `AsyncAppResult<T>` + early return; `tryAsync` helper.                                 |
| `Result.safe` loses the original non-Error value and any classification                    | We use our own `tryCatch`/`tryAsync`, which keep `cause` and assign an error code.                                     |

## Risks and mitigations

| Risk                                                                                                                     | Mitigation                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Last release Oct 2022 (no maintenance activity). Small (~100 kB unpacked, zero deps, CJS build that Vite consumes fine). | All usage goes through `src/shared/result.ts`; swapping to another library (e.g. `neverthrow`, `ts-results-es`) touches one file plus call-site method names. Re-evaluate if a bug or TS incompatibility appears. |
| No lint rule for "ignored Result" (unlike `no-floating-promises`)                                                        | Return types are annotated explicitly; code review; candidate custom ESLint rule ([README.md](README.md#decisions)).                                                                                              |

## Performance

- Result/Option are small class instances; fine for per-operation/per-call use.
- **Do not use them in hot inner loops** (toolpath point generation, simulation voxels): validate inputs once at the entry of the heavy routine, run the loop on plain values, return a single `AppResult` at the end.
- `AppError` captures a stack (relatively expensive) – errors should be exceptional, not a control-flow signal in tight loops. For "search miss" use `Option`.
- `withContext` copies; chains are short (≈3–6 frames), so cost is negligible.
