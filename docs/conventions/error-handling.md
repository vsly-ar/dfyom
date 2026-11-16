# Error handling: Result, Option, AppError, invariant models

Status: **draft – research pending. Do not use in code until this doc is accepted.**
Principle: [principles.md §4](../principles.md#4-explicit-errors-result-option-apperror-invariant-models) · Library: [oxide.ts](https://www.npmjs.com/package/oxide.ts) ([ADR 0002](../decisions/0002-oxide-ts-result-option.md))

This document captures the intended pattern; the research tasks below must be completed and the scenarios filled in with real code examples before acceptance.

## Intended pattern

1. **Return types are contracts.** Functions that can fail return `Result<T, AppError>`; functions that may have no value return `Option<T>`. Exceptions do not cross function boundaries except inside model constructors (below) and at third-party boundaries.
2. **`AppError`** – one app-specific error type with a classification (code/kind), a human message, a cause chain, and a structured context bag. It is **enriched** while travelling up the chain:
   - Low level: a model detects a violated invariant (e.g. negative chamfer radius) → returns the original error.
   - Higher levels add what they know (which operation, which part, inputs).
   - Top level (UI action, agent API call, CLI command) adds the entry point and arguments before handing the error to the central error handler / logger ([logging.md](logging.md)).
3. **Invariant models.** Models have a **private constructor** that validates invariants and **throws**. A **static factory** calls the constructor, catches, classifies the error into an `AppError` and returns `Result<Model, AppError>`. Consequently an invalid model instance cannot exist.

## Research tasks (before acceptance)

- [ ] Evaluate `oxide.ts` API surface (match, map/andThen, async Results, `Result.safe`), bundle size, maintenance status, TS strictness compatibility.
- [ ] Define the `AppError` shape (codes taxonomy, context typing, serialization across IPC / to agents / to logs, cause chain, user-facing vs. developer messages).
- [ ] Decide how constructor invariant errors are classified (dedicated `InvariantError` thrown internally?).
- [ ] Helper functions: enrich/`withContext`, wrapping third-party throwing APIs, combining multiple Results (validation of many fields), async pipelines, converting to UI messages.
- [ ] Interop with React (error boundaries, form validation), workers, IPC, logging.

## Scenarios to document (with code examples)

- [ ] Creating a model from user input (form) – showing field-level errors.
- [ ] Creating a model from persisted data – **migrations**: versioned schemas, migrating old data step by step, each step returning `Result`, and what happens when a model's invariants become stricter.
- [ ] Updating a model (immutable `with…` methods returning `Result`).
- [ ] Composing results across a call chain with enrichment at each level.
- [ ] Top-level handling: UI action, agent API call, CLI command.
- [ ] Wrapping throwing third-party code and Node/Electron APIs.
- [ ] Async/long-running operations in workers (abort → error kind?).
- [ ] Testing: asserting on `Result`s and `AppError` codes.
