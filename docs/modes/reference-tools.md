# Reference tools: section, levels, holes, compare and fit for a reference model

Status: accepted (proposed 2026-11-23 for hardening [DF60](../plans/hardening.md); the user answered [Q70–Q80](#open-questions-for-the-user) on 2026-11-24 and took every recommendation); **P1 implemented with its follow-ups** ([§ Implementation (P1)](#implementation-p1)), **P2 implemented** ([§ Implementation (P2)](#implementation-p2)), **P3 implemented** ([§ Implementation (P3)](#implementation-p3)), **P4 implemented** ([§ Implementation (P4)](#implementation-p4)), **P5 implemented** ([§ Implementation (P5)](#implementation-p5)); DF60 complete · Source: black-box test of 2026-11-23 (scaled enclosure in two setups, `.continuous/research/2026-11-23-enclosure-two-setup-test.md`, issues I-5 and I-11) · Base: [reference-model.md](reference-model.md) (import, placement, fit, the [reference-only rule](reference-model.md#rule-reference-only)) · Single owner of levels, sections and holes of a reference since Q71 ([reference-query.md](reference-query.md), the v0.4 follow-up draft, is folded in here); the simulated-cut deviation stays in [deviation.md](deviation.md) · Async queries: [ADR 0021](../decisions/0021-async-queries.md), [commands.md § Async queries](../architecture/commands.md#async-queries) · UI: [ui.md § Reference tools](../conventions/ui.md#reference-tools-df60) · Shapes and fitting: [shapes.md](../architecture/shapes.md) · Agent API and budget: [llm-api.md](../architecture/llm-api.md) · Hole feature: [design-v0.4.md § Hole feature](design-v0.4.md#hole-feature) · Terms: [glossary.md](../glossary.md)

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
- The **face frame** puts w = 0 at the stock face and the stock below it (`faceFrame(direction, stock)`; the section plane is w = −depth). Results are in that face's [face frame](design-v0.2.md#face-frame) (what `design.*.add` takes, so no conversion). With `frame: 'setup'` (only with `{ setupId }`) point results are also given in the setup's WCS (`setupFrame(direction, rotation, stock)` in `src/core/toolpath/wcs.ts`: rotation and work zero applied) in a `wcs` object beside the face-frame fields (the section's `z`; per level `z` and `bounds`; per loop `bounds`, circle `center` and `sharp`), for reading against a program. Shapes are always made in the face frame (shapes live on faces, not setups).
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
- **Fitter (S8 outcome):** direct G1 **biarcs on the section's vertices** (`fitClosedPolyline` in `src/core/geometry/2d/fit-polyline.ts`) replaced the planned detour through the test-only `fitLoop` (cubic chains) and `fitCurve`: the vertices already lie on the surface, so tangents are estimated from them and each span between corners is covered by biarcs, split until every vertex is within `tolerance`. Refinements that make faceted CAD shapes come out exact and compact:
  - a biarc half that turns less than 1° becomes a line when the points still fit;
  - a vertex's tangent is the tangent of the **circle through it and its two neighbours** (the central chord when the chords are equal; with uneven chords the central chord leans towards the longer one, which broke a stretch at every short chord);
  - a vertex next to a chord at least 3 × longer than its other chord, whose short side goes on with another short chord (a straight side meeting a fillet's fan), takes the long chord's direction first, so a faceted r 4 rounded rectangle fits to four lines and four r 4 arcs; the circle tangent stays the alternative a stretch may end on, since a smooth curve cut through a slanted strip of facets gives the same long–short pattern;
  - **slivers merged:** a stretch holding an element under 0.05 mm (`MIN_ELEMENT`) is refitted as one line or arc over the same vertices (alone or with a neighbouring stretch), within the tolerance and leaving a tangent break of at most 4.5° to the right (under the inside-corner check's 5°, so a merge never makes a sharp inside corner; loops are oriented with the material on the left) or half `cornerAngle` to the left.
- **S8 measured** on the full enclosure body (`enclosure-wood-full.stl`, 77 112 triangles, `stock.top` frame without scale, tolerance 0.01 mm): every loop within 0.0100 mm; chaining + fitting 4–14 ms per section (≈ 40 ms at z 2 with the four foot holes). P1 as first built, then with the circle tangents, the long-chord alternative and the sliver merge (P1 follow-up, 2026-11-24):

  | Height          | Outline elements (P1 → now) | Cavity elements | Elements < 0.05 mm |
  | --------------- | --------------------------- | --------------- | ------------------ |
  | z 20 (mid-wall) | 78 → 74                     | 61 → 66         | 0 → 0              |
  | z 50            | 192 → 169                   | 63 → 66         | 3 → 0              |
  | z 2             | 237 → 86 (+ 4 circles)      | –               | 2 → 0              |
  | z 40            | 360 → 201                   | 315 → 174       | 57 → 0             |
  | z 5             | 384 → 176                   | 289 → 104       | 92 → 0             |
  | z 59            | 510 → 283                   | –               | 63 → 0             |

  Both S8 targets now hold at every height: a sweep every 0.5 mm from z 0.25 to 59.75 gives at most 266 elements per loop, none under 0.05 mm (the shortest 0.05 mm), every loop within 0.01 mm (`reference-section.test.ts` checks the six heights above).

- **Circle test:** every vertex within `tolerance` of the least-squares circle **and** no chord spanning more than 46° of it (eight chords and some slack), so a D-shaped hole, whose flat is one chord with its ends on the circle, stays a line and an arc with two corners (found with the P1 follow-ups).
- **Radii from facets:** an STL fillet of radius r is a fan of chords; the fitted arc's radius is within `tolerance` of r when the chord count is ≥ 3, so `minInsideRadius` is meaningful. A 90° corner exported sharp stays a corner (reported `sharp`), never a tiny arc.

### UI

In the [Reference panel](../conventions/ui.md#reference-panel-hardening-df2df8), visuals in [ui.md § Reference tools](../conventions/ui.md#reference-tools-df60) (existing tokens only). P1 ships the rows below except the parts marked later:

- **Levels** list: two groups "From top" / "From bottom" (the face and its opposite; a face picker for side faces), each row depth, area, visible area; an undercut row greyed. Choosing one sets the section depth just inside the level (0.01 mm past it, so the cut has the floor's outline, not the face itself). Pointing at a row highlights the level's faces on the ghost.
- **Section**: face picker, depth field (quantity; `stock.top.z - 10` style formulas as in placement), the loops filter (the tolerance stays at its 0.01 mm default; a field for it later); the loops listed with their size and inside corners as chips (sharp ones with the warning token) ("r 0", "r 3.98"). "Create shape" (one shape, holes kept) and "Create shapes" (one per outer loop) send `design.shape.import { from }`; "Round sharp inside corners to …" offers the smallest library end mill radius as its default. The fitted loops are drawn over the ghost with the sharp inside corners marked, and the Shape Editor backdrop shows the same fitted loops instead of the raw segments (P1 follow-ups).

## 2. Features (holes)

`design.reference.find { kind: 'holes', face?, maxDiameter?: 50 (mm), limit?: 64 }` (P3; `face` and `frame: 'setup'` as for the other kinds):

- **Detection:** a section at the middle of every gap between consecutive levels (and just under the face); a `hole` loop that is a circle (within 0.02 mm) is a hole slice; slices whose centres agree within 0.05 mm stack into one hole: `{ center: [u, v], diameter, depth, bottom, mouth?, steps }` with `bottom` `through` (it reaches the opposite stock face), `flat` or `cone` (`coneAngle` from the bottom's triangles), `mouth` `{ type: 'countersink', diameter, angle }` or `{ type: 'counterbore', diameter, depth }` when the top slices widen, `steps` the diameter per depth band otherwise. Only holes whose axis is the face normal (the others show from the face they open on); circular bosses (circle loops with role `outer`) are not holes.
  - **As built (P3):** the heights are the flat triangles' (both facings, joined within 0.005 mm) and the mesh's top and bottom; each gap gets a section at its middle and 0.02 mm inside each end (so a mouth always has a slice just under its level). The **bore** is the narrowest band of the stack (its diameter the mean of its slices, its centre their mean); the bands above it are the mouth or steps; a slice wider than the bore **below** it ends the hole there (a mouth on the far side shows from the opposite face).
  - **Profile from the mesh, not the slices:** the slices only find and size the holes; the mouth and the bottom are read from the triangles near the axis, whose vertices lie on the real surface: a mouth band with **tilted** triangles (neither flat nor vertical) is a countersink, its angle the median slope of those triangles (each from its own vertices, so faceting does not bias it) and its diameter the top slice's extrapolated to the mouth's level; a single vertical band is a counterbore (its floor the level between the bands); two or more vertical bands are `steps`.
  - **Bottom along the axis:** the triangles whose projection holds the centre, by depth. One above the mouth means the hole is not reachable from this face: it is left out. The first one below the bore's end (the deepest vertex on the bore's wall) within one diameter is the **cap**: flat (its normal on the axis) → `flat` at its depth; tilted → `cone` with `coneAngle` = 2 · atan(r / (apex − rim)) and `depth` to full diameter (the drilling's convention). None at all → `through` (nothing closes the hole up to the opposite stock face). One further away (the hole opens into a void with material beyond) → `flat` at the bore's end.
  - Each hole also has `top`, the depth of its mouth's level below the stock face (0 when it opens on the face).
- **Grouping:** holes with equal size and mouth (within 0.02 mm) are one group: `{ count, holes: [[u, v], …], size: { diameter, depth, bottom, mouth? }, pattern? }`. `pattern` is `{ kind: 'grid', origin, pitch: [du, dv], count: [nu, nv] }` or `{ kind: 'circle', center, pitchDiameter, count, startAngle }` when every centre fits within 0.02 mm, else absent (a list).
  - **As built:** the size also carries `top`, `coneAngle` and `steps` when set; a grid needs every crossing of its columns and rows filled at equal pitches (a 1 × n line is a grid too); a circle needs at least three holes at equal angles; a square 2 × 2 is a grid. `holes` starts at the pattern's first instance (the grid's origin, the circle's start angle), then by v, u.
- **Suggestion per group** (`suggest`), never applied by itself:
  - a **Bolt hole** (`design.hole.add` args) when the mouth is a countersink (`type: countersink`, `csDiameter`, `csAngle` rounded to the nearest of 82°/90°/100°/120° within 2°) or a counterbore (`cbDiameter`, `cbDepth`), with `fastener` set when the [fastener table](design-v0.4.md#fastener-table) has a size whose clearance (any fit) is within 0.1 mm of the diameter;
  - otherwise a **Drilling** (`design.drilling.add` args: `diameter`, `bottom`, `depth`);
  - with a `pattern`, the first hole's args plus the `design.clones.add` grid or circle row ([features.md § Clones](features.md#clones)); without one, one call per hole (the args differ only in `center`).
  - Args are mm strings in the face frame with `on: <face>`, ready to send; an agent may edit them (e.g. round Ø 1.33 up to a drill it has).
  - **As built:** `suggest: { command, args, also?, clones? }`. `args` are the first hole's (`partId` left out); `fastener` comes with the matching `fit`; a cone bottom is `drillPoint` (a Drilling also gets `pointAngle` when it is not 118° ± 1°); a stepped hole is a Drilling per band, widest first (`also`: the further calls, same centre). `clones: { rows: [row] }` is the Clones row (a grid `{ kind: 'grid', cols, rows, du, dv }`; a circle an `arc` row: centre `pitchDiameter / 2` away at `startAngle + 180°`, `arc` 360°, `step` 360° / count); its `source` is what the calls made (`{ featureId }` of the hole, `{ operationIds }` of the drillings).
  - **Mouth below the face** (`top` > 0.01 mm, e.g. a reference sitting below the stock face before the facing): a Drilling stays ready to send (depths from the stock face; it only cuts air above the mouth once the material there is gone), but a Bolt hole's counterbore or countersink would sit at the stock face: its suggestion gets `note: 'belowFace'`, its depths are given from the mouth, and its `on` must become the surface at `top` (the facing or pocket floor) before it is sent. The UI disables "Add as Bolt hole" then and says why.
- **Too small for the library:** a group whose diameter is below every library tool that could make it gets `note: 'noTool'` with the smallest candidate ("Ø 1.33 < the smallest drill or end mill, 1.588 mm"), which is the black-box I-11 case found before the design, not after. (As built: the candidates are the library's drills and end mills; below the smallest by more than 0.01 mm; `smallestTool` gives its diameter; an empty library gives no note.)
- Result size: ≤ 64 holes in ≤ 16 groups ≈ 4 KB. (As built: `limit` counts holes, largest diameters first; `more` counts the holes left out; at most 16 groups.)

**UI:** a "Holes" list in the Reference panel by group ("4 × Ø 2.45 countersunk Ø 4.87 90°, grid 2 × 2"); rings on the ghost at each hole; per group "Add as Bolt hole" or "Add as Drilling" (with Clones when a pattern was found), one undo step per click, through the same commands the suggestion names. (As built: the calls of one click share a [compound gesture](../architecture/commands.md#gestures-live-edits); a list without a pattern sends one call per hole.)

## 3. Compare

`design.reference.compare { partId, referenceId?, source: { kind: 'part' }, threshold?: 0.1 mm, limit?: 10 }` – the command of [deviation.md](deviation.md#the-command) (a job; `job.wait` returns the result), restricted here to the **design** source; `source: { kind: 'plan', planId }` (simulated cut) is deviation.md's ([Implementation (V3)](deviation.md#implementation-v3)).

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
- The [deviation.md causes](deviation.md#result) (`toolRadius`, `holeMouth`, …) apply to the plan source; for the design source the only explained kind is `cornerRadius` (an extra region within the design's inside corner radius of a corner whose reference corner is sharper, i.e. the fillet the design chose on purpose: a rounded inside corner leaves material a sharp one does not), so an agent can tell intended fillets from mistakes.
- Not undoable, changes nothing; stale after any design edit (the result carries the `evaluation` it used).

### Overlay (UI)

- **Compare** toggle in the Reference panel: runs the job for the current evaluation and draws a colour overlay on the part in the Design viewport: part-mesh vertices coloured by signed distance to the reference (a diverging map: missing material one hue, extra material another, neutral within `threshold`; hues from existing tokens, fixed by the ui.md amendment), the missing pieces drawn as translucent volumes over the part (they are not part of it), a legend with the threshold and the max values.
- **Regions list** under the toggle: kind, max deviation, operation; choosing one frames the camera on it and selects its operation. The viewport's text summary reads the stats ("Compare: 2 regions over 0.1 mm, worst 0.42 mm missing at pocket3").
- While the overlay is on, it re-runs after each finished evaluation (debounced, the previous job cancelled); off, nothing runs. The per-vertex distances come with the job's result to the window only (not to agents: RT-G). (As built: through a separate window-only request after the job, [§ Implementation (P5)](#implementation-p5).)

## 4. Scale and fit

DF5's fit already does what the agent needed (`fit: { scaleTo, margin, anchor, z }`, [§ Fit to stock](reference-model.md#fit-to-stock)); the manual work in the test was rescaling its own slices, which [section → shape](#section-to-shape) removes since it reads the placed reference. Left to add:

- **Result fields** (implemented in P1): `design.reference.import` and `.update` return `scale` (as written), `placed` (the box in the part frame) and `facingDepth`, as `list` does, so a fit needs no follow-up `list` (the test made two).
- **Small-feature check after a scale change** (P3, needs `holes`; not in P1): the update result's `warnings` gain `reference.featureBelowTool` (info) per hole group the new scale puts below the library's smallest fitting tool, and the sections' sharp-corner count is not repeated here (it belongs to section → shape).
  - **As built (P3):** when an update sets `scale`, `fit` or `sourceUnit` and the library has a drill or end mill, the command's `prepare` step (before the draft) reads the holes from all six stock faces at the **current** placement (the worker caches holes per matrix and options with the mesh), scales their diameters by the new/old size ratio and adds one info warning per distinct diameter below the smallest tool − 0.01 mm (`params: { diameter, count, smallest, scale }`). An update without a size change, or an empty library, adds none. The Reference panel shows them with the import's notes until the next size change replaces them.
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

`reference.compare` runs on the geometry lane; the reference mesh is read there once per asset as `reference.section` does. As built (P4) the part mesh is copied to it from the evaluation (see [§ Implementation (P4)](#implementation-p4)).

## Agent API and budget

| Tool                                  | Kind                                | `tools/list` cost                          |
| ------------------------------------- | ----------------------------------- | ------------------------------------------ |
| `design.reference.find`               | async query (P1)                    | ≈ 1.3 K measured (levels and section args) |
| `face: { setupId }`, `frame: 'setup'` | existing args extended (P2)         | + 0.37 K measured                          |
| `design.shape.import`                 | existing command, gains `from` (P1) | + 0.7 K measured (659 → ≈ 1.36 K)          |
| `kind: 'holes'`, `maxDiameter`        | existing args extended (P3)         | + 0.25 K measured                          |
| `design.reference.update`             | existing; result fields only (P1)   | in the output schema                       |
| `design.reference.compare`            | job (P4; `source: plan` since V3)   | 0.88 K (measured, P4); +0.16 K (V3)        |

P1 measured: 107 245 → 109 183 characters (124 → 125 tools, + 1.94 K, under the 120 K budget; logged in [llm-api.md § Implementation](../architecture/llm-api.md#implementation-task-310)). Results stay ≤ 5 KB by default (levels ≈ 2.5 KB, section summary ≈ 1–3 KB, holes ≈ 4 KB, compare ≈ 2 KB). The primer's bullet grows with the phases; P1: "Reference: `design_reference_find` (levels, section) → `design_shape_import { from }`"; P3 adds "holes → the suggested `design_hole_add`/`design_drilling_add` (+ `design_clones_add`)".

## Implementation (P1)

Implemented 2026-11-24 (hardening DF60 P1); code points back here.

- **Async query kind** ([ADR 0021](../decisions/0021-async-queries.md), [commands.md § Async queries](../architecture/commands.md#async-queries)): `defineAsyncQuery` in `define.ts`, `Dispatcher.queryAsync`; agents reach it through the same tool as any query (read-only and idempotent hints).
- **`design.reference.find`** with `kind: 'levels' | 'section'` as above; `design.shape.import { from }` with `roundInside`; `scale`, `placed` and `facingDepth` on import and update.
- **Corner semantics** (two readings, both "where a tool must fit"): `find` reports the **material's** concave corners per loop (an outline's inner bends, a cavity's corners); the shapes `from` makes report `minInsideRadius` in the **pocket** sense, as `design.shape.get` does, because a shape is cut as a pocket or followed as a profile. A mid-wall outline therefore shows its fitted fillets (r 65 at z 20 of the enclosure), never the 0 of a line path.
- **Section shapes** carry no link or source back to the reference (the reference-only rule): an ordinary literal shape, its name "Section 20 mm".
- **UI:** the Levels and Section rows (face picker, levels from both sides, section depth, loops filter, corner chips, rounding, Create shape / Create shapes). Choosing a level sets the shared section depth that the Shape Editor backdrop reads as well.
- Tests: `fit-polyline.test.ts`, `mesh-levels.test.ts`, `reference-section.test.ts`, `reference-find.test.ts`, `Reference.test.tsx` (axe), the e2e reference spec with renders.
- **Follow-ups (2026-11-24):**
  - **Fitter:** circle tangents, the long-chord alternative and the sliver merge ([§ Fitting](#fitting)); S8 met at every height of the enclosure. The circle test also refuses a chord over 46° (a D shape was read as a full circle).
  - **Loops on the ghost:** the window's `reference.section` IPC takes `fit` and answers the fitted loops too (the agent result stays a summary, RT-G); the Reference panel publishes the face, depth, the shown loops and the hovered level as window state (`referenceOverlay`), and the Design scene draws them in the part frame (`reference-overlay.ts`, `ReferenceOverlay.tsx`): loops as lines, sharp inside corners as rings, the hovered level's faces (`levelTriangles` in `mesh-levels.ts`, run in the window on the ghost's own triangles: a display filter, not a query).
  - **Shape Editor backdrop:** `useReferenceSection` asks for the fitted loops and draws (and snaps to) them, chorded within 0.002 mm; an open section keeps the raw segments.
  - Tests: `fit-polyline.test.ts` (long and short chords in turns), `reference-section.test.ts` (feature-rich heights), `mesh-levels.test.ts` (`levelTriangles`), `reference-overlay.test.ts`, `Reference.test.tsx`; renders `df-reference-tools` and `df-reference-level-hover`.

## Implementation (P2)

Implemented 2026-11-24 (hardening DF60 P2, agent API only); code points back here.

- **`face`** (`FaceArg` in `reference-find.ts`) is a union of a stock face id and `{ setupId }`, on `design.reference.find` and `design.shape.import.from`. `resolveFace` looks the setup up in the plans of the part (any plan; rule `unknownSetup` at `face.setupId` otherwise) and takes its direction; the result names `setupId` beside `face`. A setup face reads exactly as its stock face does (the same levels, loops and shapes).
- **`frame: 'setup'`** on the find (rule `setupFrameNeedsSetup` without a setup face) adds the `wcs` object ([§ Faces and frames](#faces-and-frames)): face frame → part frame (`faceFrame`) → WCS (`unapplyPlacement` of `setupFrame` with the setup's rotation). Bounds stay axis-aligned under the quarter turns. Shapes are still made in the face frame, so `design.shape.import.from` takes no `frame`.
- Budget: 109 838 → 110 210 characters (+ 0.37 K, no new tool; [llm-api.md § Implementation](../architecture/llm-api.md#implementation-task-310)).
- Tests: `reference-find.test.ts` (a bottom setup's `{ setupId }` equals `stock.bottom` for levels, section and import; `frame: 'setup'` with a 90° rotation matches `setupFrame`; the two refusals).

## Implementation (P3)

Implemented 2026-11-24 (hardening DF60 P3); code points back here.

- **Core:** `mesh-holes.ts` (`meshHoles` on a face-frame matrix, `holeGroups`, `holeSuggestion`, `csAngle`, `fastenerFor`), as [§ 2](#2-features-holes) describes; `circleOf` is split out of `fit-polyline.ts` and `nestingRoles` out of `reference-section.ts` so the slices use the same circle test and nesting as the section. The worker task `reference.holes` (geometry lane) caches the holes per matrix and options beside the kept mesh.
- **`design.reference.find { kind: 'holes', maxDiameter? }`** returns `groups` (size, holes, pattern, `suggest`, `note: 'noTool'` with `smallestTool`, a `message`; `wcs` with `frame: 'setup'`) and `holeCount`; `limit` counts holes (default 64). `reference.featureBelowTool` on `design.reference.update` ([§ 4](#4-scale-and-fit)).
- **UI** ([ui.md § Reference tools](../conventions/ui.md#reference-tools-df60)): a Holes section under Section, one row per group ("4 × Ø 2.45 mm countersunk Ø 4.86 mm 83°, 3.94 mm deep, grid 2 × 2"), a "No tool under Ø …" chip, and "Add as Bolt hole" / "Add as Drilling" with the group's icon. A click sends the suggestion: a pattern as its first hole and `design.clones.add` (source `featureId` or the drillings' `operationIds`), a list as one command per hole; all with one gesture id, so one undo step. A group whose mouth is below the face (`belowFace`) has the button disabled with the reason beside it. The holes are drawn on the ghost as `--vp-selected` rings at their mouths (`holes` in `referenceOverlay`); the viewport's text summary counts them.
- **Decisions while building:** the countersink angle is the median slope of the tilted facets and the suggestion snaps it to 82°/90°/100°/120° within 2° (the enclosure's measures 82.85°, so `82°`); the row shows the measured angle rounded. A blind hole that ends in a void (the enclosure's foot holes stop 0.24 mm under the cavity floor) reads as `flat`. Setup faces joined the panel's face picker in P5's change ([§ Implementation (P5)](#implementation-p5)).
- Budget: 110 210 → 110 461 characters (+ 0.25 K, no new tool; [llm-api.md § Implementation](../architecture/llm-api.md#implementation-task-310)).
- Tests: `mesh-holes.test.ts` (bottoms, mouths, from the opposite face, boss and tube, grid, circle, list, belowFace, steps, suggestion round trip through evaluated parts, the enclosure's foot holes), `reference-find.test.ts` (`kind: 'holes'` through the dispatcher, `noTool`, the suggestion sent as it is, `featureBelowTool` on and off), `reference-overlay.test.ts` (rings), `Reference.test.tsx` (Holes list, axe, one undo step per click, belowFace); e2e `reference.e2e.ts` adds the full enclosure's foot holes from the bottom and Add as Bolt hole; render `df-reference-holes` (light and dark).

## Implementation (P4)

Implemented 2026-11-24 (hardening DF60 P4); code points back here.

- **Core:** `mesh-distance.ts` (`MeshBvh`: a median-split BVH over triangles, closest point with an early stop below a bound) and `reference-compare.ts` (weld, closed check, the boolean method, the height-map fallback, `cornerRadii`/`isCornerFillet`). The worker task `reference.compare` (geometry lane, 120 s timeout) reads the reference through the kept mesh, places it with the ghost matrix, welds it (1e-4 mm) and runs the boolean method, or the height maps when the welded mesh is not closed or `fromMesh` refuses it. `design.reference.compare` is a job ([§ 3](#3-compare)) that evaluates the part, sends its mesh with surface labels, maps the surface indices to ids and operations and cuts the result to `limit`.
- **Result** as [§ Result (agent)](#result-agent), plus: `cause: 'cornerRadius'` on a region, `offcuts: { count, volume }` (extra pieces that never touch the reference: the frame a through profile cuts free; not regions, and left out of `partVolume`; DF90: also the frame a through profile's tabs still hold, see below), `note` when the height maps were used (why) and `evaluation` = the evaluation's `inputHash`. `threshold` is a plain number in mm (0.001–10), like the find's knobs; `limit` 1–64.
- **Decisions while building:**
  - **Regions, not raw pieces.** One boolean piece can join unrelated deviations through a facet-thin sliver along a wall (on the enclosure, the notch, the rebate and the top edge round are one piece of `part − reference`). A piece is split into regions by its _deviating samples_: each own-side triangle is sampled on a barycentric grid (≤ 8 per edge, step max(piece diagonal / 32, threshold)), samples farther than `threshold` from the other surface are kept and joined when they are grid neighbours or within one step of each other. A region's `volume` is the piece's when the region box (its samples grown by its `maxDev` + threshold) holds the whole piece, otherwise the piece's material inside that box (one more boolean).
  - **`maxDev` is sampled**, not taken at vertices: a missing pocket's floor is farthest from the reference in its middle. The error is below the sample step. A sample is first checked against the piece's own faces on the other surface (an upper bound of the true distance), which rules out most samples of a thin sliver cheaply.
  - **Noise:** a piece smaller than the threshold (diagonal) or without a deviating sample goes to `below`. `stats.missingVolume` and `extraVolume` count only the pieces over the threshold (DF90: a missing volume of 17.5 mm³ beside `maxMissing: 0` read as a contradiction); `below.volume` holds the rest.
  - **Frame held by tabs (DF90):** tabs join the frame to the part, and the part to the reference, so the frame used to show as the largest extra region (`profileN.offcut`). The command passes the loops of the +z through profiles with tabs (shape rings flattened away from the part, `WasteLoops`); the worker builds a waste solid (outside the loop for an outside profile, inside it for an inside one, over the compared box) and subtracts it from the extra material before the pieces are split. The cut faces neither count as contact nor are measured; the removed volume is one more `offcuts` entry and leaves `partVolume`. Profiles on other faces and on-line profiles are not clipped (follow-up).
  - **Attribution:** the part-surface triangles of the piece inside the region box, by area (top 3 surfaces shown; operations are the surfaces' operation ids that exist in the part).
  - **`cornerRadius`:** an extra region whose part area is ≥ 80 % on corner/fillet surfaces (`.corner[i]`, region arcs, `.floorFillet`) and whose `maxDev` is at most that surface's radius.
  - **Inside-out reference** (negative volume after welding) is turned over rather than refused. The closed check is done in the worker on the welded mesh, not stored on the reference record.
  - **The part mesh is copied** to the worker (welded there, 1e-6 mm): the evaluated solid lives in the evaluation service, not in the geometry worker, so reusing it would need a new cross-process handle. Measured cost is small next to the booleans.
- **Performance:** the full enclosure (77 K triangles) against its approximated design: ≈ 2.1–2.4 s in-process under vitest on the dev machine (`toMesh` of the two boolean results ≈ 1.3 s, regions ≈ 0.7 s); the < 2 s target was not quite met at P4. P5 brought it under ([§ Performance](#performance)).
- **Enclosure check:** with the cavity, the two bottom steps and the outline profile imported from sections, nothing is missing (maxMissing < 0.1 mm); the omitted features come out as extra regions: the top edge round with the notch (4.27 mm) and rebate along it as one region, the back slot (1.09 mm) and the six pilot holes (1.13–1.54 mm) each on their own; the frame the through profile frees is in `offcuts`. A cavity 2 mm too deep ranks first as missing on `pocket1.floor`.
- **Agent:** the primer's Reference bullet names `design_reference_compare { source: { kind: "part" } }` → `job_wait`.
- Budget: 111 284 → 112 165 characters (+ 0.88 K, one new tool, 126 tools; [llm-api.md § Implementation](../architecture/llm-api.md#implementation-task-310)).
- Tests: `reference-compare.test.ts` (BVH against brute force and Voronoi regions, weld/closed/pieces; the test part against itself, a pocket 0.2 mm too deep, a missing pocket within 1 % of its volume, sharp vs r 3 corners as `cornerRadius` with the threshold moving them to `below`, refusals; the height-map fallback for an open mesh; the enclosure approximated and with a too-deep cavity).

## Implementation (P5)

Implemented 2026-11-24 (hardening DF60 P5); code points back here. UI as in [ui.md § Reference tools](../conventions/ui.md#reference-tools-df60).

- **Flow:** the panel's Compare switch sets `referenceCompare` in the window's UI store (part, reference, threshold). `useReferenceCompare` (mounted with the design scene, so it outlives the panel) runs `design.reference.compare { source: part, threshold, limit: 20 }` 300 ms after each finished evaluation, aborting the running job first (`job.abort`), and waits for it (`job.wait`). A result whose `evaluation` is not the current `inputHash` is dropped (a newer run follows). It then asks main for the **overlay view** of the mesh it shows: `reference.compareView { referenceId, positions, threshold }` (window plumbing like `reference.section`, not a command: RT-G), answered by the geometry worker task `reference.compareView` with the **signed distance** of every vertex (`signedDistances`, + extra, − missing) and the **missing pieces** over the threshold (the triangles of the `reference − part` pieces with deviating samples, kept by the last compare for that mesh hash and threshold, else none). The scene draws the view only on the mesh whose `positions` it was computed for.
- **Signed distance** (`MeshBvh.signedDistance` in `mesh-distance.ts`): the closest point and, for its sign, the angle-weighted pseudo-normal there (Bærentzen and Aanæs): the face normal inside a face, the sum over the faces tied at an edge or a vertex (weighted by their angle at a vertex). Right at concave and convex edges and corners of a closed, outward mesh; for an open reference (height-map method) the sign is that of the nearest facet and can flip near holes in the mesh ([§ Not yet](#not-yet)).
- **Colours** (`viewport/deviation.ts`): neutral `--vp-part` within ± threshold, then 35 % → 100 % of `--danger` (missing) or `--info` (extra) at the largest deviation of that kind (at least twice the threshold), per vertex, interpolated across triangles. Missing volumes: translucent `--danger` (0.3). A chosen region is framed (box grown to ≥ 10 mm, from the current view direction) and drawn as a `--vp-selected` box.
- **Setup faces in the panel** (P2's UI gap): "Read from" lists the setups of the part's plans under a "Setups" group; choosing one sends `face: { setupId }` to the find and to `design.shape.import.from`.
- **Decisions while building:**
  - **Separate view request** instead of distances in the job result: the job's result is the agent result (≤ 2 KB, RT-G), the distances are megabytes; the window sends the mesh it draws, so the distances always match its vertices.
  - **The overlay outlives the panel**: choosing a region selects its operation, which closes the Reference panel (a design selection of another id does); the overlay stays on, its legend with "Hide" moves to the viewport's bottom-left, and edits in the operation inspector re-colour the part. The switch in the panel and Hide turn it off; removing the reference or switching part turns it off.
  - **`--danger` at low opacity for the missing volumes**, not `--danger-subtle` (an area token for chrome: it is close to `--vp-part` in light and near-black in dark, so the volumes did not read).
  - **Pieces are solids, not mesh shells** (a P4 fix found by the e2e): a part that wholly holds the reference (the plain stock block before any operation) leaves `part − reference` as a block with a void, which `components` split into an outer shell that "never meets the reference" (counted as an offcut) and a void shell of the reference's volume without deviating samples: "matches within 0.1 mm". `solidPieces` joins each inner shell (negative volume) to the smallest outer shell whose box holds it, so it is one extra region of the right volume.
  - The job appears in the status bar's job list as "Compare with reference" while it runs (≈ 2 s), like evaluations.
- **No schema change:** `design.reference.compare` is unchanged; llm-api.md and the budget stay as P4 left them.
- Tests: `mesh-distance.test.ts` (sign on faces, convex edges and corners, against inside-the-box at random points, a concave edge of an L prism); `reference-compare.test.ts` (the overlay view of a pocket 0.2 mm too deep: −0.2 on the floor vertices, within 0.2 elsewhere, the missing slab at 0.1 and none at 0.5; a box wholly inside the block is one extra region of block − box, no offcut); `deviation.test.ts` (the colour map, scale, per-corner colours, fade; region frame, worst region, view only on its mesh); `Reference.test.tsx` (off runs nothing; on runs the job with the threshold and limit, asks the view for the shown mesh, summary and legend, region framing; an edit re-runs and replaces; a stale result is dropped; Hide stops; setup faces in Read from send `{ setupId }`; axe); `tokens.test.ts` (the map's ends on `--vp-part`, mark target); e2e `reference.spec.ts` and renders.

## UI reach of the agent's values (X2)

Design notes for the gaps X2-1, X2-2, X2-3 and X2-9 of [v0.4-llm-first.md § X2 measured](../plans/v0.4-llm-first.md#x2-measured-2026-11-26): the app flow reached every step of X1 but the user typed values an agent reads from `find` and `design.shape.import { from }` results. Decisions taken by delegation (D70, 2026-11-26); visuals in [ui.md § Reference tools](../conventions/ui.md#reference-tools-df60) and [§ Shape in the operation inspector](../conventions/ui.md#shape-in-the-operation-inspector). No command, argument or result changes: the agent API and `tools/list` stay as they are.

- **Full precision on demand (X2-1).** The rows keep their 0.01 mm figures (they are for reading at a glance); every figure that the row rounds carries the value at 0.001 mm (0.0001″) as its tooltip and in the row's accessible description: a level's depth, a loop's size, a hole group's bore, mouth (countersink Ø and the measured angle at 0.1°) and depth. No copy button: the values a user would copy now have actions of their own (below), and a tooltip reads without a click.
- **Hole positions (X2-1).** A hole group's row gets a muted second line with where the holes are, in the face frame at 0.001 mm: a grid "First at u 36.469 v 55.735 · pitch 177.062 × 88.531 mm" (X/Y on the top), a circle "Centre … · pitch Ø …", a list its first four centres ("… and 2 more").
- **Bolt hole on the floor (X2-1, X2-9).** A group whose mouth lies below the face (`belowFace`) is offered "Add as Bolt hole on Facing 1 floor" when the part has a floor that can carry it: an operation's floor surface on the same face (`onTarget`, a facing or pocket floor or a blind profile's floor) whose depth from the face equals the mouth's `top` within 0.01 mm, the first in design order. The click sends the suggestion as it is with `on` that floor, then the Clones row, in one gesture (one undo step): what X1 sends. Without such a floor the button stays off with the reason, as before.
- **Place where the section lies (X2-2).** A section's shapes are made in the face frame, so `placeAt` (anchor min/min at the shape's own min corner) is the identity placement. The pocket's and profile's Shape group offers it for any named shape: **"Place as drawn"** beside "Edit shape" puts the shape at its own coordinates on the operation's face (anchor min/min, position the min corner of the shape's own bounds at 0.001 mm: `placeAt` for a section's shape, the same box moved by the inset for an offset of one). Two updates (`anchor`, then the position) in one gesture, one undo step; off while the shape is rotated, mirrored or scaled (its own coordinates no longer describe the placed box) or already there. **Not automatic on choosing a shape:** a drawn or imported shape's own coordinates mean nothing on the face (an SVG's are the page's), and a shape does not record that it came from a section (no schema change in pre-alpha).
- **The inset of a step (X2-3).** Decision: a readout in the Section group, not a measuring tool. X1's inset is the mean gap of the four sides of two sections' outlines' bounds; a point-to-point measure in the Shape Editor gives one side only, and showing raw bounds leaves the arithmetic to the user. Under the loop list an **"Inset from"** `Select` lists the part's closed shapes; with one chosen, the line reads "4.821 mm inside Section 22.5 mm (sides 4.81–4.83 mm)": the mean of the four gaps between the shape's own bounds and the bounds of the section's largest outline (both in the face frame, each rounded to 0.001 mm first, as the results give them), "inside" or "outside" by its sign, the spread of the four sides after it (a non-uniform step shows a wide spread). **"Create offset"** beside it makes the shape's offset at that distance and side (the Offset dialog's command: a new shape "Section 22.5 mm offset", one undo step). The shape's coordinates are read as the face frame, which holds for shapes made from a section of the same face; the hint says so.

## Performance

The worker keeps the last mesh read per asset. Measured on the full enclosure body (77 112 triangles, dev machine): `levels` ≈ 120 ms (target < 100 ms for 50 K triangles: in line), section chaining 3–8 ms and fitting 2–14 ms (target < 200 ms); `holes` (P3) ≈ 210–225 ms per face (the first read; the worker caches it). At the 1 M triangle warn limit, about ten times that.

**Compare** (P4 → P5, `reference-compare.perf.ts`: the enclosure against its approximated design, evaluation excluded, in-process under vitest, dev machine; three edits of the cavity depth after a first run):

| Run                    | P4 (before)          | P5 (after)           |
| ---------------------- | -------------------- | -------------------- |
| First compare          | ≈ 2.33 s             | ≈ 2.01 s             |
| After an edit (median) | ≈ 2.31 s (2.22–2.60) | ≈ 1.78 s (1.72–1.94) |

What P5 changed: the worker keeps the **prepared reference** (placed, welded, closed check, volume, BVH) per reference file and matrix, and the reference **solid** as a kept solid (`SolidPort.kept`, within the shared 300 K kept-triangle budget; a larger reference is rebuilt per run), so an edit no longer redoes the transform, weld, BVH (≈ 110 ms) and `fromMesh` (≈ 70 ms); region clustering uses numeric cell keys instead of strings (≈ 225 → 100 ms); the BVH's closest-point search reuses its stack and starts from the last sample's triangle (sampling ≈ 400 → 250 ms). What is left is the two manifold booleans and their `toMesh` (≈ 1.15 s), which only a cheaper method (a narrow band around the changed operations) would cut. The target (< 2 s for an edit) is met; the first run is at the edge.

The overlay's per-vertex view (`reference.compareView`) reuses the prepared reference's BVH: signed distances for the approximated design's mesh (8 247 vertices) against the enclosure take ≈ 260 ms after the compare (a run after an edit measured 1.70 / 1.75 / 1.90 s in the same session).

## Not yet

| Item                                                         | Where                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| `detail: "full"` on `find`                                   | When an agent needs loop geometry without making shapes      |
| `source: plan` (simulated cut)                               | [deviation.md](deviation.md), the v0.4 follow-up             |
| Compare overlay in the plan scene (against a plan's part)    | With `source: plan` ([deviation.md](deviation.md))           |
| Exact signs of the overlay against an open reference         | With a watertight repair of open meshes                      |
| Silhouette (outline of the whole model seen from a face)     | Later; a section near the widest level serves                |
| Feature recognition into operations                          | Assisted recreation, later                                   |
| Holes along other axes than face normals; slots and obrounds | With assisted recreation                                     |
| STEP references (exact faces instead of facets)              | STEP import ([reference-model.md](reference-model.md#later)) |

## Phases

Smallest useful first; each phase is mergeable on its own and ends with `npm run check` green and the doc's tests.

| Phase | Content                                                                                                                                                                                                                                                      | Needs                       | Unblocks                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------- |
| P0    | **Done.** Docs accepted: this doc (and reference-query.md merged into it, Q71), ui.md amendment for the panel rows, llm-api amendment + ADR for async queries (Q72)                                                                                          | Q70–Q80                     | all                                                         |
| P1    | **Done (implemented).** **Levels + section → shape**: async query kind; `levels` (both sides, visible area); `section` summary; chaining, `fit-polyline`, corner radii; `from` (+ `roundInside`); fit result fields; Reference panel Levels and Section rows | P0; S8 measured in P1       | The black-box flow without a slicer for outlines and depths |
| P2    | **Done (implemented).** **Setup faces**: `{ setupId }` faces and `frame: 'setup'`                                                                                                                                                                            | P1                          | Reading sections against a setup's program                  |
| P3    | **Done (implemented).** **Holes**: detection, groups, patterns, suggestions, `noTool`; `reference.featureBelowTool` after a scale (left out of P1: it needs holes); Holes list and ghost rings                                                               | P1                          | Bolt holes and drillings from the reference                 |
| P4    | **Done (implemented).** **Compare (agent)**: `design.reference.compare { source: part }` boolean method, height-map fallback, attribution, `cornerRadius`                                                                                                    | P1 (`mesh-distance` shared) | A measurable "does the design match"                        |
| P5    | **Done (implemented).** **Compare overlay**: per-vertex colours, missing volumes, regions list, auto re-run while shown; setup faces in the panel                                                                                                            | P4, ui.md amendment         | –                                                           |
| later | Simulated-cut source, causes, exit numbers ([deviation.md](deviation.md)); holes off the face normal, slots; silhouettes; STEP references                                                                                                                    | v0.4 follow-up              | –                                                           |

## Test plans

Fixtures: the enclosure STL (`src/core/design/__fixtures__/enclosure-wood-base.stl`), the black-box test's full enclosure body (`enclosure-wood-full.stl`, added with P1 as Q71 agreed; [testing.md § Fixtures](../conventions/testing.md)), and synthetic meshes written from the evaluated test part as `stl.test.ts` does.

- **P1 levels** (`mesh-levels.test.ts`): a synthetic stepped block gives each floor's depth within 0.001 mm and its area within 0.1 %; a floor under an overhang has `visibleArea` 0 from that side and full from the other; the enclosure gives the cavity floor and the bottom steps within 0.01 mm of the black-box values; `minArea` and `limit` with `more`.
- **P1 section and fitting** (`fit-polyline.test.ts`, `mesh-section.test.ts`): a faceted circle (32–256 chords) fits to one `circle` within the tolerance; a rounded rectangle r 4 faceted with 8 chords per corner gives four arcs with `minInsideRadius` 4 ± 0.01; a sharp rectangle keeps four corners (`sharp`, `minInsideRadius` absent) and none becomes a micro-arc; the enclosure outline and cavity meet S8's targets; open mesh → `open: true`; a plane missing the mesh → `loops: []`.
- **P1 section → shape** (`reference-commands.test.ts`): import with `from` makes a shape whose `smallestInsideRadius` equals the fitted value (not 0); round trip: pocket with the shape, evaluate, section the part at the same depth: two-sided distance ≤ the tolerance; `roundInside 1.6` on a sharp rectangle gives r 1.6 corners and the report's count; scale ×0.5 then section: loops half size, nothing scaled by the caller; undo is one step.
- **P1 UI** (`Reference.test.tsx`, axe): Levels rows and choosing one sets the depth; Section draws fitted loops with corner chips; Create shape(s) sends the command; e2e with the enclosure fixture (renders behind `DFYOM_RENDERS=1`, hidden windows per the fixture).
- **P2:** `{ setupId }` of a bottom setup equals `stock.bottom`; `frame: 'setup'` with a 90° rotation matches `setupFrame`.
- **P3 holes** (`mesh-holes.test.ts`): synthetic through, flat, cone bottoms; counterbore and countersink mouths (angle within 1°); a boss is not a hole; a 2 × 2 grid and a 6-hole circle become patterns, an irregular set a list; suggestions round-trip: sending the suggested args and evaluating gives a part whose hole sections match within 0.02 mm; the enclosure's four foot holes come back as one countersunk group, grid 2 × 2, at (±88.53, ±44.27); `noTool` with a library whose smallest tool is larger.
- **P4 compare** (`reference-compare.test.ts`): reference = the evaluated test part written as STL → no region over the threshold; a pocket 0.2 mm too deep → one `missing` region, maxDev 0.2 ± 0.01, attributed to that pocket; a missing pocket → one `extra` region with its volume within 1 %; an open mesh → `method: 'heightmap'`; the black-box project's design against its STL lists the eased cavity step (extra, ≈ 1.09 mm) and the omitted wall slots (extra) as the worst regions; perf: enclosure < 2 s on the reference machine (`npm run perf`). As built: see [§ Implementation (P4)](#implementation-p4).
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
