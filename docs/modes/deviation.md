# Deviation check: the simulated cut against the reference

Status: draft (proposed 2026-11-22 from the [LLM-first black-box test](../plans/v0.4-llm-first.md#source), finding F4; milestone: the v0.4 follow-up, after v0.4 and before v0.5; decisions below are proposals until the user answers [Q43–Q44](../plans/v0.4-llm-first.md#questions-for-the-user)) · Plan of record: [plans/v0.4-llm-first.md](../plans/v0.4-llm-first.md) · Reference: [reference-model.md](reference-model.md), [reference-tools.md](reference-tools.md) · The design against the reference (the evaluated part): [reference-tools.md § Compare](reference-tools.md#3-compare) (hardening DF60, Q71) · Toolpaths: [plan-v0.1.md § Toolpath data model](plan-v0.1.md#toolpath-data-model) · Workholding causes: [workholding.md](workholding.md) · Terms: [glossary.md](../glossary.md)

Nothing in the app tells whether the programs make the reference. The v0.3 exit test checks the design in test code only (the evaluated part's mid-wall section against the STL's, ≤ 0.2 mm; [testing.md § v0.3 headless golden path](../conventions/testing.md)), and the black-box agent wrote its own Z-map of both programs against the STL. Since hardening DF60 (Q71) the **design** source (does the evaluated part match?) is owned by [reference-tools.md § Compare](reference-tools.md#3-compare) (3D booleans, height-map fallback); this doc keeps only the **simulated cut** of a plan's toolpaths (do the programs make it?): headless first (agents, CLI, exit tests), a view in the viewport later.

"Deviation" here is the geometric distance between two surfaces; the tolerance sense of the word (a limit minus the nominal value) is unchanged ([glossary](../glossary.md)).

## Decisions

| Id   | Decision                                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DV-A | The **simulated cut** of a plan's toolpaths (do the programs make it?) is this doc's source; the evaluated **part** moved to [reference-tools.md](reference-tools.md#3-compare) (DF60). One command, a `source` union.     |
| DV-B | Two **methods**: a **height map** (Z-map) per approach direction, and **sections** at chosen depths with the two-sided distance per loop. Both 2.5D; a full 3D comparison (voxels, dexels in three axes) is later.         |
| DV-C | A **job** (it may take seconds) that returns **compact statistics and regions**, never the raw map; the map is kept for a later viewport view.                                                                             |
| DV-D | Every region over the threshold gets a **cause** when the app knows one (tool radius, workholding keep-out, edge band, a hole mouth the design does not model); the exit test requires every large region to be explained. |
| DV-E | The simulated cut **promotes the toolpath heightmap test oracle** (`Heightmap.sweep` in `src/core/toolpath/testing/oracles.ts`) to production code; it becomes the seed of in-process stock later.                         |

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
- **Cut map** (`source: plan`): the stock top swept by every move of the setups of that direction, in machining order, with the tool's profile (flat, ball, bull-nose, drill point, chamfer cone): worker task `simulate.heightmap` over the toolpaths in the setup frame, mapped back to the part frame. Setups from other directions are independent maps (no in-process stock yet, as Plan itself).
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

Targets on the enclosure (two setups, 250 × 200 mm, 0.5 mm cells: 200 K cells per direction): the reference map < 0.5 s, the cut map < 2 s for the 26 000-line top program (the black-box agent's Node script took 0.6 s), all in the compute worker with progress per setup. Spike S9 measures the swept-tool cost for arcs and drill points and the aliasing of the edge band.

## Display (later)

A diverging colour map on the part in Design and Plan (over-cut and under-cut colours from the [ui.md](../conventions/ui.md) palette, neutral within the threshold), region markers with their cause, and the statistics in a panel. Specified with the UI amendment after the headless command proves out; this milestone ships the command and the numbers (plan task U4: a results panel without the colour map, first to cut).

## Testing

- Synthetic: the simulated cut of a plan for a part equal to the reference gives max |dev| < cell size outside the edge band; a pocket 0.2 mm too deep gives one region, sign over-cut, maxDev 0.2 ± 0.01.
- Cut map against the existing toolpath heightmap oracle (they are the same code after DV-E; the oracle's own tests stay).
- The enclosure: the black-box test's numbers (top p99 |dev| 0.005 mm, bottom p99 0.005 mm at 0.5 mm cells) reproduced within 0.01 mm from its saved project's programs; the R3 step corners come back as `toolRadius` regions, the hole mouths as `holeMouth`.

## Not yet

| Item                                                  | Where                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Viewport colour map                                   | [Display (later)](#display-later)                                        |
| 3D comparison (walls, undercuts, voxels / tri-dexels) | With simulation ([plan.md § Simulation](plan.md#simulation--prediction)) |
| In-process stock across setups                        | Roadmap Later list; reuses the cut map                                   |
| Surface finish, scallop and wall-taper estimates      | With 3D finishing                                                        |
| Tolerances on the reference (per-face limits)         | When parts carry tolerances on surfaces                                  |
