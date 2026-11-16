# Error handling: Result, Option, AppError, invariant models

Status: **draft – ready for review** (accept to start implementing)
Principle: [principles.md §4](../../principles.md#4-explicit-errors-result-option-apperror-invariant-models) · Decisions: [ADR 0002 oxide.ts](../../decisions/0002-oxide-ts-result-option.md), [ADR 0004 Zod](../../decisions/0004-zod-for-shape-validation.md) · Logging side: [logging.md](../logging.md)

Start here. This page has the rules and the map; each topic lives in its own file.

## Map

| File                           | Read it when you…                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| [library.md](library.md)       | want to know what oxide.ts offers, its verified pitfalls and risks, or performance limits                   |
| [app-error.md](app-error.md)   | create or enrich an error, add an error code, send an error across a boundary                               |
| [helpers.md](helpers.md)       | need a helper (`fail`, `ctx`, `tryCatch`, `collect`, `parseWith`, …), parse untrusted data, or write tests  |
| [models.md](models.md)         | write a model, validate a form, update a model, validate many inputs                                        |
| [boundaries.md](boundaries.md) | write a service/command chain, a UI handler, agent tool, CLI command, automation, worker or cancellable job |
| [migrations.md](migrations.md) | load/save persisted data or change a persisted shape                                                        |

## Rules

1. A function that can fail returns `AppResult<T>` (= `Result<T, AppError>`). Async: `Promise<AppResult<T>>` (alias `AsyncAppResult<T>`).
2. A function that may have no value returns `Option<T>`. Plain `T | undefined` is fine for optional **properties** (DTOs, React props).
3. **Never throw** – except (a) inside a model's private constructor, (b) bugs. Third-party throwing code is wrapped with `tryCatch` / `tryAsync` at the call site.
4. Models: **private constructor checks invariants and throws; static `create()` returns `AppResult<Model>`** via `construct()`. An invalid instance cannot exist.
5. Untrusted data (files, IPC, agent input, devices) is shape-checked with **Zod** (`parseWith`) before it reaches a model. Schemas check shape; models check domain rules.
6. Every layer that knows something useful **enriches** the error: `.mapErr(ctx('where', { data }))`. The entry point (UI / agent / CLI / automation) wraps the chain with `atBoundary()`, which adds the action name + args and reports the error **once**.
7. `Result`/`Option` values **never cross a process/thread/JSON boundary** – convert with `toWire()` / `fromWire()`.
8. Import from `src/shared/result`, **never from `oxide.ts` directly**.
9. Never use `Option.from` / `Result.from` / `Result(x)` on numbers or strings (`0` and `""` become `None`/`Err`).
10. `unwrap()` / `expect()` only (a) right after an `isOk()`/`isErr()` check in the same scope, (b) in tests.

## How the pieces fit

```text
 entry point (UI action / agent tool / CLI / automation)
   └─ atBoundary(entry, run, report)        adds "ui:design.chamfer.apply" + args, reports once
        └─ service / command                 .mapErr(ctx('addChamferToPart', { partId }))
             └─ Model.create(props)          construct(): classify → AppError, frame 'Chamfer.create'
                  └─ private constructor     invariants(): throws InvariantViolation(issues)
```

Errors are created at the bottom with a **code** and **issues**, collect **context frames** on the way up, and are **handled once** at the top (logged, shown to the user, returned to the agent).

## Don'ts

| Don't                                                 | Do instead                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `throw` in services, commands, UI handlers            | `return fail(...)`                                             |
| `try/catch` around app code to "be safe"              | Let Results propagate; only `atBoundary` catches stray throws. |
| `Option.from(depth)`, `Result(x)`                     | `Some(depth)`, `Option.nonNull(x)`                             |
| `unwrap()` without a preceding check                  | early return, `unwrapOr`, `match`                              |
| Log and return the same error                         | Return it; the boundary logs once.                             |
| Send `Ok(...)`/`Some(...)` via IPC/`postMessage`/JSON | `toWire()` / DTOs                                              |
| `import … from 'oxide.ts'`                            | `import … from '@/shared/result'` (or relative path)           |
| Cast untrusted JSON (`raw as Dto`)                    | `parseWith(DtoSchema, raw, where)`                             |
| Duplicate domain rules in Zod schemas                 | Keep them in model invariants                                  |
| Inline new error-code strings                         | Add to `ERROR_CODES` first                                     |
| Put large data (meshes, toolpaths) in frames          | ids + sizes                                                    |
| Make machine-specific limits model invariants         | Plan-layer checks returning `AppResult`                        |

## Adopting the pattern in existing code

1. Wrap at the edge first: callers use `tryCatch(() => legacy(), code, msg)`, so new code gets Results immediately.
2. Convert the module bottom-up: leaf functions return `AppResult` first; callers switch to early-return; remove the edge wrapper last.
3. Convert a plain class to an invariant model by adding `static create()`, making the constructor `private`, and fixing all `new X(` call sites (the compiler lists them).
4. One module per commit; tests for the module's error codes are added in the same commit.

## Reference design

Code blocks in these files are the **reference design**. They were compiled and tested (18 tests) against `oxide.ts@1.1.0`, `zod@4.6.7` and TypeScript 7.0.2 with this repo's `tsconfig.base.json`, on 2026-11-16. Once a block is implemented in `src/`, **replace it with a link to the file** ([documentation.md rule 3](../documentation.md#rules)).

## Decisions

| #   | Question                                          | Status                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Schema library for shape checks of untrusted data | **Decided: Zod 4** – [ADR 0004](../../decisions/0004-zod-for-shape-validation.md)                                                                                                                                                        |
| 2   | Logging integration                               | Boundary reporter logs `toJSON()` at `severity`; library choice in [logging.md](../logging.md).                                                                                                                                          |
| 3   | Lint enforcement                                  | Open. When ESLint is added: ban `oxide.ts` imports outside `src/shared/result.ts`, ban `Option.from`/`Result.from`, `no-restricted-syntax` for `ThrowStatement` outside constructors/`src/shared`. Custom rule for unused Results later. |
| 4   | Localization of `userMessage` / issue messages    | Open. English now; `rule` + `params` are stable so i18n keys can be derived later.                                                                                                                                                       |
| 5   | Agent API error contract                          | Open. `ResultWire` as defined in [app-error.md](app-error.md#serialization); confirm when [llm-api.md](../../architecture/llm-api.md) is designed.                                                                                       |

## Implementation checklist

When this doc set is accepted:

- [ ] `npm i oxide.ts@1.1.0 zod@^4.6.7` (oxide.ts pinned exactly).
- [ ] `src/shared/errors/codes.ts`, `src/shared/errors/app-error.ts` – [app-error.md](app-error.md)
- [ ] `src/shared/result.ts`, `src/shared/parse.ts`, `src/shared/testing/result.ts` – [helpers.md](helpers.md)
- [ ] `src/shared/model.ts` – [models.md](models.md#helpers)
- [ ] `src/shared/boundary.ts` – [boundaries.md](boundaries.md#entry-points-ui-agent-cli-automation)
- [ ] Tests ported from the prototype (invariants, composite, enrichment, serialization pitfalls, abort, parsing, migrations, boundary).
- [ ] Replace each code block with a link to the implementing file; keep rules, tables and scenarios.
- [ ] Set status to `implemented` in every file here and in [docs/README.md](../../README.md).
