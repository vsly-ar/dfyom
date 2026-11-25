# cnc-code's pattern helper: what it does

Status: draft (research note, 2026-11-25; user TG #333 "research how the patterns helper is working in the cnc-code project, we need something like it as a feature, but with shape support, also with optional chamfering") · Proposal built on it: [modes/patterns.md](../modes/patterns.md) · Earlier placeholder: [features.md § Patterns](../modes/features.md#patterns)

Source: the user's other project `cnc-code` (read only, at commit `faab517`, version 0.2.100). Paths below are relative to that repo. They are code spans, not links, because the repo is not part of DFYOM. Its own docs: `docs/patterns.md` (the shared library), `docs/helpers/pattern.md` (the helper), `docs/plan/pattern.md`, `docs/plan/pattern-library.md`, `docs/plan/inlay-pattern.md`, `docs/plan/pattern-isogrid.md`, `docs/plan/pattern-invert-morse.md`. No screenshots of the pattern UI exist in its docs. The picker draws its tiles live from each pattern's code (`src/cnc-ui/pattern/preview.ts`). The real-machine test cut is listed in `docs/cuts-todo.md` § Pattern helper and has **not** been cut yet.

## Summary

- A **helper** (cnc-code's word for a parametric generator of operations, like a DFYOM feature). It covers the **whole stock top, less a margin**, with a decorative pattern. It has no position and no boundary shape.
- The patterns are a **fixed catalogue of 36**, each drawn by code (never images): 15 **cells** (closed areas pocketed), 16 **grooves** (centre lines, V-bit or flat), 5 **reliefs** (a 2.5D depth map). The user can't supply a cell shape.
- **Up to 3 layers stacked in Z.** Each layer has its own pattern, bit and depth. Layer 2 is cut only inside what layer 1 cleared to its floor, and so on. An option cuts the bottom layer **through** the sheet.
- **Invert** turns cells into islands and grooves into ridges. Reliefs flip their depth.
- **Optional chamfer per layer.** One V-bit for all layers, a max width in mm, and a per-pattern share of that width at each edge. It is cut by cnc-code's linked chamfer helper.
- **Structure read-out**: weight, stiffness and strength against the solid plate, from simple beam sections.

## Code map

| Part                            | Path                                                                                                                        | Lines (approx.) |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Pattern model                   | `src/core/pattern/types.ts` (`PatternDef`, `PatternInput`, `PatternShape`, `Box`)                                           | 70              |
| Saved choice                    | `src/core/pattern/params.ts` (`PatternChoice`, zod)                                                                         | 30              |
| Frame (angle, offset)           | `src/core/pattern/frame.ts`                                                                                                 | 60              |
| Layout in work coordinates      | `src/core/pattern/layout.ts` (`layOutPattern`, `cutToBox`)                                                                  | 120             |
| Catalogue and bit rules         | `src/core/pattern/catalog/` (`cells.ts`, `grooves.ts`, `morse.ts`, `relief.ts`, `shapes.ts` builders, `index.ts` bit rules) | 1 550           |
| Helper (params, plan, generate) | `src/helpers/pattern/` (`params.ts`, `geometry.ts`, `generate.ts`, `layers.ts`, `chamfer.ts`, `structure.ts`)               | 1 570           |
| Helper UI                       | `src/helpers/pattern/Panel.tsx`, `views.tsx`, `StructureSection.tsx`                                                        | 1 400           |
| Shared picker                   | `src/cnc-ui/pattern/PatternPicker.tsx`, `preview.ts`                                                                        | 180             |
| Tests                           | `catalog.test.ts`, `layout.test.ts`, `generate.test.ts`, `structure.test.ts`, … and golden G-code in `__golden__/`          | 2 000           |

The library (`src/core/pattern/`) imports only 2D geometry and the `Tool` type, so a second user can reuse it: the **inlay** helper uses cells or grooves as its inlay shape (`docs/plan/inlay-pattern.md`).

## Inputs and parameters

A layer is a `PatternChoice` plus how it is cut (`src/helpers/pattern/params.ts`):

| Param               | Meaning                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pattern`           | Catalogue id (stable, saved)                                                                                                                               |
| `scale`             | **Cell size in mm** (one hole to the next, the groove pitch), not a factor. Its lower limit comes from the bit (`minScale`)                                |
| `spacing`           | **Material left between two elements** in mm (the rib or land). It does not scale with the pattern                                                         |
| `angle`             | Pattern turned about the area's centre, degrees CCW                                                                                                        |
| `offsetX / offsetY` | The pattern origin moved from the area centre, for example to put a hole or an isogrid boss on a chosen spot                                               |
| `seed`              | For random patterns (Voronoi cells, bubbles, Truchet, maze, Morse letters). Seeded mulberry32, deterministic                                               |
| `text`, `tight`     | For Morse code only                                                                                                                                        |
| `toolId`, `depth`   | The layer's bit and its thickness below the layer above                                                                                                    |
| `invert`            | Cut what the pattern leaves                                                                                                                                |
| `chamfer`           | `{ on, width }`: the max width. The pattern says the share per edge                                                                                        |
| Helper-wide         | `margin` (uncut border; 0 runs past the stock edges by the bit radius + 1 mm), `through`, `direction` (climb or conventional), `chamferToolId` (one V-bit) |

Each pattern declares which optional params it uses (`uses`). The panel shows only those.

## Layout kinds

There is **no separate layout parameter**. Each catalogue entry hard-codes its own arrangement through the builders in `catalog/shapes.ts`:

- `lattice(box, px, py, stagger)`: square or rectangular grids. Staggering by rows or columns gives hexagonal packings (honeycomb, staggered holes, diamonds).
- `copies(shape, centres)`: one prototype shape placed at every centre.
- `rounded(ring, r)`: inside corners rounded to at least the bit radius (`toolRadius` is passed in), so a round bit can follow the drawn shape.
- Special generators: Voronoi cells and random bubbles (seeded), isogrid (three rib families at 60° with round bosses at the nodes), Truchet arcs and a maze (seeded), concentric circles, spiral, sunburst (radial), Greek key, fish scales, basket weave.
- The pattern is drawn in its **own frame** covering the area's bounding box (`patternBounds`) and may run past it. The frame is turned by the angle and moved by the offset about the area centre (`frameOf`, `toWork`).

Not present: user-drawn cells, a boundary shape other than the stock rectangle, along-a-path layouts, polar arrays of cells (only radial grooves), size gradients, per-cell skip.

## Geometry and toolpaths

`planLayer` (`src/helpers/pattern/geometry.ts`) calls `layOutPattern` and then works per kind:

| Kind    | Bit                    | Cut                                                                                                                                                          |
| ------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cells   | flat end mill          | `pocket` per cell: helix entry where it fits, else ramp, else plunge. Nearest-first from the front-left. No finishing lap                                    |
| Grooves | flat end mill or V-bit | Flat: `pocket` of the widened lines, or `contour` on the line when the groove is the bit's width. V-bit: `contour` on the line, joined into the longest runs |
| Relief  | flat end mill, V-bit   | `raster` on a depth map (cell ≤ 0.25 mm, ≤ 400 000 cells), stepover ≤ 0.5 mm, along the pattern's direction snapped to 45°                                   |

- **As cut, not as drawn.** Cells are _opened_ by the bit radius (shrunk, then grown back), which is what a round bit reaches. The chamfer and the structure read-out use that outline. If more than 10 % of the drawn area is lost, a warning says the pattern is too fine for the bit. This is measured before clipping, so edge slivers don't count.
- **Clipping**: the layout is clipped to the area (stock less margin). Partial cells at the edge are kept. The inlay offers "whole cells only" instead, because partial cells there are V-carving slivers.
- **Layers**: layer n+1 is clipped to the region layer n cleared to its floor, starting at that floor. A layer under a relief starts from the top inside the whole area. A layer under V-grooves is skipped (no floor). A relief may only be layer 1.
- **Through**: the bottom layer goes to the stock bottom plus breakthrough, and its operation is marked as freeing material. Warnings report **loose pieces**: islands not held by a layer below or by the border.
- **Bit limits** (`catalog/index.ts`): `suits` (no drills; cells not with a V-bit) and `minScale` from the pattern's `narrowest(scale, spacing)`: 1.1 × Ø for cells, 1 × Ø for flat grooves, 2 × Ø for reliefs, a 1 mm pitch for V-grooves. Inverted, `minSpacing` = 1.1 × Ø and islands ≥ 0.5 mm.

## Chamfer

`src/helpers/pattern/chamfer.ts`, docs `docs/helpers/pattern.md` § Chamfer:

- Per layer `{ on, width }`. One V-bit for all layers. On by default for layer 1 when the library has a V-bit, off for lower layers. V-bit grooves and reliefs get no chamfer, because the V already bevels them.
- The **width share** comes from the pattern: `PatternDef.chamfer(p, side)` gives 0…1 of the max width at an edge point, for a rim or an island. For example, the small holes of "big and small holes" get half. Each as-cut outline is one edge at its smallest share, rounded to 0.05 mm steps, so a pattern makes a few runs rather than one per cell. Depth = width / tan(V/2). Edges under 0.05 mm are dropped.
- It is cut by cnc-code's **chamfer helper** via a _chamfer request_: one run per layer and width, each with its own depth and top Z. With "through" on and the bottom layer unchamfered, the chamfer runs before the through layer, while the sheet is still stiff.
- **Lower layers**: an edge is chamfered only where the V's cone stays clear of the walls of every layer above (`wallClearance`). The others are skipped with a count.
- A **rib narrower than 2 × width** gets a warning that the two chamfers meet in a ridge. This is the same finding as DFYOM's `dfm.chamferMeets` ([edge-chamfers.md § DFM findings](../modes/edge-chamfers.md#dfm-findings)).
- The helper reports **no edges** to cnc-code's edge list, because hundreds of outlines would drown it.

## UI

- **Panel** (`Panel.tsx`): the Area section has margin, through and direction. Layers are vertical tabs ("L1 Honeycomb"); drag or Alt+↑/↓ reorders them, but a relief can't move below layer 1. Each layer has the pattern preview, **Pick…**, tool, depth (with the Z range shown), only the params the pattern uses, and Invert. The scale field stops at the bit minimum and shows it. "+" adds a layer (max 3).
- **Picker** (`PatternPicker.tsx`): tiles grouped by kind, each drawn by the pattern's own code at its defaults. The tooltip is the description. Patterns the current bit or layer position can't take are greyed out with the reason.
- **Info views** (active (i)): the layer stack as a Z section. Bits in a row with their minimum scale. A scale or spacing sample two cells across at real size with the bit drawn to scale. Normal against inverted. The chamfer section and wall clearance. A Morse card.
- **Structure** read-out (`structure.ts`): weight, stiffness along X and Y, strength in % of solid, the same-weight solid plate, equivalent thickness, and with a material the mass and the sag under 1 kg. The limits of the beam model are listed.

## Edge cases and limits it handles

- Scale below the bit minimum is still cut, with a warning, and the parts too small for the bit are left uncut.
- Cells too small for a helix ramp or plunge, with the pocket's warning (quiet for patterns).
- Layers deeper than the stock with through off. Through when the layers above already reach the bottom. A layer with nothing to stand in. A layer that cuts nothing. Flutes shorter than the layer depth.
- Loose islands when cut through. No border when the margin is 0.
- Invert on V-grooves is ignored with a warning. Morse characters with no code are listed.
- Limits: 3 layers. Relief map ≤ 400 000 cells. There is no explicit cell-count limit: the stock size and scale set it, and every cell is its own `pocket` call.

## What carries over to DFYOM, and what doesn't

| cnc-code                                             | In DFYOM                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed catalogue of drawn cells                       | Cells are any **named shape** or a primitive ([design-v0.3.md § Shape definition](../modes/design-v0.3.md#shape-definition)) on a chosen **lattice**. Catalogue entries become presets of lattice + cell                     |
| Whole stock less a margin                            | Any face target, with a **boundary** shape (or the face) less a margin, clipped by the 2D port (the split parts already clip by region, [split-parts.md](../modes/split-parts.md#mapping-the-source-into-a-piece))           |
| A `pocket` call per cell                             | **One pocket operation** whose shape is the multi-loop region of every cell (pockets take any number of loops, S-G): one tool, one plan operation, one removal solid                                                         |
| Per-pattern chamfer share, chamfer helper            | One **edge chamfer** operation on that pocket. Edge chamfers already run round every loop (EC-B, [edge-chamfers.md](../modes/edge-chamfers.md)). A constant width; per-cell shares are not needed when cells are user shapes |
| Layers in one helper                                 | A second pattern `on` the first one's floor, bounded by the first one's cells (proposal Q127)                                                                                                                                |
| Opened-by-bit as-cut outline                         | The evaluation already removes what the tool reaches. Corner and rest-material DFM exists (`dfm.cornerTooSmall`, `dfm.restMaterial`)                                                                                         |
| Grooves, reliefs, Morse, Voronoi, isogrid, structure | Later, each on its own question (proposal Q124, Q125, Q129)                                                                                                                                                                  |
