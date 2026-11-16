# 0002 – oxide.ts for Result and Option

Status: accepted (library choice) · Date: 2026-11-16

## Context

We want function signatures to state failure and absence explicitly, and errors to carry rich, enriched context ([principles.md §4](../principles.md#4-explicit-errors-result-option-apperror-invariant-models)).

## Decision

Use [`oxide.ts`](https://www.npmjs.com/package/oxide.ts) for Rust-style `Option<T>` and `Result<T, E>`, combined with an app-specific `AppError`.

## Consequences

- Usage patterns, `AppError` shape and helpers are defined in [conventions/error-handling/](../conventions/error-handling/README.md); the dependency is pinned to `1.1.0` and wrapped by [`src/shared/result.ts`](../../src/shared/result.ts).
