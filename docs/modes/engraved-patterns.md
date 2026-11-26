# Engraved patterns and the Line operation

Status: accepted (by delegation, 2026-11-25: the user delegated the choices, D70, so the recommended options below are **accepted by delegation** and the user may veto; hardening [DF112, DF113](../plans/hardening.md#intake-user-feedback-goes-here), user TG #352; E0 spike run 2026-11-25, [report](../research/2026-11-25-engraved-patterns-and-lines.md#spike-e0)) · Research: [engraved patterns and lines](../research/2026-11-25-engraved-patterns-and-lines.md) · Builds on: [patterns.md](patterns.md) (lattices, boundary, presets dialog), [edge-chamfers.md](edge-chamfers.md) (V-bit toolpaths), [design-v0.3.md](design-v0.3.md) (shapes, open paths, SVG import), [features.md](features.md) (feature model A1–A6), [geometry.md § Carving (later)](../architecture/geometry.md#carving-later) (engraving on-line) · Terms: [glossary.md](../glossary.md)

The user asked (TG #352): "add a new feature: an engraved pattern and an operation it will need: a Line. The Line may be curved and have different depth across its path. I guess the easiest way to have this flexibility and configurability would be by SVGs (where depth is encoded in color or brightness) … please also create some typical presets with SVGs. And also create a few circular ones please (for a round surface)."

- A **Line** is an operation. It cuts a groove along the centreline of open or closed paths, and its depth may change along the path. It is candidate 9 of [features.md § Candidate features](features.md#candidate-features) and the "Engraving (on-line)" of [geometry.md § Carving](../architecture/geometry.md#carving-and-engraving-vector-based).
- An **engraved pattern** is a feature. It places a **motif** (a preset SVG, an imported SVG or the part's shapes) once or on a lattice over an area, and cuts it with one owned Line.

## Decisions

| Id   | Decision (accepted by delegation, D70)                                                                                                                                                                                                                                                                                          | Section                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| EP-A | **A new operation kind `line`**, not a profile variant. A Line takes many paths, cuts on the centreline at a depth that may vary, and accepts V-bits, ball and flat end mills. It has no `slotWidth`, no tabs and no cut side. Profile `side: 'on'` stays for constant-width grooves and slots                                  | [Line operation](#line-operation)             |
| EP-B | **Depth is stored as levels on shapes.** Path items of named shapes get optional per-vertex `levels` (0..1). The operation maps them to depths with `{ min, max }`. The geometry stays one shape and editable in the Shape Editor, and changing min/max needs no re-import                                                      | [Levels](#levels-on-shapes)                   |
| EP-C | **SVG encoding:** stroke darkness → level (black = deepest), a colour legend at import that can override any colour, `data-level` (one value or stops start → end) for exact values, and elements whose ends meet chained into one line. Stroke width → depth is an import option. Gradients come later, and opacity is ignored | [SVG encoding](#svg-encoding)                 |
| EP-D | **Toolpath:** centreline, depth passes at most `stepdown` deep (pass k clamps at −k · stepdown), open lines alternate direction, **ramp-back entry** within `rampAngle`, level steps **blended** over ±`blend`, helical arcs. Lines in nearest-neighbour order, each finished before the next                                   | [Toolpath](#toolpath-plan)                    |
| EP-E | **The engraved pattern is its own feature kind `engraving`.** It shares Pattern's layout code and schema (lattice, spacing, boundary, margin, fit) and its Presets dialog. It differs in the motif (lines), in allowing tiles to touch or overlap, and in chaining and de-duplicating lines across tiles                        | [Engraved pattern](#engraved-pattern-feature) |
| EP-F | **"Round surface" = a round flat part** (coaster, lid, box top) cut on a 3-axis machine. Circular presets are single round motifs that **fit the boundary**, and polar lattices with **radial** rotation. No cylinder wrapping (needs a 4th axis)                                                                               | [Round parts](#round-parts)                   |
| EP-G | **Presets are SVG files shipped in `src/core/design/engraving/presets/`.** They are created for DFYOM under GPL-3.0-or-later and loaded as text. A shipped preset never changes; a new design gets a new id                                                                                                                     | [Presets](#presets)                           |
| EP-H | **Agent API:** `design.line.add/update` and `design.engraving.add/update` (updates as listed sketches; the engraving's layout args as sketches of `design.pattern.add`'s), and `levels` on `design.shape.import`. ≤ 3.0 K of `tools/list` in all                                                                                | [Agent API](#agent-api)                       |

## Line operation

`design.line.add` creates an operation of kind `line`:

| Field   | Kind / values                                                                                                                                                                                                 | Default                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `on`    | Face target ([design-v0.2.md § Face targets](design-v0.2.md#face-targets-generalised-on)), as a pocket                                                                                                        | Last facing's floor, else `stock.top`                 |
| `paths` | 1–50 placed named shapes `{ shapeId, center, rotation?, mirror?, scale? }`, as a pocket's named shape. Every loop and open path of each shape is a line                                                       | –                                                     |
| `depth` | A length (constant), `{ start, end }` (linear along each line, by arc length), or `{ min, max }` (from the shapes' [levels](#levels-on-shapes): level 0 → `min`, 1 → `max`; a path without levels is level 1) | `{ min: 0.2 mm, max: 1 mm }` with levels, else 0.5 mm |
| `blend` | Length ≥ 0: a level step is blended over ±`blend` along the line                                                                                                                                              | 1 mm                                                  |
| `tool`  | The tool field (A4 as on other operations): `chamferMill` (V-bit, the default auto choice), `ballEndMill`, `flatEndMill`                                                                                      | auto: a 60° V-bit                                     |
| `name`  | Default "Line 1"                                                                                                                                                                                              |                                                       |

- **Plan strategy keys** (plan-only, as other operations): `stepdown` (from feeds), `entry` (`ramp` default, `plunge`: V-bits only), `rampAngle` (0.5°–30°, default 10°, the chamfer's range).
- **Surfaces:** none. A groove's floor is not a face target.
- **Invariants:** every depth > 0 and less than the stock under the face (`lessThanStockThickness`); `min ≤ max`; `{ start, end }` > 0; the shapes exist (`unknownShape`). A shape of only closed loops is fine (a closed line).
- **Removal solid** (built otherwise, see [Implementation (E1)](#implementation-e1)): the tool swept along each line, built per chord as the convex hull of the tool solid (cone, ball-capped cylinder, cylinder) at the chord's two ends, unioned per line. Arcs are chorded at the surface tolerance. Built and cached per line. E1 measures the cost on the rosette (≈ 1 400 mm of line) against the evaluation budget; per-cell batching as in [patterns.md § Chamfer](patterns.md#chamfer) is the fallback.
- **Width read-out:** the groove width at a depth: V-bit w = dt + 2 d tan(α/2); ball 2 √(d (D − d)) up to D; flat D ([research § Tools](../research/2026-11-25-engraved-patterns-and-lines.md#tools-entries-and-passes)).

### Levels on shapes

- A `path` item ([design-v0.3.md § Shape definition](design-v0.3.md#shape-definition)) gains optional `levels`: one number 0..1 for the whole path, or one per vertex (vertex 0 = start, i = end of segment i; `levels.length` = segments + 1, closed paths repeat vertex 0 at the end). The level is linear by arc length between vertices. Rules: `levelRange` (0..1) and `levelCount`.
- **Booleans ignore levels.** A shape with levels used by a pocket or profile cuts as before. `dfm.levelsIgnored` (info) says so when levels exist but the operation is not a Line or the Line's depth is constant.
- **Shape Editor:** a path with levels draws in a dark-to-light ramp (the same as its SVG preview), and each vertex has a Level field. A "Levels" toggle in the toolbar shows or hides the ramp.
- **No migration:** an absent field is the old behaviour (pre-alpha rule; `schemaVersion` unchanged).

### SVG encoding

How `design.shape.import { levels }` reads depth (default `colour`; `width`; `none`). The research compares the options ([§ Encoding depth](../research/2026-11-25-engraved-patterns-and-lines.md#encoding-depth-in-an-svg)).

1. **`data-level`** on an element (or inherited from its group): one value 0..1, or stops spread evenly from start to end (`"0 1 0"` fades in and out). The importer splits elements at the stops' positions, so the vertex levels are exact. This wins over the colour.
2. **Stroke colour** (`stroke` attribute or `style`, inherited): level = 1 − luma (Rec. 709) of the opaque colour. Black is the deepest; white strokes are refused as invisible (`levelWhite`, warning). Fills are ignored for open paths; a closed path's level comes from its stroke, else from its fill.
3. **Colour legend:** the import dialog lists every distinct colour found with its element count and default level, and each level can be edited before import. That is how a red/blue drawing becomes 1 mm / 0.3 mm. The result stores the levels, not the colours.
4. **`width`:** level = stroke width (after the transform) ÷ the widest stroke, for V-carve-style drawings.
5. **Chaining** is done by the Line, not the importer. Open paths of one Line whose ends meet within 0.01 mm form one line, and level steps between them are blended.
6. **Ignored, with a report warning:** `stroke-opacity`/`opacity` (`opacityIgnored`), gradient strokes (`strokeGradientIgnored`; a linear or radial gradient as a spatial ramp is E5), Inkscape Power Stroke outlines (they are fills).

The importer's `SvgShape` gains the element's stroke paint and width per item. The XML walk already has them ([`import.ts`](../../src/core/import/svg/import.ts) reads `style`). The import report gains `levels: { mode, colours: [{ colour, count, level }] }`.

## Toolpath (Plan)

A new generator `generateLine` (`src/core/toolpath/line.ts`), request kind `line`. The E0 spike's [`line.ts`](../../spikes/engrave/line.ts) is its sketch.

- **Profile:** per line, the depth along its arc length s as piecewise-linear z(s): levels mapped by `{ min, max }`, steps blended over ±`blend` (clamped to half the neighbouring pieces), measured from the `on` face.
- **Passes:** n = ⌈max depth / stepdown⌉. Pass k cuts z_k(s) = max(z(s), −k · stepdown), and the last pass is the profile. Open lines alternate direction (no return rapid); closed lines keep climb direction (as profiles) and start at the middle of their longest element (the edge chamfer's rule).
- **Entry (ramp-back):** before pass k, go `Lr` ahead in the pass direction along the floor already cut (pass 1: rapid, then feed down to the face), then ramp back to the pass start reaching z_k(start), at most `rampAngle`, never below z_k. Lr = drop / tan(rampAngle), capped at the line length. A line too short for the ramp zigzags on itself. Closed lines ramp along the loop before the start, as the chamfer's `rampRing`. `entry: 'plunge'` (V-bits) feeds straight down at `plungeRate`.
- **Moves:** `G1` with Z for lines; arcs with a linear Z are helical `G2`/`G3`; arcs are split at 90° and at every profile breakpoint. A profile that is not linear on an arc is split there.
- **Order:** lines in nearest-neighbour order from the front-left, each line entered at its nearer end (open lines are reversible). All passes of a line before the next. Travel uses [safe links](safe-links.md).
- **Crossings:** cut as they come (the later line cuts air in the earlier groove). Their count shows in the read-out. **Coincident** segments are removed before the toolpath (the deeper kept).
- **Feeds:** V-bits use [F10](../architecture/feeds-speeds.md#chamfer-mills-v04) with De = dt + 2 × max depth × tan(α/2), engagement `chamfer { depth }`. Ball and flat end mills use a full-width slot at the pass depth.
- **Spike numbers:** a 91 mm three-colour line, 0.52–1.5 mm deep, came to 2 passes, a 4.5 mm ramp, 36 gCode lines and 189 mm of cut ([research § Spike E0](../research/2026-11-25-engraved-patterns-and-lines.md#spike-e0)).

## Engraved pattern (feature)

`design.engraving.add` creates a feature of kind `engraving` (A1–A6 unchanged):

| Field      | Kind / values                                                                                                                                                                                                              | Default                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `on`       | Face target, as a pocket                                                                                                                                                                                                   | Last facing's floor, else `stock.top`                    |
| `motif`    | `{ preset }` (an id of [Presets](#presets)) or `{ shapeIds }` (named shapes of the part, open or closed, with levels; their joint bounding box is the motif's frame)                                                       | `{ preset: 'waves' }`                                    |
| `size`     | The motif's width (height keeps the aspect), or `scale`; with `layout: 'single'` and `fit: 'boundary'` it is derived                                                                                                       | the preset's size                                        |
| `rotation` | Angle, or `'radial'` on a polar lattice (each tile turned to face the centre)                                                                                                                                              | 0                                                        |
| `layout`   | `single` (one motif at `center`, or fitted) or a lattice: Pattern's `lattice`, `spacing` (gap ≥ 0 or pitch; touching tiles are the normal case), `angle`, `origin`, `alternate` ([patterns.md § Model](patterns.md#model)) | the preset's                                             |
| `boundary` | `face` or `{ shapeId, center, rotation? }`, as Pattern                                                                                                                                                                     | `face`                                                   |
| `margin`   | Length ≥ 0                                                                                                                                                                                                                 | 3 mm                                                     |
| `fit`      | `whole` (tiles wholly inside), `clip` (lines cut at the boundary less the margin) or, with `single`, `boundary` (the motif scaled to fit the boundary less the margin, centred)                                            | `clip` for lattices, `boundary` for single round presets |
| `depth`    | As the Line's (`{ min, max }`, constant, `{ start, end }`)                                                                                                                                                                 | `{ min: 0.2 mm, max: 1 mm }`                             |
| `name`     | Default "Engraving 1"                                                                                                                                                                                                      |                                                          |

- **Owned shape** `<id>_lines` (read-only, A1 as Pattern's `<id>_cells`) with one `engraving` item. It resolves in the 2D layer as follows:
  1. Resolve the motif: the preset SVG through the importer, or the shapes. Levels come along.
  2. Place it singly or at each lattice node (shared lattice code with the `pattern` item).
  3. Keep whole tiles or clip the lines to the boundary less the margin. Clipping an open path at a region's boundary is a new 2D port operation: split at the crossings and keep the inside pieces.
  4. Remove coincident segments, keeping the higher level.
  5. Chain lines whose ends meet across tiles.

  The resolution is cached by the item hash, as patterns.

- **Owned operation** `<id>_line`: a Line on `<id>_lines` with the feature's `on`, `depth` and its own tool field.
- **Invariants:** a resolved element count ≤ 20 000 (the SVG import limit, `engravingTooMany`); the motif has at least one path (`engravingEmpty`); `fit: 'boundary'` only with `single`; `rotation: 'radial'` only with `polar`.
- **Clones and split parts:** as patterns ([patterns.md § Split parts and Clones](patterns.md#split-parts-and-clones)). Lines crossing a split line are clipped per piece.

### Round parts

The user's "circular ones (for a round surface)" are motifs for a **round flat face**: a coaster, a lid, the top of a turned box. Two ways:

- **A round preset, single, fitted:** pick Rosette, set the boundary to the part's round outline (a circle shape or the outline profile's shape), and `fit: 'boundary'` scales it to the diameter less the margin.
- **A polar lattice with radial rotation:** a small motif (a leaf, a scale) repeated on rings about the centre, each turned to face outwards. Radial rotation is new here; Pattern's polar keeps cell orientation ([patterns.md § Model](patterns.md#model)) and can adopt it later.

Engraving follows flat faces only. A curved surface would need surface probing or a rotary axis, and is not planned.

## Presets

SVG files in [`src/core/design/engraving/presets/`](../../src/core/design/engraving/presets/), created for DFYOM (GPL-3.0-or-later, stated in each file's header comment). A manifest `presets.ts` lists the id, name, kind and default layout, and loads each file as text through the bundler (`?raw`, a declaration for `*.svg?raw` in core). A test imports every file without warnings. [`make-presets.mjs`](../../spikes/engrave/make-presets.mjs) reproduces them. Authoring rules: sizes in mm (`width="…mm"` and a matching `viewBox`), `fill="none"`, strokes only, depth by stroke darkness or `data-level`, tiles that join at their edges.

| Id             | Kind   | Default layout             | Content                                                        | Levels       |
| -------------- | ------ | -------------------------- | -------------------------------------------------------------- | ------------ |
| `waves`        | tile   | square, 20 × 10, gap 0     | One sine period per tile; rows chain into continuous waves     | 1            |
| `chevrons`     | tile   | square, 20 × 10, gap 0     | Two nested zigzags                                             | 1, 0.5       |
| `crosshatch`   | tile   | square, 10 × 10, gap 0     | Both diagonals → a diamond grid                                | 0.8          |
| `scales`       | tile   | staggered, 12 × 6, gap 0   | One arc per tile → fish scales                                 | 1            |
| `seigaiha`     | tile   | staggered, 20 × 10, gap 0  | Three concentric half rings (Japanese wave)                    | 1, 0.6, 0.35 |
| `basket-weave` | tile   | square, 16 × 16, gap 0     | 2 × 2 blocks of three strokes, alternating direction and level | 1, 0.55      |
| `greek-key`    | tile   | one row, 20 × 12, gap 0    | Meander band                                                   | 1            |
| `wood-grain`   | tile   | square, 40 × 20, gap 0     | Five flowing, periodic lines fading in and out (`data-level`)  | 0.1–1        |
| `vine`         | single | 60 × 26                    | Curved stem (tapered), almond leaves, tapering veins           | 0.5–1        |
| `rosette`      | round  | single, Ø 80, fit boundary | Twelve overlapping circles in a border ring                    | 1, 0.7       |
| `sunburst`     | round  | single, Ø 80, fit boundary | 36 rays fading outwards, long and short, centre ring           | 1 → 0.1, 0.8 |
| `ripples`      | round  | single, Ø 80, fit boundary | Five concentric wavy rings, shallower outwards                 | 1 … 0.32     |
| `mandala`      | round  | single, Ø 80, fit boundary | Eight inner and sixteen outer petals, rings                    | 1, 0.6, 0.35 |

- **The Presets dialog** of Pattern (DF107) is reused: a grid of thumbnails rendered from the SVG (dark = deep), grouped Tiles · Motifs · Round. Picking one sets `motif`, `layout`, `size` and `fit`, and nothing else.
- **Rosette note:** twelve circles meet at the centre, so the V-bit passes there twelve times (mostly air). The centre ring covers it.

## DFM

| Code                 | When                                                                                                                                                                                      | Kind    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `dfm.lineTooDeep`    | A depth beyond the tool's reach: a V-bit's cutting-edge height (DC − dt) / 2 / tan(α/2), a ball or flat end mill's flute length. Marker at the deepest place                              | error   |
| `dfm.lineMerge`      | Two lines (or two parts of one line) closer than their groove widths at that place plus 0.3 mm, so the wall between them goes. Found as `dfm.patternThinWeb` finds webs, up to 10 markers | warning |
| `dfm.lineShallow`    | A depth under 0.05 mm (a hairline that a stock height error erases)                                                                                                                       | info    |
| `dfm.levelsIgnored`  | Levels on a shape cut by a pocket or profile, or by a Line with a constant depth                                                                                                          | info    |
| `dfm.engravingEmpty` | No line left inside the boundary less the margin                                                                                                                                          | warning |
| `dfm.engravingHeavy` | The resolved lines pass 5 000 elements or 10 m: "the part updates more slowly"                                                                                                            | info    |
| Existing, unchanged  | `dfm.shapeOutsideFace`, `lessThanStockThickness`, the tool fit of the owned Line                                                                                                          | –       |

- Findings roll up on the feature row and show at the field that drives them (depth max, spacing, tool).
- **Read-out:** "86 lines · 1.42 m · depth 0.2–1.0 mm · width ≤ 1.15 mm (60° V-bit) · 12 crossings".

## UI

Follows [ui.md § Features (v0.4)](../conventions/ui.md#features-v04) and the inspector layout of [inspector-layout.md](../conventions/inspector-layout.md).

- **Add list:** "Line" among the operations; "Engraved pattern" next to Pattern. With Pattern there are now two decorative features, and the Add list's grouping follows DF98's one-list rule.
- **Line inspector:** Paths (a multi-pick of shapes with thumbnails, plus "Import SVG…" as DF49), Depth (a segmented choice: Constant / Start → end / From levels; then the fields), Tool, More (blend). Under the depth fields, a **legend**: a dark-to-light bar from `max` to `min` with the levels in use as ticks.
- **Engraved pattern inspector:** Motif (Presets… button, or the part's shapes), Layout (Single / lattice tiles, as Pattern), Area (boundary, margin, fit), Depth (legend as above), Read-out.
- **Import SVG dialog:** a Levels choice (From colour, From stroke width, None). With From colour it shows the colour legend: swatch, element count, a level field per colour, and a preview of the drawing in levels.
- **Viewport:** while editing, lines are drawn at their groove width with depth as shading. The boundary less the margin is dashed and clipped-away parts are ghosts, as Pattern.
- **Plan:** the Line's plan operation shows passes and the ramp in the toolpath view like other operations. The strategy row has Entry and Ramp angle.

## Agent API

Current `tools/list`: **114.7 K** of 120 K (114,720 chars, 141 tools, measured in E0).

| Tool / arg                                                                                                                                                                                                         | Estimate |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `design.line.add { partId, on?, paths, depth, blend?, tool?, name? }`                                                                                                                                              | ≈ 1.0 K  |
| `design.line.update { operationId, …same }` (`paths`, `depth` as listed sketches "As design.line.add …")                                                                                                           | ≈ 0.4 K  |
| `design.engraving.add { partId, on?, motif, size?, rotation?, layout?, boundary?, margin?, fit?, depth, name? }`. `layout` and `boundary` are sketches "As design.pattern.add …" (same meaning, validated in full) | ≈ 1.1 K  |
| `design.engraving.update { featureId, …same }` (sketches)                                                                                                                                                          | ≈ 0.4 K  |
| `levels: 'colour' \| 'width' \| 'none'` and `colours?: { "#rrggbb": level }` on `design.shape.import`; `levels` on path items of `design.shape.add` (update is already a sketch)                                   | ≈ 0.2 K  |

- **Total ≈ 3.1 K → ≈ 117.8 K**, 2.2 K headroom. The **target is ≤ 3.0 K**. If E1/E3 measure over it, the cuts come in this order: the depth union described once in the primer instead of per tool (−0.3 K), then the engraving's layout fields folded into one sketch arg (−0.3 K). Beyond that is DF79's option B (one `design.operation.update` for every kind), a separate decision.
- **No new query or preview tool.** Results carry `{ featureId, operationIds, lines, length, depth: [min, max], maxWidth, crossings, warnings }`, and `dryRun: true` on add/update returns them without changing the part, as Pattern. Presets are listed in the primer (13 ids), not in a tool.
- Results of `design.shape.import` carry the levels legend (output schema only).

## Slices

Sizes are agent working days including docs, tests and review, as in [patterns.md § Slices](patterns.md#slices).

| Slice | Content                                                                                                                                                                                                                                                                                                                                                                                                         | Exit                                                                                                                                                                   | Size        |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| E0    | **Done 2026-11-25** ([report](../research/2026-11-25-engraved-patterns-and-lines.md#spike-e0)). Spike: coloured strokes → levels with the existing importer, chaining, profile, passes, ramp-back, gCode through the GRBL post; 13 preset SVGs; `tools/list` measured                                                                                                                                           | Research note, sample program, presets render                                                                                                                          | S: done     |
| E1    | **Built 2026-11-25** (provisional, [Implementation (E1)](#implementation-e1)). **Line operation:** model, `constant` and `{ start, end }` depth on named shapes (open and closed), V-bit, ball and flat; `generateLine` (passes, ramp-back, plunge option, helical arcs, order, links); removal solid with its cost measured; `dfm.lineTooDeep`, `dfm.lineShallow`; `design.line.add/update`; minimal inspector | A curved open line fluting 0.2 → 1.5 mm with a 60° V-bit on the lid; removed volume matches the swept-cone integral within 1 %; golden; virtual machine to Idle        | M: ≈ 3 days |
| E2    | **Built 2026-11-25** (provisional, [Implementation (E2)](#implementation-e2); the deferred items listed there). **Levels:** `levels` on path items (model, Shape Editor ramp and field), importer paint per item, `data-level` stops, colour legend, `width` mode, `design.shape.import { levels, colours }`; the Line's `{ min, max }`, chaining and blends; `dfm.levelsIgnored`                               | The E0 sample imported in the app gives the spike's depths (±0.001 mm) and program; an Inkscape-saved copy too                                                         | M: ≈ 3 days |
| E3    | **Engraved pattern, single:** feature kind `engraving`, owned shape and Line, `motif` (preset or shapes), `single` with `center` or `fit: 'boundary'`, presets manifest and `?raw` loading, Presets dialog reuse, `design.engraving.add/update`, read-out                                                                                                                                                       | Rosette fitted to a Ø 90 coaster at 0.2–1.0 mm, in the UI and headless; every preset imports clean (test)                                                              | M: ≈ 3 days |
| E4    | **Tiling and circular:** lattices through Pattern's code, gap 0 tiles, `whole`/`clip` with open-path clipping, coincident-segment removal, chaining across tiles, polar with `rotation: 'radial'`, `dfm.lineMerge`, `dfm.engravingHeavy`, `dfm.engravingEmpty`                                                                                                                                                  | Waves over a 150 × 100 lid clipped to a rounded rectangle (continuous lines, no double cut); scales on a polar lattice round a lid rim; a merge found on a 0.3 mm wall | M: ≈ 3 days |
| E5    | **Later**, each on its own request: gradient strokes as spatial ramps, V-carving of closed regions (medial axis), single-line fonts (text), depth-scaled feeds, a smooth (eased) blend profile                                                                                                                                                                                                                  | –                                                                                                                                                                      | later       |

E1–E4 make the user's request: ≈ 12 days.

## Implementation (E1)

Built 2026-11-25 (provisional, on a branch). Code: `src/core/design/operation.ts` (`Line`, `LineDepth`), `src/core/geometry/line.ts` (chains, coincident removal, removal solid, width), `src/core/toolpath/line.ts` (`generateLine`), `src/renderer/src/modes/design/LineInspector.tsx`.

- **Model:** kind `line` with `on`, `paths` (named placements, 1–50) and `depth` (a length or `{ start, end }`); new optional kind, no `schemaVersion` change. `{ min, max }` (levels), `blend` and a path's `scale` came with [E2](#implementation-e2).
- **Tool:** the operation's tool field as on other kinds; the auto choice puts library chamfer mills (V-bits) first for a Line, and its generalized tool is a 60° chamfer mill of the standard sizes. Ball and flat end mills fit too (tool-fit rule `lineTool`). The removal solid and the DFM read the resolved tool (`lineCutter`); without one the default is a 60° V-bit, Ø 6.
- **Coincident elements** (`lineChains`): elements of all lines matched on a 0.05 mm grid of their middles with ends within 0.01 mm; the deeper is kept (equal: the later goes), and a line losing an element splits into open runs with their sliced depth profile. Two squares sharing an edge: one loop and an open run of three.
- **Removal solid:** the plan's per-chord convex hulls cost 5.2 s on 1 428 mm of line (20 copies of a 71.4 mm curve, ≈ 740 hull meshes in one batch union). Built instead per line as **one lofted mesh per smooth run** (the tool's profile across the line, mitred at each chord bend) with the tool itself (a convex polyhedron) at every corner over 20° (or where the mitre would fold) and at the open ends; their union is the Minkowski sum of the tool and the chorded line. Same 1 428 mm: **0.53 s** for the evaluation (140 meshes, 8 240 triangles, built in 17 ms). Volumes within 1 % of the swept-cone integral (0.2 → 1.5 mm curve), a closed square V-groove, a ball and a flat groove. Per-cell batching was not needed.
- **Toolpath:** as [Toolpath (Plan)](#toolpath-plan). A closed line with a constant depth starts at the middle of its longest element; with a ramp it starts at its own start (the profile's s = 0). Strategy keys `entry`, `rampAngle` (default 10°); pass kind `rough`. Feeds: chamfer engagement for a V-bit, slot for end mills.
- **DFM:** `dfm.lineTooDeep` is a **warning**, not an error: DFM findings are warnings or info. `dfm.lineShallow` info under 0.05 mm.
- **Agent tools, lean as the chamfer's:** `design.line.add { partId, name?, on?, paths, depth? }` and `.update` (`paths` and `depth` listed as sketches "As design.line.add …", validated in full). No `tool` or `generalTolerance` arg: the tool goes through `design.operation.tool.*`. `plan.design.operation.update` takes a Line's `depth` string (the shared `depth` arg); its paths and `{ start, end }` are edited design-side. Measured: `design_line_add` 986, `design_line_update` 544 chars; tools/list 114,720 → **116,272** (+1,552, 143 tools; estimate 1.4 K), 3.7 K headroom under 120 K. The ≤ 3.0 K target for E1–E3 leaves 1.45 K for E2/E3 (estimate 1.7 K): E3 takes the first cut listed under [Agent API](#agent-api).
- **Split parts:** split pieces do not carry a Line yet; the split reports it as a finding ("… split pieces do not carry Lines yet"). Clipping open paths per piece comes with E4.
- **UI (minimal):** "Line" in the Add list's Operations (after Drilling, icon groove); with no shape on the part, Add makes a wave shape (two arcs) and places it in the middle. The inspector: Paths (`on`, per path a shape Select and its centre u/v), Depth (Constant / Start → end), Tool. The plan copy shares it.
- **Tests:** `src/core/geometry/line.test.ts`, `src/core/toolpath/line.test.ts`, `src/core/design/line.test.ts`, `src/core/plan/line-plan.test.ts`; goldens `line-ramp.nc` (60° V-bit, 0.2 → 1.5 mm on a curve) and `line-vgroove-closed.nc` (90° V-bit, 0.8 mm round a rounded square) in `src/core/post/grbl/__golden__/`; headless exit `src/main/cli/exit-criteria.line.test.ts` (`dfyom batch`: shape, Line 0.2 → 1.5 mm, plan with the V-bit, export, virtual machine to Idle); e2e `e2e/line.e2e.ts` (Add → Line, Start → end, the Line in Plan).

## Implementation (E2)

Built 2026-11-25 (provisional, on a branch). Code: `src/core/import/svg/paint.ts` (colours, `data-level`), `src/core/import/svg/import.ts` (levels per item, stops), `src/core/design/shape-items.ts` (`levels` rules, `pathLevelProfile`), `src/core/design/geometry-input.ts` (levels and `scale` into the Line geometry), `src/core/geometry/line.ts` (profiles from levels, chaining, blends).

- **Model:** a path item's optional `levels` (one number or one per vertex, as [Levels on shapes](#levels-on-shapes)); level 1 is not stored. The Line's `depth` gains `{ min, max }` and the Line gains `blend` (default 1 mm) and a path `scale` (0 < scale ≤ 1000, about the placement's anchor). All optional, no `schemaVersion` change. Invariants: `levelRange`, `levelCount` on the item; `minAboveMax` on `depth.min`, `nonNegative` on `blend`. Changing an item's vertex count drops its per-vertex levels; a whole-path level stays.
- **Import:** level = 1 − Rec. 709 luma of the stroke (named colours, `#rgb[a]`, `#rrggbb[aa]`, `rgb()/rgba()` with % and `/` alpha), inherited from groups and `style`; a closed path without a stroke takes its fill (default black). `data-level` (one value or stops) wins; open paths are split at the stops (snapped within 0.001 of a vertex), so vertex levels are exact. Warnings `levelInvalid`, `opacityIgnored`, `strokeGradientIgnored`, `levelWhite`. The levels cross the worker boundary (`svg.import` schema) and land on the shape's path items.
- **Depth:** level ℓ → `min + ℓ (max − min)`; a path without levels is level 1. An open path's profile follows its vertex levels by arc length; a closed shape (region) takes one level, the deepest of its items. **Chaining** (open lines whose ends meet within 0.01 mm, greedy, reversing as needed) and **blends** (each step spread linearly over ±`blend`, clamped to half the neighbouring pieces) apply only with `{ min, max }`, so E1's lines and programs are unchanged. The design-side deepest depth (plan checks, split, strategy) is `max`; the DFM and tool fit read the resolved profiles.
- **Toolpath fix:** the cut points along a line (`LinePath.breaksIn`) are now sorted. Interior profile points (blends) came after the element breaks and were dropped. That also moved one line of the E1 golden `line-ramp.nc`: pass 1 now reaches its −0.5 mm floor at X18.24 as the profile says, where before it ramped on to X30.
- **Inspector:** Depth gains "From SVG levels" with Deepest (`depth.max`) and Shallowest (`depth.min`), stepKind `depth`, and Blend (stepKind `small`) behind the group's More row. Switching keeps the values: a constant becomes Deepest, start/end become max/min.
- **Agent tools:** `design.line.add/update` take `depth: { min, max }`, `blend` and a path `scale`. Levels are not command args: they come only from `design.shape.import`. The shape DTO carries them, but `design.shape.add` and `.item.update` do not take them (their listing would have cost ≈ 0.3 K). Measured: `design_line_add` 1,242 (+256), `design_line_update` 618 (+74); tools/list 116,272 → **116,602** (+330, 143 tools). That leaves ≈ 1.1 K of E1–E3's 3.0 K for E3.
- **Not built (deferred):** the `width` mode and `design.shape.import { levels, colours }`, the colour legend in the import dialog and report, the Shape Editor ramp, Level field and toolbar toggle, `dfm.levelsIgnored`, and the Inkscape-saved copy of the sample.
- **Tests:** `src/core/import/svg/levels.test.ts` (colours, alpha, `data-level`, stops, inheritance, loops, warnings); `src/core/design/line-levels.test.ts` (the E0 sample through `design.shape.import`: stored levels, the spike's depths ±0.001 mm, chaining and blend, `blend: 0`, `scale`, rules, item edits); the golden `line-levels.nc` (the sample, 0.2–1.5 mm, 60° V-bit); headless `src/main/cli/exit-criteria.line-levels.test.ts` (the wood grain preset imported, planned and exported at varying depth); e2e `e2e/line.e2e.ts` (Import SVG…, From SVG levels, toolpaths and export with Z between Shallowest and Deepest).

## Decided here (not questions)

- **Profile `on` is not extended** (EP-A). It would grow `design.profile.*`, the largest design tools (3.6 K + 3.0 K), and give one loop per operation. The Line keeps grooves of many paths in one operation.
- **Levels, not depths, on shapes** (EP-B). The same SVG serves a 0.5 mm and a 2 mm engraving. Colours are not kept after import (the legend maps them once).
- **No double-cut avoidance at crossings** (as every CAM surveyed). Coincident segments are removed because tiling makes them systematically.
- **Tiles may touch** (gap ≥ 0, no overlap invariant): grooves crossing is a design choice for lines, unlike pockets.
- **Presets are immutable once shipped** (EP-G). Projects store the preset id, and the resolution reads the shipped file. Changing a file would silently change projects.
- **The "round surface" reading** (EP-F) is taken by delegation. If the user meant a cylinder, it is a rotary-axis project and outside this doc.

## Questions for the user

None blocking. The choices above were delegated (D70); the user may veto any of them.
