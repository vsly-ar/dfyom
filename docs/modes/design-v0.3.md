# Design mode v0.3: shapes

Status: accepted (user, D29 of 2026-11-22: S-A to S-L and Q22–Q25 as recommended, [Decisions](#decisions)); the shape model and `design.shape.*` are implemented ([§ Implementation (K2)](#implementation-k2)), pockets and profiles take shapes ([§ Implementation (K3)](#implementation-k3); their solids and toolpaths come with G1, T1, T2); the UI is not yet · Scope: [roadmap v0.3](../roadmap.md#v03--shapes) (D16: Q12, Q14, Q16) · v0.2 base: [design-v0.2.md](design-v0.2.md) · 2D layer, geometry and import: [architecture/shapes.md](../architecture/shapes.md) · Toolpaths: [plan-v0.3.md](plan-v0.3.md) · 2D library: [ADR 0019](../decisions/0019-2d-geometry-library.md) (accepted) · Tasks: [plans/v0.3.md](../plans/v0.3.md) · Terms: [glossary.md](../glossary.md)

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
- **Later:** offset items (an outline grown by a distance), mirror, ellipse as a primitive, text, a shape library across projects.

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
- `tabs.count` spaces them evenly (default, as v0.1). `tabs.positions?: Quantity[]` places them freely (S-I); given positions replace the count. Each tab must lie on the loop with its width, and tabs must not overlap (`model.invariant`, rules `tabOutside`, `tabsOverlap`).
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

- Corner checks are the familiar "minimum inside radius vs tool" rule. The fix offers "Round corners to ≥ r" (adds or raises `fillets` / `cornerRadius`), as the v0.1 suggestion does.
- The [auto tool choice](design-v0.2.md#auto-choice) ranks fitting tools that leave no rest material first, then by diameter.

## SVG import

- `design.shape.import { partId, path, options }` reads an SVG file (paths, `rect`, `circle`, `ellipse`, `polygon`, `polyline`, `line`; transforms; nested groups) in the dispatcher's prepared input, as the reference import does ([commands.md § Prepared input](../architecture/commands.md#prepared-input)).
- Units come from the root `width`/`height` with units and the `viewBox`; unitless files assume 96 px per inch (CSS) with an option to override (mm, inch, px at 72/96 dpi).
- Each closed subpath becomes a closed `path` item, open subpaths open paths; fills combine by the element's `fill-rule` (outer loops `add`, holes `subtract`), and the elements of one shape combine even-odd, so a circle drawn as its own element inside an outline is a hole; fill colours and strokes are ignored. Options: one shape per file, per top-level element (default), or per loop (an outer loop with its holes); open paths are shapes of their own. The shape frame is the page in mm, y up from its bottom-left corner ([shapes.md § SVG import](../architecture/shapes.md#svg-import)).
- Lines and circular arcs stay exact (arcs over 180° split in two); quadratic and cubic Béziers and elliptical arcs become **tangent-continuous arcs** (biarcs) within 0.01 mm, except at cusps, which stay true corners ([shapes.md § Arc fitting](../architecture/shapes.md#arc-fitting)).
- The **import report** (result and a dialog): elements imported and skipped (text, images, clip paths, strokes without fill as open paths), Béziers fitted (count, max deviation), corners kept at cusps and micro corners merged, loops repaired (self-intersections, tiny segments), the size read and the unit assumed. The SVG is not stored; the shape keeps `source: { file, element }` for information.

## Measure and snap

Toward the [direction](../roadmap.md#direction) (S-L; scope in [Q23](#answered-questions); bounded, and the first item cut if v0.3 runs long, [plans/v0.3.md § Risks](../plans/v0.3.md#risks-and-spikes)):

- **Snap** while dragging in the Shape Editor or the viewport: grid (a setting), shape points (ends, centres, midpoints), stock edges and corners, and the **reference section**: the [reference model](reference-model.md)'s outline cut by the face plane at a chosen depth (computed in the worker from the mesh). Snapping never changes a value's unit or source format beyond what the user typed.
- **Measure:** point-to-point and point-to-edge distances in the viewport on the part, stock and reference, shown in the project units; nothing is stored.
- Fitting arcs to a reference section automatically ("trace the reference") is assisted recreation, later.

## Commands and queries (v0.3)

Names per [commands.md § Naming](../architecture/commands.md#naming); `document` commands unless noted; results carry `warnings` of the part. One gesture = one command.

| Command / query                                   | Args                                                                                                                                                     | Result                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `design.shape.add`                                | `{ partId, name?, items }`                                                                                                                               | `{ shapeId, warnings }`                                                                 |
| `design.shape.update`                             | `{ partId, shapeId, name?, items? }` – replaces the item list                                                                                            | `{ warnings }`                                                                          |
| `design.shape.item.update`                        | `{ partId, shapeId, index, …parameters }` – one item's fields (the editor's commits)                                                                     | `{ warnings }`                                                                          |
| `design.shape.remove`                             | `{ partId, shapeId }` – fails with `design.referenced` while used                                                                                        | `{ warnings }`                                                                          |
| `design.shape.import` (prepared input)            | `{ partId, path, unit?, split? }`                                                                                                                        | `{ shapeIds, report, warnings }`                                                        |
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
- **Queries.** `design.shape.list { partId }` → per shape `id`, `name`, item count, `usedBy`, and when it resolves `kind`, `area`, `bounds`; `design.shape.get { partId, shapeId }` → `shape` (DTO), `usedBy`, and `resolved` (loops as elements in mm, area, bounds, smallest inside radius) or `issues`.
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
- **Not yet.** Parts with named or rotated shapes, profiles `on` and tab positions evaluate since G1 ([shapes.md § Implementation (G1)](../architecture/shapes.md#implementation-g1)); toolpaths of such operations fail with `plan.check` (`shapeToolpathLater`) until T1/T2; their parameter DFM checks come with K4; the renderer shows no outline for them and the inspector edits their placement only (UI tasks).
- **`tools/list`** after K3: 97.7 K of the 100 K budget ([llm-api.md](../architecture/llm-api.md#implementation-task-310)).

## Answered questions

Answered by the user with D29 (2026-11-22, every recommendation taken):

22. **Shape entry:** parametric items first: primitives + booleans + a typed line/arc path, dimensions as quantities, handles that edit those numbers (S-B, S-C). No constraint solver (coincident, tangent, parallel, dimensions driving a free sketch) in v0.3; it can be added later as another item kind without changing operations or persistence.
23. **Measure and snap:** in v0.3, bounded: snap to grid, shape points, stock edges and the reference section, and a point-to-point measure (S-L). Automatic tracing of the reference stays later. First to cut if v0.3 runs long.
24. **Open paths and blind grooves:** for `side: 'on'` only, with a blind `depth` allowed for `on` (a groove, an engraving line with a flat end mill). Inside/outside stay closed and through.
25. **SVG or DXF:** SVG in v0.3; DXF (LINE, ARC, CIRCLE, LWPOLYLINE with bulges, SPLINE) right after.

The ADR 0019 build (Q26) and the exit-criteria part (Q27) are recorded in [plans/v0.3.md § Confirmed decisions](../plans/v0.3.md#confirmed-decisions).
