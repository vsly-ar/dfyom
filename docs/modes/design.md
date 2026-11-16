# Design mode

Status: draft · Terms: [glossary.md](../glossary.md)

**Goal:** design parts that can be manufactured on the user's existing machines (DFM-first).

## Workflow

1. Pick a **stock** from the stock library.
2. Define a **working area** in it.
3. Add **operations** (facing, pocketing, drilling, profiling, chamfering, cutting a straight line / curve / shape, …) or **features** (groups of operations, e.g. a bolt hole = several drilling ops + pocketing + chamfering + threading; engraving/carving = many operations).
4. Optionally import a 3D model (not necessarily CAD) **for reference only**.

## Generalized tools

Operations specify tool _requirements_, not concrete tools. Examples:

- Facing: "either a fly cutter or any finishing end mill ≥ 1/4″".
- Chamfering: almost any tool able to produce a smooth surface with its side or bottom, as long as the specified angle is achievable.

Concrete tools are chosen in [plan mode](plan.md).

## Tolerances and references

- Every operation and surface carries a **tolerance** – loose by default.
- Every operation/surface may carry **references** – part zero by default.

## Cutouts

Cutout operations (profile, straight/curved line and shape cuts) may include **tabs**.

## Open questions

- Data model for operations vs. features (composition, parameter inheritance).
- How generalized tool requirements are expressed and matched against tool libraries.
- Geometry kernel / representation (see future ADR).
