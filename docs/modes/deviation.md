# Deviation check: the simulated cut against the reference

Status: implemented (X2 of the v0.4 follow-up, 2026-11-26: the app flow through the UI, [X2 measured](../plans/v0.4-llm-first.md#x2-measured-2026-11-26)); accepted by delegation (D70, 2026-11-26; the user can veto: [readiness review](../plans/v0.4-llm-first.md#readiness-review-2026-11-26); proposed 2026-11-22 from the [LLM-first black-box test](../plans/v0.4-llm-first.md#source), finding F4, [Q43–Q44](../plans/v0.4-llm-first.md#questions-for-the-user); milestone: the v0.4 follow-up, after v0.4 and before v0.5) · Built: the cut map (S9, V2: [Implementation](#implementation-s9-v2)) and the `source: plan` compare (V3: [Implementation](#implementation-v3)), the results panel without the colour map (U4: [Implementation](#implementation-u4)) · Plan of record: [plans/v0.4-llm-first.md](../plans/v0.4-llm-first.md) · Reference: [reference-model.md](reference-model.md), [reference-tools.md](reference-tools.md) · The design against the reference (the evaluated part): [reference-tools.md § Compare](reference-tools.md#3-compare) (hardening DF60, Q71) · Toolpaths: [plan-v0.1.md § Toolpath data model](plan-v0.1.md#toolpath-data-model) · Workholding causes: [workholding.md](workholding.md) · Terms: [glossary.md](../glossary.md)

Nothing in the app tells whether the programs make the reference. The v0.3 exit test checks the design in test code only (the evaluated part's mid-wall section against the STL's, ≤ 0.2 mm; [testing.md § v0.3 headless golden path](../conventions/testing.md)), and the black-box agent wrote its own Z-map of both programs against the STL. Since hardening DF60 (Q71) the **design** source (does the evaluated part match?) is owned by [reference-tools.md § Compare](reference-tools.md#3-compare) (3D booleans, height-map fallback); this doc keeps only the **simulated cut** of a plan's toolpaths (do the programs make it?): headless first (agents, CLI, exit tests), a view in the viewport later.

"Deviation" here is the geometric distance between two surfaces; the tolerance sense of the word (a limit minus the nominal value) is unchanged ([glossary](../glossary.md)).

## Decisions

| Id   | Decision                                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DV-A | The **simulated cut** of a plan's toolpaths (do the programs make it?) is this doc's source; the evaluated **part** moved to [reference-tools.md](reference-tools.md#3-compare) (DF60). One command, a `source` union.                                                                                                                                  |
| DV-B | Two **methods**: a **height map** (Z-map) per approach direction, and **sections** at chosen depths with the two-sided distance per loop. Both 2.5D; a full 3D comparison (voxels, dexels in three axes) is later.                                                                                                                                      |
| DV-C | A **job** (it may take seconds) that returns **compact statistics and regions**, never the raw map; the map is kept for a later viewport view.                                                                                                                                                                                                          |
| DV-D | Every region over the threshold gets a **cause** when the app knows one (tool radius, workholding keep-out, edge band, a hole mouth the design does not model); the exit test requires every large region to be explained.                                                                                                                              |
| DV-E | The cut map is **its own production sweep** (`src/core/toolpath/simulate.ts`, spike S9): exact swept segments and arcs sampled at cell centres. It neither promotes the test oracle (`Heightmap.sweep`, which stays the independent check) nor reuses DF64's `StockHeights` field (a whole-cell upper bound); it is the seed of in-process stock later. |

## The command

`design.reference.compare { partId, referenceId?, source, method?, threshold?, cell? }` – a `job` ([commands.md § Jobs](../architecture/commands.md#long-running-commands-jobs)): returns `{ jobId }`, `job.wait` gives the result. Not undoable, changes no document.

| Arg         | Values                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`    | `{ kind: 'plan', planId, setupIds? }` (default: every setup of the plan, in order); `{ kind: 'part' }`: [reference-tools.md](reference-tools.md#3-compare)                         |
| `method`    | `{ heightmap?: { faces? } , sections?: { face, depths[] } }`; default `heightmap` over the approach directions in use (the part's operation faces, or the plan's setup directions) |
| `threshold` | length, default 0.1 mm: cells and loop points beyond it count as deviating                                                                                                         |
| `cell`      | length, default 0.5 mm (min 0.1 mm, at most 4 M cells per direction, else `input.malformed`, rule `tooLarge`)                                                                      |

## Height map method

For each direction (a face's −n, looking at the stock from that face):

- **Reference map:** for every cell centre, the depth (below that stock face) of the first reference surface hit along the direction (ray cast of the placed mesh, worker task `reference.heightmap`); no hit = the column is empty (outside the part).
- **Cut map** (`source: plan`): the stock top swept by every move of the setups of that direction, in machining order, with the tool's profile (flat, ball, bull-nose, drill point, chamfer cone): worker task `simulate.heightmap` over the toolpaths in the setup's WCS, turned back into the direction's face frame on the reference map's grid (cell centres at (i + ½, j + ½)·cell), so the two maps subtract cell by cell. Setups from other directions are independent maps (no in-process stock yet, as Plan itself), except that a column cut through from the opposite face is empty from both ([Implementation (V3)](#implementation-v3)).
- **Deviation per cell** = source depth − reference depth, sign convention: **positive = material left (under-cut), negative = cut too deep (over-cut)**, in mm.
- **Domain:** cells where the reference has material in the column, grown by 1 mm. Cells outside (the stock frame, the tabs) are reported as an area only (`outsidePart`). An **edge band** (cells within half a cell of a vertical reference wall, where any Z-map aliases) is excluded from the statistics and reported as an area, unless `strict: true`.

## Sections method

For each requested depth on a face: the reference section ([reference-tools.md § Section](reference-tools.md#section)) and the cut map's contour at that depth, and the **two-sided distance** per loop (every point of each loop to the other set, sampled every 0.1 mm), as in the v0.3 exit check. Loops present on one side only are reported as `missing` / `extra` with bounds.

## Result

```
{ source, method, cell, threshold,
  stats: { cells, mean, p50, p95, p99, max, overcutMax, undercutMax, areaOver },   // |dev| unless signed
  excluded: { outsidePart, edgeBand },                                              // mm²
  regions: [{ face, bounds, area, volume, maxDev, sign, depthRange, cause?, operationId? }],  // ≤ 20, largest volume first
  more?, sections?: [{ face, depth, loops: [{ role, maxDistance, p95, missing?, extra? }] }] }
```

- **Regions:** connected cells beyond the threshold (an over-cut also of one operation: [Implementation (V3)](#implementation-v3)). `operationId` is the plan or design operation whose footprint covers the region (so an agent knows what to edit). `cause`:
  - `toolRadius` – within the tool radius of an inside corner the plan already reports as rest material (`plan.restMaterial`);
  - `workholding` – inside a keep-out zone ([workholding.md § Keep-out](workholding.md#keep-out-in-toolpaths), the `plan.workholding.unmachined` area);
  - `holeMouth` – at a hole the [hole detection](reference-tools.md#2-features-holes) finds with a countersink or counterbore mouth the design lacks;
  - none – unexplained: the agent's job.
- Size: under 8 KB for the exit part; numbers in mm rounded to 0.001. As built (V3): at most 20 regions and 5 KB ([Implementation (V3)](#implementation-v3)).

## Performance

Targets on the enclosure (two setups, 250 × 200 mm, 0.5 mm cells: 200 K cells per direction): the reference map < 0.5 s, the cut map < 2 s for the 26 000-line top program (the black-box agent's Node script took 0.6 s), all in the compute worker with progress per setup. Spike S9 measured the cut map at **55 ms** for that program (0.5 mm; 175 ms at 0.25 mm): [Implementation](#implementation-s9-v2).

## Display (later)

A diverging colour map on the part in Design and Plan (over-cut and under-cut colours from the [ui.md](../conventions/ui.md) palette, neutral within the threshold), region markers with their cause, and the statistics in a panel. Specified with the UI amendment after the headless command proves out; this milestone ships the command and the numbers (plan task U4: a results panel without the colour map, built: [Implementation (U4)](#implementation-u4)).

## Testing

- Synthetic: the simulated cut of a plan for a part equal to the reference gives max |dev| < cell size outside the edge band; a pocket 0.2 mm too deep gives one region, sign over-cut, maxDev 0.2 ± 0.01.
- Cut map against the toolpath heightmap oracle (`Heightmap.sweep`, independent code since S9): equal within one cell on the black-box test's two programs; exact against closed forms for flat, ball, V-bit, drill point, level arcs and ramps (`simulate.test.ts`).
- The enclosure: the black-box test's numbers (top p99 |dev| 0.005 mm, bottom p99 0.005 mm at 0.5 mm cells) reproduced within 0.01 mm from its saved project's programs; the R3 step corners come back as `toolRadius` regions, the hole mouths as `holeMouth`. As built: [X0](#x0-q44-measured-on-the-black-box-tests-programs) (the mouths fall in the edge band).

## Implementation (S9, V2)

**S9 decision (2026-11-26): a new sweep, neither candidate as is.** Measured on the black-box test's programs (the top one: 26 185 lines, 26 170 moves, 1 893 arcs, 6 mm flat end mill; G-code fixtures `src/core/toolpath/__fixtures__/enclosure-{top,bottom}.nc.gz`, read by `testing/gcode.ts`), 0.5 mm cells, idle M-series Mac:

| Candidate                                        | Top program | Cells > 0.1 mm off the oracle | Why not / why                                                                                                                                                                                  |
| ------------------------------------------------ | ----------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DF64 `StockHeights.cut` (production)             | 140 ms      | 2 462 (1.2 %, along walls)    | A cell is lowered only where the whole cell is under the tool (an upper bound, right for links and clamps), and sloped pieces count at their highest Z: every wall comes out up to a cell wide |
| `Heightmap.sweep` (test oracle, 0.1 mm samples)  | 1 000 ms    | –                             | Stamps a disc every 0.1 mm: 18× slower, and promoting it would leave the cut map without an independent check                                                                                  |
| **`simulateHeightmap`** (`toolpath/simulate.ts`) | **55 ms**   | 1 (a cell centre on the edge) | Point samples at cell centres like the reference map; each move swept exactly, not sampled                                                                                                     |

- **Sweep.** Per feed move, the cells in its bounds ± R: a straight move by the distance to the segment (a flat end on a slope by the lowest tip Z of the stretch above the point: exact); a level arc by the distance to the arc (sector test, in pieces of at most a half turn: exact); a helix in chords within 0.002 mm; a sloped move of a shaped tool (ball, bull nose, V-bit, drill point) in pieces of at most 0.01 mm height, each at its closest point (never too deep, at most 0.01 mm high); drill cycles expanded (vertical: exact). The tool's surface is `toolSurface`'s, its constants taken once (`toolProfile`). Shares only `arcSweep` and `expandDrill` with the field and the oracle.
- **Frames.** Toolpaths come in their setup's WCS (as the plan stores them) and are turned back with `fromWcs` (rotation, work zero); one map per direction in order of first use, setups of one direction sweep the same map in machining order; values are the material top in the face frame, clamped at −thickness (through). The map is float32 (transferred); 0.1 mm minimum cell and 4 M cells per direction (`input.malformed`, rules `tooSmall`, `tooLarge`).
- **Worker.** `simulate.heightmap` on the `toolpath` lane (no WASM; [workers.md](../architecture/workers.md#what-runs-on-a-worker)); toolpaths get the spot check; a step per toolpath and per 2 000 moves (abort latency well under 50 ms).
- **Edge band (S9, against the placed STL as the black-box test placed it):** off the band (no reference step over 0.1 mm to a neighbouring cell) top p95 = p99 = 0.005 mm at both 0.5 and 0.25 mm, bottom 0.001 mm, as the black-box agent's own Z-map (149 331 cells in the part at 0.5 mm). The band is 12.2 cm² on the top at 0.5 mm (92 of its cells over 0.1 mm), 6.1 cm² at 0.25 mm (336); on the bottom 19.1 cm² (394) and 11.2 cm² (1 437). Halving the cell halves the band's area but not its count of aliased cells, so the band stays excluded rather than refined away. Off-band cells over 0.1 mm: top 6 (0.5 mm) / 26 (0.25 mm), the R3 step corners; bottom 12 / 164, the hole mouths and drill points: V3's `toolRadius` and `holeMouth` causes.
- **Tests:** `simulate.test.ts` (closed forms per tool, arcs, ramps, setups and turns, the oracle on both enclosure programs within one cell, the task through the worker boundary); `simulate.perf.ts` (`npm run perf`: the 2 s budget, the S9 numbers above).

## Implementation (V3)

**As built (slice LF4, 2026-11-26).** `design.reference.compare { partId, referenceId?, source: { kind: 'plan', planId }, threshold?, limit? }`: the existing job's `source` became `{ kind: 'part' | 'plan', planId? }` (one enum value and one optional id, the smallest schema change; `planId` is checked in the job: `input.malformed` rules `required` and `otherPart`). Not built yet: `setupIds`, `method.sections`, `cell` (fixed 0.5 mm) and `strict`; the agent cannot change them, so every result is comparable with Q44.

- **Flow** (`reference-commands.ts` `comparePlan`): the plan's operation inputs in machining order (`planOperationInputs`; a plan finding fails the job as it fails the export); each toolpath from the cache or generated (`ensureToolpath`, as `plan.export`); then **two lanes at once**: `simulate.heightmap` (toolpath lane, the setups' toolpaths in their WCS) and the new `reference.heightmap` (geometry lane: the kept reference mesh placed with its ghost matrix, `referenceHeightmaps` in `reference-compare.ts`, NaN where a column misses it) on the same grid (`gridCells`), both transferred; the host subtracts them (`comparePlanMaps`, `reference-compare-plan.ts`, pure). The cut map now records which toolpath last lowered each cell (`CutMap.by`), so a region names its plan operation.
- **One piece of in-process stock: through columns.** Opposite directions share columns (`faceToFace`): where the material one face leaves lies wholly above what the opposite face's cut left, the column is empty and both maps read the stock bottom there. Without it the outline cut through from the top showed, from the bottom, as 35 mm of material beside every bottom step. Other directions stay independent maps.
- **Domain and edge band:** the reference's columns grown by 1 mm (outside: `excluded.outsidePart`); a cell is in the band when any of its 8 neighbours differs in reference height by more than the threshold, an empty column counting as the stock bottom (as S9 measured; `excluded.edgeBand`). Slopes steeper than the threshold per cell are band too (countersinks, the edge round).
- **Result:** `{ source: 'plan', method: 'heightmap', cell, threshold, stats, faces[], excluded, regions[], more?, unexplained, planId }`; `stats` and each `faces[]` entry: `cells, mean, p50, p95, p99, max, overcutMax, undercutMax, areaOver` (|dev| in mm over the compared cells, areas mm²). A region: `face` (stock face id), `bounds` (face frame [u, v], cell edges), `area`, `volume`, `maxDev`, `sign` (`undercut` / `overcut`), `depthRange` (depths below the face of both surfaces), `cause?`, `operationId?` (the plan operation that last cut most of its cells, else most cells within a tool radius around it). **Grouping:** 4-connected cells of one sign; an over-cut region is also of one operation, the one that last cut each cell (`CutMap.by`), so touching over-cuts of different operations stay apart, each with its own operation and worst value (review R6: a 0.5 mm facing over-cut touching two pockets' 2.5 mm came back as one region credited to the facing with the pockets' value). Material left is not split (no one operation made it; the majority names it), and no depth band is needed: an operation's over-cut at several depths is still one mistake. Largest volume first, at most 20 (`limit` lowers it), then dropped from the end while the JSON is over 5 KB (`more`). `unexplained` counts every region over 0.5 mm without a cause, listed or not (Q44's third number).
- **Causes as built** (first match): `workholding` – overlaps the face-frame bounds of material a keep-out leaves (`plan.workholding.unmachined`'s list); `drillPoint` (over-cut) – within the drill radius of a drilled hole's centre and no deeper than the drill's point cone (the reference's hole bottom is flatter or shallower); `holeMouth` (under-cut) – within two hole diameters of a drilled hole's centre; `tab` (under-cut) – wholly in columns without reference, cut from this face or the opposite one by a profile with tabs; `toolRadius` (under-cut) – every cell within the tool radius of a higher reference cell, no wider than the tool, beside cells the same operation cut to the region's reference level (rather than reading `plan.restMaterial`: the geometry says the same and needs no 2D pass). Holes are the drill cycles of the toolpaths and the vertical plunges of a drill (programs read back from G-code have no cycles).
- **Agent API:** `tools/list` 111,202 → **111,362** chars (+160: the enum value, `planId`, one summary sentence); results are in the output schema only (a union with the part result). The primer's Reference bullet names `{ kind: "plan", planId }`.
- **Tests:** `reference-compare-plan.test.ts`: statistics (percentiles, signs, areas), a pocket 0.2 mm too deep as one over-cut region, each cause and its negative (a lump mid-floor, a 1 mm tool, no tabs, a hole too deep), through columns, the 20-region and 5 KB caps, `cutHoles`, touching over-cuts of two operations as separate regions (R6); U4's block headless (a 0.5 mm facing and two pockets against the stock's box STL: three over-cut regions, Facing 1 at 0.5 mm and each pocket at 2.5 mm); X0 on the black-box programs (below); the command headless on the enclosure (a plan made in the app: cavity, outline with tabs, bottom facing; the omitted steps and holes come back as unexplained regions on the facing) and its refusals.

### X0: Q44 measured on the black-box test's programs

The two saved programs (`enclosure-{top,bottom}.nc.gz`, setups +z and −z, no turn or zero) against `enclosure-wood-base.stl` placed as the test placed it (centred, bottom 1 mm above the stock bottom), threshold 0.1 mm:

| Q44 number                                       | Target    | 0.5 mm cells        | 0.25 mm cells (same) | Met                  |
| ------------------------------------------------ | --------- | ------------------- | -------------------- | -------------------- |
| p95 \|dev\| outside the edge band (top / bottom) | ≤ 0.05 mm | 0.005 / 0.001 mm    | 0.005 / 0.001 mm     | yes                  |
| p99 \|dev\| outside the edge band (top / bottom) | ≤ 0.1 mm  | 0.005 / 0.001 mm    | 0.005 / 0.001 mm     | yes                  |
| Regions over 0.5 mm without a cause              | 0         | **8** of 22 regions | 8                    | **no, by 8 regions** |

- **Why the third misses: a real defect of the black-box programs, not of the check.** The 2.5 mm drill (118°) goes 5.559 mm into the bottom; the reference's holes end 4.944 mm in (flat), 0.241 mm under the cavity floor (5.185 mm from the bottom). The drill's point passes the floor by 0.374 mm at all four holes, so each column is open: from the bottom an over-cut of 35.06 mm (the hole's end missing), from the top an over-cut of 5.185 mm (a pinhole in the cavity floor), on the drilling and the top program. Not `drillPoint`: the over-cut is deeper than the point. S9's independent maps showed it only as a 0.615 mm over-cut at the tip; the through columns make it visible. The black-box agent's own Z-map missed it.
- **Explained:** the eight tab regions (four from each face: 8 mm tabs; from the bottom the step program leaves them) as `tab`, the cavity's two sharp corners (34.8 mm high, 0.75 mm² each) as `toolRadius`. The hole mouths (countersinks, 4.86 mm) lie in the edge band at both cell sizes (their slopes step more than 0.1 mm per cell), so no `holeMouth` region appears; the band is 39.9 cm² at 0.5 mm, 21.6 cm² at 0.25 mm.
- **In the G-code, not the cells:** the drill's tip is at Z −5.691, 0.506 mm past the floor; the 0.5 mm cells sample its point off the axis and see 0.374. The exit fixture records both, with the reference's levels, sections and holes ([v0.4-llm-first.md § X0 fixture](../plans/v0.4-llm-first.md#x0-fixture-2026-11-26)).
- **No threshold changed;** Q44 stays as accepted. X1's own programs (the app's drilling at the detected depth) are what the exit test checks; this fixture keeps the black-box numbers as a regression record.

## Implementation (U4)

**As built (2026-11-26).** The results panel in the Plan inspector without a selection, a group "Compare with reference" after the plan's Checks; UI rules in [ui.md § Deviation panel](../conventions/ui.md#deviation-panel). No command or schema change: the window calls `design.reference.compare { partId, referenceId? (only with several references), source: { kind: 'plan', planId }, threshold, limit: 20 }` and follows the job with `job.get` (as toolpath generation), Cancel is `job.abort`.

- **Decisions (by delegation, D70):**
  - **Run on demand, not after each edit.** The job takes seconds and generates missing toolpaths; unlike the design overlay ([reference-tools.md § Overlay](reference-tools.md#overlay-ui)) it runs only on "Compare". A result whose plan inputs changed since (revision, pending set, library) stays on screen with an "outdated" note.
  - **Held by the window's plan store** (`plan-store.ts` `deviation`, one run per window, of one plan), so choosing a region (which selects its operation and replaces the inspector) and coming back keeps the result, the chosen row and a running job. The run's end re-reads the plan's toolpaths (the job generated them into the cache).
  - **No framing or marking of the region** in the viewport as first built (U4); added after it, see [§ Region marker (U4 follow-up)](#region-marker-u4-follow-up).
  - **What is shown:** the summary (regions counted with `more`, `unexplained`), the regions (sign, max deviation, operation, cause; "check: no known cause" for one over 0.5 mm without a cause, as Q44 counts, design review R5), then a closed Statistics accordion (design review R7): the overall statistics (mean, 95 %, 99 %, max, worst over- and under-cut, area over the threshold, the edge band's area) and one line per face when there are several. A result that arrives scrolls the group into view. `p50`, `cells`, `depthRange`, `volume` and `excluded.outsidePart` stay in the result for agents.
- **Code:** `modes/plan/DeviationPanel.tsx`, the run in `plan-store.ts` (`compareDeviation`, `cancelDeviation`, `chooseDeviationRegion`), strings in `messages/deviation.ts`.
- **Tests:** `Deviation.test.tsx` (no reference; the job's arguments, progress, Cancel; the scroll into view on a result; the order summary → regions → closed Statistics; the statistics and regions with causes, a region selecting its operation and staying chosen, the outdated note after an edit; the within state; a failed job; axe); `e2e/deviation.e2e.ts` (a faced block with two pockets against a box STL of the stock: over-cut regions, a region selects its operation; renders `design/features/renders/u4-deviation-panel-{light,dark}.png`).

## Region marker (U4 follow-up)

**As built (2026-11-26).** Choosing a region row marks and frames the region in the Plan viewport; UI rules in [ui.md § Deviation panel](../conventions/ui.md#deviation-panel). No command or schema change.

- **Box:** the region's `bounds` (face frame `[u, v]`, cell edges) and `depthRange` (depths below the face) give a box in the face frame (`w` from −max depth to −min depth); its eight corners go to the part frame through `faceFrame(direction of face, plan stock)` (the frame the result's maps use: origin at the stock face's lower-left corner, `w` = 0 on the stock face). Stock faces are axis-aligned, so the corners' bounds are the box. Pure: `regionBox` in `modes/plan/deviation-region.ts`.
- **Marker:** the box's 12 edges, drawn over everything (no depth test, never pickable) in the row's swatch colour (`--danger` over-cut, `--info` under-cut), fading in over `--motion-base` (at once with reduced motion). A region a cell thin in depth draws as its outline at that depth.
- **Framing:** from the current view direction (the camera does not turn), the box grown to at least 10 mm on each side, so a one-cell region is not filled edge to edge. Choosing the same row again frames again. A frame is requested once per choice: switching modes and back does not frame again.
- **Every row is a button now:** a region without an operation (a tab, the frame) marks and frames only; a row with one also selects its operation as before. The plan scene draws the part in the part frame whichever setup is shown, so the marker does not depend on the setup.
- **Cleared:** when another region is chosen (replaced), when a new result arrives (its rows are new), and while the result is outdated (an edit, an Apply or a library change since the run, the same test as the panel's note).
- **Held:** the chosen row, its box and the framing request are in the window's plan store with the run (`chooseDeviationRegion(index, box)`), so the marker survives an operation selection.
- **Tests:** `deviation-region.test.ts` (boxes for top, bottom and side faces, the minimum framing size), `Deviation.test.tsx` (a row without an operation is a button that marks without selecting; the marker clears when the result goes outdated), `e2e/deviation.e2e.ts` (a chosen region draws the marker layer and moves the camera; dark capture `u4-deviation-marker-dark.png`).

## Not yet

| Item                                                  | Where                                                                      |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| Viewport colour map                                   | [Display (later)](#display-later); the panel, marker and framing are built |
| `setupIds`, `method.sections`, `cell` and `strict`    | [Implementation (V3)](#implementation-v3): fixed 0.5 mm height map         |
| 3D comparison (walls, undercuts, voxels / tri-dexels) | With simulation ([plan.md § Simulation](plan.md#simulation--prediction))   |
| In-process stock across setups                        | Roadmap Later list; reuses the cut map                                     |
| Surface finish, scallop and wall-taper estimates      | With 3D finishing                                                          |
| Tolerances on the reference (per-face limits)         | When parts carry tolerances on surfaces                                    |
