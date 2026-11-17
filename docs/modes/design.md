# Design mode

Status: accepted · Library: [library.md](../architecture/library.md) · Terms: [glossary.md](../glossary.md) · Geometry: [geometry.md](../architecture/geometry.md) · Values: [quantities.md](../architecture/quantities.md) · Commands: [commands.md](../architecture/commands.md)

**Goal:** design parts that can be manufactured on the user's existing machines (DFM-first).

Sections marked **v0.1** define the operations of [roadmap v0.1](../roadmap.md#v01--25d-basics-to-the-virtual-machine) (task 1.8 of the [plan](../plans/v0.1.md)); the rest is direction for later milestones.

## Workflow

1. Pick a **stock** from the stock library.
2. Define a **working area** in it (v0.1: the whole stock).
3. Add **operations** (facing, pocketing, drilling, profiling, chamfering, cutting a straight line / curve / shape, …) or **features** (groups of operations, e.g. a bolt hole = several drilling ops + pocketing + chamfering + threading; engraving/carving = many operations).
4. Optionally import a 3D model (not necessarily CAD) **for reference only**.

## Generalized tools

Operations specify tool _requirements_, not concrete tools (e.g. facing: "a fly cutter or any flat end mill ≥ 1/4″"). Concrete tools, passes, stepdown/stepover and feeds/speeds (from the tool's [presets](../architecture/library.md#feeds-and-speeds-presets)) are chosen in [plan mode](plan.md).

**Design intent vs. tool choice:** design states the _result_ – radii, depths, diameters, slot width. Plan picks a tool that produces it within tolerance (e.g. a floor fillet: bull-nose end mill in one pass or ball end mill with 3D passes; a hole: drill bit or helical boring with an end mill). Design never names a tool; it only checks that the result is _achievable_ ([DFM checks](#dfm-checks)).

## Tolerances and references

- Every parameter is a [quantity](../architecture/quantities.md) and may carry an explicit tolerance; untoleranced values use the [general tolerance](../architecture/quantities.md#tolerance) of operation → part → project (features: later).
- Surfaces inherit their operation's tolerance in v0.1.
- References: XY positions are in the part frame (below); depths are measured down from the operation's `on` surface.

## Part and stock (v0.1)

- One **part** per project in v0.1; the data model keeps a list of parts, so several parts need no format change later (record `parts/<id>.json`, [persistence.md](../architecture/persistence.md#working-folder-layout)): `{ id, name, stock, generalTolerance?, operations[] }`.
- `stock` is the id of a `block` stock **snapshot** ([library.md](../architecture/library.md#stock)) ([library references](../architecture/persistence.md#library-references)); the stock is the starting body: `part = stock − …` ([geometry.md](../architecture/geometry.md#principle-geometry-comes-from-material-removal)).
- **Part zero** is the top face's front-left corner: X right, Y back, Z up; the stock occupies `0..length × 0..width × −thickness..0`.
- Stock surfaces: `stock.top`, `stock.bottom`, `stock.side[0..3]` (0 = front, then counter-clockwise seen from above).

## Positioning (v0.1)

Each operation has:

- `on`: a horizontal planar surface it starts from – `stock.top` or an earlier operation's floor or tab top (e.g. `facing1.floor`). Default: the last facing's floor, else `stock.top`.
- `shape`: an axis-aligned 2D shape (no rotation in v0.1) in the part frame, given by its center:
  - `rectangle { center: [x, y], length (X), width (Y), cornerRadius }`
  - `circle { center: [x, y], diameter }`

The removal region is the shape extruded from `on.z − depth` up through the stock top (it overshoots, [evaluation rules](../architecture/geometry.md#evaluation-rules)): a 3-axis tool removes everything above the cut.

## Operations (v0.1)

Common to all: `id` (generated, `facing1`, `pocket2`, …; immutable, used in [surface ids](../architecture/geometry.md#surfaces-and-stable-ids)), `name` (display label), optional `generalTolerance` (one `±` per kind). Constraint violations are `model.invariant` errors; DFM warnings never block. Defaults are given as metric / inch – each is the default in a project with that [unit system](../glossary.md).

### Facing

Flattens the top of the stock. v0.1 faces the whole top; `on` is always `stock.top`, there is no `shape`.

| Parameter | Kind   | Default        | Constraints            | DFM warnings                                                                  |
| --------- | ------ | -------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `depth`   | length | 0.5 mm / 1/64″ | > 0; < stock thickness | Depth > 3 mm / 1/8″: "removes a lot of material – check the stock thickness". |

Surfaces: `facing1.floor` (the new top). Tool requirement: flat end mill (incl. surfacing bits).

### Pocket

Blind recess with flat floor; retained regions: inside corner radius and floor fillet ([fillets](../architecture/geometry.md#fillets-as-retained-regions)).

| Parameter            | Kind   | Default     | Constraints                                              | DFM warnings                                                                                               |
| -------------------- | ------ | ----------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `shape`              | –      | required    | rectangle or circle; size > 0                            | Narrowest size < smallest end-mill diameter in the tool library: "no tool fits".                           |
| `depth`              | length | required    | > 0; floor above `stock.bottom`                          | Depth > 4 × narrowest size: "deep, narrow pocket – needs a long tool".                                     |
| `shape.cornerRadius` | length | 3 mm / 1/8″ | rectangle only; 0 ≤ r ≤ min(length, width)/2             | r < radius of the smallest end mill in the library ("no tool can make this corner"); r = 0 always warns.   |
| `floorRadius`        | length | 0           | 0 ≤ f ≤ depth; f ≤ `cornerRadius` (circle: ≤ diameter/2) | f > 0 and the library has no bull-nose end mill with corner radius f and no ball end mill with radius ≤ f. |

Surfaces: `pocket1.floor`, `pocket1.wall[i]` (rectangle: 0 = front, counter-clockwise; circle: `wall[0]`), `pocket1.corner[i]` (corner cylinders, `i` = following wall), `pocket1.floorFillet`. Tool requirement: end mill with radius ≤ `cornerRadius`; for `floorRadius` > 0 as in [geometry.md](../architecture/geometry.md#fillets-as-retained-regions).

### Drilling

One round hole per operation, so every hole has stable surface ids; plan mode groups holes of equal diameter into one drilling pass.

| Parameter    | Kind   | Default    | Constraints                                           | DFM warnings                                                   |
| ------------ | ------ | ---------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| `center`     | –      | required   | point `[x, y]` in the part frame                      | Hole partly outside the stock.                                 |
| `diameter`   | length | required   | > 0                                                   | No drill bit of this diameter and no end mill smaller than it. |
| `bottom`     | –      | `through`  | `through`, `flat` or `drillPoint`                     | –                                                              |
| `depth`      | length | required\* | \*not for `through`; > 0; bottom above `stock.bottom` | Depth > 5 × diameter: "needs pecking or a long drill".         |
| `pointAngle` | angle  | 118°       | `drillPoint` only; 60°–180°                           | –                                                              |

`depth` is measured to full diameter; a `drillPoint` cone lies below it. Surfaces: `drill1.wall`, `drill1.bottom` (not for `through`). Tool requirement: `drill` of `diameter` (within tolerance; its `pointAngle` sets the tip for `drillPoint`), or an end mill < `diameter` by helical boring (`flat` or `through` only).

### Profile with tabs

Through cut along a closed shape (cutout), holding the cut-out piece with **tabs**.

| Parameter        | Kind   | Default      | Constraints                                                                                                                                      | DFM warnings                                                                                    |
| ---------------- | ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `shape`          | –      | required     | rectangle or circle; size > 0                                                                                                                    | Slot leaves the stock: stock margin < `slotWidth` ("tabs hold nothing").                        |
| `side`           | –      | `outside`    | `outside` (shape = part outline) or `inside` (shape = opening)                                                                                   | `inside`: same corner check as a pocket.                                                        |
| `slotWidth`      | length | 6 mm / 1/4″  | > 0                                                                                                                                              | Smaller than the smallest end-mill diameter in the library.                                     |
| `tabs.count`     | scalar | 4            | integer ≥ 0; spaced evenly, first at the middle of `wall[0]` (circle: the front); `inside` with the slot covering the opening: no tabs are built | 0: "the piece comes loose at the last pass".                                                    |
| `tabs.width`     | length | 6 mm / 1/4″  | > 0; all tabs fit on the perimeter                                                                                                               | –                                                                                               |
| `tabs.thickness` | length | 2 mm / 1/16″ | > 0; < stock thickness                                                                                                                           | Evaluation finds a loose piece ([`decompose()`](../architecture/geometry.md#evaluation-rules)). |

The removal region is a slot of `slotWidth` beside the shape (outside it for `outside`, inside for `inside`), through the stock bottom; tabs are its retained regions, measured up from `stock.bottom`. An `inside` profile whose slot covers the whole opening (`slotWidth` ≥ half the narrowest size, within the 0.01 mm chord tolerance) cuts the opening out completely: there is no offcut and no tabs are built (DFM warning `dfm.tabsUnused` when `tabs.count` > 0; [geometry.md](../architecture/geometry.md#building-the-solids)). Surfaces: `profile1.wall[i]`, `profile1.corner[i]` (as for a pocket), `profile1.tab[i].top`, `profile1.tab[i].end[0|1]`. Tool requirement: end mill with diameter ≤ `slotWidth` and enough flute length for the stock thickness.

## Ordering and composition

- Operations form an ordered list per part. Removal composes by union, so the geometry does not depend on the order: `part = stock − ∪ (removal(op) − retained(op))` ([geometry.md](../architecture/geometry.md#principle-geometry-comes-from-material-removal)).
- The order matters for **references only**: `on` and expressions may reference stock surfaces and surfaces of **earlier** operations. This keeps the dependency graph acyclic and the list readable top to bottom.
- A retained region (tab, fillet) inside another operation's removal region is removed; evaluation reports it as a DFM warning ([geometry.md open question](../architecture/geometry.md#open-questions)).
- The design order is not the machining order; plan mode orders passes freely.
- Design edits never change existing plans, except plans in `draft` status ([plan snapshots](plan-v0.1.md#plans-are-snapshots)).
- **Repeat (later):** several identical features (a list of holes, a bolt circle, a row of pockets) are made by a **repeat** feature that instances one operation at several positions, never by list parameters on an operation. This is why drilling has one hole per operation.

## DFM checks

- Derived on every evaluation, never stored: constraint checks (sync, in the command) and geometry checks (worker, [evaluation rules](../architecture/geometry.md#evaluation-rules)). Codes, rules and the warning shape: [geometry.md](../architecture/geometry.md#evaluation-checks) (geometry) and [parameter and tool checks](../architecture/geometry.md#parameter-and-tool-checks) (`parameterChecks`, called by the commands).
- Tool checks compare against the whole **tool library** ([library.md](../architecture/library.md#tool): flat, bull-nose and ball end mills, drills), not a chosen machine. With an empty library only geometric checks run.
- Library edits are non-undoable effect commands outside the project document, so they trigger a re-check but never change the part.
- Each warning names the operation and parameter and suggests a value (e.g. "use cornerRadius ≥ 3.2 mm").

## Commands and queries (v0.1)

Names follow [commands.md](../architecture/commands.md#naming); all are `document` commands, one gesture = one command. Quantities are passed as entered (`"1/16\""`); `Shape` as in [Positioning](#positioning-v01).

| Command                                                                | Args                                                                     | Result            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------- |
| `design.part.add`                                                      | `{ name, stockLibraryItemId }` – takes the stock snapshot                | `{ partId }`      |
| `design.part.update`                                                   | `{ partId, name?, generalTolerance? }`                                   | `{}`              |
| `design.facing.add` / `.pocket.add` / `.drilling.add` / `.profile.add` | `{ partId, name?, on?, …parameters }` – omitted parameters take defaults | `{ operationId }` |
| `design.facing.update` / `.pocket.update` / …                          | `{ partId, operationId, …parameters to change }`                         | `{}`              |
| `design.operation.remove`                                              | `{ partId, operationId }`                                                | `{}`              |
| `design.operation.move`                                                | `{ partId, operationId, toIndex }`                                       | `{}`              |

- v0.1: `design.part.add` fails with `model.invariant` when the project already has a part; `design.drilling.add` adds one hole.
- `remove` and `move` are shared by all operation types. Both fail with `design.referenced` (new error code, task 2.5) if a later operation would reference a removed or later surface; the error lists the dependants.
- Queries: `design.part.get`, `design.operation.list`, `design.warning.list` (DFM warnings of the last evaluation).
- Arg schemas and the operation DTO union live in `src/core/design/` (planned, task 2.5) and link back here.

## Retained regions: tabs and fillets

Cutout operations (profile, straight/curved line and shape cuts) may include **tabs**, and pockets may leave **fillets**. Both use one mechanism – [geometry.md#cutting-operation-framework](../architecture/geometry.md#cutting-operation-framework).

## Carving and engraving (later)

Carving and engraving work from **vectors** (SVG/DXF or drawn paths); raster images are traced to vectors on import. Each operation (engraving, V-carving, vector relief) has a profile and a tolerance; plan mode expands it into passes – [geometry.md#carving-and-engraving-vector-based](../architecture/geometry.md#carving-and-engraving-vector-based).
