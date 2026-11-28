# Run: surface maps

Status: accepted (v0.5 [RV10](../plans/v0.5-run.md#slices), delegation D88; Q227), RV10 implemented ([§ Implementation (RV10)](#implementation-rv10)); RV11 (bed map) not yet · Plan: [v0.5-run.md § 9](../plans/v0.5-run.md#9-surface-probing-stock-and-bed-maps) · Probing: [run-probing.md](run-probing.md) (the cycle runner, the probe check DF143) · Post: [grbl.md § Post-processor](../architecture/grbl.md#post-processor-task-211) · Safety: [run.md § Safety](run.md#safety) · Terms: [glossary.md](../glossary.md) (surface map, Z compensation)

A **stock map** is a grid of heights probed on the stock top, like a 3D printer's bed levelling mesh. With **Follow the surface map** ticked in the pre-flight, the run's program is exported with the map: its Z follows the measured surface, so an engraving, a V-carve or a cut in thin sheet keeps its depth on warped stock. Off by default; the map changes nothing until the user opts in for a run.

## The map

`HeightMap` (`src/core/post/height-map.ts`, headless):

| Field      | Meaning                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `origin`   | The grid's first point (X, Y; work coordinates, mm): its front-left corner                              |
| `spacing`  | The distances between columns (X) and between rows (Y), mm > 0                                          |
| `cols`     | Points along X, 2–30 (the dialog offers 3–30)                                                           |
| `rows`     | Points along Y, 2–30                                                                                    |
| `z`        | The surface's work Z per point, row by row from the front (`z[row × cols + col]`); `null`: not measured |
| `skipped`  | Indices of points left out under workholding ([§ Skipped points](#skipped-points)); their `z` is `null` |
| `workZero` | G54 X, Y (machine coordinates) when the map was taken: the map is in the work frame of that zero        |

Saved with the setup it was taken for: app settings `surfaceMaps`, keyed `<planId>/<setupId>` ([ui.md § Settings](../conventions/ui.md#settings)), with the date, the probe kind and the margin. **Decided:** app state, not the plan file: a finalized plan is not edited by probing, the map is a measurement of today's stock, and per-machine measurements already live there (RV8, RV9). A new map for the setup replaces the old; **Clear map** removes it.

- **Heights are relative.** Only differences matter: the Z0 touch-off of the run decides the absolute level, the map how the surface varies around it. So a map stays valid across tool changes and re-zeroing Z; it does not across a change of G54 **X/Y** (the grid would sit elsewhere on the stock): [§ Refusals](#refusals).
- **Bilinear interpolation** inside a cell from its four corners; the map's **range** is max − min over its points.

## Probing a map

Run navigator › Probing › **Map stock surface…** (with a plan and a setup chosen; connected; disabled while a job runs) opens an end-placed dialog, the 3D view beside it visible:

1. **Area:** the setup's stock top inset by a **margin** (default 5 mm, at least the probe's radius plus 1 mm, so no point lands on an edge), in the setup's work coordinates.
2. **Grid:** **Columns × Rows** (default 5 × 4, each 3–30; the larger side of the stock gets more points) or **Spacing** (one value, the counts follow); the dialog shows the spacing, the count and a time estimate (each point: the move, the probe at the seek feed, the retract).
3. **Probe settings:** the probe kind from Machine settings (any kind; the text says the clip needs a conductive top, aluminium or a foil, and that wood or MDF needs a 3D probe, Q220), **Clearance** between points (default 2 mm, the probe's `retract`), **Search depth** (default 5 mm below the last contact, 25 mm for the first point).
4. **Workholding:** each point's path (the move at the travel height and the probe to its full depth) goes through the [workholding guard](run-workholding.md#the-guard); a point whose path comes within the margin of an item is **skipped** (listed: "3 points skipped under Toe clamp 1"). With the guard off (not homed, no G54, no items) no point is skipped.
5. **Probe check:** the Map button waits for the [probe check](run-probing.md#probe-check-df143) like every probing action, and shows the probe input beside it.
6. **Map:** the user puts the bit above the first point (front left; the dialog says where) within the search depth of the top. **Map surface** starts `run.machine.surfaceMap` (a job; the dialog is the confirmation; a real machine's map is confirmed once more as a probe cycle). Points go in **serpentine order** (row by row, alternating direction) so each move is one cell.

Per point (`probeSurfacePoint`, `src/core/run/surface-probe.ts`): up to the travel height if lower (a rapid along Z only: the travelled path), then across to the point at the travel height with **`G38.3`** (an unexpected contact stops it without an alarm: the map stops, "The probe touched something on the way to point 7…"), then **`G38.2` down** through the shared runner (the seek, one slow re-probe at 1 mm back-off, the retract by the clearance). The **travel height** is the job's start Z for the first point, then the last contact plus the clearance. The search depth is cut by the travel's bottom (the runner's travel rule); RV11 adds the bed as the floor.

- **A failed point** (no contact: `ALARM:5`, recovered by the runner; an unexpected contact; an error) stops the map and **keeps the measured points**: the dialog shows the partial map with the failed point marked and **Retry from there** (it probes the missing points only, in the same order). A partial map is saved but cannot be followed.
- **Stop** (the footer's Stop or the dialog's Stop map) is the job's abort (feed hold and reset); the points measured so far are kept as after a failure.
- The heat map ([below](#heat-map)) fills point by point while the job runs.

### Skipped points

A skipped point's height is **filled** from its measured neighbours (the mean of the measured or already filled points among its eight neighbours, repeated until every skipped point has a value) when the map is used; the heat map shows them hatched with "filled". A map whose points are all skipped cannot be used. The program does not cut under a clamp anyway (the export's workholding check refuses it), so a filled point only shapes the cells next to it.

### Heat map

The map as a grid of cells coloured from the lowest (cool) to the highest (warm) point, with the min, the max and the **range** in the project unit, the probed count ("18 of 20 points"), the date and the probe kind. The colours are the data-viz sequential ramp (not the accent); each cell has its value as a title and the grid is a `role="img"` with a text alternative (min, max, range, points). A range over the follow limit is marked with the refusal's text.

## Following the map

The run pre-flight shows **Follow the surface map** (a checkbox, **off by default**, per pre-flight) when the setup has a map, with the map's date, range, point count and the largest |dz| the program gets. Ticked, `run.job.check` and `run.job.start` take the map (`surfaceMap`), and the run's program is the plan's program exported with it (`ExportInput.heightMap`, as a resume uses `resumeFrom`). The soft-limit and work-area checks run on the compensated program. **Plan programs only** (Q227): an external gCode file never gets the box (a file DFYOM did not write cannot be re-exported).

The compensation (`applyHeightMap`, in the export between the blocks and the post):

1. **Which moves:** every move with an end below the **clearance height** (the setup's links plane) in the setup frame. Moves with both ends at or above it, the clearance moves themselves and the tool-change moves are written as they are: **a rapid above the safe height is never lowered** (nor raised).
2. **Arcs** among them are linearised: chords of at most 0.002 mm sagitta, helices with Z along the sweep.
3. **Splitting:** each such line (feed or rapid) is split into equal segments no longer, in X/Y, than the **max segment**: half the smaller spacing, at most 2 mm (Q227). Vertical moves stay one segment.
4. **The offset** at each segment end: `dz(x, y) = h(x, y) − h(x₀, y₀)`, where `h` is the bilinear map and (x₀, y₀) the **touch-off spot** of the move's tool run ([z-reference.md](z-reference.md#touch-off-spot)): the Z0 the operator sets there stays exact, and every other point moves with the surface around it. A point below the clearance gets `z + dz`; the interpolated Z between a clearance point and a cut point is offset like any other below the clearance.
5. **Beyond the grid:** the grid sits a margin inside the stock, but profiles and facings reach past it, so up to **one cell** (one spacing) outside the grid the map is extrapolated linearly from its edge cell (exact for a tilt); further out is refused.

The export's result carries what the pre-flight shows: the max |dz|, the range, and the number of moves split.

### Refusals

`run.surfaceMap` (an error with one issue; the pre-flight shows its message instead of the soft-limit result, Start run stays disabled until the box is unticked or the cause fixed):

| Rule         | When                                                                                            | Message (shortened)                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `incomplete` | A point (not skipped) has no height                                                             | "The map is incomplete (12 of 20 points): Retry from there or map again."               |
| `zero`       | The live G54 X or Y differs from the map's by more than 0.01 mm, or the map is of another setup | "The work zero moved since the map was taken: map the surface again."                   |
| `range`      | The map's range exceeds the **follow limit** (app setting, default 1 mm, 0.1–5 mm)              | "The surface varies by 1.42 mm, more than the 1.00 mm limit: check the stock or raise…" |
| `outside`    | A compensated move lies more than one cell outside the grid                                     | "The program leaves the mapped area at X 120.0 Y 3.0: map a larger area."               |
| `anchor`     | A tool run's touch-off spot is more than one cell outside the grid, or the run has none         | "The touch-off spot X 150 Y 40 is outside the map."                                     |
| `clearance`  | The largest dz reaches the clearance height (links would be at or below the surface)            | "The surface rises 6.0 mm above Z0 here, above the clearance height."                   |

**Follow limit** (`surfaceMapMaxRange`, Settings › Run): a range over it is refused rather than compensated, because a large range usually means a mis-probe (a chip, a missed contact), a loose stock, or stock too warped to hold; the plan's "warn over 3 mm" became this refusal with a lower default (the user raises it deliberately).

**Decided:** the export's workholding check runs on the plan's moves, before compensation; a compensated move differs from them by at most the follow limit in Z (1 mm by default), below the guard's margin (2 mm).

## Virtual machine

The virtual operator's stock surface: when a map is probed on the virtual machine, the host lays a **tilted height field** over the stock top (the probe scene's `heightField`, [grbl.md § Probe scene](../architecture/grbl.md#probe-scene-rv3)) at the work Z0 of the live G54 (or the virtual stock's top), tilted `VIRTUAL_TILT` = 0.004 in X and −0.002 in Y (about 0.4 mm over 100 mm), so the map shows a range and the compensation does something visible. It is taken away after the job, like the plate.

## Not here

The **bed map** (RV11: per machine, in machine coordinates, the floor for every probe), compensation of external gCode files (Q227 (2)), compensation in the sender, an agent tool (Q229: `run.machine.surfaceMap` is UI only; `run.job.start` takes `surfaceMap` from any source like its other arguments, so an agent on the virtual machine can follow a map it was given).

## Implementation (RV10)

- **Core:** `src/core/post/height-map.ts` (`HeightMap`, `checkHeightMap`, `filledHeights`, `mapHeight`, `applyHeightMap`, `maxSegmentOf`, `HEIGHT_MAP_DEFAULTS`); `ExportInput.heightMap` and `GrblExport.surface` in `src/core/post/export.ts`; `PlanExportOptions.heightMap` in `plan-export.ts`; `src/core/run/surface-probe.ts` (`surfaceGrid`, `probeSurfacePoint`, `mapEstimateSeconds`); the job `run.machine.surfaceMap` and the host action `surfacePoint` (`src/core/run/commands.ts`, `host.ts`); `surfaceMap` on `run.job.start`/`run.job.check` (`job.ts`, the zero check `surfaceMapZero`).
- **Renderer:** `SurfaceMapDialog.tsx` (+ test with axe), `SurfaceHeatMap.tsx`, the navigator button, `surfaceMapOpen` in the run store, the pre-flight checkbox in `RunDialogs.tsx`; settings `surfaceMaps` and `surfaceMapMaxRange` (`src/shared/settings.ts`).
- **Tests:** `height-map.test.ts` (interpolation, extrapolation, filling, segment length, arcs linearised, rapids above the clearance untouched, `dz = 0` at the touch-off spot, every refusal, a golden `__golden__/height-map-engraving.nc`), `surface-probe.test.ts` (a grid on the emulator's tilted height field within 0.005 mm, a failed point keeps the others, an unexpected contact, the serpentine order), `surface-follow.test.ts` (the oracle: a compensated engraving streamed on the emulator over a tilted height field keeps its depth below the real surface within 0.02 mm, checked on the trace), `SurfaceMapDialog.test.tsx`, `e2e/run-surface.e2e.ts` (hidden: map on the virtual machine → follow → the run ends; the streamed Z varies).
- **Waits for the user:** a map on the user's real stock (a conductive top or a 3D probe, Q220).
