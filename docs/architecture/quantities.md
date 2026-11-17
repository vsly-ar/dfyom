# Quantities: units, tolerances and expressions

Status: implemented (tasks 2.1 and 2.2) · Terms: [glossary.md](../glossary.md) · Models: [error-handling/models.md](../conventions/error-handling/models.md) · Tasks: [v0.1 plan](../plans/v0.1.md) 2.1 (literals), 2.2 (expressions)

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
- `/` starts a `fraction` only when a digit follows it directly; otherwise it is the deviation separator: `+0/-0.05`, `+1/−0.05`, `+0.1/0`.
- In a deviation pair, an upper deviation `digits/digits` is read as a fraction when the rest still forms a pair (`+1/16"/-0`, `+1/2/0`); otherwise it is an integer followed by the separator (`+1/0` = +1/0, not a zero denominator). `+1/2` therefore means upper +1, lower +2 (rejected: `order` invariant). Spaces around the separator (`+1 / 0`) are always unambiguous.
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

- Parsed by our own small parser in `src/core` – never `eval`. Literals inside expressions use the [literal grammar](#literal-grammar-task-21); a fraction token binds tighter than `/`, so `1/16"` is a literal and `D/2` a division. A fraction right after `/` or `÷` (`D/2/5`) is rejected (`ambiguousDivision`, hint `D/(2/5)` or `(D/2)/5`), because reading `2/5` first would break left-associativity.
- v0.1 operators: `+`, `−`/`-`, `*`/`×`, `/`/`÷`, parentheses, unary minus. No functions in v0.1 – arithmetic only.
- A trailing tolerance applies to the whole expression and overrides propagation: `(D/2) ±0.01`.
- References form a **dependency graph**; cycles are rejected with an `AppError`.
- Units are checked dimensionally: `+`/`−` need equal kinds; `×`/`÷` allow quantity × scalar, quantity ÷ scalar and quantity ÷ same kind → scalar. Other products (area, length × rpm → feed) are rejected in v0.1.
- A bare number in `+`/`−` adopts the other operand's kind in the project unit (`D + 0.5` = D + 0.5 mm in a mm project); in `×`/`÷` it is a scalar.
- Tolerance propagates by **worst-case interval arithmetic** for every operator: each operand is the interval [nominal + lower, nominal + upper]; the result's deviations are the result interval minus the nominal result (`a − b`: upper = `a.upper − b.lower`). Untoleranced operands count as exact; a result with no toleranced operand is untoleranced. A divisor interval containing 0 is an error.

### Expression grammar

```ebnf
expression = ws, sum, [ ws, tolerance ], ws ;      (* tolerance: literal grammar, field kind *)
sum        = product, { ws, ( "+" | "-" | "−" ), product } ;
product    = unary, { ws, ( "*" | "×" | "/" | "÷" ), unary } ;
unary      = ws, ( "-" | "−" ), unary | primary ;
primary    = number | reference | "(", sum, ws, ")" ;
number     = magnitude, [ ws, unit ] ;              (* literal grammar; unit of any kind *)
reference  = name, { ".", name } ;  name = ( letter | "_" ), { letter | digit | "_" } ;
```

Decisions made with task 2.2 (conservative where the rules above left room):

- **A valid literal stays a literal.** The field first tries the [literal grammar](#literal-grammar-task-21); only if that fails is the source an expression. So `10+0.1/-0.05` is still 10 with a tolerance. If both fail, the error that got further into the source is reported (ties: the expression's), e.g. `10 mm/min` in a length field stays a `quantity.unit` error.
- **Trailing tolerance:** a tolerance starts at `±` (or `+/-`, `+-`), or at a sign that follows whitespace, is glued to a number (optional unit) and is followed by the pair's `/`: `D +0.1/-0.05`. Such a sign is **never** read as an operator; the tolerance must end the expression, otherwise it is a `quantity.syntax` error `tolerancePosition` (`(D +0.1/-0.05)`, `D ±0.1 * 2`, `D +1/2 * 3`). `D + 0.1`, `D + 1/2` and `D+1/2` are additions. The pair is read exactly as in the literal grammar, so `D +2/1` is upper +2, lower +1 (valid, like `10 +2/1`) and `D -1/2` / `D +1/2` fail the `order` invariant; write `D - 1/2`. Deviation units must be of the field kind; without a unit they take the field's default unit.
- `1-1/2` stays rejected inside expressions (`hyphenatedMixedNumber`) so a mistyped mixed number never silently subtracts; write `D - 1/2`.
- Unary minus only; unary plus (`D * +2`) is a syntax error. A number directly followed by a name (`2D`) is an unknown unit (no implicit multiplication). After a number, `unit/letters` is one unit only when it is a known spelling (`10 mm/min`); otherwise `/` is division (`10 mm/D`).
- **Bare numbers:** `bare × bare`, `bare ÷ bare`, `bare ± bare` and `−bare` stay bare; a bare result takes the field's kind and default unit (`2 * 3` in an inch field = 6 in). A bare number adopting a length or feed rate in `+`/`−` uses the unit system of the field's default unit (`mm`… → mm, `in`/`ft`/`in/min` → inch); in a field whose default unit does not tell (angle, spindle speed, scalar) it is an `expression.dimension` error (`bareNumberUnit`: write the unit, e.g. `(D + 1 mm) / D`). Angle, spindle speed and scalar have one unit each.
- The result must be of the field's kind (`resultKind`); scalar results are not silently given a unit.
- The divisor interval is checked even when a trailing tolerance overrides propagation.
- References resolve to the referenced quantity's exact value and **explicit** tolerance; an untoleranced reference counts as exact (general tolerances are not applied inside expressions).

### Dependency graph

Nodes are value ids, each mapped to the references its expression uses (`referencesOf`). A reference belongs to the node with the longest id that equals it or is a dotted prefix of it, so `pocket1.floor.z.max` depends on node `pocket1.floor.z` (tolerance limits and sub-values cannot bypass cycle detection). `DependencyGraph.create` rejects cycles, including self-references, with `expression.cycle` (issue rule `cycle`, params `{ cycle: [a, b, …, a] }`), and gives the evaluation order (dependencies first; declaration order breaks ties). References owned by no node (tool, machine, other inputs) are external inputs; a changed input also covers its dotted sub-values (`tool` → `tool.diameter`). The traversal is iterative (no recursion limit on long chains). `affectedBy(changed)` lists the transitive dependents of changed values or inputs, in evaluation order – exactly the values to re-evaluate.

### Expression-sourced quantities

An expression-sourced quantity is an ordinary `Quantity` (same model and [DTO](#persistence-dto), no extra field): `source` is the expression as entered, `kind` and `defaultUnit` are the field's, `exact` is the evaluated value, `tolerance` the trailing or propagated one.

- On **edit**: `quantityFromSource(source, ctx, resolver)` – literal or expression, evaluated against a `ReferenceResolver` port (`resolve(name) → Option<Quantity>`; real resolvers for project variables, surfaces, tool and machine come with the design and library models).
- On **load**: nothing is evaluated; the stored exact value is used as is ([lifecycle](#value)).
- On an **input change**: the owner asks the graph what is affected and calls `reevaluate(quantity, resolver)` in that order; it re-parses the stored source with the stored kind and default unit. A literal comes back unchanged.
- Dependencies are extracted by parsing the stored source (not evaluating it); a source the current parser cannot read returns its parse error, and the stored value stays.

## Persistence (DTO)

Implementation in `src/core/quantity/` (each header links here): [`rational.ts`](../../src/core/quantity/rational.ts), [`units.ts`](../../src/core/quantity/units.ts), [`parse.ts`](../../src/core/quantity/parse.ts) (literal grammar), [`tolerance.ts`](../../src/core/quantity/tolerance.ts), [`quantity.ts`](../../src/core/quantity/quantity.ts) (model: `Quantity.parse(source, ctx)` / `create()` / `fromDTO()` → `AppResult`), [`quantity.dto.ts`](../../src/core/quantity/quantity.dto.ts); tests: [`quantity.test.ts`](../../src/core/quantity/quantity.test.ts). Expressions in `src/core/expression/`: [`ast.ts`](../../src/core/expression/ast.ts) (AST, `referencesIn`), [`parse.ts`](../../src/core/expression/parse.ts) (`parseExpression`), [`evaluate.ts`](../../src/core/expression/evaluate.ts) (`evaluate`, `ReferenceResolver`), [`graph.ts`](../../src/core/expression/graph.ts) (`DependencyGraph`), [`quantity.ts`](../../src/core/expression/quantity.ts) (`quantityFromSource`, `reevaluate`, `referencesOf`); tests: [`expression.test.ts`](../../src/core/expression/expression.test.ts), [`graph.test.ts`](../../src/core/expression/graph.test.ts).

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

2.2 issue rules (path `[]`, params `{ offset, … }` at the operator or operand): `expression.reference` – `unknownReference` (`name`); `expression.dimension` – `kindMismatch`, `unsupportedProduct` (`left`, `right`), `resultKind` (`expected`, `actual`), `bareNumberUnit` (`kind`); `expression.domain` – `divisionByZero`, `divisorContainsZero` (`lo`, `hi`); `expression.cycle` – `cycle` (`cycle`, no offset). Expression syntax errors are `quantity.syntax` / `quantity.unit` like literals, plus the `quantity.syntax` rules `tolerancePosition` and `ambiguousDivision` (params add `hint`).

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
