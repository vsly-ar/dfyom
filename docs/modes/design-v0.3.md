# Design mode v0.3: shapes

Status: implemented (v0.3; accepted by the user, D29 of 2026-11-22: S-A to S-L and Q22–Q25 as recommended, [Decisions](#decisions)): the shape model and `design.shape.*` ([K2](#implementation-k2)), shapes on pockets and profiles ([K3](#implementation-k3)), `design.shape.import` ([I1](#implementation-i1)), the Shape UI ([U1](#implementation-u1), [U2](#implementation-u2), [U3](#implementation-u3)) and the exit-criteria flow through the UI ([X2](#implementation-x2)); the Shape UI's visuals await the user's review (L3, [ui.md § Shapes (v0.3)](../conventions/ui.md#shapes-v03)); what was not built is listed under [Implementation (X2)](#implementation-x2) · Scope: [roadmap v0.3](../roadmap.md#v03--shapes) (D16: Q12, Q14, Q16) · v0.2 base: [design-v0.2.md](design-v0.2.md) · 2D layer, geometry and import: [architecture/shapes.md](../architecture/shapes.md) · Toolpaths: [plan-v0.3.md](plan-v0.3.md) · 2D library: [ADR 0019](../decisions/0019-2d-geometry-library.md) (accepted) · Tasks: [plans/v0.3.md](../plans/v0.3.md) · Terms: [glossary.md](../glossary.md)

v0.3 replaces "a pocket or profile is a rectangle or a circle" with **named shapes** of lines and arcs. Everything not mentioned here stays as in [design.md](design.md) and [design-v0.2.md](design-v0.2.md): face targets, face frames, placement anchors, the tool field, Apply.

## Decisions

Settled with the user when this doc was accepted (D29, 2026-11-22: every recommendation taken); the sections below specify them. Q22–Q25 are recorded under [Answered questions](#answered-questions).

| Id  | Decision                                                                                                                                                                                                   | Section                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| S-A | A shape is a **part-level named record** with its own 2D frame; operations reference it by id and place it on their face. One shape can serve several operations (a pocket and the profile around it).     | [What a shape is](#what-a-shape-is)                     |
| S-B | Entry is **parametric**: primitives combined by ordered booleans, plus a **path** item typed as a list of line and arc segments. No sketch constraint solver in v0.3 ([Q22](#answered-questions)).         | [Shape definition](#shape-definition)                   |
| S-C | Dimensions are quantities and may be expressions over surfaces, as operation parameters are; there are **no geometric constraints** (parallel, tangent, coincident). Positions use anchors.                | [Constraints](#constraints)                             |
| S-D | A shape is drawn **as seen from outside the face** it is placed on ([face frame](design-v0.2.md#face-frame)), so text-like and asymmetric shapes read correctly on every face.                             | [Placing a shape on a face](#placing-a-shape-on-a-face) |
| S-E | Every pocket and profile shape may be **rotated** by any angle; a rotated rectangle goes through the general loop path.                                                                                    | [Placing a shape on a face](#placing-a-shape-on-a-face) |
| S-F | Profiles cut `outside`, `inside` or `on` (the centreline, Q12). An **open** shape is allowed only with `on` ([Q24](#answered-questions)).                                                                  | [Cut side](#cut-side-and-open-shapes)                   |
| S-G | A pocket takes a closed shape with any number of loops: holes in the region are **islands** left standing.                                                                                                 | [Operations](#operations-that-take-a-shape)             |
| S-H | A profile takes one closed loop (or one open path); a region of several loops needs one profile per loop.                                                                                                  | [Operations](#operations-that-take-a-shape)             |
| S-I | **Free-form tabs**: positions along the loop, entered or dragged; `tabs.count` spacing stays the default. No floor fillets on shapes (Q16).                                                                | [Tabs](#tabs-on-shapes)                                 |
| S-J | Only floors and tab tops have stable surface ids; walls of a shape operation are numbered for display and may renumber after a shape edit (walls are not face targets, [D12 A](design-v0.2.md#decisions)). | [Surfaces](#surfaces)                                   |
| S-K | **SVG import** creates a shape of path items (Béziers and ellipses become tangent arcs, biarcs) with an import report; DXF later ([Q25](#answered-questions)).                                             | [SVG import](#svg-import)                               |
| S-L | **Measure and snap** (roadmap direction): snap to the grid, shape points, stock edges and the reference model's section; a measure tool for distances ([Q23](#answered-questions)).                        | [Measure and snap](#measure-and-snap)                   |

## What a shape is

- A **shape** is a named 2D figure in its own **shape frame** (`x` right, `y` up, origin where the user puts it), defined by a [shape definition](#shape-definition) and resolved by the 2D layer into either a **region** (closed loops: one or more outer loops counter-clockwise, holes clockwise, never crossing) or an **open path** (one chain of lines and arcs). Resolution and normalisation: [shapes.md § Resolving a shape](../architecture/shapes.md#resolving-a-shape).
- Shapes belong to a **part** (`part.shapes[]`) and are listed in the navigator above the operations. They never make geometry on their own; an operation that references one does.
- Ids follow [design.md § Implementation](design.md#implementation-task-25): `shape1`, `shape2`, …; default names "Shape 1"; an imported shape takes the SVG element's id or label.
- A shape referenced by an operation cannot be removed (`design.referenced`, like a referenced surface).
- Kept from v0.1: the inline `rectangle` and `circle` of pockets and profiles. They stay the fast path for the common case and need no shape record; "Convert to shape" turns one into a named shape (one undo step).

## Shape definition

An ordered list of **items**. Each item is a primitive or a path, combined with what came before by its `op`:

| Item        | Parameters (quantities in the shape frame)                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rectangle` | `center`, `length`, `width`, `cornerRadius` (as v0.1), `rotation`                                                                                                  |
| `circle`    | `center`, `diameter`                                                                                                                                               |
| `obround`   | `center`, `length`, `width`, `rotation` (a slot shape: two half circles joined by straight sides)                                                                  |
| `polygon`   | `center`, `sides` (3–64), `diameter` across corners or across flats, `cornerRadius`, `rotation` (regular polygon)                                                  |
| `path`      | `start: [x, y]`, `segments[]`, `closed`, optional `fillets[] { vertex, radius }`; segment = `line { to }`, `arc { to, radius, cw, large? }` or `tangentArc { to }` |

- **Booleans:** `op` is `add` (union), `subtract` (difference) or `intersect`; the first item is always `add`. Booleans need closed items; a shape with an open path has exactly one item.
- **Corner fillets** on paths and polygons round a vertex with a tangent arc (industry "fillet"); a radius too large for its neighbours is `model.invariant`, rule `filletTooLarge`.
- **Invariants** (`model.invariant`, path `shapes.<id>.items.<n>.<param>`): sizes > 0; an `arc` radius ≥ half its chord (`arcRadius`); segments longer than ε (`segmentTooShort`); a closed path that crosses itself (`shapeSelfIntersects`, [shapes.md](../architecture/shapes.md#validity)); a result with no area (`shapeEmpty`).
- **Later:** offset items (an outline grown by a distance; drafted in [design-llm-first.md](design-llm-first.md#offset-item)), mirror, ellipse as a primitive, text, a shape library across projects.

### Constraints

No geometric constraint solver in v0.3 (S-C). What a sketcher's constraints give is covered this way:

- **Dimensions** are quantities (tolerances, units, expressions over surface levels as in [design.md](design.md#implementation-task-25)); `tangentArc` gives tangency, `fillets` give tangent corners, primitives give symmetry and parallel sides.
- **Positions** of items are explicit coordinates; the operation's [anchor](design-v0.2.md#placement-anchors) places the whole shape.
- References between shapes (`shape1.items[0].length`) and drag-to-solve sketching are later ([Q22](#answered-questions)).

## Placing a shape on a face

A pocket or profile `shape` gains a third kind, `named`:

```text
shape = rectangle { center, length, width, cornerRadius, rotation? }
      | circle    { center, diameter }
      | named     { shapeId, center, rotation?, mirror? }
anchor?          (top-level arg, as v0.2)
```

- The shape frame is laid onto the operation's [face frame](design-v0.2.md#face-frame): shape `x` → `u`, `y` → `v`, seen from outside the face (S-D). `mirror: true` flips `x` (for a part cut from the bottom that must match a top drawing).
- **`rotation`** (angle, counter-clockwise seen from outside, about the anchor point) applies to named shapes and rectangles (S-E). The anchor uses the bounding box of the **placed, rotated** shape in the face frame (what the user sees), so v0.2's rules hold: changing the anchor keeps the geometry, size and rotation edits keep the anchor point.
- `on`, `depth`, overshoot and the access checks are unchanged ([design-v0.2.md § Faces](design-v0.2.md#faces-and-face-targets)).

## Cut side and open shapes

| Profile `side` | Slot of `slotWidth`                          | Shape                        | Default `slotWidth`        |
| -------------- | -------------------------------------------- | ---------------------------- | -------------------------- |
| `outside`      | beside the loop, outside it (part outline)   | one closed loop              | 6 mm / 1/4″ (as v0.1)      |
| `inside`       | beside the loop, inside it (opening)         | one closed loop              | 6 mm / 1/4″                |
| `on` (new)     | centred on the loop or path (centreline cut) | one closed loop or open path | the tool diameter at Apply |

- **`on` is a groove** cut along a line, the CAM "on-line" or "no compensation" profile. Through (as every profile in v0.2, `depth` = stock extent) or, new for `on` only, a blind `depth` below `on` for a groove that does not cut through ([Q24](#answered-questions)).
- **Open paths** have two ends; the slot gets round ends of `slotWidth` / 2 (the tool's footprint). `tabs` are allowed on a through `on` cut of a closed loop only (an open through groove holds nothing apart).
- `side` changes keep `slotWidth`; a closed loop becoming open (path edit) with `inside`/`outside` is `model.invariant`, rule `openNeedsOn`.

## Operations that take a shape

| Operation | Shape kinds                                            | Changes from v0.2                                                                                                                               |
| --------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Pocket    | rectangle, circle, named closed region (several loops) | Holes of the region are **islands** at full height. `floorRadius` must be 0 for named shapes (`model.invariant`, rule `floorRadiusShape`; Q16). |
| Profile   | rectangle, circle, one named closed loop or open path  | `side: 'on'`; free-form tabs; a region with several loops fails with rule `profileOneLoop` (make one profile per loop, S-H).                    |
| Facing    | none                                                   | –                                                                                                                                               |
| Drilling  | none                                                   | –                                                                                                                                               |

The generated pass strategies are in [plan-v0.3.md](plan-v0.3.md).

### Tabs on shapes

- Positions are distances along the loop from its **start point**: the loop point with the lowest `v` (then lowest `u`) in the face frame, so the first tab is "at the front" as on v0.1 rectangles; the distance runs counter-clockwise seen from outside.
- `tabs.count` spaces them evenly (default, as v0.1); since v0.4 a counted tab over a side where the slot leaves no stock moves to the nearest side that holds ([design-v0.4.md § Tabs relocate off free sides](design-v0.4.md#tabs-relocate-off-free-sides-tb1)). `tabs.positions?: Quantity[]` places them freely (S-I); given positions replace the count. Each tab must lie on the loop with its width, and tabs must not overlap (`model.invariant`, rules `tabOutside`, `tabsOverlap`).
- The viewport shows tab markers that drag along the loop (one gesture, [commands.md § Gestures](../architecture/commands.md#gestures-live-edits)).

### Surfaces

- Stable as today: `<op>.floor`, `<op>.tab[i].top`, `<op>.tab[i].end[0|1]` (tab index = tab order from the start point), the stock's ids. These are what `on` and formulas use.
- Islands add no surface ids: an island is uncut material, its top stays the surface it stood on (`stock.top`, `facing1.floor`).
- Walls and corners of a shape operation are `wall[i]` / `corner[i]` per element of the resolved loops, for display and DFM markers only: `i` is the **element index across all loops** in element order, the outer loop (loop 0, from the start point, counter-clockwise) first, then the holes – one index space for both roles (lines → `wall[i]`, arcs → `corner[i]`), as spike S3 built it ([shapes.md § Geometry](../architecture/shapes.md#geometry-for-shape-operations)). Recommended over counting per role as rectangles do (`wall[0..3]`, `corner[0..3]`). Ids may renumber whenever the shape or its resolution changes; nothing may reference them (S-J; walls are not face targets).

## DFM checks for shapes

Parameter checks stay synchronous in the commands ([geometry.md § Parameter and tool checks](../architecture/geometry.md#parameter-and-tool-checks)): the 2D layer is fast enough for the command step ([shapes.md § Performance](../architecture/shapes.md#performance)). Rules that read a rectangle or circle read the resolved loops instead:

| Code                                        | Rule for shapes                                                                                                                                                                                                                                                                                                            | Severity |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `dfm.cornerSharp`, `dfm.cornerTooSmall`     | Every **inside corner of the cut** (a sharp vertex or an arc of radius below the tool radius where the material wraps round the tool: pocket region corners, an outside profile's concave notches, an opening's corners) is checked; `params.at` = `[u, v]` for the marker, one warning per corner up to 10, then a count. | warning  |
| `dfm.toolUnfit` (`cornerRadius`, `width`)   | Against the operation's tool: the smallest inside corner radius and the region's narrowest width (the region eroded by the tool radius is empty) ([fit table](design-v0.2.md#fit-when-a-tool-can-make-the-operation)).                                                                                                     | warning  |
| `dfm.pocketNoToolFits`, `dfm.slotNoTool`    | Narrowest size = the region's width as above, against the smallest library end mill.                                                                                                                                                                                                                                       | warning  |
| `dfm.restMaterial` (new)                    | With the operation's tool, the cut leaves material away from corners: necks narrower than the tool between two parts of the region. `params.area`, `params.at`. Corners are the corner rules' job.                                                                                                                         | warning  |
| `dfm.shapeOutsideFace` (new)                | A pocket's placed shape reaches outside the face rectangle of its direction (v0.2 checks holes only).                                                                                                                                                                                                                      | warning  |
| `dfm.slotLeavesStock`, `dfm.slotOpensStock` | Stock margin measured from the loop's offset by `slotWidth`, not its bounding box.                                                                                                                                                                                                                                         | as v0.2  |
| `dfm.shapeHeavy` (new)                      | The shape operation's flattened chords exceed the evaluation budget (≈ 3 000 chords, [shapes.md § Performance](../architecture/shapes.md#performance)): the part updates more slowly. `params.chords`. Decided with D29 ([shapes.md § Decisions](../architecture/shapes.md#decisions-d29)).                                | info     |

- Corner checks are the familiar "minimum inside radius vs tool" rule. The fix offers "Round corners to ≥ r" (adds or raises `fillets` / `cornerRadius`), as the v0.1 suggestion does; a corner that cannot take r gets the largest radius it takes instead (core `maxCornerRadius`), and the fix says the warning stays ([ui.md § Implementation (U2)](../conventions/ui.md#shape-in-the-operation-inspector)). The warnings name `parameter: 'shape'` with `suggestion: atLeast(r)`; the 11th and later corners share one warning with `params.more` (their count) and `params.points` (their markers as flat `u, v` pairs), so the viewport can still mark each.
- Width rules read the region eroded by the tool radius (less 0.005 mm, so a slot as wide as the tool fits); `params.narrowest` is twice the largest inscribed radius (to 0.001 mm).
- `dfm.restMaterial` is one warning per operation at the tool field (`parameter: 'tool'`): `params.area` (total, mm²), `params.at` (the largest piece), `params.pieces`, `params.points`. It needs a tool of the right type that enters the region: after a failed type or width rule it is not reported (corner, floor and reach failures still show it). Pockets and `inside` profiles check their region, `outside` profiles the band round the loop (narrow notches); `on` grooves none.
- `dfm.shapeOutsideFace` (`parameter: 'center'`, `params.sides` as `dfm.slotOpensStock`, `params.by` mm) applies to general pockets only: a v0.1 rectangle or circle reaching over the edge stays silent as in v0.2 (an open-sided pocket cuts a rebate).
- Slot margins: the offset of a loop by `slotWidth` reaches exactly `slotWidth` beyond the loop's exact bounding box on each side (arc extremes included), so the margin per stock side is measured from those bounds, not from the shape's anchor box. Tab rules apply to through cuts of closed loops (`outside`, `inside`, closed `on`); `tabs.positions` count as tabs.
- The [auto tool choice](design-v0.2.md#auto-choice) ranks fitting tools that leave no rest material first, then by v0.2's order (preset for the material class → largest diameter → id); the candidates list says "leaves rest material". The generalized fallback is the largest standard size that fits and leaves no rest material, else the largest that fits. A current tool that fits is still kept (rest material is a warning, not a fit rule). Shapes use the [fit table](design-v0.2.md#fit-when-a-tool-can-make-the-operation) with the region's width and smallest inside corner of the cut (pockets; profiles `inside` and `outside`).
- Implementation: [shapes.md § Implementation (K4)](../architecture/shapes.md#implementation-k4).

## SVG import

- `design.shape.import { partId, path, unit?, split? }` reads an SVG file (paths, `rect`, `circle`, `ellipse`, `polygon`, `polyline`, `line`; transforms; nested groups) in the dispatcher's prepared input, as the reference import does ([commands.md § Prepared input](../architecture/commands.md#prepared-input)).
- Units come from the root `width`/`height` with units and the `viewBox`; unitless files assume 96 px per inch (CSS) with an option to override (`unit`: `mm`, `in`, `px72`, `px96`).
- Each closed subpath becomes a closed `path` item, open subpaths open paths; fills combine by the element's `fill-rule` (outer loops `add`, holes `subtract`), and the elements of one shape combine even-odd, so a circle drawn as its own element inside an outline is a hole; fill colours and strokes are ignored. Options (`split`): one shape per file, per top-level element (default), or per loop (an outer loop with its holes); open paths are shapes of their own. The shape frame is the page in mm, y up from its bottom-left corner ([shapes.md § SVG import](../architecture/shapes.md#svg-import)).
- Lines and circular arcs stay exact (arcs over 180° split in two); quadratic and cubic Béziers and elliptical arcs become **tangent-continuous arcs** (biarcs) within 0.01 mm, except at cusps, which stay true corners ([shapes.md § Arc fitting](../architecture/shapes.md#arc-fitting)).
- The **import report** (result and a dialog): elements imported and skipped (text, images, clip paths, strokes without fill as open paths), Béziers fitted (count, max deviation), corners kept at cusps and micro corners merged, loops repaired (self-intersections, tiny segments), the size read and the unit assumed. The SVG is not stored; the shape keeps `source: { file, element }` for information.

## Measure and snap

Toward the [direction](../roadmap.md#direction) (S-L; scope in [Q23](#answered-questions); bounded, and the first item cut if v0.3 runs long, [plans/v0.3.md § Risks](../plans/v0.3.md#risks-and-spikes)):

- **Snap** while dragging in the Shape Editor or the viewport: grid (a setting), shape points (ends, centres, midpoints), stock edges and corners, and the **reference section**: the [reference model](reference-model.md)'s outline cut by the face plane at a chosen depth (computed in the worker from the mesh). Snapping never changes a value's unit or source format beyond what the user typed.
- **Measure:** point-to-point and point-to-edge distances in the viewport on the part, stock and reference, shown in the project units; nothing is stored. U3 built point to point ([Implementation (U3)](#implementation-u3)).
- Fitting arcs to a reference section automatically ("trace the reference") is assisted recreation, later.

## Commands and queries (v0.3)

Names per [commands.md § Naming](../architecture/commands.md#naming); `document` commands unless noted; results carry `warnings` of the part. One gesture = one command.

| Command / query                                   | Args                                                                                                                                                     | Result                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `design.shape.add`                                | `{ partId, name?, items }`                                                                                                                               | `{ shapeId, warnings }`                                                                 |
| `design.shape.update`                             | `{ partId, shapeId, name?, items? }` – replaces the item list                                                                                            | `{ warnings }`                                                                          |
| `design.shape.item.update`                        | `{ partId, shapeId, index, …parameters }` – one item's fields (the editor's commits)                                                                     | `{ warnings }`                                                                          |
| `design.shape.remove`                             | `{ partId, shapeId }` – fails with `design.referenced` while used                                                                                        | `{ warnings }`                                                                          |
| `design.shape.import` (prepared input)            | `{ partId, path, unit?: mm\|in\|px72\|px96, split?: element\|file\|loop }`                                                                               | `{ shapeIds, report, warnings }`                                                        |
| `design.shape.convert`                            | `{ partId, operationId }` – inline rectangle or circle → named shape                                                                                     | `{ shapeId, warnings }`                                                                 |
| `design.<pocket\|profile>.add/update`             | as v0.2, plus `shape: { kind: 'named', shapeId, center, rotation?, mirror? }`, `rotation` on rectangles, profile `side: 'on'`, `depth`, `tabs.positions` | as v0.2                                                                                 |
| `design.shape.list`, `design.shape.get` (queries) | `{ partId, shapeId? }`                                                                                                                                   | definition, resolved loops (elements in mm), area, bounding box, smallest inside radius |

- Agents get the resolved loops from `design.shape.get`, so they can check a shape without the viewport ([principle 1](../principles.md#1-llm-first)).
- The `tools/list` budget (100 K, [llm-api.md](../architecture/llm-api.md#implementation-task-310)) must hold these; the item union is defined once (`$defs`).

## Apply and pending changes

- Shape edits are instant like operation edits: the shape resolves, the outline and mesh follow, parameter checks run ([apply.md § Rules for new reactions](../architecture/apply.md#rules-for-new-reactions)).
- **Pending keys** ([apply.md § What is pending](../architecture/apply.md#what-is-pending)): `(part, shape, item, field)` for item fields and `(part, shape)` for add, remove and item list changes. They are inputs of the tool choice, draft plan follow and toolpaths **of every operation that references the shape**; editing a shared shape counts once, not once per operation. The tooltip names them ("Cavity: item 2 radius").
- The auto tool choice on Apply targets the unlocked operations that reference a pending shape.

## Persistence

- `parts/<id>.json` gains optional `shapes: ShapeDTO[]` (`{ id, name, items[], source? }`, quantities as DTOs); pocket and profile shapes gain the `named` kind, `rotation?`, `mirror?`; profiles `side: 'on'` and `tabs.positions?`. Absent fields mean v0.2 behaviour, so existing projects load unchanged; **no `schemaVersion` change** (pre-alpha, [migrations.md](../conventions/error-handling/migrations.md#pre-alpha-exception-no-data-preservation-yet)).
- A `named` shape whose `shapeId` does not exist makes the part `input.malformed` (corruption, never repaired silently).
- Plans copy the part's shapes into their design snapshot ([plan-v0.1.md § Plans are snapshots](plan-v0.1.md#plans-are-snapshots)). Plan-only edits may change an operation's placement and shape reference, not shape definitions ([plan-v0.3.md](plan-v0.3.md#plan-side)).

## UI (summary)

Rules go to a [ui.md](../conventions/ui.md) amendment with the tasks ([plans/v0.3.md](../plans/v0.3.md)); intent:

- **Navigator:** a "Shapes" group above the operations (shape icon, name, "used by 2"); "Add" offers shapes (primitives, path, Import SVG…) and operations.
- **Shape Editor:** selecting a shape shows it flat in the viewport (orthographic, looking at the face of the first operation that uses it, with the stock face and the reference section as context, else its own frame); the inspector lists its items with `op`, the fields of the selected item and the path's segment table. Handles move points, radii and sizes; Shift constrains to 15°. Every commit is one `design.shape.item.update`.
- **Operation inspector:** a shape picker (inline rectangle/circle or a named shape), rotation, mirror, the `on` side, tab positions.
- Live outline: the renderer resolves shapes with the same 2D port ([shapes.md § Where the 2D layer runs](../architecture/shapes.md#where-the-2d-layer-runs)).

## Implementation (K2)

Code: [shapes.md § Implementation (K2)](../architecture/shapes.md#implementation-k2). Details the sections above left open:

- **Formulas over stock faces only.** Shape quantities may reference `stock.*` faces, not operation surfaces (`expression.reference` otherwise): shapes resolve independently of operations, so no cycle is possible ([shapes.md § Validity](../architecture/shapes.md#validity)).
- **Issue paths** in command errors are relative to the shape: `items.<n>.<param>` (e.g. `items.1.segments.2.radius`, `items.0.fillets.1.radius`, `items.2.closed`); the stored path is `shapes.<id>.items…`.
- **Defaults** (args may leave them out; stored items have them): `op: 'add'`, rectangle `cornerRadius` 3 mm / 1/8" (as v0.1), path `closed: true`, arc `cw: false`; polygon `across: 'corners'`, `cornerRadius` 0, `rotation` 0.
- **Conventions.** Rotation is counter-clockwise about `center`. A polygon at rotation 0 has a flat side at the bottom. A rectangle or obround at rotation 0 has `length` along x; an obround's `width` is its end diameter (`length ≥ width`). Path vertices are numbered 0 = `start`, i = end of segment i−1 (a closed path's vertex 0 joins its last segment or closing line to the first; a closing line starts at vertex n = segments.length; an open path's fillets go on inner vertices 1 … n−1). A `tangentArc` as first segment has no tangent (`tangentArcStart`); one whose end lies straight ahead is a line; one whose end lies behind the tangent cannot be drawn (`tangentArcReverse`).
- **Rules added** to the invariants above: `firstItemAdd` (`items.0.op`), `openPathAlone` (`items.<n>.closed`), `cornerRadiusRange` (≤ half the smaller side), `obroundLength` (length ≥ width), `range` (polygon sides 3–64), `filletNoCorner` (the neighbours are tangent there), `filletVertex` (out of range, duplicate, or an end of an open path), `tangentArcStart`, `tangentArcReverse`. A closing gap shorter than ε is `segmentTooShort` at `items.<n>.closed`.
- **`design.shape.item.update`** takes the kind's fields only (`input.malformed`, rule `notForKind`, for others); the item's kind cannot change (replace the list with `design.shape.update`). Only `items[index]` is written.
- **`design.shape.convert`** creates the shape (the item centred at the shape origin, quantities as entered); since K3 it also replaces the inline shape by the `named` one in the same undo step ([K3](#implementation-k3)).
- **Queries.** `design.shape.list { partId }` → per shape `id`, `name`, item count, `usedBy`, and when it resolves `kind`, `area`, `bounds`; `design.shape.get { partId, shapeId }` → `shape` (DTO), `usedBy`, and `resolved` (loops as elements in mm, area, bounds, smallest inside radius) or `issues`. A shape alone has no cut side, so `smallestInsideRadius` reads the region as a pocket: the smallest of its inside corners of the cut (convex vertices turning more than 5°, counter-clockwise arcs, an island's notches; [DFM checks for shapes](#dfm-checks-for-shapes)), 0 with a sharp corner, absent without corners.
- **Removing the last shape** removes `part.shapes`, so a part without shapes stays byte-identical to v0.2.
- **`tools/list`** with the seven `design.shape.*` tools: 94.9 K of the 100 K budget ([llm-api.md](../architecture/llm-api.md#implementation-task-310)).

## Implementation (K3)

Code: [shapes.md § Implementation (K3)](../architecture/shapes.md#implementation-k3). Details the sections above left open:

- **Args.** `shape` takes `{ kind: 'named', shapeId, center, rotation?, mirror?: true }`; rectangles take `rotation?`. Profiles take `side: 'on'`, `depth?` (a blind `on` groove; `null` = through again) and `tabs.positions?` (`null` returns to `count`). Positions in args are `[u, v]` in the face frame (on the top face X/Y of the part frame).
- **Placement.** A `named` shape keeps `center` as its anchor point; rotation turns about it; anchors name a point of the placed box ([Placing a shape on a face](#placing-a-shape-on-a-face)). `anchor` on update keeps the feature in place, also for named and rotated shapes. A rectangle at rotation 0 stays the v0.1 analytic shape.
- **Rules.** `unknownShape` (`input.malformed`, the `shapeId` is not in the part); `floorRadiusShape` (named pocket, `floorRadius` ≠ 0); `openNeedsOn` (an open path on a pocket, or on a profile not `on`); `profileOneLoop` (a profile's shape resolves to more than one loop, holes included); `onlyOn` (`depth` on a profile that is not `on`; a blind depth must stay inside the stock: `lessThanStockThickness`); `tabsNotAllowed` (`tabs.positions` on an open path or a blind groove); `tabOutside` (a position not in 0 ≤ s < loop length); `tabsOverlap` (two positions closer than `tabs.width` around the loop). `tabsFit` uses the loop length. The checks that need the loop length or loop count run where the 2D port is (design commands); plan commands re-checking a part without it skip them.
- **Tabs.** `tabs.count` spaces tabs evenly with the first half a spacing after the start point, so no tab straddles it (v0.1 rectangles keep their wall-middle rule until G1/T2 build general tabs). `count` is ignored on an open path or a blind groove (no tabs built); positions there are refused.
- **Convert** keeps `center`, `anchor` and a rectangle's `rotation`, so the placed box and the feature stay where they were; a pocket with a floor radius cannot be converted (`floorRadiusShape`), an operation that already places a shape neither (`alreadyNamed`).
- **Surfaces.** A blind `on` groove adds a `profile.floor` surface at its depth (G1), an `on` target like a pocket floor.
- **Not yet.** Parts with named or rotated shapes, profiles `on` and tab positions evaluate since G1 ([shapes.md § Implementation (G1)](../architecture/shapes.md#implementation-g1)); their toolpaths come from the region generators (T1/T2, [plan-v0.3.md § Wiring](plan-v0.3.md#wiring-t1-t2)); their parameter DFM checks come with K4; the renderer shows no outline for them and the inspector edits their placement only (UI tasks) – all built since (K4, U1, U2).
- **`tools/list`** after K3: 97.7 K of the 100 K budget ([llm-api.md](../architecture/llm-api.md#implementation-task-310)).

## Implementation (I1)

Code: [shapes.md § Implementation (I1 command)](../architecture/shapes.md#implementation-i1-command). Details the sections above left open:

- **Reading the file.** As the reference import: the agent, CLI or window passes an absolute local `path` (`absolutePath` otherwise); the command's prepared input reads and imports it in the worker task `svg.import` ([workers.md](../architecture/workers.md#what-runs-on-a-worker)), so `src/core` reads no file and the main thread does not parse. Undo and redo replay the shapes, never the file. Unreadable files are `unreadableFile`, importer errors keep their rules (`svgSyntax`, `svgNotSvg`, `svgViewport`, `svgEmpty`, `svgLimit`).
- **Shapes.** Every importer shape becomes a named shape (`shape<n>` numbering on), named after the element (else "Shape n"), with `source: { file: <file name>, element }`; each loop or open path one `path` item of `line` and `arc` segments (`op` from the fill: outer loops `add`, holes `subtract`; open paths `closed: false`). All shapes are added in one command, so one undo step removes the whole import. A shape with more than 1 000 loops (the item limit) is refused (`svgLimit` at `split`: import with `split: 'loop'`).
- **Values.** Literal mm sources rounded to 1 nm (`12.345678`; `12.345678 mm` in an inch project, so the exact value is kept); an arc's radius is never below half its rounded chord. The shape resolves through the 2D port like `design.shape.add`.
- **Result.** `{ shapeIds, report, warnings }`: `report` is the importer's `SvgImportReport` ([shapes.md § SVG import](../architecture/shapes.md#svg-import)) – counts imported/skipped by tag, Béziers and elliptical arcs fitted, max deviation, corners at cusps, merges, repairs, gaps closed, loops/open paths/lines/arcs, size, unit and `unitAssumed`, warnings with rule and element – and `warnings` the part's DFM warnings.
- **Window.** `bridge.files.chooseSvg()` (IPC `dfyom:file.chooseSvg`, `chooseSvgFile` in `src/main/file-dialogs.ts`, SVG filter, remembered folder `svg-import`) returns the picked path or null; the window then calls `design.shape.import` with it like an agent. The "Import SVG…" button and the report dialog are UI tasks.
- **`tools/list`:** +0.7 K (98.8 K measured with the work merged by then).
- **Known limit.** The importer's fill repair is quadratic in crossings: a path that crosses itself thousands of times (e.g. 2 000 random cubics) takes tens of seconds, beyond the task's 30 s timeout (`op.timeout`), and holds the project queue meanwhile ([commands.md § Prepared input](../architecture/commands.md#prepared-input) expects about a second).

## Implementation (U1)

UI rules and how they were settled: [ui.md § Implementation (U1)](../conventions/ui.md#implementation-u1). For this mode:

- **Shapes group** in the navigator: add (one menu per kind; Import SVG… disabled until `design.shape.import` is wired), select (opens the Shape Editor), remove (refused while used, with the reason).
- **Shape Editor:** the shape flat in its own frame (the face-on view of the first operation that uses it comes with U2), the inspector's item list, fields and the path's segment table; every field commit and every handle drag is one undo step (`design.shape.item.update`, a drag as one gesture). Rotation, fillet and polygon corner radius have fields but no handles yet.
- **Live outline** from the renderer's 2D port: the editor's outline while editing and dragging, and the 3D viewport's pending outline of operations with named or rotated shapes.

## Implementation (U2)

UI rules and how they were settled: [ui.md § Implementation (U2)](../conventions/ui.md#implementation-u2). For this mode:

- **Operation inspector:** the shape picker (inline or named, "New shape…", "Edit shape", "Convert to shape"), rotation, mirror, side On with the blind depth, and the shape's issues with their fixes ("Use side On", "Round corners to ≥ r" through `design.shape.item.update` for named items).
- **Tabs on shapes:** markers on the selected profile's loop, dragged or moved by keys as one undo step each; the Tabs group lists entered positions with "Space evenly" and "Add tab".
- **SVG import** from the Shapes group's menu, with the report reopenable from the shape inspector. The U1 note on Import SVG being disabled no longer holds.
- **Shape Editor** shows a used shape face-on, on the first operation's face, with the stock face and the face axes. The U1 note on "own frame only" no longer holds for used shapes.
- **Plan findings** for `plan.stepoverClamped` read in the project's units.

## Implementation (U3)

UI rules and how they were settled: [ui.md § Implementation (U3)](../conventions/ui.md#implementation-u3). For this mode:

- **Snap** in the Shape Editor (handle drags) and on tab markers: grid (the Snap grid setting, per unit system), shape points, stock edges and corners, and the reference section. Exact targets are written exactly in the value's unit; `Alt` or the window's "Snap" toggle drags freely.
- **Reference section** from the worker (`reference.section`): the first shown reference cut parallel to the edited shape's face at "Section depth" below it (default: the middle of the reference there). The matrix sent is the ghost's matrix followed by part → face frame (`sectionMatrix`), so the cut is exact for any rotation; the placed box is only used for the default depth.
- **Measure:** point to point in the Shape Editor (face axes) and in the 3D viewport (part, stock, references; X, Y, Z), in project units; nothing is stored. Point-to-edge is not built.
- **Reference backlog:** the ghost's feature edges are now computed in the worker with the mesh (`reference.meshStl` returns `edges`; the renderer's 0.4 s at the limit is gone, and every ghost has edges). Snapping and measuring use the exact mesh, but `reference.fit` and `exceedsStock` still use the placed box, so they stay conservative for free-angle rotations ([reference-model.md](reference-model.md#implementation-task-r3)).

## Implementation (X2)

The exit criteria's app flow runs through the UI only, in hidden windows ([testing.md § End to end](../conventions/testing.md#end-to-end), `e2e/golden-path-v0.3.e2e.ts`): the X0 drawing imported with **Import SVG…**, the cavity and outline picked as named shapes, the back wall measured in the face-on Shape Editor (a shape midpoint to a snapped point of the reference section), the cavity's step corners filleted in the segment table, the cable notch built from an obround and a rectangle and rotated on its pocket, tabs moved with the keys and typed as positions, and the open-path groove built in the segment table. Its two programs equal X1's goldens byte for byte, so the UI and the agent tools build the same part.

Fixed on the way:

- **"Round corners to ≥ r" refused silently.** The fix writes the tool radius; when the neighbouring segments cannot take it (`filletTooLarge`, the enclosure's step corners next to fitted arcs), the refusal's issues named shape-item fields the operation inspector does not show. The picker now says "The fillet does not fit between the neighbouring segments: round the corner with a smaller radius in the Shape Editor."
- **After X2** (the X2 findings): the "Round corners" fix rounds each corner to the tool radius or, where that does not fit, to the largest radius the corner takes (`maxCornerRadius` in `core/design/shape-items.ts`: bisection on the item resolver, so fitted arcs, neighbouring fillets and crossings count), and says when that is smaller than the tool radius (the warning stays). Picking an open path on a profile cutting Outside or Inside sets side On in the same update (one undo step) with a notice, instead of being refused ([S-F](#decisions): only On cuts an open shape, so the pick states the intent). A tab position typed while a marker's arrow-key run is still applying ends the run first, so its last step cannot overwrite the typed value.
- **Tab marker gestures ended early.** The markers' clean-up ran whenever the profile changed – also on the reply of a drag's or key run's own first step – so the rest of a drag was dropped and quick arrow keys lost steps (3 presses moved 2 mm). It runs on unmount only now.

Not built in v0.3 (later, or by decision):

- A constraint solver and references between shapes (Q22), offset items, mirror items, ellipse and text primitives, a shape library across projects ([Shape definition](#shape-definition)); DXF import (Q25: right after v0.3).
- Shape Editor handles for rotation, fillets and the polygon corner radius (fields only, [U1](#implementation-u1)); point-to-edge measure and snapping in the 3D viewport beyond the measure tool ([U3](#implementation-u3)); snap and measure have no headless command (an agent reads `design.shape.get`).
- "Round corners" has no fix for corners made where items meet, and rounds corners one after another (two corners sharing a short side: the first takes what fits, the second the rest); "New shape…" takes two undo steps; a moved tab marker has no live announcement and markers are not locked for positions written as expressions ([plans/v0.3.md § Known issues](../plans/v0.3.md#known-issues-and-risks)).

## Answered questions

Answered by the user with D29 (2026-11-22, every recommendation taken):

22. **Shape entry:** parametric items first: primitives + booleans + a typed line/arc path, dimensions as quantities, handles that edit those numbers (S-B, S-C). No constraint solver (coincident, tangent, parallel, dimensions driving a free sketch) in v0.3; it can be added later as another item kind without changing operations or persistence.
23. **Measure and snap:** in v0.3, bounded: snap to grid, shape points, stock edges and the reference section, and a point-to-point measure (S-L). Automatic tracing of the reference stays later. First to cut if v0.3 runs long.
24. **Open paths and blind grooves:** for `side: 'on'` only, with a blind `depth` allowed for `on` (a groove, an engraving line with a flat end mill). Inside/outside stay closed and through.
25. **SVG or DXF:** SVG in v0.3; DXF (LINE, ARC, CIRCLE, LWPOLYLINE with bulges, SPLINE) right after.

The ADR 0019 build (Q26) and the exit-criteria part (Q27) are recorded in [plans/v0.3.md § Confirmed decisions](../plans/v0.3.md#confirmed-decisions).
