# Patterns: shapes laid out over an area, with an optional chamfer

Status: draft (proposal, 2026-11-25; user TG #333 "we need something like [cnc-code's patterns helper] as a feature, but with shape support, also with optional chamfering"; questions [Q124–Q129](#questions-for-the-user) open; not scheduled; P0 spike S8 run 2026-11-25, [report](../research/2026-11-25-spike-s8-patterns.md)) · Research: [cnc-code's pattern helper](../research/2026-11-25-cnc-code-patterns-helper.md) · Replaces the parked placeholder [features.md § Patterns](features.md#patterns) (D28, D30) · Builds on: [features.md](features.md) (feature model A1–A6), [design-v0.3.md](design-v0.3.md) (shapes), [edge-chamfers.md](edge-chamfers.md) (chamfers along any loop, E1–E3 built), [split-parts.md](split-parts.md) (region clipping) · Budgets: [S6](../research/s6-clone-budgets.md), [S7](../research/2026-11-25-spike-s7-edge-chamfers.md) · Terms: [glossary.md](../glossary.md)

A **pattern** covers an area of a face with many copies of a **cell**, cut as recesses or left standing as islands, and optionally chamfered. Uses include decorative surfaces (honeycomb, diamonds, scales), lightening and ventilation holes, grip textures, and speaker or vent grilles. It is cnc-code's pattern helper ([research](../research/2026-11-25-cnc-code-patterns-helper.md#summary)) with three changes:

- **The cell is any shape:** a named shape of the part or a primitive ([design-v0.3.md § Shape definition](design-v0.3.md#shape-definition)), not a fixed catalogue.
- **The area is any boundary:** a named shape or the face, less a margin. It is not limited to the whole stock top.
- **One pocket cuts all cells.** The chamfer is the existing edge chamfer on that pocket.

## Decisions (proposed)

| Id   | Decision                                                                                                                                                                                                                                                                                                                                                                       | Section                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| PT-A | **A new feature kind `pattern`, not a Clones extension.** Clones repeat _operations_ (one per instance, own surfaces, ≤ 100 instances, D36). A pattern makes **one region** of many loops and cuts it with **one pocket**. That allows hundreds of cells, one tool, one plan operation and one removal solid. Repeating functional features (holes, counterbores) stays Clones | [Patterns and Clones](#patterns-and-clones)               |
| PT-B | **The cells are a shape, resolved by the 2D layer.** The feature owns a read-only shape with one `pattern` item. Its stored data is the pattern's parameters, never the resolved loops. The owned pocket places that shape like any named shape                                                                                                                                | [Model](#model)                                           |
| PT-C | **Owned operations:** `<id>_pocket`, and `<id>_chamfer` when a chamfer is on. The chamfer is an edge chamfer with `edgeOf` = the owned pocket, so it runs round every cell (EC-B)                                                                                                                                                                                              | [Owned shape and operations](#owned-shape-and-operations) |
| PT-D | **Lattice × cell:** a lattice of nodes (square, staggered, hex, polar) with a cell placed at each node. Spacing is set as a **gap** (the web between neighbouring cells' bounding boxes) or an explicit **pitch**. The cnc-code catalogue's lattice-plus-cell entries become **presets**                                                                                       | [Model](#model)                                           |
| PT-E | **Clipping to a boundary** through the 2D port: **whole cells** (default) or **clipped** cells                                                                                                                                                                                                                                                                                 | [Boundary and clipping](#boundary-and-clipping)           |
| PT-F | **Invert** is a shape boolean: the pocket cuts the boundary minus the cells, so the cells stand as islands                                                                                                                                                                                                                                                                     | [Model](#model)                                           |
| PT-G | **No layers inside a pattern.** A deeper pattern goes `on` the first one's floor, with the first one's cells as its boundary. That gives cnc-code's layer rule with the existing face targets (Q127)                                                                                                                                                                           | [Stacking](#stacking)                                     |
| PT-H | **No new operation kind, no new toolpath generator.** Pocket clearing and the edge-chamfer generator handle multi-loop regions already. What patterns add is geometry (the item), checks and UI                                                                                                                                                                                | [Plan](#plan)                                             |

## Patterns and Clones

|             | Clones ([features.md § Clones](features.md#clones))                               | Pattern (this doc)                                                 |
| ----------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Repeats     | Operations or one feature (a counterbored hole), each instance its own operations | A shape: every cell is a loop of one region                        |
| Positions   | Path rows (grid, offset, polar, arc, along, point), skips, stable numbering       | A lattice filling a boundary; cells are not numbered or referenced |
| Count       | ≤ 100 instances (S6: evaluation per instance)                                     | Hundreds to ≈ 2 000 cells (one prism; limit set by [P0](#slices))  |
| Surfaces    | Each instance has floors usable as `on` targets                                   | One floor: `<id>_pocket.floor`                                     |
| Tool        | Each source operation's tool, one tool change per source operation                | One tool for all cells (the pocket's tool field)                   |
| Typical use | Mounting holes, bolt circles, a 3 × 2 plate of slots                              | Honeycomb, perforations, lightening holes, grilles, textures       |

- **Neither nests the other's role.** A Clones may nest a pattern feature as its source (A6: one non-Clones feature), for example the same grille on several panels. A pattern's cell is a shape, never a feature or an operation.
- **The grid repetition question is settled:** Q30 (D34) gave linear, grid and circular repetition to Clones rows and kept "pattern" for this feature. Nothing here changes Clones.

## Model

`design.pattern.add` creates a feature of kind `pattern` (A1–A6 unchanged):

| Field       | Kind / values                                                                                                                                                                              | Default                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `on`        | Face target ([design-v0.2.md § Face targets](design-v0.2.md#face-targets-generalised-on)), as a pocket                                                                                     | Last facing's floor, else `stock.top`               |
| `cell`      | `{ shapeId, rotation?, scale? }` (a named closed shape of the part; its bounding-box centre sits on the node) or a primitive without `center`: `circle`, `rectangle`, `obround`, `polygon` | `circle { diameter: 8 mm }`                         |
| `lattice`   | `square`, `staggered` (odd rows shifted half a pitch), `hex` (60° rows: the densest packing for circles and hexagons) or `polar` (rings about a centre). Plus `angle`, `origin [u, v]`     | `staggered`, angle 0, origin at the boundary centre |
| `spacing`   | `{ gap }`: the web between the cells' bounding boxes along each lattice direction, so the pitch = cell extent + gap. Or `{ pitch: [a, b] }` given directly                                 | `{ gap: 2 mm }`                                     |
| `alternate` | `none` or `flip`: every other cell turned 180° (triangles, fish scales)                                                                                                                    | `none`                                              |
| `boundary`  | `face` (the `on` face's extent) or `{ shapeId, center, rotation? }` (placed like a pocket's named shape)                                                                                   | `face`                                              |
| `margin`    | Length ≥ 0, the uncut border inside the boundary                                                                                                                                           | 5 mm / 3/16″                                        |
| `fit`       | `whole` (only cells wholly inside the boundary less the margin) or `clip` (cells cut to it)                                                                                                | `whole` (Q128)                                      |
| `invert`    | Boolean: pocket the boundary less the margin, minus the cells                                                                                                                              | `false`                                             |
| `depth`     | Length > 0, floor above `stock.bottom` (the pocket rule; through is Q126)                                                                                                                  | 1 mm / 1/32″                                        |
| `chamfer`   | `{ width, angle }` or absent ([Chamfer](#chamfer))                                                                                                                                         | absent                                              |
| `name`      | Default "Pattern 1"                                                                                                                                                                        |                                                     |

- Every length and angle is a quantity and may be an expression, as on operations.
- **For hex and staggered lattices the gap is exact** for circles and for hexagons across their flats: the web is the gap. For other cells the web is at least the gap. [DFM](#dfm) reports the narrowest real web.
- **Polar:** rings at `pitch[0]` apart radially, and cells on each ring at the arc-length pitch `pitch[1]` (or the extent + gap). Every ring starts at `angle`. Cells keep their orientation unless `rotation: 'radial'` (later, as with Clones rotation).
- **Invariants** (`model.invariant`, rule names in code): the cell resolves to a closed region (`patternCellOpen`). Pitch > 0 and ≥ the cell extent along each direction, so cells never overlap (`patternOverlap`; an intended overlap would make one cell). The resolved cell count is at most the limit (`patternTooMany`, working value 2 000, set by [P0](#slices)). The boundary shape is closed. No pattern cell of itself (`shapeCycle`).

### Owned shape and operations

- **Owned shape** `<id>_cells` (A1 extended from operations to shapes): one item, `pattern { …the fields above that make geometry… }`, read-only in the Shape Editor. It is edited through the feature, and removed with the feature (A5). It resolves in the 2D layer ([shapes.md](../architecture/shapes.md)) as follows:
  1. Resolve the cell. Lay out the lattice over the boundary's bounding box, plus one pitch all round. Place the cell at each node (with the flip on alternate nodes).
  2. Shrink the boundary by the margin. Keep the cells inside it (`whole`), or intersect them with it (`clip`). Drop the empty ones.
  3. With `invert`, take the shrunk boundary minus the cells.

  Resolution is cached by the item's hash plus the referenced shapes' definition hashes, as the [offset item](design-llm-first.md#offset-item) does. Editing the cell or boundary shape restales the pattern.

- **Owned pocket** `<id>_pocket`: `shape: named { shapeId: '<id>_cells' }`, the feature's `on` and `depth`. It has its own tool field (A4), `generalTolerance` and name. Surfaces: `<id>_pocket.floor`. The walls are numbered for display only (S-J).
- **Owned chamfer** `<id>_chamfer` when `chamfer` is set: `edgeOf: '<id>_pocket'`, `width`, `angle`, and its own tool field. Removing the chamfer field removes the operation. Its id is stable by role (A3).
- **The `pattern` item is feature-only in the first version.** `design.shape.*` refuses it (`ownedShape`). That keeps the shape tools' schema and the Shape Editor unchanged. Exposing it as an ordinary item ("pattern inside my own shape") is later.

### Boundary and clipping

- **`whole`** keeps only cells wholly inside the boundary less the margin. This is the clean, default look, and it leaves no sliver at the edge (cnc-code's inlay made the same choice).
- **`clip`** cuts the cells with the boundary less the margin through the 2D port's intersection. This is the same operation the split parts use to clip a pocket to a piece ([split-parts.md § Mapping](split-parts.md#mapping-the-source-into-a-piece)). Clipped fragments narrower than the smallest library end mill are dropped and counted in the read-out ("14 slivers dropped"). They would only make rest material.
- **Keep-outs** (a solid patch for a logo, mounting bosses): a boundary shape with `subtract` items. There is no per-cell skip list in the first version.
- **Margin 0 at a stock edge** is allowed. Cells there open to the edge, like cnc-code's run-off. With `clip`, the boundary edge becomes a pocket wall, exactly as a pocket that reaches the edge does today.

### Stacking

cnc-code's layers (a fine lace standing on a coarse grid) become two features: pattern 2 `on: pattern1_pocket.floor` with `boundary: { shapeId: 'pattern1_cells' }`. Pattern 2's cells then exist only where pattern 1 cleared, from its floor down. A boundary shape that is itself a pattern's owned shape is allowed (read-only use is fine). If cells fall outside the floor, the existing `dfm.shapeOutsideFace` reports it. Q127 asks whether that is enough.

### Chamfer

- **The existing edge chamfer** ([edge-chamfers.md](edge-chamfers.md)), unchanged in model, toolpath and tool fit. It runs round every loop of the pocket: every cell's rim, or every island's foot when inverted. Width and angle are the chamfer's own (default 0.5 mm × 90°). **Off by default**, as for every chamfer ([edge-chamfers.md § Decided here](edge-chamfers.md#decided-here-not-questions): no automatic chamfers).
- **One width for all cells.** cnc-code's per-pattern width shares (half-width on small holes) existed because its patterns were code. With user shapes, two widths means two patterns.
- **Solid cost**, from the spike ([S7 § Cost](../research/2026-11-25-spike-s7-edge-chamfers.md#cost)): the loft costs ≈ 15–30 ms per 1 000 edge elements. Cells are disjoint loops, so the loft is built and **checked per loop**. Bevels of neighbouring cells that meet over a thin web make overlapping lofts, unioned in the kernel, not a topology change. This keeps the fast path where a whole-region check would send every cell to the sweep-union fallback, which grows superlinearly (1 000 elements ≈ 3.4 s). E1's check must run per loop before patterns ship ([P3](#slices)). S8 confirmed it: with bevels meeting over a 2 mm web the whole-region check sent 103 cells to the fallback (16 s, one step); per loop every cell lofted and the evaluation took 0.47 s. Checking per group of cells is not enough (a group of 50 neighbours falls back together). Per-cell meshes still cost ≈ 6–8 ms per cell; P3 puts the non-meeting loops in one mesh ([S8 § Recommendations](../research/2026-11-25-spike-s8-patterns.md#recommendations)). The fallback stays for a single cell whose own offset changes topology (a notch shorter than the width).

## DFM

| Code                 | When                                                                                                                                                                                                                                                                                                                                                                                       | Kind    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `dfm.patternThinWeb` | New. The narrowest web between two cells (or, inverted, the narrowest island) is under 1 mm / 0.04″. It is found as E3's `chamferMeets` finds walls ([edge-chamfers.md § Implementation (E3)](edge-chamfers.md#implementation-e3)): rest material of the material band for a disc of the limit's radius, then the width by bisection. Marker at the narrowest place, with the measured web | warning |
| `dfm.patternEmpty`   | New. No cell fits the boundary less the margin (`whole`), or every fragment was dropped                                                                                                                                                                                                                                                                                                    | warning |
| `dfm.patternHeavy`   | New. The pattern's region passes the evaluation's chord budget ([geometry.md § Performance budgets](../architecture/geometry.md#performance-budgets-v01)): "312 cells: the part updates more slowly". Same role as `dfm.clonesHeavy` and `dfm.shapeHeavy`                                                                                                                                  | info    |
| Existing, unchanged  | `dfm.cornerTooSmall`, `dfm.restMaterial` and `dfm.pocketNoToolFits` on the owned pocket (cells too small or too sharp for the tool). `dfm.chamferMeets` (a web under 2 × width; per pattern it is one finding with up to 10 markers, as E3). `dfm.chamferIncomplete`. `dfm.shapeOutsideFace`                                                                                               | –       |

- **Findings roll up** on the feature row, and each shows at the feature field that drives it: a thin web at Spacing, a cell too small at Cell, meeting bevels at Chamfer width (features.md § Validation and DFM).
- **Suggested values** in the messages: the gap that brings the web to 1 mm, and the chamfer width at half the narrowest web.

## Plan

- **The pocket** is cleared by the existing offset clearing ([plan-v0.3.md](plan-v0.3.md)) loop by loop. Cells are visited nearest-neighbour from the front-left. Each cell uses the pocket's entry rules: a helix where it fits, else a ramp. Travel between cells uses [safe links](safe-links.md) (minimum retraction over the in-process stock), which matters with hundreds of cells. P0 checks that the generator orders many disjoint loops well. If it doesn't, ordering is a fix in the pocket generator, not pattern logic.
- **The chamfer** is the edge-chamfer generator, one ring per cell in nearest-neighbour order, after the pocket.
- **Cost:** toolpaths and the program are linear in the cells (S6: ≈ 17–146 lines per instance for holes and slots). 2 000 small cells give a program of the order of 10⁵ lines, which a GRBL stream handles.

## Performance

- **Evaluation:** one prism of N loops in one subtraction, not N operations. S6's per-operation layer cost does not apply. The floor is the boolean cost per chord, ≈ 8 µs per chord ([S3](../../spikes/prisms/results.md), [S6 § Levers](../research/s6-clone-budgets.md#levers)). A Ø 8 mm circle is ≈ 40 chords at 0.01 mm, so 300 cells ≈ 12 000 chords ≈ 100 ms: over the 50 ms budget, like 100 clones, and the reason for `dfm.patternHeavy`. The output passes the 20 000-triangle budget at ≈ 100–150 round cells. A large pattern is therefore a "heavy part", which is fine as long as the evaluation stays abortable between steps. A step bigger than ≈ 100 ms would split the region into subtraction layers of disjoint cell groups (the S6 clone-layer idea).
- **Resolution:** the lattice and the containment test are linear with a spatial index on the boundary. The `clip` intersections run per cell that crosses the boundary only.
- **Chamfer:** per-loop lofts, see [Chamfer](#chamfer).
- **Cache:** the resolved region and the pocket's solid are cached by the item hash. Edits elsewhere in the part don't rebuild the pattern.
- **Measured in P0** ([S8](../research/2026-11-25-spike-s8-patterns.md)): evaluation is linear (57 / 235 / 961 ms, 13 k / 64 k / 257 k triangles at 103 / 503 / 2 009 rounded hexagons; one subtraction step, splitting the region into layers did not help), so `patternTooMany` = 2 000 and `dfm.patternHeavy` at ≈ 150 cells (≈ 5 000 chords). Quadratic, to fix in P1: the region built by booleans (a named shape's fold of N items took 258 s at 2 009; direct pieces ≤ 1 ms, so the `pattern` item emits pieces without a boolean), the 2D port's offset checks on many-piece regions (`regionContains` per loop), the pocket generator's ordering (11.5 s at 2 009) and the Z-reference spot search. Without those fixes the limit is 500.
- **Originally to measure in P0** (spike S8): evaluation, triangles, toolpath, program size and the chamfer loft for 100 / 500 / 2 000 cells (circles, rounded hexagons, a named star), `whole` and `clip`, normal and inverted. These set the cell limit and the heavy threshold.

## Split parts and Clones

- **Split parts:** the owned pocket crosses a split line like any pocket, and gets an `intersect` item with the piece region. With `whole` the piece then holds partial cells at the split. That is correct (the seam runs through the pattern), and the existing `cutsFeature` finding names the pattern. The chamfer uses E2's `sourceEdge` rule, so the split line is never chamfered.
- **Clones:** a pattern feature may be a Clones source (A6). `dfm.clonesHeavy` and `dfm.patternHeavy` both apply.

## UI

Follows [ui.md § Features (v0.4)](../conventions/ui.md#features-v04). The L-review comes with P2.

- **Add → Pattern**, next to Hole and Clones, opens the inspector with the defaults, on the selected face. A "Decorate" submenu can come when a third decorative feature (engraving, text) arrives.
- **Navigator:** a feature row ("Pattern 1", icon, "312 cells", rolled-up badge) nesting its owned shape, pocket and chamfer rows. The owned rows are read-only except for the tool fields.
- **Inspector groups:**
  - **Cell:** a picker with the part's closed shapes as thumbnails, plus the primitives with their size fields, and rotation and scale.
  - **Layout:** lattice tiles (square, staggered, hex, polar), Gap or Pitch, angle, origin, Flip alternate.
  - **Area:** boundary (Face, or a shape `Select` with a pick button), margin, Whole cells or Clip.
  - **Cut:** depth, Invert.
  - **Chamfer:** a toggle, then width and angle.
  - **Read-out:** "312 cells · web 2.0 mm · 14 slivers dropped".
- **Presets** menu in the inspector header: Staggered holes, Honeycomb, Rounded squares, Diamonds, Triangles (flip), Slots (obround), Grille (hex of small circles). Picking a preset sets cell, lattice and gap, and nothing else. These are cnc-code's lattice-plus-cell entries, without its special generators (Q125).
- **Viewport:** while editing, the boundary less the margin is dashed and dropped or clipped cells show as ghosts. The thinnest web and finding markers are drawn. Clicking a cell selects the pattern.
- **Later:** a scale and gap sample at real size with the tool drawn (cnc-code's active (i)), once the Field info views framework exists.

## Agent API

- **Two new tools:**
  - `design.pattern.add { partId, on?, cell, lattice?, spacing?, alternate?, boundary?, margin?, fit?, invert?, depth, chamfer?, name? }`, ≈ 1.2 K with shared `$ref`s to the shape primitives.
  - `design.pattern.update { featureId, …same fields }`, as a listed sketch ([llm-api.md § Schemas](../architecture/llm-api.md#schemas), `listedArgs`), ≈ 0.4 K.
- **Shared tools:** `design.feature.remove`, `.move`, `.list` and `.get` are shared. The owned pocket and chamfer show in `design.operation.list` and take `design.tool.*` as other owned operations do.
- **Results** carry `{ featureId, operationIds, cells, dropped, narrowestWeb, warnings }`, so an agent sees the count and the web without a preview tool. A `dryRun: true` on add/update returns the same without changing the part, for agents trying a gap. This costs one boolean, not a third tool.
- **Budget:** `tools/list` measured **107.4 K** of 120 K (139 tools, [edge-chamfers.md § Agent API](edge-chamfers.md#agent-api)). Patterns add ≈ 1.6 K, to ≈ 109 K. The `pattern` item is not added to the `design.shape.*` unions (PT-B), which saves ≈ 0.3 K × 3.

## Slices

Smallest first. Sizes are agent working days including docs, tests and review (as [edge-chamfers.md § Slices](edge-chamfers.md#slices)).

| Slice | Content                                                                                                                                                                                                                                                                                                                                                                                                              | Exit                                                                                                                                                                  | Size          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| P0    | **Done 2026-11-25** ([S8 report](../research/2026-11-25-spike-s8-patterns.md): limit 2 000 with the P1 changes, else 500; heavy at ≈ 150 cells; no subtraction layers; chamfer per loop). **Spike S8 (measure):** a pocket of 100 / 500 / 2 000 cells through the real evaluation, the pocket generator (loop order, entries, links) and export. The edge-chamfer loft per loop against per region on the same cells | Research note with the cell limit, heavy threshold and whether the region needs clone-style subtraction layers                                                        | S: ≈ 1 day    |
| P1    | **Core:** the `pattern` item (square, staggered and hex lattices, cell = primitive or named shape, gap or pitch, angle, origin), boundary = face less margin, `whole`. Owned shape and pocket. `design.pattern.add` / `update`, invariants, `dfm.patternEmpty`, `dfm.patternHeavy`. A minimal inspector (Cell, Layout, Area, Cut)                                                                                    | A honeycomb of rounded hexagons on the lid top, headless and in the UI. Removed volume = cells × cell area × depth. The program runs on the virtual machine. A golden | M: ≈ 3 days   |
| P2    | **Boundary and look:** boundary shape (keep-outs by its subtract items), `clip` with sliver drop, `invert`, `flip`, `polar`, presets, `dfm.patternThinWeb` with markers, viewport ghosts and read-out. L-review of the inspector                                                                                                                                                                                     | A vent grille of hex circles clipped to an obround boundary with a logo keep-out. An inverted diamond texture. Thin web found on a 0.6 mm web                         | M: ≈ 3 days   |
| P3    | **Chamfer:** the chamfer toggle (owned edge chamfer), the per-loop loft check in `chamfer-solids.ts`, `chamferMeets` rolled up on the pattern                                                                                                                                                                                                                                                                        | 300 cells chamfered 0.5 × 90° within the P0 budget. Meeting bevels on a thin web keep the loft (no fallback). The user's real cut                                     | S: ≈ 1–2 days |
| P4    | **Stacking and through**, each on its answer: Q127 (a pattern bounded by another's cells, on its floor) and Q126 (through cells)                                                                                                                                                                                                                                                                                     | cnc-code's "lace on a grid" sheet reproduced. Through cells hold no loose piece                                                                                       | S–M: ≈ 2 days |
| P5    | Later, each on its own question: grooves (Q124), special generators (Q125), structure read-out (Q129), the `pattern` item in ordinary shapes, `along` a path, radial cell rotation, size gradients                                                                                                                                                                                                                   | –                                                                                                                                                                     | later         |

P0–P3 make the user's request: shape cells, any boundary, and an optional chamfer. That is ≈ 8–9 days.

## Decided here (not questions)

- **Feature, not a Clones row:** PT-A. Clones stay for functional repeats.
- **One pocket, one tool:** a pattern with two cell sizes that need two tools is two patterns.
- **Chamfer off by default**, at one width (edge-chamfers' "no automatic chamfers").
- **Web limit 1 mm** for `dfm.patternThinWeb` (a warning, never blocking). A material-dependent limit can come with the material work.
- **Cells keep their orientation on polar lattices** (as Clones, C1). Radial rotation is later.
- **No per-cell skip.** Keep-outs are boundary booleans. Per-cell skips would need stable cell numbers, which a resolved lattice doesn't have.
- **No migration:** a new feature kind and a new item kind, with no `schemaVersion` bump (pre-alpha rule).

## Questions for the user

Numbering continues after [edge-chamfers.md](edge-chamfers.md#questions-for-the-user)'s Q121 and Q122–Q123 (run-machine and llm-api amendments). "Q124 ok" takes the recommendation.

1. **Q124 – What the first version patterns.** (1) **Cells only:** closed shapes cut as recesses or islands. (2) Cells and **grooves:** lines (straight, waves, knurl, grid) cut on the line by a V-bit or flat end mill, as cnc-code's 16 groove patterns. (3) Also **reliefs** (2.5D ripples, egg crate). _Recommendation: (1) now; grooves next as their own slice (they need an `on`-profile per line set and their own DFM); reliefs with the carving work._ Shape support is about cells, and cells are where one pocket per pattern pays off.
2. **Q125 – Presets.** (1) **Presets that are a lattice plus a cell** (honeycomb, staggered holes, squares, diamonds, triangles, slots, grille). (2) Also port cnc-code's **special generators** (Voronoi cells, random bubbles, isogrid with bosses, Truchet, maze, Morse code). (3) No presets: you pick a cell and a lattice. _Recommendation: (1)._ They cover most of cnc-code's cell catalogue with no extra code. Each generator would be its own item kind with its own tests. Ask for any you miss.
3. **Q126 – Through patterns** (perforated sheet, lightening holes cut through). (1) **Later, its own slice:** the pattern's pocket may go down to the stock bottom plus breakthrough, clearing every cell completely, so no slugs come loose. (2) Through cells as inside profiles with tabs: faster for big cells, but hundreds of tabs to snap. (3) Blind only. _Recommendation: (1) in P4._ Clearing small cells leaves nothing loose. Big cells cut through are better drawn as separate inside profiles anyway.
4. **Q127 – Layers** (a fine pattern standing on the ribs of a coarser one, as cnc-code's 3 layers). (1) **Two pattern features:** the second `on` the first's floor with the first's cells as its boundary (PT-G). (2) Layers inside one pattern feature, as cnc-code. _Recommendation: (1)._ It needs no new model: the face target and boundary already express "only where the layer above cleared". It also lets each layer have its own chamfer and tool row in the navigator.
5. **Q128 – Cells at the boundary.** (1) **Whole cells only by default**, with Clip as an option. (2) Clip by default (cnc-code's helper). _Recommendation: (1)._ Whole cells give a clean border and no slivers the tool can't clear. Clip is for textures meant to run off an edge.
6. **Q129 – Structure read-out** (cnc-code's weight, stiffness and strength versus solid, from beam sections). (1) **Later**, when you ask. (2) With the first slices. (3) Never. _Recommendation: (1)._ It is useful for isogrid and lightening work, but it is an L-sized model and view of its own, and the first use is decorative.
