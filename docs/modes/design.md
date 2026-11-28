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

**Changed 2026-11-21 (user decision D11):** the v0.1 rule "Design never names a tool" is replaced. Each design operation has a **tool field**, either a generalized tool (type + diameter, e.g. a 1/4″ flat end mill) or a specific library tool, chosen automatically unless the user locks it; Plan resolves it to a concrete tool. Spec: [design-v0.2.md § Operation tool](design-v0.2.md#operation-tool); plan side: [plan-v0.2.md](plan-v0.2.md#tool-resolution-from-the-design-tool-field). Any library tool of a type that can make the operation can be picked; a near tool of another diameter is offered, never taken automatically ([DF42](design-v0.2.md#library-tools-of-the-type-and-the-near-match-df42)). The v0.1 implementation still follows the old rule until v0.2 is implemented.

## Tolerances and references

- Every parameter is a [quantity](../architecture/quantities.md) and may carry an explicit tolerance; untoleranced values use the [general tolerance](../architecture/quantities.md#tolerance) of operation → part → project (features: later).
- Surfaces inherit their operation's tolerance in v0.1.
- References: XY positions are in the part frame (below); depths are measured down from the operation's `on` surface.

## Part and stock (v0.1)

- A project holds **several parts** (one until split parts S0 lifted rule `onePart`, [split-parts.md § Prerequisite](split-parts.md#prerequisite-several-parts-per-project)); each is a record `parts/<id>.json` ([persistence.md](../architecture/persistence.md#working-folder-layout)): `{ id, name, stock, generalTolerance?, operations[] }`, with its own stock snapshot. Every design command and query names its part by `partId`; plans pick their part (`plan.create { partId }`). The UI shows one part at a time ([ui.md § Part menu](../conventions/ui.md#part-menu-split-parts-s0)).
- `stock` is the id of a `block` stock **snapshot** ([library.md](../architecture/library.md#stock)) ([library references](../architecture/persistence.md#library-references)); the stock is the starting body: `part = stock − …` ([geometry.md](../architecture/geometry.md#principle-geometry-comes-from-material-removal)).
- **Part zero** is the top face's front-left corner: X right, Y back, Z up; the stock occupies `0..length × 0..width × −thickness..0`.
- Stock surfaces: `stock.top`, `stock.bottom`, `stock.side[0..3]` (0 = front, then counter-clockwise seen from above).

### Changing the stock (DF95)

Hardening DF95 (user TG #347: "I just changed my mind after creating the project … It may break some operations, which is okay for now"; decisions taken by delegation, D70):

- **Command:** `design.part.update { partId, stock }` (the block's values as `design.part.add` takes them: the part's own block) or `{ partId, stockLibraryItemId }` (a linked copy of that library block); both at once is `input.malformed` (rule `stockSource`). The part's stock snapshot is **replaced in place** (its id kept, so plans and references still name it), in the same command as a rename or tolerance change, so **one undo step**. The same values and link write nothing. A split piece refuses it (`derivedPart`: its blank comes from its source; the source's new stock regenerates the pieces).
- **Operations keep their values.** Nothing is moved, scaled or clamped. What depends on the stock follows as it does after "Update from library" (`design.snapshot.update`): expressions and through depths re-resolve, patterns re-expand (`design.patternFollow`), split pieces regenerate, plans go stale.
- **What no longer fits shows as findings**, never as a refusal: positions outside the stock as before (`dfm.holeOutsideStock`, `dfm.shapeOutsideFace`, `dfm.cloneOutsideStock`, …); a limit the new stock breaks that commands otherwise refuse (a pocket or drilling below the new stock bottom, rule `aboveStockBottom`; a facing or tab as thick as the stock) as **`dfm.stockLimit`** (warning) at that operation and parameter, its `params` the limit's (`rule`, `detail`, `max`, `actual`). `design.warning.list` and every design command result carry it (it also covers a thinner library stock taken by `design.snapshot.update`).
- **A broken operation doesn't block the others:** the whole-part check after an edit refuses only what the edit makes worse – a violation of another operation that it already had before the edit (same rule, same field) passes and stays its `dfm.stockLimit` warning (`src/core/design/known-issues.ts`). The edited operation (a feature's owned operations) keeps all its invariants: editing the broken operation passes only when that edit fixes it.
- **UI:** the Stock dialog of a part edits its stock ([ui.md § Stock dialog](../conventions/ui.md#stock-dialog-df11df13)).

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

With a reference model, the depth that faces down to the reference's closest point is suggested on the Depth field and used by Add → Facing (DF4, [reference-model.md § Facing depth from the reference](reference-model.md#facing-depth-from-the-reference-df4)).

#### Facing region (hardening DF145)

Status: **accepted** (2026-11-28, from the user's TG #492; Q230 and Q231 taken as recommended by delegation D89; FR1–FR3 built, see [Implementation](#implementation-fr1fr3)) · Intake: [hardening.md DF145](../plans/hardening.md#intake-user-feedback-goes-here)

The user: "There's no way to limit facing operation to a region. Even if I add a dummy pocket 0.1mm deep to select the surface it creates, there's no way to put facing operation there as well. But I wanted to face only 22mm of the surface. So I used Pocket 2 as some kind of workaround." Today a facing always covers its whole stock face ([design-v0.2.md § Face targets](design-v0.2.md#face-targets-generalised-on)).

**Proposal:** an optional `region` on the facing. Absent means the whole face, so stored facings load unchanged (no `schemaVersion` change).

| `region`                              | Meaning (face frame of the facing's `on`)                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| absent: **Whole face**                | As today                                                                                                                                      |
| `{ band: { edge, width } }`: **Band** | The strip `width` deep from one stock edge (`front`, `back`, `left`, `right` of the face), across the whole face: "22 mm from the front edge" |
| `{ shape }`: **Shape**                | A rectangle, circle or named closed shape, placed as a pocket's shape; clipped to the face                                                    |

- **Open and closed sides.** A side of the region on or beyond the stock edge is **open**: the rows run off the stock with the existing `overshoot`, as a whole facing. A side inside the face is a **boundary**: the tool stays inside the region (Q231), leaving a step of the facing depth there, its inside corners rounded by the tool radius.
- **Toolpath:** facing's rows ([plan-v0.1.md § Facing](plan-v0.1.md#facing)), clipped to the tool-centre region (the region shrunk by R at boundaries, grown past the edge at open sides as [open sides](plan-v0.3.md#open-sides-df61) do). Rows enter from an open side (no ramp); a region with no open side ramps along its first row within the pocket's `rampAngle`. No finishing pass, no floor fillet, no roughing pass.
- **How it differs from a shallow pocket** (the user's workaround): a pocket cuts offset rings with a finishing ring on every real wall, enters by helix or ramp, warns about corners and "no tool fits", and orders among pockets; an open-sided pocket already runs past the stock edge (DF61) but keeps its rings. A region facing keeps facing's rows, stepover by the flat diameter (surfacing bits included), side entry, its place first in the tool run and its cut-state handling ([cut-state.md](cut-state.md)).
- **Surfaces:** `facingN.floor` stays, its patch the region ([construction-surfaces.md](construction-surfaces.md)). Only a whole-face facing becomes the default `on` of later pockets and drillings ([design-v0.2.md](design-v0.2.md#implementation-tasks-f1-f2)): a band's floor is offered in the `on` list, never picked by default.
- **Rules and DFM:** `width` > 0 and ≤ the face's extent across that edge (`bandWidth`); a shape region that misses the face is `dfm.shapeOutsideFace`; a boundary corner tighter than the smallest flat end mill is the pocket's "no tool fits" check.
- **Not covered:** facing `on` a pocket floor (the user's dummy-pocket attempt): a shape region replaces it.
- **Decided here:** the inspector's Region row is a segmented choice **Whole face / Band / Shape**; Band shows an edge picker (the face drawn with its four edges) and Width; Shape reuses the pocket's shape fields. The viewport draws the region with its open sides dashed.

##### Questions (Q230–Q231)

1. **Q230 – Region model.** (1) **`region` on the facing: whole face, a band from one edge, or a shape** (above). (2) Only a shape region (a band is a rectangle you size yourself). (3) No change; let a facing stand `on` a pocket floor. _Recommendation: (1). The band is the user's case in one field, and it stays right when the stock changes; (3) keeps the dummy pocket._
2. **Q231 – Boundary sides and margin.** (1) **The tool stays inside the region at boundaries; open sides take the existing `overshoot`; no extra margin field.** (2) The tool centre runs on the boundary (cuts R past it, no step left exactly at the line). (3) A signed `margin` that grows or shrinks the region. _Recommendation: (1). The region is what gets faced, as a pocket's shape is; to overlap a neighbouring facing, widen the band._

##### Slices

| Slice | Content                                                                                                                                                                                   | Done when                                                                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR1   | **Core:** `region` in the model and DTO, removal region and floor patch, the default-`on` rule, rules and DFM, `region` on `design.facing.add/update` (≈ 0.3 K of `tools/list`, measured) | The user's part: a 22 mm band from the front edge evaluates to the band removed and nothing else; a whole-face facing is byte-equal (goldens)             |
| FR2   | **Toolpath:** rows clipped to the region, open sides with `overshoot`, boundaries with the tool inside, side or ramp entry; cut-state stamps of the region                                | Heightmap test: the band faced flat to depth, 0 gouge past the boundary, leftover < 0.05 mm; a shape region with no open side ramps; virtual machine Idle |
| FR3   | **UI:** the Region row (Whole face / Band / Shape), edge picker, viewport region with dashed open sides; component test with axe                                                          | The user faces 22 mm from the front edge in the installed app without a pocket                                                                            |

##### Implementation (FR1–FR3)

**FR1 (built 2026-11-28): model, rules, geometry, agent API.**

- **Model:** `Facing.region?: { kind: 'band', edge, width } | { kind: 'shape', shape }` (operation.ts); stored as `region: { band: { edge, width } }` or `{ shape }` (part.dto.ts `FacingRegionDtoSchema`), left out for the whole face, so earlier records and whole-face geometry inputs stay byte-identical (no `schemaVersion` change). Edges are in the face frame of `on`: `front` = lowest v, `back` = highest v, `left` = lowest u, `right` = highest u.
- **Agent API:** `region` on `design.facing.add` / `.update` (and `plan.design.operation.update`): `{ band: { edge, width } }`, `{ shape, anchor? }` as a pocket's, `null` = the whole face. The full schema repeats the pocket's shape (≈ 2.7 K), so the listings carry a sketch ("As design.pocket.add shape …"); measured `tools/list` 112,279 → 112,619 chars (+340) of the 120 K budget (FR3's Convert to shape: 112,636).
- **Rules:** `region.band.width` > 0 and ≤ the face's extent across the edge (`bandWidth`, `model.invariant`); a shape region takes the pocket's shape rules and `openNeedsOn`, at the pocket's paths `shape.*` (**decided here:** a facing has no other shape, so the paths stay unambiguous and the inspector's shape fields are the pocket's). A region wholly outside the face is `dfm.shapeOutsideFace` (the facing cuts nothing).
- **Geometry:** the geometry input's `region` is a placed shape in the face frame (geometry/model.ts); a band becomes a rectangle reaching `OVERSHOOT` past the stock on its three stock-edge sides (`bandShape`, geometry-input.ts). The removal is the pocket of that region from the face, `depth` deep, no fillet (`regionPocket`, outline.ts), so the surfaces are `facingN.floor` plus the region's walls as a pocket names them (`facingN.wall[i]`, `facingN.corner[i]`; **decided here**, the draft named only the floor); walls past the stock cut air and do not appear. The floor patch, the through-depth and material-band clears and the as-cut stamps (cut-state C5) are the region within the face.
- **Default `on` and Z reference:** only a whole-face top facing's floor becomes the default `on` (`defaultOn`) and the Z-reference default rule `facing` ([z-reference.md](z-reference.md#default-rule)); a region's floor is offered in the lists, never picked by default.
- **Not covered:** a region facing is not carried to split pieces (finding "faces a region: face the pieces instead"); the tool rule stays the facing's (a flat end mill) with no corner check: inside corners of the boundary are left rounded by the tool radius, as the draft says.

**FR2 (built 2026-11-28): toolpath** (`generateRegionFacing`, toolpath/region-facing.ts; a whole-face facing keeps `generateFacing`, its goldens byte-equal).

- **Tool-centre region** C = the face grown by `overshoot + R`, minus the face outside the region grown by R, cut to within `R + overshoot` of the region: open sides run off the stock as a whole facing's rows do; at an inner side the tool's edge is on the boundary.
- **Rows** as a whole facing's (axis, pattern, climb direction, stepover ≤ the flat diameter) between C's extent over the face (an end on a stock edge: the flat edge `overshoot` past it), each row cut along C's spans (C flattened inside itself, 1e-4 mm).
- **Entry:** a span starting with the tool clear of the stock plunges there (no ramp); otherwise it ramps down along its row at 3° (`FACING_RAMP_ANGLE`, the WH-D facing's; **decided here:** a facing has no ramp angle of its own, so the draft's "pocket's `rampAngle`" is this fixed angle), back and forth when the row is short. A span shorter than 0.5 mm with both ends over the stock is left to the boundary pass. Zigzag links stay at depth when both ends are clear of the stock on the same side or the link lies inside C; otherwise retract.
- **Boundary pass (decided here,** replacing the draft's "no finishing pass"**):** after each level's rows the tool follows C's inner sides (tool edge on the boundary) at the same level, climb or conventional as the rows. Without it a slanted or curved boundary, or one across the rows, keeps cusps between the rows' ends (≈ 0.34 R at a 0.75 D stepover). It is no finishing pass (no allowance); a straight inner side a row already runs along is skipped (the user's band has none).
- **Workholding keep-out (WH-D):** a region facing around workholding clears, as a pocket, its region within the face grown by `overshoot` less the rest of the face.
- **Tests:** heightmap oracles (region-facing.test.ts): bands from every edge along both axes, a circle with no open side (ramps), a slanted region across a stock edge: leftover < 0.05 mm², no gouge, nothing below the floor, the DF144 deep-cut oracle clean; golden `facing-band-front.txt` (the user's 22 mm band along the front of a 100 mm plate); design → plan → toolpath keeps the tool in front of the band's inner side.

**FR3 (built 2026-11-28): UI.**

- **Inspector:** a facing's first group is **Region**: a segmented Whole face / Band / Shape (OperationFields.tsx `FacingRegionGroup`). Band starts at the front edge, a quarter of the face across it wide; it shows **From edge** (Front (Y min), Back (Y max), Left (X min), Right (X max): the face frame's axis names) and **Width** (path `region.band.width`, its refusals at the field). Shape starts with a rectangle half the face's size at its centre and adds the pocket's **Shape** group with the same [picker](../conventions/ui.md#shape-in-the-operation-inspector) (New shape…, Edit shape…, Import SVG…, Convert to shape, placement fields): **decided here,** the region's shape is shown as the op's `shape` and its commands are sent as `region` (`regionShapeContext`), so nothing of the pocket's fields is copied. `design.shape.convert` takes a facing's inline shape region. Whole face sends `region: null`.
- **Viewport:** a region facing's outline is its region clipped to the face: the inner sides solid at the face and at the new floor, the sides on stock edges (where the rows run off) as the dashed guide while it is selected (outline.ts `facingRegionSides`, `facingRegionGuide`). A whole facing draws as before.
- **Tests:** FacingRegion.test.tsx (Band edge and width, a refused width, back to the whole face; Shape fields, New shape… one undo step, Edit shape…; axe), outline.test.ts (a band's and a shape's inner and open sides), shape-commands.test.ts (convert), e2e facing-region.e2e.ts (the user's 22 mm band from the inspector, hidden window).

### Pocket

Blind recess with flat floor; retained regions: inside corner radius and floor fillet ([fillets](../architecture/geometry.md#fillets-as-retained-regions)).

| Parameter            | Kind   | Default     | Constraints                                                                                                      | DFM warnings                                                                                               |
| -------------------- | ------ | ----------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `shape`              | –      | required    | rectangle or circle; size > 0                                                                                    | Narrowest size < smallest end-mill diameter in the tool library: "no tool fits".                           |
| `depth`              | length | required    | > 0; floor above `stock.bottom`                                                                                  | Depth > 4 × narrowest size: "deep, narrow pocket – needs a long tool".                                     |
| `shape.cornerRadius` | length | 3 mm / 1/8″ | rectangle only; 0 ≤ r ≤ min(length, width)/2 (above: Round, [DF120](hole-slots-and-round-corners.md#apply-rule)) | r < radius of the smallest end mill in the library ("no tool can make this corner"); r = 0 always warns.   |
| `floorRadius`        | length | 0           | 0 ≤ f ≤ depth; f ≤ `cornerRadius` (circle: ≤ diameter/2)                                                         | f > 0 and the library has no bull-nose end mill with corner radius f and no ball end mill with radius ≤ f. |

Surfaces: `pocket1.floor`, `pocket1.wall[i]` (rectangle: 0 = front, counter-clockwise; circle: `wall[0]`), `pocket1.corner[i]` (corner cylinders, `i` = following wall), `pocket1.floorFillet`. Tool requirement: end mill with radius ≤ `cornerRadius`; for `floorRadius` > 0 as in [geometry.md](../architecture/geometry.md#fillets-as-retained-regions).

**Through (DF116,** user TG #369: "a checkbox/toggle in the depth group to cut through, that what I was trying to do anyway"**):** `through: true` clears the pocket's region through the material below `on` to the opposite stock face (or what an earlier setup left there), with the plan's breakthrough, so no skin or slug is left – the through pocket that patterns P4 introduced ([patterns.md](patterns.md#implementation-p4)), now settable on any plain pocket: the Depth group's **Through** switch (the pattern inspector's control), `design.pocket.add` / `.update` `through` (`false` makes it blind again; measured: tools/list 111,599 → 111,830 chars, +231, of the 120 K budget). While through, `depth` is kept as entered and unused (switching Through off restores it; the Depth field is hidden), the floor is no face target (while an operation stands on it, Through is refused: `model.invariant`, rule `onSurface`). The floor fillet radius stays as entered. **Roughing (DF122):** `roughing` on `design.pocket.add` / `.update` adds an owned roughing pocket `<id>_roughing` with a bigger tool and stock to leave on walls and floor ([roughing.md](roughing.md#implementation-r1)). A drilling's through is its Bottom (Through), a profile's an empty depth (the Cut group's **Through** switch since DF116, off = a blind depth of a quarter of the material below `on`).

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

| Parameter        | Kind   | Default      | Constraints                                                                                                                                           | DFM warnings                                                                                                                                                                                                                                                |
| ---------------- | ------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shape`          | –      | required     | rectangle or circle; size > 0                                                                                                                         | `outside`: stock margin < `slotWidth` on every side ("tabs hold nothing"); on some sides only: info "slot runs out of the stock" (the frame still holds).                                                                                                   |
| `side`           | –      | `outside`    | `outside` (shape = part outline) or `inside` (shape = opening)                                                                                        | `inside`: same corner check as a pocket.                                                                                                                                                                                                                    |
| `slotWidth`      | length | 6 mm / 1/4″¹ | > 0                                                                                                                                                   | Smaller than the smallest end-mill diameter in the library.                                                                                                                                                                                                 |
| `tabs.count`     | scalar | 4            | integer ≥ 0; spaced evenly, first at the middle of `wall[0]` (circle: the front); `inside` with the slot covering the opening: no tabs are built      | 0: "the piece comes loose at the last pass".                                                                                                                                                                                                                |
| `tabs.width`     | length | 6 mm / 1/4″  | > 0; all tabs fit on the perimeter                                                                                                                    | < 1 mm / 1/32″: "too small to hold the piece".                                                                                                                                                                                                              |
| `tabs.thickness` | length | 2 mm / 1/16″ | > 0; < stock thickness; measured up from the slot's bottom (the opposite stock face, or since DF50 the material an earlier setup left under the slot) | < 1 mm / 1/32″: "too small to hold the piece". Evaluation finds a loose piece ([`decompose()`](../architecture/geometry.md#evaluation-checks)). Over half the material the slot cuts and over 5 mm / 3/16″: `dfm.tabsTall` (DF90; suggestion at most half). |

¹ Since hardening DF51, a profile added without `slotWidth` takes the narrowest wider library flat end mill that fits when no library tool fits 6 mm / 1/4″ ([design-v0.2.md § Tool choice fixes](design-v0.2.md#tool-choice-fixes-df51-df52-df54-df55)).

The removal region is a slot of `slotWidth` beside the shape (outside it for `outside`, inside for `inside`), through the stock bottom; tabs are its retained regions, measured up from `stock.bottom` (since DF50 from the material an earlier setup left under the slot, [plan-v0.2.md § Material removed by earlier setups](plan-v0.2.md#material-removed-by-earlier-setups)). An `inside` profile whose slot covers the whole opening (`slotWidth` ≥ half the narrowest size, within the 0.01 mm chord tolerance) cuts the opening out completely: there is no offcut and no tabs are built (DFM warning `dfm.tabsUnused` when `tabs.count` > 0; [geometry.md](../architecture/geometry.md#building-the-solids)). Surfaces: `profile1.wall[i]`, `profile1.corner[i]` (as for a pocket), `profile1.tab[i].top`, `profile1.tab[i].end[0|1]`. Tool requirement: end mill with diameter ≤ `slotWidth` and enough flute length for the stock thickness.

## Ordering and composition

- Operations form an ordered list per part. Removal composes by union, so the geometry does not depend on the order: `part = stock − ∪ (removal(op) − retained(op))` ([geometry.md](../architecture/geometry.md#principle-geometry-comes-from-material-removal)).
- The order matters for **references only**: `on` and expressions may reference stock surfaces and surfaces of **earlier** operations. This keeps the dependency graph acyclic and the list readable top to bottom.
- A retained region (tab, fillet) inside another operation's removal region is removed; evaluation reports it as a DFM warning ([geometry.md open question](../architecture/geometry.md#open-questions)).
- The design order is not the machining order; plan mode orders passes freely.
- Design edits never change existing plans, except plans in `draft` status ([plan snapshots](plan-v0.1.md#plans-are-snapshots)).
- **Repeat (later):** several identical features (a list of holes, a bolt circle, a row of pockets) are made by a **repeat** feature that instances one operation at several positions, never by list parameters on an operation. This is why drilling has one hole per operation. Drafted as the pattern feature in [features.md § Patterns](features.md#patterns).

## Disabling operations and features (DF106)

Status: implemented (hardening DF106, user TG #349, 2026-11-25; the open choices below were taken on the recommendation by delegation, D70) · UI: [ui.md § Feature rows and Add](../conventions/ui.md#feature-rows-and-add) (Row menu) · Plan side: [plan-v0.4.md § Disabling in a plan](plan-v0.4.md#disabling-in-a-plan-df106) · Code: `src/core/design/disabled.ts`, `disabled-follow.ts`

The user: "add an ability to disable a feature or an operation in the RMB menu (in Design mode) which hides it from Plan mode and 3D view (only displayed in the list) … Chamfer and all child operations are disabled and re-enabled with it. Can't add chamfer or other ops to a disabled element."

- **Meaning.** A disabled item stays in the operation list with every parameter, its tool field and its position, muted with an "Off" marker ([ui.md](../conventions/ui.md#feature-rows-and-add)); everything downstream treats the part as if it were not there: the evaluated 3D model (removals, surfaces, picking), DFM warnings (parameter, tool and geometry ones; the part summary and status bar too), split pieces, plan snapshots and plan operations, toolpaths and export. Enabling restores it exactly: the part record is byte-equal to before, and so are its evaluation, a draft plan after Apply and its program (the headless check in `src/core/plan/disabled-plan.test.ts`).
- **Stored:** `PartDTO.disabled`, the ids switched off directly (top-level units in design order; absent = none; an optional field, no `schemaVersion` change). Whatever follows from it is derived on every read, never stored (`disabledState`), and `enabledPart(part)` is the part without the disabled items and without the list: the one function every consumer above reads (`loadEnabledPart`, `partGeometryInput`, `takeDesignSnapshot`, the split follow). A part with nothing disabled is passed through as the same object.
- **What can be switched off: top-level rows only** – a plain operation (a chamfer row too), a feature (hole, pattern, Clones). An owned operation of a feature or a member of a Clones source is refused (`model.invariant`, rule `insideFeature`, params name the feature): **operations inside a feature are switched by the feature's own toggles** (the user: "if a feature allows enabling/disabling this operation – it can be disabled individually by just toggling the feature's checkbox"). The features' toggles today: **hole** – the head type (simple / counterbore / countersink: a simple hole has no head operations); **pattern** – "Chamfer every cell" (`chamfer: null`), the bottom chamfer's Edges (P5); **Clones** – Skip per position (an instance), the source members (`design.clones.update { source }`); **edge chamfer** – its chosen `loops` (E4a). No feature has a generic per-operation switch; one is added to a feature when it is asked for, as an option of that feature.
- **Dependants are off with it** (decided: follow, not refuse – a pocket with a chamfer could otherwise never be switched off): a chamfer on its edge (`edgeOf`), an operation `on` one of its surfaces, an expression naming one of its surfaces (`pocket1.floor.z`), an operation placing a disabled feature's owned shape, and a feature whose face is one of its surfaces or any of whose owned or nested operations depends on it (a pattern stacked on a disabled pocket's floor; a Clones whose source sits on it is off as a whole). They are not in the list: enabling the item brings them back, and so does removing the reference. `design.operation.list` returns `disabled` (every item that is off, dependants included); the navigator mutes dependants too, their "Off" marker saying they build on a disabled item.
- **Nothing new builds on a disabled item:** a design command after which a new item would be off as a dependant (Chamfer on its row, a drilling on its floor, an `on` or expression changed to its surface) or a listed item would be nested (Make Clones… of it) is refused (`model.invariant`, rule `disabledTarget`, path `disabled`, params `{ id, disabled }`: "enable it first"); the row menu leaves those items out for a disabled row. Editing, renaming, moving and removing a disabled item stay possible (its fields are checked as before); a removed item leaves the list in the same command (`design.disabledFollow`), so an id reused later is not off.
- **Split pieces** are cut from the enabled source: a disabled item is in no piece; a piece cannot switch items off (it is derived, `derivedPart`; Detach first).
- **3D view:** a disabled item has no removal, surfaces or picking; selecting its row draws no outline, axes, tab markers or Clones.
- **Plan** copies the enabled part ([plans are snapshots](plan-v0.1.md#plans-are-snapshots)): a `draft` plan follows on Apply (the plan operations of disabled items are set aside, `parked`; enabling brings the same plan operations back with their settings and place, [plan-v0.4.md](plan-v0.4.md#disabling-in-a-plan-df106)); a settled plan sees the change only on a deliberate rebuild (until then its row shows **Off in design**, `disabledInDesign` in its stale list). Design → Plan only: disabling in a plan never changes the design ([plan-v0.4.md](plan-v0.4.md#disabling-in-a-plan-df106)).
- **Undo:** one toggle is one command, one undo step (with the draft plans' follow on Apply, as any design edit).
- **Agent API:** `design.part.update { partId, disabled: [ids] }` replaces the list (`[]` enables all; unknown ids `input.malformed`, rule `unknownItem`); `design.part.get` shows the list, `design.operation.list` the effective state. No new tool ([llm-api.md § DF106](../architecture/llm-api.md#df106-disabling-operations-and-features)).
- **Keyboard:** the row menu's Disable / Enable (right-click, `Shift+F10`); no dedicated shortcut yet (none is free of the text fields' and viewport's keys without a study; to add when dogfood asks).

**Already cut** (DF135, [cut-state.md](cut-state.md)): a second list on the part, `PartDTO.alreadyCut`, with the same rules for what can be listed (top-level rows) and the same row menu place, says the material is already gone from the stock; unlike Disable the item stays in the model and everything builds on it, and plans keep it as removed material without exporting it.

## DFM checks

- Derived, never stored: parameter and tool checks (sync, in the commands and `design.warning.list`) and geometry checks (worker, [evaluation rules](../architecture/geometry.md#evaluation-rules)). Codes, rules and the warning shape: [geometry.md](../architecture/geometry.md#evaluation-checks) (geometry) and [parameter and tool checks](../architecture/geometry.md#parameter-and-tool-checks) (`parameterChecks`). How they reach commands and queries: [below](#dfm-warnings-task-28-wiring).
- Tool checks compare against the whole **tool library** ([library.md](../architecture/library.md#tool): flat, bull-nose and ball end mills, drills), not a chosen machine. With an empty library only geometric checks run.
- Library edits are non-undoable effect commands outside the project document, so they trigger a re-check but never change the part.
- Each warning names the operation and parameter and suggests a value (e.g. "use cornerRadius ≥ 3.2 mm").

## Commands and queries (v0.1)

Names follow [commands.md](../architecture/commands.md#naming); all are `document` commands, one gesture = one command. Quantities are passed as entered (`"1/16\""`); `Shape` as in [Positioning](#positioning-v01).

| Command                                                                | Args                                                                             | Result                      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------- |
| `design.part.add`                                                      | `{ name, stockLibraryItemId }` or `{ name, stock }` – takes the snapshot         | `{ partId }`                |
| `design.part.update`                                                   | `{ partId, name?, generalTolerance?, stock? \| stockLibraryItemId? }` (DF95)     | `{ warnings }`              |
| `design.part.remove` (S0)                                              | `{ partId, confirm? }` – with its references, plans (`confirm: true`), snapshots | `{ removedPlans }`          |
| `design.facing.add` / `.pocket.add` / `.drilling.add` / `.profile.add` | `{ partId, name?, on?, …parameters }` – omitted parameters take defaults         | `{ operationId, warnings }` |
| `design.facing.update` / `.pocket.update` / …                          | `{ partId, operationId, …parameters to change }`                                 | `{ warnings }`              |
| `design.operation.remove`                                              | `{ partId, operationId }`                                                        | `{ warnings }`              |
| `design.operation.move`                                                | `{ partId, operationId, toIndex }`                                               | `{ warnings }`              |

- v0.1: `design.part.add` fails with `model.invariant` when the project already has a part; `design.drilling.add` adds one hole.
- `design.part.add` takes exactly one of `stockLibraryItemId` (a linked copy of a library block) and `stock` (since DF13: the block's values as in `library.stock.add`, quantity strings, bare numbers in the project's unit system; the part's own stock with no library link, [library.md § Snapshots](../architecture/library.md#snapshots)). Neither or both is `input.malformed` (rule `stockSource`).
- `remove` and `move` are shared by all operation types. Both fail with `design.referenced` (new error code, task 2.5) if a later operation would reference a removed or later surface; the error lists the dependants.
- `warnings` are the part's DFM parameter and tool warnings after the command ([below](#dfm-warnings-task-28-wiring)); they never make a command fail.
- Queries: `design.part.list` (ids and names, so an agent can find the part after reopening), `design.part.get`, `design.operation.list`, `design.warning.list { partId } → { warnings, evaluation, error? }` (the part's DFM warnings, [below](#dfm-warnings-task-28-wiring)). Job: `design.part.evaluate { partId }` evaluates the part now and waits ([workers.md](../architecture/workers.md#jobs-for-agents)). Hardening A6 adds `design.measure` (snap targets near a part-frame point, distances and angles; [llm-api.md § A6](../architecture/llm-api.md#a6-designmeasure-headless-snap-and-measure)).
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
- **`on`** exists on pockets and drillings only: facing always starts from `stock.top`, and a profile is a through cut whose tabs are measured from `stock.bottom`. (v0.2 gives profiles a stock face as `on`; v0.3 a blind `on` groove; since hardening DF53 an `outside`/`inside` profile with a `depth` is a step: [design-v0.3.md § Steps](design-v0.3.md#steps-blind-side-profiles-df53).) Valid targets: `stock.top`, the `floor` of an earlier facing or pocket, and existing tab tops of an earlier profile (`profile1.tab[0].top`). A wrong target of the edited operation is `model.invariant` (rule `onSurface`, params list the allowed ids).
- **Expression references** in design are `<surface>.z`, `.z.min` and `.z.max` of the horizontal planar surfaces of the stock and earlier operations: `stock.top`, `stock.bottom`, `facingN.floor`, `pocketN.floor`, `drillN.bottom` (flat only). Tab tops are reachable only through `on`: bracketed ids are not expression names. z comes from the analytic model (`on.z − depth`, tab top `−thickness + tabs.thickness`) with the explicit tolerances propagated worst-case; `.min`/`.max` are its limits, untoleranced. Design never names a tool or machine, so `tool.*` and `machine.*` are unknown references here (plan mode resolves them); project variables are not specified yet. (Changed 2026-11-21, user decision D11: design operations now carry a tool field, [design-v0.2.md](design-v0.2.md#operation-tool); `tool.*` stays unknown in design expressions, [design-v0.2.md § Expressions and the tool](design-v0.2.md#expressions-and-the-tool). v0.2 adds `.x`/`.y` names and bracketed ids such as `stock.side[1].x`: [design-v0.2.md § Formula names](design-v0.2.md#formula-names).)
- **Recalculation.** The dependency graph has a node per expression parameter (`pocket2#depth`, depends on its references) and per surface `.z` (depends on its `on` surface, its operation's parameters as a whole, `pocket1#params`, and each of its operation's expression parameters, so a chain through an operation's own formula – `facing1.floor.z` → `pocket1#depth` → `pocket1.floor.z` → `pocket2#depth` – is complete and ordered). After an update, `affectedBy(<op>#params)` gives the dependants, re-evaluated in that order in the same command (one undo step).
- **Check order of an edit:** quantity errors (`quantity.*`, `expression.*`, issue path = parameter) → the edited operation's constraints (`model.invariant`, every invalid field at once) → references of all operations (`design.referenced`) → recalculation → constraints of the other operations (`model.invariant`, paths `operations.<id>.<param>`). Any failure leaves the document unchanged.
- **`design.referenced`** has one issue per broken reference (path `operations.<id>.<param>`, params `{ operationId, reference }`) and lists the dependants in its data. It also stops an update that removes a referenced surface (fewer tabs, a profile side change, a drill bottom that is no longer flat).
- **Drilling:** a `depth` for `through` or a `pointAngle` for another bottom than `drillPoint` is invalid (rule `notForBottom`); changing `bottom` drops the unused ones and `drillPoint` defaults the angle to 118°. "Bottom above `stock.bottom`" uses the full-diameter depth.
- **Profile:** "all tabs fit" is `count × width < perimeter` of the shape, skipped when an `inside` slot covers the opening (no tabs are built); the corner radius rule of a pocket applies to the profile shape too.
- **Updates** replace `shape` as a whole (an omitted `cornerRadius` takes the default, or stays Round on a Round rectangle); `tabs` merges field by field.
- **Round (DF120):** a rectangle's `round: true` (or `cornerRadius: "round"`) makes `cornerRadius` half the narrowest side, kept so by every edit and recalculation; a radius above that turns Round on and the result reports `adjusted`, unless the edit sets `round: false` ([hole-slots-and-round-corners.md § Apply rule](hole-slots-and-round-corners.md#apply-rule)). Pocket and profile results carry `round` and `adjusted`.
- **General tolerance** is `{ length?, angle? }`, each a deviation ≥ 0 (`"0.1 mm"` = ±0.1 mm), `null` clears it. `effectiveTolerance` walks operation → part; the project scope comes with project settings.
- **`design.part.add`** reads the library synchronously (`services.library.lookup`) to take the snapshot ([commands.md](../architecture/commands.md#command-definition)).
- **Not in 2.5:** DFM warnings and `design.warning.list`; wired after task 2.8 ([below](#dfm-warnings-task-28-wiring)). Constraints are only the hard parameter errors of the tables above.

### DFM warnings (task 2.8 wiring)

- **Parameter and tool warnings** come from `parameterChecks` ([geometry.md](../architecture/geometry.md#parameter-and-tool-checks)) on the part's geometry input (`toGeometryInput`), computed fresh on every call and never stored. Tools: every readable tool item of the library (`services.library`; files that do not load are skipped), reduced to `DfmTool` in canonical mm (`type`, `diameter`, the bull-nose `cornerRadius`). Unit system: the project's `ProjectDoc.unitSystem` (`mm` → metric thresholds, `inch` → inch ones), as `loadPart` returns it.
- **Command results carry them.** Every design command on a part (`design.part.update`, each `add`/`update`, `design.operation.remove`/`move`) returns `warnings` for that part after the command, so an agent sees the effect of an edit at once without a second call. `design.part.add` does not: an empty part has none. A warning never fails or rolls back a command; without a library service the commands check against an empty library (geometric rules only). The warnings are part of the command's result value, not of the document, so undo/redo do not replay them – query again after undo.
- **`design.warning.list { partId } → { warnings }`** returns the same list for the current document and the current library, so it also reflects library edits, which never change the document. It fails with `input.malformed` for an unknown part and `internal.unexpected` without a library service (like `design.part.add`).
- **Geometry warnings** (`dfm.loosePiece`, `dfm.retainedRemoved`, `dfm.surfaceCutAway`) come from the part's evaluation, which runs automatically on the geometry worker after design edits ([workers.md](../architecture/workers.md#automatic-evaluation-after-design-edits)); neither the commands nor this query run it. The mapper fills `PartGeometryInput.references` from `on` and the expression references (one entry per operation, parameter and surface) and `dependants` per referenced surface (`surfaceDependants`) for [construction surfaces](construction-surfaces.md) and `dfm.surfaceCutAway`.
- **Merging (task 2.9):** `design.warning.list` appends the warnings of the evaluation of the part's current input (by input hash) to the parameter warnings, ordered by operation (design order), parameter warnings first within an operation (`mergeWarnings` in `evaluation.ts`). The two code sets are disjoint, so nothing is deduplicated. The result also says whether that evaluation is current: `evaluation: 'done' | 'pending' | 'failed'` (with `error` when failed; geometry warnings only when `done`), so an agent knows when they are still missing; `design.part.evaluate` waits for them. Command results keep the synchronous warnings only: they never wait for the worker.

## Design UI (task 3.6)

How the design mode screens use the commands above; UI rules in [ui.md](../conventions/ui.md#design-mode-task-36), code in `src/renderer/src/modes/design/`.

- **Stock setup:** a project without a part shows the stock setup (since D45 in the Stock dialog, which opens by itself for a new project, [ui.md § Design sidebar and setup dialogs](../conventions/ui.md#design-sidebar-and-setup-dialogs-v04-d45)): part name, the block (length, width, thickness, material name and class), optionally filled from a library stock, "Save to library" and "Create part" (`design.part.add`, which takes the snapshot: linked to an unchanged library stock, else the project's own block). Nothing is added to the library unless asked (dogfood DF11–DF13, [ui.md § Stock dialog](../conventions/ui.md#stock-dialog-df11df13)); until then a new block was added with `library.stock.add`.
- **Operation navigator:** the operations in design order under a one-line read-out of the part (selecting it selects nothing: the inspector shows the part) and its stock ([ui.md § Design sidebar and setup dialogs](../conventions/ui.md#design-sidebar-and-setup-dialogs-v04-d45)). "Add" (its Operations group; while empty, one button per kind; v0.4 adds a Features group, [ui.md § Features (v0.4)](../conventions/ui.md#feature-rows-and-add)) dispatches `design.<kind>.add` with values that fit the stock (facing: defaults, or the [depth down to the reference](reference-model.md#facing-depth-from-the-reference-df4) when there is one; pocket: a third of the stock in the middle, depth a quarter of the thickness; drilling: a 6 mm / 1/4″ through hole at a quarter of the length and a third of the width; profile: an outside rectangle 4 slot widths smaller than the stock) and selects the new operation, so the user edits it at once. With a **face selected** in the viewport (DF22, [ui.md § Selection and picking](../conventions/ui.md#selection-and-picking)) Add creates the operation on that face: `on` is the face for a pocket or drilling (and for Add → Hole), the stock face of the same direction for a facing or profile, and the values above are taken from the face's rectangle (`localStock`) and the material below the face instead of the top's. Reorder (`design.operation.move`, by dragging the row's grip or `Alt+↑/↓`, [ui.md § Reordering lists](../conventions/ui.md#reordering-lists-d45); a move that breaks a reference fails with `design.referenced`, shown under the list, and changes nothing), remove (`design.operation.remove`, undo toast). Several top-level rows can be selected together (Cmd/Ctrl-click, Shift-click; DF135) for bulk marks, switches and Remove, each one undo step ([ui.md § Multi-select in the Design navigator](../conventions/ui.md#multi-select-in-the-design-navigator-df135)).
- **Inspector:** one `QuantityInput` per parameter in the groups of the tables above; a commit is one `design.<kind>.update` with that parameter (a shape or drilling center as a whole, tabs field by field), so one undo step. `on` is a list of the eligible surfaces with a pick button; formula fields offer `<surface>.z` of the stock and earlier operations and pick them in the viewport. Shape kind, drill bottom (a depth of 1 × diameter is added when leaving `through`) and profile side are segmented controls or lists, each one command.
- **Warnings:** `design.warning.list` after every revision and evaluation change, shown at the parameter (with "Apply" for a suggestion), as a row badge, in the part summary and in the status bar list.

## Retained regions: tabs and fillets

Cutout operations (profile, straight/curved line and shape cuts) may include **tabs**, and pockets may leave **fillets**. Both use one mechanism – [geometry.md#cutting-operation-framework](../architecture/geometry.md#cutting-operation-framework).

## Carving and engraving (later)

Carving and engraving work from **vectors** (SVG/DXF or drawn paths); raster images are traced to vectors on import. Each operation (engraving, V-carving, vector relief) has a profile and a tolerance; plan mode expands it into passes – [geometry.md#carving-and-engraving-vector-based](../architecture/geometry.md#carving-and-engraving-vector-based).
