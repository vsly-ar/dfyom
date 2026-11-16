# Invariant models

Status: draft – ready for review · Part of [error handling](README.md) · Code blocks are the [reference design](README.md#reference-design)

Models whose private constructor enforces invariants, created only through a static factory returning `AppResult`. Plus the model-centric scenarios: forms, updates, many inputs.

## Helpers

```ts
// → src/shared/model.ts
/** Thrown ONLY inside private model constructors; never escapes construct(). */
export class InvariantViolation extends Error {
  override readonly name = 'InvariantViolation'
  constructor(
    readonly model: string,
    readonly issues: readonly Issue[],
  ) {
    super(
      `${model}: ${issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
    )
  }
}

export interface InvariantChecker {
  check(
    ok: boolean,
    path: IssuePath,
    rule: string,
    message: string,
    params?: Record<string, unknown>,
  ): void
}

/** Runs ALL checks, then throws one InvariantViolation listing every failure. */
export function invariants(model: string, body: (c: InvariantChecker) => void): void {
  const issues: Issue[] = []
  body({
    check(ok, path, rule, message, params) {
      if (!ok)
        issues.push(
          params === undefined ? { path, rule, message } : { path, rule, message, params },
        )
    },
  })
  if (issues.length > 0) throw new InvariantViolation(model, issues)
}

/** Body of every static create(): calls the private constructor and classifies what it throws. */
export function construct<T>(model: string, build: () => T): AppResult<T> {
  try {
    return Ok(build())
  } catch (cause) {
    if (cause instanceof InvariantViolation) {
      return Err(
        new AppError('model.invariant', cause.message, {
          issues: cause.issues,
          where: `${model}.create`,
          cause,
        }),
      )
    }
    if (cause instanceof AppError) return Err(cause.withContext(`${model}.create`))
    // Anything else is a bug in the constructor (TypeError, RangeError, …).
    return Err(
      new AppError('internal.unexpected', `${model} constructor threw unexpectedly`, {
        where: `${model}.create`,
        cause,
      }),
    )
  }
}
```

Classification table:

| Thrown in constructor                                       | Becomes                                               |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `InvariantViolation` (via `invariants()`)                   | `model.invariant` with all `issues`                   |
| `AppError` (rare: constructor calls helper that throws one) | same error + frame `Model.create`                     |
| anything else (`TypeError`, …)                              | `internal.unexpected` (bug), original kept as `cause` |

## A simple model

```ts
export interface ChamferProps {
  readonly angleDeg: number
  readonly sizeMm: number
}

export class Chamfer {
  private constructor(
    readonly angleDeg: number,
    readonly sizeMm: number,
  ) {
    invariants('Chamfer', (c) => {
      c.check(
        Number.isFinite(angleDeg) && angleDeg > 0 && angleDeg < 90,
        ['angleDeg'],
        'range',
        'must be between 0° and 90° (exclusive)',
        { min: 0, max: 90, actual: angleDeg },
      )
      c.check(
        Number.isFinite(sizeMm) && sizeMm > 0,
        ['sizeMm'],
        'positive',
        'must be greater than 0',
        { actual: sizeMm },
      )
    })
    Object.freeze(this)
  }

  static create(p: ChamferProps): AppResult<Chamfer> {
    return construct('Chamfer', () => new Chamfer(p.angleDeg, p.sizeMm))
  }

  with(patch: Partial<ChamferProps>): AppResult<Chamfer> {
    return Chamfer.create({ ...this.toDTO(), ...patch })
  }

  toDTO(): ChamferProps {
    return { angleDeg: this.angleDeg, sizeMm: this.sizeMm }
  }
}
```

Model rules:

- Constructor is `private`; parameters are already-typed values (or already-constructed child models). Only `create()` (and other static factories such as `fromDTO()`) call it.
- `invariants()` checks **every** rule (not first-fail), so a form can show all problems at once. `rule` is a stable id; `params` carries numbers the UI/agent can use (recommended range, actual value).
- Guard numbers with `Number.isFinite`: `Infinity` passes `> 0`, and `NaN` only fails by accident (every comparison is false) – make the intent explicit.
- Instances are **immutable** (`readonly` + `Object.freeze`). Changes go through `with()` → `create()`, so invariants are re-checked on every change.
- Constructors do no I/O and no expensive computation; derived heavy data is computed lazily or by services.
- Invariants are **domain rules** (angle < 90°). Machine/tool-dependent limits (max depth for _this_ tool) are **not** invariants; they are checks in the plan layer returning `AppResult`.

## Composite models

Children are created first (collecting all child issues with prefixed paths); the parent constructor only receives valid children and checks cross-field rules.

```ts
export class EdgeTreatment {
  private constructor(
    readonly chamfers: readonly Chamfer[],
    readonly maxTotalMm: number,
  ) {
    invariants('EdgeTreatment', (c) => {
      const total = chamfers.reduce((s, ch) => s + ch.sizeMm, 0)
      c.check(
        total <= maxTotalMm,
        ['chamfers'],
        'maxTotal',
        `total chamfer size ${total} mm exceeds ${maxTotalMm} mm`,
        { total, maxTotalMm },
      )
    })
  }

  static create(p: {
    chamfers: readonly ChamferProps[]
    maxTotalMm: number
  }): AppResult<EdgeTreatment> {
    const children = collect(
      p.chamfers.map((c, i) => Chamfer.create(c).mapErr((e) => e.prefixIssues('chamfers', i))),
    )
    if (children.isErr()) return children
    return construct('EdgeTreatment', () => new EdgeTreatment(children.unwrap(), p.maxTotalMm))
  }
}
```

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
