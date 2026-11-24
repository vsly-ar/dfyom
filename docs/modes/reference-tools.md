# Reference tools: section, levels, holes, compare and fit for a reference model

Status: accepted (proposed 2026-11-23 for hardening [DF60](../plans/hardening.md); the user answered [Q70–Q80](#open-questions-for-the-user) on 2026-11-24 and took every recommendation); **P1 implemented** ([§ Implementation (P1)](#implementation-p1)), P2–P5 accepted, not built · Source: black-box test of 2026-11-23 (scaled enclosure in two setups, `.continuous/research/2026-11-23-enclosure-two-setup-test.md`, issues I-5 and I-11) · Base: [reference-model.md](reference-model.md) (import, placement, fit, the [reference-only rule](reference-model.md#rule-reference-only)) · Single owner of levels, sections and holes of a reference since Q71 ([reference-query.md](reference-query.md), the v0.4 follow-up draft, is folded in here); the simulated-cut deviation stays in [deviation.md](deviation.md) · Async queries: [ADR 0021](../decisions/0021-async-queries.md), [commands.md § Async queries](../architecture/commands.md#async-queries) · UI: [ui.md § Reference tools](../conventions/ui.md#reference-tools-df60) · Shapes and fitting: [shapes.md](../architecture/shapes.md) · Agent API and budget: [llm-api.md](../architecture/llm-api.md) · Hole feature: [design-v0.4.md § Hole feature](design-v0.4.md#hole-feature) · Terms: [glossary.md](../glossary.md)

## Problem

Turning a reference STL into a design is manual. In the 2026-11-23 black-box test the agent imported and fitted the STL with the app (`fit.scaleTo` and `margin` worked), then wrote ≈ 200 lines of its own Python to find everything else: the outline, cavity and step loops (Z sections), the floor depths (a horizontal-face histogram), the holes and their countersinks (sections and height maps), and it had to scale its own slices because its slicer read the raw file. Its loops went in as line paths of 183–287 vertices, so `design.shape.get` reported `smallestInsideRadius: 0` and the cavity's real step corners made the pocket untoolable without anyone saying where. At the end nothing could tell whether the design matched the STL.

What exists today (code, not drafts):

| Capability                                     | Where                                                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| STL parse, mesh in the worker, ghost           | `src/core/design/stl.ts`, worker tasks `reference.parseStl` / `reference.meshStl` ([reference-model.md](reference-model.md#ghost-mesh-task-r3)) |
| Fit to stock with margin and scale to fit      | `fitScale`, `fitPosition` in `src/core/design/reference.ts` ([§ Fit to stock](reference-model.md#fit-to-stock))                                 |
| Raw plane section (segments only, no loops)    | `meshSection` in `src/core/design/mesh-section.ts`, worker task `reference.section` (Shape Editor backdrop and snap, UI only)                   |
| Extreme point along a face normal              | `meshBounds` (facing-depth suggestion, [DF4](reference-model.md#facing-depth-from-the-reference-df4))                                           |
| Section → loops → cubic chains (**test code**) | `sliceMesh`, `fitLoop` in `src/core/design/enclosure-sections.testing.ts` (writes the enclosure sections SVG fixture)                           |
| Béziers → lines and arcs within a tolerance    | `fitCurve` / `biarc` in `src/core/import/svg/fit.ts` ([shapes.md § Arc fitting](../architecture/shapes.md#arc-fitting))                         |
| 2D regions (nesting, orientation, offsets)     | `Region2dPort` (`src/core/geometry/2d/port.ts`, CavalierContours)                                                                               |
| 3D booleans, pieces, volume                    | `SolidPort` (`src/core/geometry/solid-port.ts`: `fromMesh`, `subtract`, `intersect`, `decompose`, `volume`; manifold-3d behind `manifold/`)     |
| Labelled part mesh (surface id per triangle)   | [geometry.md § Surface ids in meshes](../architecture/geometry.md#surface-ids-in-meshes)                                                        |
| Height map (test oracle only)                  | `Heightmap` in `src/core/toolpath/testing/oracles.ts`                                                                                           |
| Headless measure and snap on the design        | `design.measure` ([llm-api.md § A6](../architecture/llm-api.md#a6-designmeasure-headless-snap-and-measure)); references are not covered         |

So every geometry kernel this doc needs is already a core port; what is missing is chaining, fitting into shapes, classification, comparison and the commands.

## Scope

Four tools, each for the UI and agents through one command layer ([commands.md](../architecture/commands.md)):

1. [**Section and levels**](#1-section-and-levels): cut the reference at a depth on a stock face and get closed loops as fitted shapes with their corner radii; list the flat levels seen from a face and from the opposite one.
2. [**Features (holes)**](#2-features-holes): detect cylindrical holes and offer them as Drilling or Bolt hole suggestions.
3. [**Compare**](#3-compare): deviation between the evaluated design and the reference, as compact regions for agents and a colour overlay in the viewport.
4. [**Scale and fit**](#4-scale-and-fit): what is left after DF5's fit (result fields, the small-feature check).

The [reference-only rule](reference-model.md#rule-reference-only) stands for all four: results are read-outs; a shape, depth or hole taken from them is an ordinary literal that never follows the mesh, and no check reads the reference.

## Decisions

Decided by the user on 2026-11-24 (Q70–Q80, every recommendation). RT-A takes over reference-query.md's RQ-A–RQ-E.

| Id   | Decision                                                                                                                                                                                                                                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RT-A | One query `design.reference.find` with a `kind` union (`levels`, `section`; `holes` with P3): one MCP tool instead of three. Section → shape is `design.shape.import { from }` beside the file path (the same command and import report, no new tool). Results are in the face frame of a stock face, depths positive into the stock, lengths in mm rounded to 0.001. |
| RT-B | (P2) A face may be named by a **setup** (`{ setupId }` = that setup's direction face); coordinates stay in the face frame unless `frame: 'setup'` asks for the setup's WCS ([§ Faces and frames](#faces-and-frames), Q73).                                                                                                                                            |
| RT-C | Fitted sections report **corner radii**: per loop the smallest fitted inside radius, the sharp inside corners with their positions, and the max deviation; the shapes made from them carry real arcs, so `smallestInsideRadius` is the fitted value (Q74).                                                                                                            |
| RT-D | `levels` returns both sides of the axis in one call by default (floors from the face and from the opposite face), each level with its **visible area** from each side (Q75).                                                                                                                                                                                          |
| RT-E | `holes` results carry a **suggestion**: the exact args of `design.hole.add` (Bolt hole, when the mouth is a counterbore or countersink or a fastener matches) or `design.drilling.add`, plus a Clones row when equal holes form a grid or circle. Nothing is added by itself (Q76).                                                                                   |
| RT-F | Compare of the **design** uses 3D booleans on the existing `SolidPort` when the reference mesh is closed (missing = reference − part, extra = part − reference, split into pieces), height maps when it is open; [deviation.md](deviation.md)'s height-map method stays for the simulated cut (Q77).                                                                  |
| RT-G | Agent results are **summaries by default** (counts, bounds, radii, worst regions); geometry only through `design.shape.import { from }` or the reserved `detail: "full"` arg ([llm-api.md § Result size](../architecture/llm-api.md#result-size)).                                                                                                                    |
| RT-H | Everything that reads the mesh runs in the compute worker on the mesh it keeps per asset (as `reference.section` does), so the queries are **async queries** (Q72, [ADR 0021](../decisions/0021-async-queries.md)): one call that resolves when the worker answers, not a job.                                                                                        |

## Faces and frames

- `face` is a stock face target (`stock.top`, `stock.bottom`, `stock.side[0]`–`stock.side[3]`; default `stock.top`), or (P2) `{ setupId }` of the part's plan: the face of that setup's direction ([plan-v0.2.md § Setups from face directions](plan-v0.2.md#setups-from-face-directions)). Operation surfaces are refused (rule `stockFaceOnly`).
- The **face frame** puts w = 0 at the stock face and the stock below it (`faceFrame(direction, stock)`; the section plane is w = −depth). Results are in that face's [face frame](design-v0.2.md#face-frame) (what `design.*.add` takes, so no conversion). With `frame: 'setup'` (only with `{ setupId }`) point results are also given in the setup's WCS (`setupFrame(direction, rotation, stock)` in `src/core/toolpath/wcs.ts`: rotation and work zero applied) under `wcs: [x, y]`, for reading against a program. Shapes are always made in the face frame (shapes live on faces, not setups).
- Depths are from the stock face at the stock level (0 = the face, positive into the stock). After a [facing or an earlier setup](plan-v0.2.md#material-removed-by-earlier-setups) the stock face is still the datum: the query reads the reference, not the remaining stock.

## 1. Section and levels

### Levels

`design.reference.find { partId, referenceId?, face?, kind: 'levels', sides?: 'both' | 'face', minArea?: 1 (mm²), limit?: 32 }`:

- The mesh's triangles whose normal lies within 0.5° of the face's axis (±n), grouped into **levels** by height; each level's `depth` is below the face at the stock level (0 = the stock face; negative above it, when the reference sticks out), `area` in mm², `bounds` in the face frame. Levels under `minArea` are dropped; at most `limit` (largest areas win, `more: n` when cut), sorted by depth.

- **Both sides by default** (`sides: 'both'`): one pass over the triangles gives the levels facing the face (floors machinable from it) and those facing away (floors machinable from the opposite face). Result `{ face, opposite, levels: [{ depth, facing: 'face' | 'opposite', area, visibleArea, bounds }], more? }`; `depth` always from `face`, and for `opposite` levels also `depthFromOpposite`.
- **`visibleArea`**: the part of the level seen from its side (a ray from the level towards that stock face meets no triangle), sampled on a 0.25 mm grid. A level with `visibleArea` 0 is an undercut for 2.5D work; the UI greys it.
- Levels closer than 0.005 mm join; the flat test uses the triangles' normals within 0.5° of the axis.
- Size: ≤ 32 levels ≈ 2.5 KB.

Black-box case: one call from `stock.top` returns the rim (0), the cavity floor (56.33 unscaled), and from the opposite side the part bottom and the two bottom steps (1.77, 4.19 from the bottom), which took the agent a histogram script.

### Section

`design.reference.find { partId, referenceId?, face?, kind: 'section', depth, tolerance?: 0.01 (mm), cornerAngle?: 15 (deg), loops?: 'all' | 'outer' | 'holes' }` – `depth` is a length as written (`"12.5"`, `"20 mm"`); `tolerance`, `cornerAngle` and `minArea` are plain numbers in mm, degrees and mm² (read-outs, not document values). The mesh is cut by the plane at `depth`, the segments chained into loops, oriented by nesting (outer loops counter-clockwise, holes clockwise) and fitted to lines and arcs ([§ Fitting](#fitting)); the result is **summarised** (RT-G):

```
{ face, depth, tolerance,
  loops: [{ role: 'outer' | 'hole', area, bounds, elements, circle?: { center, diameter },
            corners: { minInsideRadius, sharp: [[u, v], …], sharpCount }, maxDeviation, open? }],   // ≤ 50 loops, more?
  fit: { elements, maxDeviation } }
```

- `circle`: when every point of the loop lies within `tolerance` of one circle (a hole or a boss).
- `corners.minInsideRadius`: the smallest radius of a fitted arc at a concave turn of the material (the region's inside corners, where a tool must fit; [glossary: inside corner radius](../glossary.md)); `sharp`: the concave corners kept as corners (the mesh turns by more than `cornerAngle` there), at most 8 positions per loop plus `sharpCount`. A loop with sharp inside corners will need a fillet or a smaller tool; this is the number the black-box agent never had.
- `detail: "full"` (reserved, not in P1) would add each loop's shape `item`; geometry goes into shapes through `from`. Size guard: at most 5000 elements in a section → shape, else `input.malformed`, rule `sectionLimit`, with a hint to raise `tolerance` or narrow `loops`.
- A plane that misses the mesh gives `loops: []` and a note; an open mesh may give `open: true` loops, which section → shape skips with a note.

### Section to shape

`design.shape.import { partId, from: { referenceId?, face?, depth, tolerance?, loops?, roundInside? }, name?, split? }` – `from` and `path` are exclusive (rule `pathOrFrom`). The section is computed and fitted as above, then made into shapes as an SVG import's are ([design-v0.3.md § SVG import](design-v0.3.md#svg-import)): `split: 'file'` (the default for a section) makes one shape with its holes, `split: 'loop'` one shape per outer loop with its holes; names default to "Section 12.5 mm" (+ " 2", …); a loop that is a circle becomes a `circle` item, any other loop a closed `path` of lines and arcs. One undo step; a plane that misses the mesh is refused (rule `emptySection`), open loops are skipped and counted (`skippedOpen`).

- The shapes are in the face frame, so a pocket or profile on that face with the `named` shape at anchor `min`/`min` and `center` at the shape's own min corner lands where the reference is; the result returns that placement per shape (`placeAt: { center, anchor }`), so the agent does not compute it.

- **`roundInside`** (a length, optional, Q74): every sharp inside corner gets a tangent fillet of that radius (2D offset in and out by the radius on the region, `Region2dPort.offset`), so the shape is toolable at once: a material shape is closed (offset −r, then +r), a cavity's shape opened (+r, then −r). The result's `section.rounded` gives how many corners were rounded and the largest material change (`maxChange`, the distance from a sharp corner to the new boundary: (√2 − 1) × r at a 90° corner). Default off: the section is what the mesh is.
- The result's `section.shapes` gives per shape `minInsideRadius` (pocket sense: the same reading as `design.shape.get`'s `smallestInsideRadius`) and `sharpCount`, so the agent knows before adding the pocket whether a tool will fit (the existing [tool-fit check](../architecture/geometry.md) then names the tool).
- Shapes are made at the depth's **section of the placed reference** (scale and rotation applied), so nothing is scaled by hand.

### Fitting

- **Pipeline:** `meshSection` segments → chain into loops (ends welded within 1e-4 mm) → orient and nest (`Region2dPort.normalise`) → split at corners (turn > `cornerAngle`) → each run fitted to lines and tangent arcs within `tolerance` → circle test (every point within `tolerance` of one circle) → shape items.
- **Fitter (S8 outcome):** direct G1 **biarcs on the section's vertices** (`fitPolyline` in `src/core/geometry/2d/fit-polyline.ts`) replaced the planned detour through the test-only `fitLoop` (cubic chains) and `fitCurve`: the vertices already lie on the surface, so tangents are estimated from them and each span between corners is covered by biarcs, split until every vertex is within `tolerance`. Two refinements make faceted CAD shapes come out exact: a biarc half that turns less than 1° becomes a line when the points still fit, and a vertex next to a chord at least 3 × longer than its other chord takes that long chord's direction (a straight side meeting a fillet), so a faceted r 4 rounded rectangle fits to four lines and four r 4 arcs.
- **S8 measured** on the full enclosure body (`enclosure-wood-full.stl`, 77 112 triangles, `stock.top` frame without scale, tolerance 0.01 mm): every loop within 0.0100 mm; chaining + fitting 6–12 ms per section (38 ms at z 2 with the four foot holes).

  | Height          | Outline elements  | Cavity elements | Elements < 0.05 mm |
  | --------------- | ----------------- | --------------- | ------------------ |
  | z 20 (mid-wall) | 78                | 61              | 0                  |
  | z 50            | 192               | 63              | 3                  |
  | z 2             | 237 (+ 4 circles) | –               | 2                  |
  | z 40            | 360               | 315             | 57                 |
  | z 5             | 384               | 289             | 92                 |
  | z 59            | 510               | –               | 63                 |

  The ≤ 300 elements target holds mid-wall and at plain heights; heights that cut through slots, ribs and the lid lip exceed it, and there the "no element under 0.05 mm" target is missed (shortest 0.001 mm), since short facets between nearly tangent runs survive as their own elements. Accepted for P1 (the shapes are correct within the tolerance and `sectionLimit` still guards size); merging slivers into their neighbours is a follow-up ([§ Not yet](#not-yet)).

- **Radii from facets:** an STL fillet of radius r is a fan of chords; the fitted arc's radius is within `tolerance` of r when the chord count is ≥ 3, so `minInsideRadius` is meaningful. A 90° corner exported sharp stays a corner (reported `sharp`), never a tiny arc.

### UI

In the [Reference panel](../conventions/ui.md#reference-panel-hardening-df2df8), visuals in [ui.md § Reference tools](../conventions/ui.md#reference-tools-df60) (existing tokens only). P1 ships the rows below except the parts marked later:

- **Levels** list: two groups "From top" / "From bottom" (the face and its opposite; a face picker for side faces), each row depth, area, visible area; an undercut row greyed. Choosing one sets the section depth just inside the level (0.01 mm past it, so the cut has the floor's outline, not the face itself). Hovering a row to highlight the level's faces on the ghost: later.
- **Section**: face picker, depth field (quantity; `stock.top.z - 10` style formulas as in placement), the loops filter (the tolerance stays at its 0.01 mm default; a field for it later); the loops listed with their size and inside corners as chips (sharp ones with the warning token) ("r 0", "r 3.98"). "Create shape" (one shape, holes kept) and "Create shapes" (one per outer loop) send `design.shape.import { from }`; "Round sharp inside corners to …" offers the smallest library end mill radius as its default. Drawing the fitted loops over the ghost and in the Shape Editor backdrop (instead of the raw segments): later.

## 2. Features (holes)

`design.reference.find { kind: 'holes', face?, maxDiameter?: 50 mm, limit?: 64 }` (P3):

- **Detection:** a section at the middle of every gap between consecutive levels (and just under the face); a `hole` loop that is a circle (within 0.02 mm) is a hole slice; slices whose centres agree within 0.05 mm stack into one hole: `{ center: [u, v], diameter, depth, bottom, mouth?, steps }` with `bottom` `through` (it reaches the opposite stock face), `flat` or `cone` (`coneAngle` from the bottom's triangles), `mouth` `{ type: 'countersink', diameter, angle }` or `{ type: 'counterbore', diameter, depth }` when the top slices widen, `steps` the diameter per depth band otherwise. Only holes whose axis is the face normal (the others show from the face they open on); circular bosses (circle loops with role `outer`) are not holes.

- **Grouping:** holes with equal size and mouth (within 0.02 mm) are one group: `{ count, holes: [[u, v], …], size: { diameter, depth, bottom, mouth? }, pattern? }`. `pattern` is `{ kind: 'grid', origin, pitch: [du, dv], count: [nu, nv] }` or `{ kind: 'circle', center, pitchDiameter, count, startAngle }` when every centre fits within 0.02 mm, else absent (a list).
- **Suggestion per group** (`suggest`), never applied by itself:
  - a **Bolt hole** (`design.hole.add` args) when the mouth is a countersink (`type: countersink`, `csDiameter`, `csAngle` rounded to the nearest of 82°/90°/100°/120° within 2°) or a counterbore (`cbDiameter`, `cbDepth`), with `fastener` set when the [fastener table](design-v0.4.md#fastener-table) has a size whose clearance (any fit) is within 0.1 mm of the diameter;
  - otherwise a **Drilling** (`design.drilling.add` args: `diameter`, `bottom`, `depth`);
  - with a `pattern`, the first hole's args plus the `design.clones.add` grid or circle row ([features.md § Clones](features.md#clones)); without one, one call per hole (the args differ only in `center`).
  - Args are mm strings in the face frame with `on: <face>`, ready to send; an agent may edit them (e.g. round Ø 1.33 up to a drill it has).
- **Too small for the library:** a group whose diameter is below every library tool that could make it gets `note: 'noTool'` with the smallest candidate ("Ø 1.33 < the smallest drill or end mill, 1.588 mm"), which is the black-box I-11 case found before the design, not after.
- Result size: ≤ 64 holes in ≤ 16 groups ≈ 4 KB.

**UI:** a "Holes" list in the Reference panel by group ("4 × Ø 2.45 countersunk Ø 4.87 90°, grid 2 × 2"); rings on the ghost at each hole; per group "Add as Bolt hole" or "Add as Drilling" (with Clones when a pattern was found), one undo step per click, through the same commands the suggestion names.

## 3. Compare

`design.reference.compare { partId, referenceId?, source: { kind: 'part' }, threshold?: 0.1 mm, limit?: 10 }` – the command of [deviation.md](deviation.md#the-command) (a job; `job.wait` returns the result), restricted here to the **design** source; `source: plan` (simulated cut) stays in deviation.md and the v0.4 follow-up.

### Method (RT-F)

- **Closed reference** (the parser's closed check passes): weld the STL (1e-4 mm), place it, `SolidPort.fromMesh`; with the evaluated part solid: `missing = reference − part` (material the reference has and the design cuts away: an over-cut), `extra = part − reference` (material the design leaves that the reference does not have: an under-cut); `decompose` both into pieces; per piece `volume`, bounds, and `maxDev` = the largest distance of its vertices to the part's surface (missing) or the reference's surface (extra), with a closest-point query over a BVH of the other mesh (new core module `mesh-distance.ts`).
- **Open or non-manifold reference** (or `fromMesh` refused): fall back to deviation.md's [height map method](deviation.md#height-map-method) for the part source, from the faces the design's operations use; the result says `method: 'heightmap'`.
- **Noise:** pieces with `maxDev` under `threshold` (facet chords, rounding) are summed into `below: { count, volume }`, not listed.
- **Attribution:** each piece's faces that lie on the part mesh carry surface ids ([geometry.md § Surface ids in meshes](../architecture/geometry.md#surface-ids-in-meshes)); the piece names the surfaces it touches most (by area) and their operations, so the agent knows what to edit ("missing 0.4 mm³ along `pocket3.wall[7]`").

### Result (agent)

```
{ method: 'boolean' | 'heightmap', threshold,
  stats: { missingVolume, extraVolume, maxMissing, maxExtra, referenceVolume, partVolume },
  regions: [{ kind: 'missing' | 'extra', volume, maxDev, at: [x, y, z], bounds, surfaces: [id, …], operationIds: [id, …] }],  // ≤ limit, largest maxDev × volume first
  more?, below: { count, volume }, evaluation }
```

- Part frame, mm, rounded to 0.001; `at` is the point of `maxDev`, so the agent can `design.measure` there. ≤ 10 regions ≈ 2 KB.
- The [deviation.md causes](deviation.md#result) (`toolRadius`, `holeMouth`, …) apply to the plan source; for the design source the only explained kind is `cornerRadius` (a missing region within the design's inside corner radius of a corner whose reference corner is sharper, i.e. the fillet the design chose on purpose), so an agent can tell intended fillets from mistakes.
- Not undoable, changes nothing; stale after any design edit (the result carries the `evaluation` it used).

### Overlay (UI)

- **Compare** toggle in the Reference panel: runs the job for the current evaluation and draws a colour overlay on the part in the Design viewport: part-mesh vertices coloured by signed distance to the reference (a diverging map: missing material one hue, extra material another, neutral within `threshold`; hues from existing tokens, fixed by the ui.md amendment), the missing pieces drawn as translucent volumes over the part (they are not part of it), a legend with the threshold and the max values.
- **Regions list** under the toggle: kind, max deviation, operation; choosing one frames the camera on it and selects its operation. The viewport's text summary reads the stats ("Compare: 2 regions over 0.1 mm, worst 0.42 mm missing at pocket3").
- While the overlay is on, it re-runs after each finished evaluation (debounced, the previous job cancelled); off, nothing runs. The per-vertex distances come with the job's result to the window only (not to agents: RT-G).

## 4. Scale and fit

DF5's fit already does what the agent needed (`fit: { scaleTo, margin, anchor, z }`, [§ Fit to stock](reference-model.md#fit-to-stock)); the manual work in the test was rescaling its own slices, which [section → shape](#section-to-shape) removes since it reads the placed reference. Left to add:

- **Result fields** (implemented in P1): `design.reference.import` and `.update` return `scale` (as written), `placed` (the box in the part frame) and `facingDepth`, as `list` does, so a fit needs no follow-up `list` (the test made two).
- **Small-feature check after a scale change** (P3, needs `holes`; not in P1): the update result's `warnings` gain `reference.featureBelowTool` (info) per hole group the new scale puts below the library's smallest fitting tool, and the sections' sharp-corner count is not repeated here (it belongs to section → shape).
- **Not proposed:** automatic orientation for the best scale (orientation is design intent: an enclosure's cavity faces up whatever fits best) and non-uniform scale ([reference-model.md § Scope](reference-model.md#scope-v02) keeps it later).

## Core and process split

All analysis is headless core (`src/core`, no Electron, DOM or Node-only imports); the worker hosts it; the renderer only draws.

| Module                                             | Contents                                                                                                           | Phase |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----- |
| `src/core/design/mesh-section.ts` (extended)       | `sectionChains`: segments chained into loops (ends welded within 1e-4 mm), `open` chains                           | P1    |
| `src/core/geometry/2d/fit-polyline.ts`             | corners, G1 biarcs on the vertices within a tolerance, line snapping ([§ Fitting](#fitting))                       | P1    |
| `src/core/design/reference-section.ts`             | `fitSection`: orientation by nesting, circle test, concave corners and radii per loop                              | P1    |
| `src/core/design/mesh-levels.ts`                   | flat-triangle grouping by height, visible area (envelopes on a 0.25 mm grid)                                       | P1    |
| `src/core/design/reference-find.ts`                | target reference, stock face, the face-frame matrix, the worker calls behind `find` and `from`                     | P1    |
| `src/core/design/section-shapes.ts`                | fitted loops → shape items, `split`, `roundInside` (offset in and out on `Region2dPort`)                           | P1    |
| `src/core/workers/tasks.ts`                        | `reference.levels` (new), `reference.section` (gains `fit` and loops); both on the mesh the worker keeps per asset | P1    |
| `src/core/design/reference-commands.ts`            | `design.reference.find` (async query); `scale`, `placed`, `facingDepth` on import and update                       | P1    |
| `src/core/design/shape-commands.ts`                | `from` on `design.shape.import`                                                                                    | P1    |
| `src/renderer/src/modes/design/ReferenceTools.tsx` | the Levels and Section rows of the Reference panel                                                                 | P1    |
| `src/core/design/mesh-holes.ts`                    | circle slices, stacking, bottom and mouth, grouping and patterns, suggestions (pure; fastener table lookup)        | P3    |
| `src/core/design/mesh-distance.ts`                 | BVH, closest point, signed distance per vertex                                                                     | P4    |
| `src/core/design/reference-compare.ts`             | boolean method, pieces, attribution; height-map fallback                                                           | P4    |

`reference.compare` runs on the geometry lane with the part's evaluation (the worker that holds the evaluated solid), so the part mesh is not copied; the reference mesh is read there once per asset as `reference.section` does.

## Agent API and budget

| Tool                       | Kind                                   | `tools/list` cost                          |
| -------------------------- | -------------------------------------- | ------------------------------------------ |
| `design.reference.find`    | async query (P1)                       | ≈ 1.3 K measured (levels and section args) |
| `design.shape.import`      | existing command, gains `from` (P1)    | + 0.7 K measured (659 → ≈ 1.36 K)          |
| `design.reference.update`  | existing; result fields only (P1)      | in the output schema                       |
| `design.reference.compare` | job (P4; `source: part` only at first) | ≈ 0.5 K (estimate)                         |

P1 measured: 107 245 → 109 183 characters (124 → 125 tools, + 1.94 K, under the 120 K budget; logged in [llm-api.md § Implementation](../architecture/llm-api.md#implementation-task-310)). Results stay ≤ 5 KB by default (levels ≈ 2.5 KB, section summary ≈ 1–3 KB, holes ≈ 4 KB, compare ≈ 2 KB). The primer's bullet grows with the phases; P1: "Reference: `design_reference_find` (levels, section) → `design_shape_import { from }`".

## Implementation (P1)

Implemented 2026-11-24 (hardening DF60 P1); code points back here.

- **Async query kind** ([ADR 0021](../decisions/0021-async-queries.md), [commands.md § Async queries](../architecture/commands.md#async-queries)): `defineAsyncQuery` in `define.ts`, `Dispatcher.queryAsync`; agents reach it through the same tool as any query (read-only and idempotent hints).
- **`design.reference.find`** with `kind: 'levels' | 'section'` as above; `design.shape.import { from }` with `roundInside`; `scale`, `placed` and `facingDepth` on import and update.
- **Corner semantics** (two readings, both "where a tool must fit"): `find` reports the **material's** concave corners per loop (an outline's inner bends, a cavity's corners); the shapes `from` makes report `minInsideRadius` in the **pocket** sense, as `design.shape.get` does, because a shape is cut as a pocket or followed as a profile. A mid-wall outline therefore shows its fitted fillets (r 65 at z 20 of the enclosure), never the 0 of a line path.
- **Section shapes** carry no link or source back to the reference (the reference-only rule): an ordinary literal shape, its name "Section 20 mm".
- **UI:** the Levels and Section rows (face picker, levels from both sides, section depth, loops filter, corner chips, rounding, Create shape / Create shapes). Choosing a level sets the shared section depth that the Shape Editor backdrop reads as well.
- Tests: `fit-polyline.test.ts`, `mesh-levels.test.ts`, `reference-section.test.ts`, `reference-find.test.ts`, `Reference.test.tsx` (axe), the e2e reference spec with renders.

## Performance

The worker keeps the last mesh read per asset. Measured on the full enclosure body (77 112 triangles, dev machine): `levels` ≈ 120 ms (target < 100 ms for 50 K triangles: in line), section chaining 3–8 ms and fitting 2–14 ms (target < 200 ms); `holes` (P3) < 1 s. At the 1 M triangle warn limit, about ten times that.

## Not yet

| Item                                                                      | Where                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Fitted loops and corner markers drawn on the ghost; level hover highlight | P1 follow-up (UI)                                            |
| Shape Editor backdrop from the fitted loops instead of the raw segments   | P1 follow-up (UI)                                            |
| Merging sub-0.05 mm slivers in feature-rich sections (S8)                 | P1 follow-up ([§ Fitting](#fitting))                         |
| `detail: "full"` on `find`                                                | When an agent needs loop geometry without making shapes      |
| Setup faces, holes, compare, overlay                                      | [P2–P5](#phases)                                             |
| Silhouette (outline of the whole model seen from a face)                  | Later; a section near the widest level serves                |
| Feature recognition into operations                                       | Assisted recreation, later                                   |
| Holes along other axes than face normals; slots and obrounds              | With assisted recreation                                     |
| STEP references (exact faces instead of facets)                           | STEP import ([reference-model.md](reference-model.md#later)) |

## Phases

Smallest useful first; each phase is mergeable on its own and ends with `npm run check` green and the doc's tests.

| Phase | Content                                                                                                                                                                                                                                                      | Needs                       | Unblocks                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------- |
| P0    | **Done.** Docs accepted: this doc (and reference-query.md merged into it, Q71), ui.md amendment for the panel rows, llm-api amendment + ADR for async queries (Q72)                                                                                          | Q70–Q80                     | all                                                         |
| P1    | **Done (implemented).** **Levels + section → shape**: async query kind; `levels` (both sides, visible area); `section` summary; chaining, `fit-polyline`, corner radii; `from` (+ `roundInside`); fit result fields; Reference panel Levels and Section rows | P0; S8 measured in P1       | The black-box flow without a slicer for outlines and depths |
| P2    | **Setup faces**: `{ setupId }` faces and `frame: 'setup'`                                                                                                                                                                                                    | P1                          | Reading sections against a setup's program                  |
| P3    | **Holes**: detection, groups, patterns, suggestions, `noTool`; `reference.featureBelowTool` after a scale (left out of P1: it needs holes); Holes list and ghost rings                                                                                       | P1                          | Bolt holes and drillings from the reference                 |
| P4    | **Compare (agent)**: `design.reference.compare { source: part }` boolean method, height-map fallback, attribution, `cornerRadius`                                                                                                                            | P1 (`mesh-distance` shared) | A measurable "does the design match"                        |
| P5    | **Compare overlay**: per-vertex colours, missing volumes, regions list, auto re-run while shown                                                                                                                                                              | P4, ui.md amendment         | –                                                           |
| later | Simulated-cut source, causes, exit numbers ([deviation.md](deviation.md)); holes off the face normal, slots; silhouettes; STEP references                                                                                                                    | v0.4 follow-up              | –                                                           |

## Test plans

Fixtures: the enclosure STL (`src/core/design/__fixtures__/enclosure-wood-base.stl`), the black-box test's full enclosure body (`enclosure-wood-full.stl`, added with P1 as Q71 agreed; [testing.md § Fixtures](../conventions/testing.md)), and synthetic meshes written from the evaluated test part as `stl.test.ts` does.

- **P1 levels** (`mesh-levels.test.ts`): a synthetic stepped block gives each floor's depth within 0.001 mm and its area within 0.1 %; a floor under an overhang has `visibleArea` 0 from that side and full from the other; the enclosure gives the cavity floor and the bottom steps within 0.01 mm of the black-box values; `minArea` and `limit` with `more`.
- **P1 section and fitting** (`fit-polyline.test.ts`, `mesh-section.test.ts`): a faceted circle (32–256 chords) fits to one `circle` within the tolerance; a rounded rectangle r 4 faceted with 8 chords per corner gives four arcs with `minInsideRadius` 4 ± 0.01; a sharp rectangle keeps four corners (`sharp`, `minInsideRadius` absent) and none becomes a micro-arc; the enclosure outline and cavity meet S8's targets; open mesh → `open: true`; a plane missing the mesh → `loops: []`.
- **P1 section → shape** (`reference-commands.test.ts`): import with `from` makes a shape whose `smallestInsideRadius` equals the fitted value (not 0); round trip: pocket with the shape, evaluate, section the part at the same depth: two-sided distance ≤ the tolerance; `roundInside 1.6` on a sharp rectangle gives r 1.6 corners and the report's count; scale ×0.5 then section: loops half size, nothing scaled by the caller; undo is one step.
- **P1 UI** (`Reference.test.tsx`, axe): Levels rows and choosing one sets the depth; Section draws fitted loops with corner chips; Create shape(s) sends the command; e2e with the enclosure fixture (renders behind `DFYOM_RENDERS=1`, hidden windows per the fixture).
- **P2:** `{ setupId }` of a bottom setup equals `stock.bottom`; `frame: 'setup'` with a 90° rotation matches `setupFrame`.
- **P3 holes** (`mesh-holes.test.ts`): synthetic through, flat, cone bottoms; counterbore and countersink mouths (angle within 1°); a boss is not a hole; a 2 × 2 grid and a 6-hole circle become patterns, an irregular set a list; suggestions round-trip: sending the suggested args and evaluating gives a part whose hole sections match within 0.02 mm; the enclosure's four foot holes come back as one countersunk group, grid 2 × 2, at (±88.53, ±44.27); `noTool` with a library whose smallest tool is larger.
- **P4 compare** (`reference-compare.test.ts`): reference = the evaluated test part written as STL → no region over the threshold; a pocket 0.2 mm too deep → one `missing` region, maxDev 0.2 ± 0.01, attributed to that pocket; a missing pocket → one `extra` region with its volume within 1 %; an open mesh → `method: 'heightmap'`; the black-box project's design against its STL lists the eased cavity step (extra, ≈ 1.09 mm) and the omitted wall slots (extra) as the worst regions; perf: enclosure < 2 s on the reference machine (`npm run perf`).
- **P5 overlay:** the overlay's colour per vertex equals core's signed distance for a fixture; toggling runs and stops the job; stale result after an edit is replaced; text summary; renders light and dark for review.

## Glossary

New terms (added to [glossary.md](../glossary.md) with this draft): **Missing material / extra material** and **Deviation overlay**. Existing terms used as defined there: depth level, reference section, inside corner radius, height map, geometric deviation, over-cut / under-cut, Bolt hole, Drilling.

## Open questions for the user

Each with a recommendation; "Q70 ok" takes it. **Answered by the user 2026-11-24 ("Q70-80 OK"): all recommendations taken.**

1. **Q70 – Slot.** DF60 in hardening takes P1–P3 (levels, section → shape, setup faces, holes), then P4–P5 (compare and overlay), instead of waiting for the v0.4 follow-up's R1–R5 and V1–V3; the simulated-cut compare stays in the follow-up. _Recommendation:_ yes; P1 first, since it removes the slicer and the `smallestInsideRadius: 0` problem in one step.
2. **Q71 – One doc.** On acceptance, [reference-query.md](reference-query.md) is merged into this doc (it becomes the single owner of levels, section and holes) and [deviation.md](deviation.md) keeps only the simulated-cut source; the follow-up plan's rows 1.2 and 1.4 then point here. And may the black-box test's full enclosure STL become a test fixture? _Recommendation:_ yes to both.
3. **Q72 – Async queries.** The reference queries need the worker; [Q42](../plans/v0.4-llm-first.md#questions-for-the-user) proposed an async query kind (option A, one call) over jobs (option B, two calls). _Recommendation:_ A, decided now for hardening with ADR 0021, since P1 depends on it.
4. **Q73 – Setup faces.** `face` may be `{ setupId }`, results stay in the face frame, `frame: 'setup'` adds WCS coordinates for read-outs; shapes are always made in the face frame. _Recommendation:_ yes, as P2 (after the face-frame P1).
5. **Q74 – Sharp inside corners in sections.** Always report them (`minInsideRadius`, `sharp` positions); rounding them is opt-in (`roundInside`, UI default = the smallest library end mill radius), never automatic. _Recommendation:_ yes; automatic rounding would silently change the part.
6. **Q75 – Levels from both sides.** One `levels` call returns both the face's and the opposite face's floors, with visible areas. _Recommendation:_ yes (one pass, saves a call per part, shows undercuts).
7. **Q76 – Hole suggestions.** Holes come grouped, with ready-to-send `design.hole.add` (countersink/counterbore or a fastener match within 0.1 mm) or `design.drilling.add` args and a Clones row for grids and circles; nothing is added without a click or a call. _Recommendation:_ yes.
8. **Q77 – Compare method for the design.** 3D booleans with manifold-3d (already the evaluation kernel) when the reference is closed, the height map only as a fallback; this brings the 3D comparison deviation.md left for later forward for the design source. _Recommendation:_ yes; the booleans are exact, find walls and undercuts the height map cannot, and reuse code that exists.
9. **Q78 – Compare defaults.** Threshold 0.1 mm (as deviation.md), at most 10 regions in the result, ranked by max deviation × volume; intended fillets reported as `cornerRadius` regions, not hidden. _Recommendation:_ yes.
10. **Q79 – Overlay refresh.** The overlay re-runs after each finished evaluation while it is shown (debounced, cancelled by the next edit) and does nothing while hidden; agents call compare explicitly. _Recommendation:_ yes; a manual "Refresh" would leave stale colours on screen.
11. **Q80 – Fit additions.** `import`/`update` return `scale`, `placed` and `facingDepth`; a `reference.featureBelowTool` info after a scale change (with P3); no automatic orientation or non-uniform scale. _Recommendation:_ yes.
