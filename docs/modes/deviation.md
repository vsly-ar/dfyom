# Deviation check: the simulated cut against the reference

Status: accepted by delegation (D70, 2026-11-26; the user can veto: [readiness review](../plans/v0.4-llm-first.md#readiness-review-2026-11-26); proposed 2026-11-22 from the [LLM-first black-box test](../plans/v0.4-llm-first.md#source), finding F4, [Q43–Q44](../plans/v0.4-llm-first.md#questions-for-the-user); milestone: the v0.4 follow-up, after v0.4 and before v0.5) · Built: the cut map (S9, V2: [Implementation](#implementation-s9-v2)); the `source: plan` compare is V3 · Plan of record: [plans/v0.4-llm-first.md](../plans/v0.4-llm-first.md) · Reference: [reference-model.md](reference-model.md), [reference-tools.md](reference-tools.md) · The design against the reference (the evaluated part): [reference-tools.md § Compare](reference-tools.md#3-compare) (hardening DF60, Q71) · Toolpaths: [plan-v0.1.md § Toolpath data model](plan-v0.1.md#toolpath-data-model) · Workholding causes: [workholding.md](workholding.md) · Terms: [glossary.md](../glossary.md)

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
- **Cut map** (`source: plan`): the stock top swept by every move of the setups of that direction, in machining order, with the tool's profile (flat, ball, bull-nose, drill point, chamfer cone): worker task `simulate.heightmap` over the toolpaths in the setup's WCS, turned back into the direction's face frame on the reference map's grid (cell centres at (i + ½, j + ½)·cell), so the two maps subtract cell by cell. Setups from other directions are independent maps (no in-process stock yet, as Plan itself).
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

- **Regions:** connected cells beyond the threshold. `operationId` is the plan or design operation whose footprint covers the region (so an agent knows what to edit). `cause`:
  - `toolRadius` – within the tool radius of an inside corner the plan already reports as rest material (`plan.restMaterial`);
  - `workholding` – inside a keep-out zone ([workholding.md § Keep-out](workholding.md#keep-out-in-toolpaths), the `plan.workholding.unmachined` area);
  - `holeMouth` – at a hole the [hole detection](reference-tools.md#2-features-holes) finds with a countersink or counterbore mouth the design lacks;
  - none – unexplained: the agent's job.
- Size: under 8 KB for the exit part; numbers in mm rounded to 0.001.

## Performance

Targets on the enclosure (two setups, 250 × 200 mm, 0.5 mm cells: 200 K cells per direction): the reference map < 0.5 s, the cut map < 2 s for the 26 000-line top program (the black-box agent's Node script took 0.6 s), all in the compute worker with progress per setup. Spike S9 measured the cut map at **55 ms** for that program (0.5 mm; 175 ms at 0.25 mm): [Implementation](#implementation-s9-v2).

## Display (later)

A diverging colour map on the part in Design and Plan (over-cut and under-cut colours from the [ui.md](../conventions/ui.md) palette, neutral within the threshold), region markers with their cause, and the statistics in a panel. Specified with the UI amendment after the headless command proves out; this milestone ships the command and the numbers (plan task U4: a results panel without the colour map, first to cut).

## Testing

- Synthetic: the simulated cut of a plan for a part equal to the reference gives max |dev| < cell size outside the edge band; a pocket 0.2 mm too deep gives one region, sign over-cut, maxDev 0.2 ± 0.01.
- Cut map against the toolpath heightmap oracle (`Heightmap.sweep`, independent code since S9): equal within one cell on the black-box test's two programs; exact against closed forms for flat, ball, V-bit, drill point, level arcs and ramps (`simulate.test.ts`).
- The enclosure: the black-box test's numbers (top p99 |dev| 0.005 mm, bottom p99 0.005 mm at 0.5 mm cells) reproduced within 0.01 mm from its saved project's programs; the R3 step corners come back as `toolRadius` regions, the hole mouths as `holeMouth`.

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

## Not yet

| Item                                                  | Where                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Viewport colour map                                   | [Display (later)](#display-later)                                        |
| 3D comparison (walls, undercuts, voxels / tri-dexels) | With simulation ([plan.md § Simulation](plan.md#simulation--prediction)) |
| In-process stock across setups                        | Roadmap Later list; reuses the cut map                                   |
| Surface finish, scallop and wall-taper estimates      | With 3D finishing                                                        |
| Tolerances on the reference (per-face limits)         | When parts carry tolerances on surfaces                                  |
