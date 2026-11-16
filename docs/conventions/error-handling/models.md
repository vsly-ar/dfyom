# Invariant models

Status: implemented · Part of [error handling](README.md)

Models whose private constructor enforces invariants, created only through a static factory returning `AppResult`. Plus the model-centric scenarios: forms, updates, many inputs.

## Helpers

Implementation: [`src/shared/model.ts`](../../../src/shared/model.ts) · tests: [`model.test.ts`](../../../src/shared/model.test.ts)

Classification table:

| Thrown in constructor                                       | Becomes                                               |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `InvariantViolation` (via `invariants()`)                   | `model.invariant` with all `issues`                   |
| `AppError` (rare: constructor calls helper that throws one) | same error + frame `Model.create`                     |
| anything else (`TypeError`, …)                              | `internal.unexpected` (bug), original kept as `cause` |

## A simple model

Example (`Chamfer`: `private constructor` + `invariants()`, `static create()` via `construct()`, `with()`, `toDTO()`): [`src/shared/testing/chamfer.fixture.ts`](../../../src/shared/testing/chamfer.fixture.ts). It is a test fixture; the real feature models live in `src/core`.

Model rules:

- Constructor is `private`; parameters are already-typed values (or already-constructed child models). Only `create()` (and other static factories such as `fromDTO()`) call it.
- `invariants()` checks **every** rule (not first-fail), so a form can show all problems at once. `rule` is a stable id; `params` carries numbers the UI/agent can use (recommended range, actual value).
- Guard numbers with `Number.isFinite`: `Infinity` passes `> 0`, and `NaN` only fails by accident (every comparison is false) – make the intent explicit.
- Instances are **immutable** (`readonly` + `Object.freeze`). Changes go through `with()` → `create()`, so invariants are re-checked on every change.
- Constructors do no I/O and no expensive computation; derived heavy data is computed lazily or by services.
- Invariants are **domain rules** (angle < 90°). Machine/tool-dependent limits (max depth for _this_ tool) are **not** invariants; they are checks in the plan layer returning `AppResult`.

## Composite models

Children are created first (collecting all child issues with prefixed paths); the parent constructor only receives valid children and checks cross-field rules.

Example: `EdgeTreatment` in [`src/shared/testing/chamfer.fixture.ts`](../../../src/shared/testing/chamfer.fixture.ts).

Child issues come back as `chamfers.1.angleDeg`, `chamfers.1.sizeMm` – directly mappable to form fields. Cross-field rules are only checked once all children are valid (a deliberate two-phase validation).

## Creating a model from user input (forms)

1. Form state holds **raw props** (strings/numbers as typed).
2. On change (debounced) or submit: `Model.create(props)`.
3. `Ok` → enable apply, render the live preview from the model.
4. `Err` with `code === 'model.invariant'` → map `issues` by `path.join('.')` to field messages; use `params` for the recommended-range hint and the dynamic illustration ([principles.md §5](../../principles.md#5-user-friendly-beginner-friendly-highly-graphical)).
5. Any other code → generic error banner via the boundary reporter.

The same `create()` serves the UI form, the agent API and file loading – there is one validation path.

## Updating a model

`model.with(patch)` → `AppResult<Model>`. The old instance stays valid and unchanged (undo/redo friendly).

## Many inputs at once

`collect()` (all invariant issues) vs `Result.all(a, b, c)` (first error, typed tuple). Use `collect` for user-facing validation, `Result.all` for internal composition.
