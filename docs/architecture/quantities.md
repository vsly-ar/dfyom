# Quantities: units, tolerances and expressions

Status: draft · Terms: [glossary.md](../glossary.md) · Models: [error-handling/models.md](../conventions/error-handling/models.md)

Every dimensional input (lengths, angles, feeds, speeds, …) is a **quantity**: an immutable value object, not a bare `number`.

## Value

A quantity keeps what the user entered and derives everything else from it.

| Part        | Example                    | Purpose                                                            |
| ----------- | -------------------------- | ------------------------------------------------------------------ |
| Source      | `1/16"`, `3.175 mm`, `D/2` | Exactly what was entered; shown back to the user as entered.       |
| Exact value | rational 1/16 in `in`      | Lossless value (bigint numerator/denominator) in the entered unit. |
| Canonical   | 1.5875 (float64, mm)       | Derived; used by geometry and toolpaths.                           |
| Tolerance   | see below                  | Optional; untoleranced values inherit one.                         |

Why not integer µm/nm storage: binary inch fractions are not integers in either (1/16″ = 1587.5 µm; 1/128″ = 198 437.5 nm). Keeping the entered rational is exact for every input, and float64 mm is far more precise than any machine downstream – the geometry layers compute in floating point anyway ([geometry.md](geometry.md)).

Each project has a **unit system** (mm or inch), initialized from a user preference. Every field accepts either unit as typed; computed values are displayed in the project unit system.

Display precision belongs to the **field** (e.g. a length field shows 3 decimals in mm); values entered as fractions are displayed as fractions.

## Tolerance

| Kind                        | Notation        | Meaning                                                                                            |
| --------------------------- | --------------- | -------------------------------------------------------------------------------------------------- |
| Untoleranced                | `10`            | **General tolerance** applies, inherited from the nearest of operation → feature → part → project. |
| Symmetric                   | `10 ±0.05`      | Equal deviation both ways.                                                                         |
| Bilateral (unequal)         | `10 +0.1/−0.05` | Different upper and lower deviations; unilateral is the case where one is 0.                       |
| Limit dimensions (proposed) | `9.95–10.1`     | Min/max stated directly.                                                                           |

Not used: **basic dimension** – in GD&T it means a theoretically exact value toleranced by a feature control frame, which DFYOM does not model. ISO 286 fits (`H7`) may be added later.

## Expressions and references

A quantity may be a simple formula over references:

- project variables (`wall_thickness`),
- surfaces of operations, including their tolerance limits (`pocket1.floor.z`, `pocket1.floor.z.max`) – surface ids: [geometry.md](geometry.md#surfaces-and-stable-ids),
- tool parameters (`tool.diameter`, `tool.flute_length`),
- machine variables (`machine.travel.z`).

Rules:

- Parsed by our own small parser in `src/core` – never `eval`.
- References form a **dependency graph**; cycles are rejected with an `AppError`.
- Units are checked dimensionally (length + angle is an error).
- Tolerance propagates worst-case through `+` and `−`; other operators: open question.

## Open questions

- Which arithmetic operators and functions the expression language has.
- Tolerance propagation beyond addition/subtraction.
- Whether a value may override the field's display precision.
- DTO shape (to be defined as a Zod schema in `src/core` with a link back here).
