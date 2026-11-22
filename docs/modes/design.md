# Design mode

Status: implemented (v0.1 sections, design UI task 3.6) · Library: [library.md](../architecture/library.md) · Terms: [glossary.md](../glossary.md) · Geometry: [geometry.md](../architecture/geometry.md) · Values: [quantities.md](../architecture/quantities.md) · Commands: [commands.md](../architecture/commands.md)

**Goal:** design parts that can be manufactured on the user's existing machines (DFM-first).

Sections marked **v0.1** define the operations of [roadmap v0.1](../roadmap.md#v01--25d-basics-to-the-virtual-machine) (task 1.8 of the [plan](../plans/v0.1.md)); the rest is direction for later milestones. v0.2 (accepted: face targets on any ±X/±Y/±Z face, placement anchors and the operation tool field) is specified in [design-v0.2.md](design-v0.2.md); the reference model of workflow step 4 in [reference-model.md](reference-model.md).

## Workflow

1. Pick a **stock** from the stock library.
2. Define a **working area** in it (v0.1: the whole stock).
3. Add **operations** (facing, pocketing, drilling, profiling, chamfering, cutting a straight line / curve / shape, …) or **features** (groups of operations, e.g. a bolt hole = several drilling ops + pocketing + chamfering + threading; engraving/carving = many operations). Draft concept: [features.md](features.md) (B23).
4. Optionally import a 3D model (not necessarily CAD) **for reference only**. v0.2: STL, placed and fitted to the stock ([reference-model.md](reference-model.md)).

## Generalized tools

Operations specify tool _requirements_ (e.g. facing: "a fly cutter or any flat end mill ≥ 1/4″"). Concrete tools, passes, stepdown/stepover and feeds/speeds (from the tool's [presets](../architecture/library.md#feeds-and-speeds-presets)) are chosen in [plan mode](plan.md).

**Design intent vs. tool choice:** design states the _result_ – radii, depths, diameters, slot width. Plan picks a tool that produces it within tolerance (e.g. a floor fillet: bull-nose end mill in one pass or ball end mill with 3D passes; a hole: drill bit or helical boring with an end mill), and design checks that the result is _achievable_ ([DFM checks](#dfm-checks)).

**Changed 2026-11-21 (user decision D11):** the v0.1 rule "Design never names a tool" is replaced. Each design operation has a **tool field**, either a generalized tool (type + diameter, e.g. a 1/4″ flat end mill) or a specific library tool, chosen automatically unless the user locks it; Plan resolves it to a concrete tool. Spec: [design-v0.2.md § Operation tool](design-v0.2.md#operation-tool); plan side: [plan-v0.2.md](plan-v0.2.md#tool-resolution-from-the-design-tool-field). The v0.1 implementation still follows the old rule until v0.2 is implemented.

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

- `on`: a horizontal planar surface it starts from – `stock.top` or an earlier operation's floor or tab top (e.g. `facing1.floor`). Default: the last facing's floor, else `stock.top`. (v0.2: any face target with a ±X/±Y/±Z normal, [design-v0.2.md § Face targets](design-v0.2.md#face-targets-generalised-on); positions by a [placement anchor](design-v0.2.md#placement-anchors).)
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

| Parameter        | Kind   | Default      | Constraints                                                                                                                                      | DFM warnings                                                                                                                                              |
| ---------------- | ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shape`          | –      | required     | rectangle or circle; size > 0                                                                                                                    | `outside`: stock margin < `slotWidth` on every side ("tabs hold nothing"); on some sides only: info "slot runs out of the stock" (the frame still holds). |
| `side`           | –      | `outside`    | `outside` (shape = part outline) or `inside` (shape = opening)                                                                                   | `inside`: same corner check as a pocket.                                                                                                                  |
| `slotWidth`      | length | 6 mm / 1/4″  | > 0                                                                                                                                              | Smaller than the smallest end-mill diameter in the library.                                                                                               |
| `tabs.count`     | scalar | 4            | integer ≥ 0; spaced evenly, first at the middle of `wall[0]` (circle: the front); `inside` with the slot covering the opening: no tabs are built | 0: "the piece comes loose at the last pass".                                                                                                              |
| `tabs.width`     | length | 6 mm / 1/4″  | > 0; all tabs fit on the perimeter                                                                                                               | < 1 mm / 1/32″: "too small to hold the piece".                                                                                                            |
| `tabs.thickness` | length | 2 mm / 1/16″ | > 0; < stock thickness                                                                                                                           | < 1 mm / 1/32″: "too small to hold the piece". Evaluation finds a loose piece ([`decompose()`](../architecture/geometry.md#evaluation-checks)).           |

The removal region is a slot of `slotWidth` beside the shape (outside it for `outside`, inside for `inside`), through the stock bottom; tabs are its retained regions, measured up from `stock.bottom`. An `inside` profile whose slot covers the whole opening (`slotWidth` ≥ half the narrowest size, within the 0.01 mm chord tolerance) cuts the opening out completely: there is no offcut and no tabs are built (DFM warning `dfm.tabsUnused` when `tabs.count` > 0; [geometry.md](../architecture/geometry.md#building-the-solids)). Surfaces: `profile1.wall[i]`, `profile1.corner[i]` (as for a pocket), `profile1.tab[i].top`, `profile1.tab[i].end[0|1]`. Tool requirement: end mill with diameter ≤ `slotWidth` and enough flute length for the stock thickness.

## Ordering and composition

- Operations form an ordered list per part. Removal composes by union, so the geometry does not depend on the order: `part = stock − ∪ (removal(op) − retained(op))` ([geometry.md](../architecture/geometry.md#principle-geometry-comes-from-material-removal)).
- The order matters for **references only**: `on` and expressions may reference stock surfaces and surfaces of **earlier** operations. This keeps the dependency graph acyclic and the list readable top to bottom.
- A retained region (tab, fillet) inside another operation's removal region is removed; evaluation reports it as a DFM warning ([geometry.md open question](../architecture/geometry.md#open-questions)).
- The design order is not the machining order; plan mode orders passes freely.
- Design edits never change existing plans, except plans in `draft` status ([plan snapshots](plan-v0.1.md#plans-are-snapshots)).
- **Repeat (later):** several identical features (a list of holes, a bolt circle, a row of pockets) are made by a **repeat** feature that instances one operation at several positions, never by list parameters on an operation. This is why drilling has one hole per operation. Drafted as the pattern feature in [features.md § Patterns](features.md#patterns).

## DFM checks

- Derived, never stored: parameter and tool checks (sync, in the commands and `design.warning.list`) and geometry checks (worker, [evaluation rules](../architecture/geometry.md#evaluation-rules)). Codes, rules and the warning shape: [geometry.md](../architecture/geometry.md#evaluation-checks) (geometry) and [parameter and tool checks](../architecture/geometry.md#parameter-and-tool-checks) (`parameterChecks`). How they reach commands and queries: [below](#dfm-warnings-task-28-wiring).
- Tool checks compare against the whole **tool library** ([library.md](../architecture/library.md#tool): flat, bull-nose and ball end mills, drills), not a chosen machine. With an empty library only geometric checks run.
- Library edits are non-undoable effect commands outside the project document, so they trigger a re-check but never change the part.
- Each warning names the operation and parameter and suggests a value (e.g. "use cornerRadius ≥ 3.2 mm").

## Commands and queries (v0.1)

Names follow [commands.md](../architecture/commands.md#naming); all are `document` commands, one gesture = one command. Quantities are passed as entered (`"1/16\""`); `Shape` as in [Positioning](#positioning-v01).

| Command                                                                | Args                                                                     | Result                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------- |
| `design.part.add`                                                      | `{ name, stockLibraryItemId }` – takes the stock snapshot                | `{ partId }`                |
| `design.part.update`                                                   | `{ partId, name?, generalTolerance? }`                                   | `{ warnings }`              |
| `design.facing.add` / `.pocket.add` / `.drilling.add` / `.profile.add` | `{ partId, name?, on?, …parameters }` – omitted parameters take defaults | `{ operationId, warnings }` |
| `design.facing.update` / `.pocket.update` / …                          | `{ partId, operationId, …parameters to change }`                         | `{ warnings }`              |
| `design.operation.remove`                                              | `{ partId, operationId }`                                                | `{ warnings }`              |
| `design.operation.move`                                                | `{ partId, operationId, toIndex }`                                       | `{ warnings }`              |

- v0.1: `design.part.add` fails with `model.invariant` when the project already has a part; `design.drilling.add` adds one hole.
- `remove` and `move` are shared by all operation types. Both fail with `design.referenced` (new error code, task 2.5) if a later operation would reference a removed or later surface; the error lists the dependants.
- `warnings` are the part's DFM parameter and tool warnings after the command ([below](#dfm-warnings-task-28-wiring)); they never make a command fail.
- Queries: `design.part.list` (ids and names, so an agent can find the part after reopening), `design.part.get`, `design.operation.list`, `design.warning.list { partId } → { warnings, evaluation, error? }` (the part's DFM warnings, [below](#dfm-warnings-task-28-wiring)). Job: `design.part.evaluate { partId }` evaluates the part now and waits ([workers.md](../architecture/workers.md#jobs-for-agents)).
- Arg schemas and the operation DTO union live in `src/core/design/` and link back here ([Implementation](#implementation-task-25)).

## Implementation (task 2.5)

Code in `src/core/design/`, each file's header links here:

| File                | Contents                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `part.dto.ts`       | Part and operation DTOs (Zod), stored in `ProjectDoc.parts` (record `parts/<id>.json`)                                                                                 |
| `operation.ts`      | Operations with `Quantity` values, DTO ↔ model, field kinds, defaults, `effectiveTolerance`                                                                            |
| `surfaces.ts`       | `SurfaceTable` (analytic z of horizontal surfaces), the reference resolver, `checkReferences`, recalculation                                                           |
| `validate.ts`       | The constraints of the tables above (`model.invariant`)                                                                                                                |
| `geometry-input.ts` | `toGeometryInput(part, stock)`: the pure mapper to the geometry input (`src/core/geometry/model.ts`)                                                                   |
| `load.ts`           | `loadPart(doc, partId)`, `partGeometryInput(doc, partId)`                                                                                                              |
| `commands.ts`       | The commands and queries above (`DESIGN_COMMANDS`, `DESIGN_QUERIES`); `updateOperation`, reused for plan-only edits ([plan-v0.1.md](plan-v0.1.md#plans-are-snapshots)) |
| `warnings.ts`       | Tools → `DfmTool`, `partWarnings` (`parameterChecks` of a part), `DfmWarningSchema` ([below](#dfm-warnings-task-28-wiring))                                            |

Decisions made with task 2.5, where this doc left room:

- **DTOs.** Operations are a union on `kind` (`facing`, `pocket`, `drilling`, `profile`); every parameter is a quantity DTO, `center` a pair `[x, y]` of lengths. The stock snapshot lives in `ProjectDoc.snapshots` (`snapshots/<id>.json`); the part's `stock` is its id.
- **Ids** are the kind prefix (`facing`, `pocket`, `drill`, `profile` – `drill` as in the surface ids) plus 1 + the highest number of that prefix in the part, so removing the last one frees its number. The default `name` is `Pocket 2` etc.
- **`on`** exists on pockets and drillings only: facing always starts from `stock.top`, and a profile is a through cut whose tabs are measured from `stock.bottom`. Valid targets: `stock.top`, the `floor` of an earlier facing or pocket, and existing tab tops of an earlier profile (`profile1.tab[0].top`). A wrong target of the edited operation is `model.invariant` (rule `onSurface`, params list the allowed ids).
- **Expression references** in design are `<surface>.z`, `.z.min` and `.z.max` of the horizontal planar surfaces of the stock and earlier operations: `stock.top`, `stock.bottom`, `facingN.floor`, `pocketN.floor`, `drillN.bottom` (flat only). Tab tops are reachable only through `on`: bracketed ids are not expression names. z comes from the analytic model (`on.z − depth`, tab top `−thickness + tabs.thickness`) with the explicit tolerances propagated worst-case; `.min`/`.max` are its limits, untoleranced. Design never names a tool or machine, so `tool.*` and `machine.*` are unknown references here (plan mode resolves them); project variables are not specified yet. (Changed 2026-11-21, user decision D11: design operations now carry a tool field, [design-v0.2.md](design-v0.2.md#operation-tool); `tool.*` stays unknown in design expressions, [design-v0.2.md § Expressions and the tool](design-v0.2.md#expressions-and-the-tool). v0.2 adds `.x`/`.y` names and bracketed ids such as `stock.side[1].x`: [design-v0.2.md § Formula names](design-v0.2.md#formula-names).)
- **Recalculation.** The dependency graph has a node per expression parameter (`pocket2#depth`, depends on its references) and per surface `.z` (depends on its `on` surface, its operation's parameters as a whole, `pocket1#params`, and each of its operation's expression parameters, so a chain through an operation's own formula – `facing1.floor.z` → `pocket1#depth` → `pocket1.floor.z` → `pocket2#depth` – is complete and ordered). After an update, `affectedBy(<op>#params)` gives the dependants, re-evaluated in that order in the same command (one undo step).
- **Check order of an edit:** quantity errors (`quantity.*`, `expression.*`, issue path = parameter) → the edited operation's constraints (`model.invariant`, every invalid field at once) → references of all operations (`design.referenced`) → recalculation → constraints of the other operations (`model.invariant`, paths `operations.<id>.<param>`). Any failure leaves the document unchanged.
- **`design.referenced`** has one issue per broken reference (path `operations.<id>.<param>`, params `{ operationId, reference }`) and lists the dependants in its data. It also stops an update that removes a referenced surface (fewer tabs, a profile side change, a drill bottom that is no longer flat).
- **Drilling:** a `depth` for `through` or a `pointAngle` for another bottom than `drillPoint` is invalid (rule `notForBottom`); changing `bottom` drops the unused ones and `drillPoint` defaults the angle to 118°. "Bottom above `stock.bottom`" uses the full-diameter depth.
- **Profile:** "all tabs fit" is `count × width < perimeter` of the shape, skipped when an `inside` slot covers the opening (no tabs are built); the corner radius rule of a pocket applies to the profile shape too.
- **Updates** replace `shape` as a whole (an omitted `cornerRadius` takes the default); `tabs` merges field by field.
- **General tolerance** is `{ length?, angle? }`, each a deviation ≥ 0 (`"0.1 mm"` = ±0.1 mm), `null` clears it. `effectiveTolerance` walks operation → part; the project scope comes with project settings.
- **`design.part.add`** reads the library synchronously (`services.library.lookup`) to take the snapshot ([commands.md](../architecture/commands.md#command-definition)).
- **Not in 2.5:** DFM warnings and `design.warning.list`; wired after task 2.8 ([below](#dfm-warnings-task-28-wiring)). Constraints are only the hard parameter errors of the tables above.

### DFM warnings (task 2.8 wiring)

- **Parameter and tool warnings** come from `parameterChecks` ([geometry.md](../architecture/geometry.md#parameter-and-tool-checks)) on the part's geometry input (`toGeometryInput`), computed fresh on every call and never stored. Tools: every readable tool item of the library (`services.library`; files that do not load are skipped), reduced to `DfmTool` in canonical mm (`type`, `diameter`, the bull-nose `cornerRadius`). Unit system: the project's `ProjectDoc.unitSystem` (`mm` → metric thresholds, `inch` → inch ones), as `loadPart` returns it.
- **Command results carry them.** Every design command on a part (`design.part.update`, each `add`/`update`, `design.operation.remove`/`move`) returns `warnings` for that part after the command, so an agent sees the effect of an edit at once without a second call. `design.part.add` does not: an empty part has none. A warning never fails or rolls back a command; without a library service the commands check against an empty library (geometric rules only). The warnings are part of the command's result value, not of the document, so undo/redo do not replay them – query again after undo.
- **`design.warning.list { partId } → { warnings }`** returns the same list for the current document and the current library, so it also reflects library edits, which never change the document. It fails with `input.malformed` for an unknown part and `internal.unexpected` without a library service (like `design.part.add`).
- **Geometry warnings** (`dfm.loosePiece`, `dfm.retainedRemoved`, `dfm.surfaceMissing`) come from the part's evaluation, which runs automatically on the geometry worker after design edits ([workers.md](../architecture/workers.md#automatic-evaluation-after-design-edits)); neither the commands nor this query run it. The mapper fills `PartGeometryInput.references` from `on` and the expression references (one entry per operation, parameter and surface) for `dfm.surfaceMissing`.
- **Merging (task 2.9):** `design.warning.list` appends the warnings of the evaluation of the part's current input (by input hash) to the parameter warnings, ordered by operation (design order), parameter warnings first within an operation (`mergeWarnings` in `evaluation.ts`). The two code sets are disjoint, so nothing is deduplicated. The result also says whether that evaluation is current: `evaluation: 'done' | 'pending' | 'failed'` (with `error` when failed; geometry warnings only when `done`), so an agent knows when they are still missing; `design.part.evaluate` waits for them. Command results keep the synchronous warnings only: they never wait for the worker.

## Design UI (task 3.6)

How the design mode screens use the commands above; UI rules in [ui.md](../conventions/ui.md#design-mode-task-36), code in `src/renderer/src/modes/design/`.

- **Stock setup:** a project without a part shows the stock setup (since D45 in the Stock dialog, which opens by itself for a new project, [ui.md § Design sidebar and setup dialogs](../conventions/ui.md#design-sidebar-and-setup-dialogs-v04-d45)): part name, then a new block (length, width, thickness, material name and class; added to the stock library with `library.stock.add`) or a block from the library, and "Create part" (`design.part.add`, which takes the snapshot).
- **Operation navigator:** the operations in design order under a one-line read-out of the part (selecting it selects nothing: the inspector shows the part) and its stock ([ui.md § Design sidebar and setup dialogs](../conventions/ui.md#design-sidebar-and-setup-dialogs-v04-d45)). "Add" (its Operations group; while empty, one button per kind; v0.4 adds a Features group, [ui.md § Features (v0.4)](../conventions/ui.md#feature-rows-and-add)) dispatches `design.<kind>.add` with values that fit the stock (facing: defaults; pocket: a third of the stock in the middle, depth a quarter of the thickness; drilling: a 6 mm / 1/4″ through hole at a quarter of the length and a third of the width; profile: an outside rectangle 4 slot widths smaller than the stock) and selects the new operation, so the user edits it at once. Move up/down (`design.operation.move`, buttons and `Alt+↑/↓`; a move that breaks a reference fails with `design.referenced` and changes nothing), remove (`design.operation.remove`, undo toast).
- **Inspector:** one `QuantityInput` per parameter in the groups of the tables above; a commit is one `design.<kind>.update` with that parameter (a shape or drilling center as a whole, tabs field by field), so one undo step. `on` is a list of the eligible surfaces with a pick button; formula fields offer `<surface>.z` of the stock and earlier operations and pick them in the viewport. Shape kind, drill bottom (a depth of 1 × diameter is added when leaving `through`) and profile side are segmented controls or lists, each one command.
- **Warnings:** `design.warning.list` after every revision and evaluation change, shown at the parameter (with "Apply" for a suggestion), as a row badge, in the part summary and in the status bar list.

## Retained regions: tabs and fillets

Cutout operations (profile, straight/curved line and shape cuts) may include **tabs**, and pockets may leave **fillets**. Both use one mechanism – [geometry.md#cutting-operation-framework](../architecture/geometry.md#cutting-operation-framework).

## Carving and engraving (later)

Carving and engraving work from **vectors** (SVG/DXF or drawn paths); raster images are traced to vectors on import. Each operation (engraving, V-carving, vector relief) has a profile and a tolerance; plan mode expands it into passes – [geometry.md#carving-and-engraving-vector-based](../architecture/geometry.md#carving-and-engraving-vector-based).
