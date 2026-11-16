# Quantities: units, tolerances and expressions

Status: accepted (task 2.1 implemented; expressions pending) · Terms: [glossary.md](../glossary.md) · Models: [error-handling/models.md](../conventions/error-handling/models.md) · Tasks: [v0.1 plan](../plans/v0.1.md) 2.1 (literals), 2.2 (expressions)

Every dimensional input (lengths, angles, feeds, speeds, …) is a **quantity**: an immutable invariant model, not a bare `number`. Sections up to [Tolerance](#tolerance) are task 2.1; [Expressions](#expressions-and-references) are task 2.2 and do not block 2.1.

## Value

A quantity keeps what the user entered and derives everything else from it.

| Part         | Example                    | Purpose                                                                                            |
| ------------ | -------------------------- | -------------------------------------------------------------------------------------------------- |
| Kind         | length                     | Dimension; fixed by the field ([kinds](#kinds-and-units)).                                         |
| Source       | `1/16"`, `3.175 mm`, `D/2` | Exactly what was entered; **display only** – shown back as entered, never re-parsed on load.       |
| Default unit | `mm`                       | Unit a bare number meant at entry; stored so a later unit-system switch does not change the value. |
| Exact value  | 1/16 in → 127/80 mm        | **Single source of truth.** Bigint rational, normalized (gcd 1, denominator > 0), canonical unit.  |
| Canonical    | 1.5875 (float64, mm)       | Nearest float64 to the exact value; used by geometry and toolpaths.                                |
| Tolerance    | see below                  | Optional; untoleranced values inherit one.                                                         |

Why not integer µm/nm storage: binary inch fractions are not integers in either (1/16″ = 1587.5 µm; 1/128″ = 198 437.5 nm). Every v0.1 unit factor is rational (1 in = 127/5 mm), so the exact value is lossless in the canonical unit; decimals are exact too (`0.1` = 1/10). float64 mm is far more precise than any machine downstream – the geometry layers compute in floating point anyway ([geometry.md](geometry.md)).

**Equality:** `a.equals(b)` ⇔ same kind, equal exact values and equal tolerances (exact upper and lower deviations). Source, default unit and tolerance notation are entry/display data and not compared (`1"` equals `25.4 mm`; `±0.05` equals `+0.05/−0.05`). Never compare canonical floats for quantity equality.

**Model invariants** (`model.invariant`): source length 1–256; the default unit belongs to the kind; the canonical float64 is finite (a persisted exact value beyond float64 range is rejected); plus the [tolerance](#tolerance) and rational invariants.

**Lifecycle:** the source is parsed (literal) or evaluated (expression) only when the user **edits** the value, or when an expression's inputs change. Otherwise the stored exact value is used as is, so a parser change alters an old value only when that value is updated, directly or indirectly. The model does **not** check that source and exact value agree.

Each project has a **unit system** (mm or inch), initialized from a user preference. Every field accepts either unit as typed; computed values are displayed in the project unit system.

Display precision belongs to the **field** only (e.g. a length field shows 3 decimals in mm, 4 in inch); values have no precision override. The UI shows the source and may show the exact value next to it at field precision; computed and converted values use field precision.

## Kinds and units

| Kind           | Canonical | Accepted spellings (alphabetic units are case-insensitive)    | Bare-number default |
| -------------- | --------- | ------------------------------------------------------------- | ------------------- |
| `length`       | mm        | `mm`, `cm`, `m`, `um`/`µm`; `in`/`inch`/`"`/`″`; `ft`/`'`/`′` | project unit        |
| `angle`        | deg       | `deg`/`°`                                                     | deg                 |
| `feedRate`     | mm/min    | `mm/min`; `in/min`/`ipm`                                      | project unit /min   |
| `spindleSpeed` | rpm       | `rpm`                                                         | rpm                 |
| `scalar`       | 1         | none, `%` (= 1/100)                                           | none                |

Persisted unit ids (`defaultUnit`) are `mm cm m um in ft deg mm/min in/min rpm 1 %`; `1` is the dimensionless unit (a bare `scalar`). `µ` is the micro sign U+00B5. Implementation: [`units.ts`](../../src/core/quantity/units.ts).

- A unit of another kind is an error (`mm/min` in a length field). Counts (tabs, passes) are `scalar` fields with an integer field rule.
- Not in v0.1: `rad` (π is not rational), DMS angles, compound feet-inch (`1' 6"`), surface speed, chip load, time.

## Literal grammar (task 2.1)

```ebnf
literal   = ws, value, [ ws, tolerance ], ws ;
value     = [ sign ], magnitude, [ ws, unit ] ;
magnitude = mixed | fraction | decimal ;
mixed     = digits, ws1, fraction ;                (* 1 1/2 *)
fraction  = digits, "/", digits ;                  (* no spaces inside *)
decimal   = digits, [ ".", [ digits ] ] | ".", digits ;
tolerance = pm, ws, dev                            (* ±0.05, +/-0.05 *)
          | sign, dev, ws, "/", ws, [ sign ], dev ; (* +0.1/−0.05, +0.1/0 *)
dev       = magnitude, [ ws, unit ] ;
sign      = "+" | "-" | "−" ;                      (* − is U+2212 *)
pm        = "±" | "+/-" | "+-" ;
digits    = digit, { digit } ;
ws        = { " " | "\t" | U+00A0 } ;  ws1 = ( " " | "\t" | U+00A0 ), ws ;
unit      = (* spellings from the table above *) ;
```

- Decimal separator is `.` only (no locale-dependent `,`); no exponent, no thousands separator.
- `1-1/2"` is rejected with a hint to write `1 1/2"` (it would mean subtraction in an expression).
- Deviations without a unit take the value's unit; the value without a unit takes the field's bare-number default.
- Negative values are syntactically allowed; whether a field accepts them is a field/model rule (e.g. spindle speed > 0).
- Source length ≤ 256 characters (UTF-16 code units, i.e. `string.length`; rule `maxLength`).
- A `unit` token is a run of letters (optionally `letters/letters`, e.g. `mm/min`) or one symbol (`"″'′°%`). Any such token that is not a spelling of the field's kind is a `quantity.unit` error, so `1e3` (exponent) fails as unknown unit `e`.
- `pm` is ASCII `+/-`/`+-` or `±` only (`+/−` with U+2212 is rejected).
- In a deviation pair, `digits/digits` is always read as a fraction (no spaces inside, as in `fraction`): `+1/0` is a zero denominator and `+1/2` lacks the separating `/`. Write `+1 / 0` (spaces) when the upper deviation is an integer; `+0.1/0` needs none.
- Implementation: [`parse.ts`](../../src/core/quantity/parse.ts) (`parseLiteral`), used by `Quantity.parse`.

## Tolerance

| Kind                | Notation        | Meaning                                                                                            |
| ------------------- | --------------- | -------------------------------------------------------------------------------------------------- |
| Untoleranced        | `10`            | **General tolerance** applies, inherited from the nearest of operation → feature → part → project. |
| Symmetric           | `10 ±0.05`      | Equal deviation both ways.                                                                         |
| Bilateral (unequal) | `10 +0.1/−0.05` | Different upper and lower deviations; unilateral is the case where one is 0.                       |

Later: **limit dimensions** (min/max stated directly) – not in v0.1; enter them as deviations. Not used: **basic dimension** – in GD&T it means a theoretically exact value toleranced by a feature control frame, which DFYOM does not model. ISO 286 fits (`H7`) may be added later.

Representation and resolution:

- Stored as `Option<{ notation, upper, lower }>`: exact rational deviations from the nominal, canonical unit; `notation` (`symmetric | deviations`) only drives display.
- Invariants: denominators ≠ 0; `upper ≥ lower`; `±` deviation ≥ 0. Both deviations may share a sign (`−0.02/−0.05`).
- The value object stores **only the explicit tolerance**. The effective tolerance of an untoleranced value is resolved by the design model (`effectiveTolerance(quantity, scope)` walking operation → feature → part → project), never by the quantity itself.
- General tolerance: one symmetric `±` tolerance per kind per scope (e.g. ±0.1 mm, ±0.5°); the nearest scope that sets one wins.
- Implementation: [`tolerance.ts`](../../src/core/quantity/tolerance.ts) (`Tolerance.create`); `Quantity.tolerance` is an `Option<Tolerance>`.

## Expressions and references

A quantity may be a simple formula over references:

- project variables (`wall_thickness`),
- surfaces of operations, including their tolerance limits (`pocket1.floor.z`, `pocket1.floor.z.max`) – surface ids: [geometry.md](geometry.md#surfaces-and-stable-ids),
- tool parameters (`tool.diameter`, `tool.flute_length`),
- machine variables (`machine.travel.z`).

Rules:

- Parsed by our own small parser in `src/core` – never `eval`. Literals inside expressions use the [literal grammar](#literal-grammar-task-21); a fraction token binds tighter than `/`, so `1/16"` is a literal and `D/2` a division.
- v0.1 operators: `+`, `−`/`-`, `*`/`×`, `/`/`÷`, parentheses, unary minus. No functions in v0.1 – arithmetic only.
- A trailing tolerance applies to the whole expression and overrides propagation: `(D/2) ±0.01`.
- References form a **dependency graph**; cycles are rejected with an `AppError`.
- Units are checked dimensionally: `+`/`−` need equal kinds; `×`/`÷` allow quantity × scalar, quantity ÷ scalar and quantity ÷ same kind → scalar. Other products (area, length × rpm → feed) are rejected in v0.1.
- A bare number in `+`/`−` adopts the other operand's kind in the project unit (`D + 0.5` = D + 0.5 mm in a mm project); in `×`/`÷` it is a scalar.
- Tolerance propagates by **worst-case interval arithmetic** for every operator: each operand is the interval [nominal + lower, nominal + upper]; the result's deviations are the result interval minus the nominal result (`a − b`: upper = `a.upper − b.lower`). Untoleranced operands count as exact; a result with no toleranced operand is untoleranced. A divisor interval containing 0 is an error.

## Persistence (DTO)

Implementation in `src/core/quantity/` (each header links here): [`rational.ts`](../../src/core/quantity/rational.ts), [`units.ts`](../../src/core/quantity/units.ts), [`parse.ts`](../../src/core/quantity/parse.ts) (literal grammar), [`tolerance.ts`](../../src/core/quantity/tolerance.ts), [`quantity.ts`](../../src/core/quantity/quantity.ts) (model: `Quantity.parse(source, ctx)` / `create()` / `fromDTO()` → `AppResult`), [`quantity.dto.ts`](../../src/core/quantity/quantity.dto.ts); tests: [`quantity.test.ts`](../../src/core/quantity/quantity.test.ts). Expressions go to `src/core/expression/` (2.2).

```ts
// src/core/quantity/quantity.dto.ts – shape only; domain rules live in Quantity
const RationalDtoSchema = z.object({
  num: z.string().regex(/^-?\d+$/),
  den: z.string().regex(/^\d+$/),
}) // bigint strings
export const QuantityDtoSchema = z.object({
  kind: z.enum(['length', 'angle', 'feedRate', 'spindleSpeed', 'scalar']),
  source: z.string().min(1).max(256), // display only
  defaultUnit: z.enum(UNIT_IDS), // bare-number unit at entry, used when the source is re-parsed after an edit
  exact: RationalDtoSchema, // canonical unit; the value
  tolerance: z
    .object({
      notation: z.enum(['symmetric', 'deviations']),
      upper: RationalDtoSchema,
      lower: RationalDtoSchema,
    })
    .optional(), // explicit tolerance only
})
```

Load: `parseWith(QuantityDtoSchema, …)` → `Quantity.fromDTO()`, which checks the invariants (denominator ≠ 0, tolerance rules) and normalizes the rationals. It does **not** re-parse `source`.

## Error codes

Added to [`codes.ts`](../../src/shared/errors/codes.ts) with the implementing task ([registry rules](../conventions/error-handling/app-error.md#error-code-registry)). All `warn`, not retryable; `issues` carry `rule` and `params` (`{ offset, expected }`) so the input field can mark the position.

2.1 issue rules: `quantity.syntax` – `syntax`, `hyphenatedMixedNumber` (params add `hint`, e.g. `1 1/2"`), `zeroDenominator`, `maxLength`; `quantity.unit` – `unknownUnit`, `unitKind` (`expected` lists the kind's spellings). Their issue path is `[]` (the field itself). `model.invariant` issues use model paths: `exact.den`, `defaultUnit`, `source`, `tolerance.upper|lower` with rules `denominatorNonZero`, `unitKind`, `length`, `finite`, `order`, `symmetric`, `nonNegative`.

| Code                   | Task | When                                                                  |
| ---------------------- | ---- | --------------------------------------------------------------------- |
| `quantity.syntax`      | 2.1  | Source does not match the grammar (incl. `1-1/2"`, zero denominator). |
| `quantity.unit`        | 2.1  | Unknown unit, or unit of another kind than the field.                 |
| `model.invariant`      | 2.1  | Rational/tolerance invariants above; field rules (sign, integer).     |
| `expression.reference` | 2.2  | Unknown reference.                                                    |
| `expression.cycle`     | 2.2  | Dependency cycle.                                                     |
| `expression.dimension` | 2.2  | Kind mismatch or unsupported product (`length + angle`, `mm × mm`).   |
| `expression.domain`    | 2.2  | Division by zero, or a divisor interval that contains 0.              |

## Open questions

None block v0.1. Later, when needed:

- Notation for limit dimensions (e.g. `9.95..10.1`).
- ISO 2768 general tolerance classes (f/m/c/v) instead of a single `±` per kind.
- Expression functions (`min`, `max`, `abs`, …); trig would need `rad` and non-rational values.
