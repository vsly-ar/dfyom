# Spike S8: pattern-sized pockets (100 / 500 / 2 000 cells)

Status: draft (spike report, 2026-11-25; Apple M1 Pro, Node v26.7.0, manifold-3d 3.5.4, a loaded machine; runs capped at the coordinator's time limit, see [Not measured](#not-measured)) · Slice: [patterns.md § Slices](../modes/patterns.md#slices) P0 · Hardening [DF92](../plans/hardening.md#intake-user-feedback-goes-here) · Base: [S6](s6-clone-budgets.md), [S7](2026-11-25-spike-s7-edge-chamfers.md), [geometry.md § Performance budgets](../architecture/geometry.md#performance-budgets-v01) · Not the v0.4-llm-first spike S8 (section fitting, [reference-tools.md § Fitting](../modes/reference-tools.md#fitting)); this one is named by patterns.md

Question: can one pocket whose shape is N cells (N = 100 / 500 / 2 000) go through DFYOM's real design, evaluation, plan and export, with and without the edge chamfer, and where does it break? What cell limit and what changes does P1 need?

**Verdict: yes up to ≈ 500 cells as the code stands; 2 000 needs four P1/P3 changes, all local.** Evaluation, triangles, program size and memory grow linearly and are fine to 2 000. What breaks are five **quadratic spots**: the named shape's fold of N items, the 2D port's offset checks on an N-piece region, the pocket generator's ordering, the chamfer's whole-region loft check and its fallback, and the Z-reference spot search. Each has a linear form that was measured or is a known pattern.

## What was built

Throwaway code in [`spikes/patterns/`](../../spikes/patterns/), against `src/core` (no app code changed):

- [`lattice.ts`](../../spikes/patterns/lattice.ts): hex and square lattices with a gap, `whole` fit inside a rectangle less a margin, the smallest 3 : 2 boundary holding N cells. Cells: a **hexagon** 10 mm across flats with R1 corners (a `polygon` item, turned 30° so the web is exactly the gap) and a **circle** Ø 10. Gap 2 mm, margin 5 mm. Three ways to the region: the **fold** of N `add` items (`resolveDefinition`, what a named shape does today), one **normalise** of all N loops, and **direct pieces** (the cell resolved once and moved to every node; no boolean, cells are disjoint by the `patternOverlap` invariant).
- [`patterns.test.ts`](../../spikes/patterns/patterns.test.ts): per case, through the command layer of the app (`planSetup` with a board stock in walnut): `design.shape.add` (N items), `design.pocket.add` (named shape, 1.5 deep), optional `design.chamfer.add { edgeOf: pocket1, width }` (Ø 6 90° chamfer mill), `project.apply`; then `partGeometryInput` + `evaluatePart` (Manifold, 2D port, steps timed), `loopChamferConstruction`, `plan.create`, `plan.toolpath.generate` (the region-pocket and edge-chamfer generators, the plan's automatic tool choice), `exportPlan` (GRBL with safe links). Variants: the chamfer split into one operation per cell (**per-cell lofts**, composed and unioned by `evaluatePart`'s subtraction layers) or per 50 cells (**batch-50**); the pocket split per 100 cells. The fixture's `SHAPE_ITEMS_MAX` (1 000) is lifted to 10 000 at load time by the spike's vitest config.
- [`profile.test.ts`](../../spikes/patterns/profile.test.ts): one case with step labels and a CPU profile (`--cpu-prof`).

Run: `npx vitest run -c spikes/patterns/vitest.config.mts --silent=false` (env `S8_COUNTS`, `S8_CASES`, `S8_CHAMFERS`, `S8_FOLD`, `S8_PLAN`). Typecheck: `npx tsc -p spikes/patterns`.

## Numbers

Hex lattice of rounded hexagons (the honeycomb). Times in ms, warm median unless noted; "step" = the longest time between two `steps.step()` calls (abort latency).

| N cells (boundary) | Chamfer               | 2D: fold / normalise / direct | Eval (step)         | Triangles | WASM heap | Generate | Program lines / kB / est. min | Export |
| ------------------ | --------------------- | ----------------------------- | ------------------- | --------- | --------- | -------- | ----------------------------- | ------ |
| 103 (158 × 105)    | –                     | 156 / 61 / 0.5                | 57 (47)             | 13 316    | 16 MB     | 88       | 4 093 / 66 / 3.6              | 51     |
| 103                | 0.5 (loft)            | –                             | 404 (181)           | 35 772    | 33 MB     | 82       | 5 961 / 98 / 10.4             | 307    |
| 103                | 1.2 (meets: fallback) | –                             | **15 937 (15 057)** | 101 834   | 429 MB    | 92       | 5 961 / 98 / 7.8              | 390    |
| 503 (333 × 222)    | –                     | 6 974 / 2 791 / 0.6           | 235 (148)           | 64 488    | 44 MB     | 849      | 19 787 / 336 / 17.3           | 168    |
| 503                | 0.5 (loft)            | –                             | 3 783 (2 546)       | 174 702   | 151 MB    | 892      | 28 855 / 492 / 50.5           | 3 016  |
| 503                | 1.2 (fallback)        | –                             | not run (minutes)   | –         | –         | –        | –                             | –      |
| 2 009 (633 × 422)  | –                     | **258 126 / 102 654** / 1.0   | 961 (603)           | 257 360   | 713 MB¹   | 11 473   | 78 902 / 1 363 / 68.7         | 675    |

¹ One kernel for the whole run (a WASM heap never shrinks); the 2 009-cell chamfer case trapped (`memory access out of bounds`) on that grown heap and was not rerun in time.

`design.shape.add` itself (the fold plus the command's checks and warnings): 0.2 / 7.5 / **331** s. One square lattice of Ø 10 circles, 1 107 cells (55 350 chords): fold 173 ms, normalise 34 ms, evaluation 840 ms; circles in rows whose boxes do not overlap skip the boolean, the interlocking hexagon rows do not.

Chamfer constructions (same part: per-cell and whole volumes agree to 10⁻⁶ mm³ where both ran):

| N   | Chamfer | Whole region        | Per-cell lofts: build alone | Per-cell: eval (step) | Batch-50: eval (step)              |
| --- | ------- | ------------------- | --------------------------- | --------------------- | ---------------------------------- |
| 103 | 0.5     | loft, 404 (181)     | 63, 103 / 103 lofts         | 368 (61)              | 346 (99)                           |
| 503 | 0.5     | loft, 3 783 (2 546) | 281, 503 / 503 lofts        | 2 928 (231)           | 1 787 (565)                        |
| 103 | 1.2     | fallback, 15 937    | 63, 103 / 103 lofts         | 468 (76)              | –                                  |
| 503 | 1.2     | fallback (not run)  | 304, 503 / 503 lofts        | 4 162 (243)           | 76 195 (7 095): fallback per group |

Splitting the **pocket** into 100-cell operations did not help: 2 009 cells 1 307 ms with a 642 ms step (one prism: 961 / 603). Each layer's subtraction pays for the whole part, as S6 found for clone layers.

## Findings

1. **Evaluation is linear and fine to 2 000** (≈ 0.45 ms and ≈ 128 triangles per hexagon cell, ≈ 16 µs per chord): 57 / 235 / 961 ms. The cost is one subtraction step (47 / 148 / 603 ms). Triangles pass the 20 000 budget at ≈ 150 cells, and the 50 ms evaluation at ≈ 100. So `dfm.patternHeavy` belongs at **≈ 150 cells (or ≈ 5 000 chords)**, and a 2 000-cell pattern is a heavy part with a ≈ 0.6 s abort latency, an accepted exception like clone layers.
2. **The region must not be built by booleans.** The named shape's fold is quadratic (0.16 / 7 / 258 s), and so is the port's `normalise` (it folds too: 0.06 / 2.8 / 103 s). Direct pieces take ≤ 1 ms at 2 009. Cells are disjoint by the `patternOverlap` invariant, so the `pattern` item can emit pieces without a boolean (`clip` intersects only the cells crossing the boundary). This also means **a 2 000-cell pattern cannot be an ordinary named shape** (also `SHAPE_ITEMS_MAX` = 1 000).
3. **The 2D port's offset checks are quadratic on many-piece regions.** CPU profile at 503 cells: `offsetChecked` → `offsetProblem` / `keepsPieces` → `regionContains` (winding number over every element of every piece) per input loop. At 503 cells it took ≈ 0.8 s per loft check and ≈ 7 s of the profiled run in all, under the chamfer loft's `sameAsPort` check, the pocket generator's wall offset, and the plan's Z reference. A bounding-box prefilter per piece in `regionContains` (or offsetting a disjoint region piece by piece) makes it linear.
4. **The chamfer must be built per cell.** The whole-region loft check offsets the whole region (finding 3) and, as soon as two neighbours' bevels meet (width 1.2 on a 2 mm web, a normal decorative choice), sends **every** cell to the swept-chord fallback: 16 s at 103 cells in one step with a 429 MB heap. Built per loop, every cell lofted (103 / 103, 503 / 503) in both widths, the build is linear (≈ 0.6 ms per cell), and the evaluation is 0.37–0.47 s at 103 and 2.9–4.2 s at 503 with steps ≤ 250 ms. **Batching the check per group of cells is wrong**: a group of 50 neighbours falls back together (76 s at 503).
5. **The per-cell chamfer still costs ≈ 6–8 ms per cell** (≈ 12–16 s at 2 000 by extrapolation): the overlapping per-cell lofts are unioned layer by layer, each layer's subtraction paying for the part. Cheaper P3 forms, not measured: one loft mesh of all cells whose bevels do not meet (per-loop check, then one mesh: the 503-cell whole loft built in ≈ 1.5 s, of which ≈ 0.8 s was the quadratic check), with only the meeting cells as separate meshes.
6. **Toolpaths and program are linear except the generator's ordering.** 39 lines and ≈ 30 mm of rapids per cell (nearest-neighbour order holds; each cell is entered on its own helix), 79 k lines / 1.36 MB / 69 min at 2 009 cells without chamfer; the 0.5 mm chamfer triples the run time (10.4 vs 3.6 min at 103: one slow contour per cell). Generation is quadratic: 88 / 849 / 11 473 ms (the whole-region wall offset, finding 3, and `nearestFirst` over every remaining root). It also steps only per depth level, so one level of 2 000 cells is one 10 s step.
7. **Export with a chamfer is dominated by the Z reference.** At 503 cells 3.0 s, ≈ 1.8 s of it the touch-off spot search (`flat-patch.ts` `touchOffSpot` → `score`) over a face with 503 holes.
8. **Memory** is linear: the evaluation mesh 0.4 / 1.9 / 7.5 MB (renderer transfer), the WASM heap 16 → 151 MB at 503 with the chamfer, the test process ≈ 0.3–1.1 GB RSS (it also holds the document history). The 429 MB heap of the meeting-bevel fallback at 103 cells is the outlier.

## Recommendations

- **Cell limit (`patternTooMany`): 2 000**, conditional on the P1 changes below; **500** if P1 ships without them. **Heavy threshold (`dfm.patternHeavy`): ≈ 150 cells**, set in code as ≈ 5 000 region chords so cell size counts.
- **P1, the `pattern` item:** emit the region as direct pieces (no fold, no `normalise`); boundary containment per cell by bounds, `clip` booleans only for cells crossing the boundary. Cache by item hash as planned.
- **P1, the 2D port:** a per-piece bounds prefilter in `regionContains` and in `keepsPieces`/`offsetProblem` (or piece-wise offset of disjoint regions). It is generic, helps every many-loop region, and fixes findings 3, 6 (in part) and 7 at once.
- **P1, the pocket generator:** a spatial grid for `nearestFirst`, and a `steps.step()` per group of cells within a level (abort latency).
- **P1, evaluation:** keep one prism and one subtraction; do not split the pocket (no gain). Evaluating per cell plus instancing is not needed: the evaluation is linear and the part is one mesh. The operation cache already keeps the pocket's solid across unrelated edits; keeping `stock − pattern` as a kept solid (as clone layers do) is the next lever if edits elsewhere feel slow.
- **P3, the chamfer:** check the loft **per loop**, never per region or per group. Put the loops whose bevels do not meet into one loft mesh, and each loop whose bevel meets a neighbour into its own loft mesh, unioned in the kernel. The swept-chord fallback stays only for a single loop whose own offset changes topology. P3's exit "300 cells within the P0 budget" becomes ≈ 2 s fresh with ≤ 250 ms steps, not 50 ms.
- **Z reference:** bound the touch-off spot search (spatial index of holes, or score on a coarse grid first) before patterns with chamfers ship.
- **Renderer:** 257 k triangles at 2 009 cells without chamfer, ≈ 2.5 × that with one: within what Three.js draws on the reference machine, but the 20 000 budget is far behind; a level of detail can come later if the viewport stutters.

## Not measured

Stopped at the time limit: circles on the hex lattice and both cells on the square lattice at 100 / 500 / 2 000 (one square-lattice circle case, 1 107 cells, is above), 2 000 cells with a chamfer (extrapolated in finding 5), the fallback at 503 cells, 5 000 cells, `clip`, inverted patterns and a named star cell. The harness runs them as is (`S8_CASES=hex-circle,square-hex,square-circle`).
