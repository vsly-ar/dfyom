# Safe links: minimum retraction over the in-process stock

Status: accepted, L1–L2 implemented ([Implementation notes](#implementation-notes-l1l2); proposed 2026-11-24 for hardening [DF64](../plans/hardening.md); the user answered [Q94–Q105](#open-questions-for-the-user) on 2026-11-24, "q94-105 ok", every recommendation taken) · Source: the user's real cut, TG #242 ("retracting to safe-Z and traveling at it between operations is unoptimized – we know the exact geometry of the part below at any point in time, plus clamping/workholding"), and TG #244 (retracts hit the Z+ limit, [DF68](../architecture/grbl.md#z-headroom-hardening-df68)) · Base: [plan-v0.1.md § Safe heights](plan-v0.1.md#setup-orientation-work-zero-safe-heights), [plan-v0.1.md § Toolpath generators](plan-v0.1.md#toolpath-generators-task-210) (common rules), [grbl.md § Output dialect](../architecture/grbl.md#output-dialect), [grbl.md § Virtual machine](../architecture/grbl.md#virtual-machine-task-38), [plan-v0.2.md § Material left for later cuts (DF61)](plan-v0.2.md#material-left-for-later-cuts-df61), [plan-v0.2.md § Tool reach past the stock and clamps (DF59)](plan-v0.2.md#tool-reach-past-the-stock-and-clamps-hardening-df59-interim) · Related drafts: [workholding.md](workholding.md) (WH-C hops, Q37–Q40 open), [deviation.md](deviation.md) (DV-E: the heightmap simulation in production) · Terms: [glossary.md](../glossary.md)

Every toolpath starts with a horizontal rapid at the clearance height and ends with a rapid up to it ([common rules](plan-v0.1.md#toolpath-generators-task-210)), so between two operations the tool always climbs to the clearance height, crosses there and comes all the way down again, however low the material between them is. This doc replaces those links with the **lowest safe link** over the **in-process stock** of the setup (the material that is really left when the link runs), without a workholding model: low links fly only where the setup's own program proves that no clamp can stand, or where the user states the clamp height. Tool changes, pauses and the program's start and end stay at the clearance height.

## Decisions

Proposed; settled by [Q94–Q105](#open-questions-for-the-user).

| Id   | Decision                                                                                                                                                                                                                                                                                      | Section                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| SL-A | A **link** is the travel between two consecutive toolpaths of one tool run in a setup with no pause between them. Tool changes, any `M0` pause, the first move of the program and of a tool run, and the end stay at the clearance height, as today.                                          | [What changes](#what-changes)                                               |
| SL-B | Links are a **post-pass over the setup's ordered toolpaths** (`planLinks`), after generation: generators, their properties and the per-operation toolpath cache are unchanged.                                                                                                                | [Where it runs](#where-it-runs)                                             |
| SL-C | The **in-process stock height field** of the setup: a conservative 0.5 mm grid holding, per cell, an upper bound of the material's top, starting flat at Z0 and lowered by every feed move of the setup's earlier toolpaths with the tool's real profile. Kerfs of through cuts stay at Z0.   | [In-process stock height field](#in-process-stock-height-field)             |
| SL-D | One **lowest safe level** per link: up at the exit, across at that level, down at the entry. Level = the field's maximum under the tool's corridor + the vertical margin, at least the entry's Z, at most the clearance height. No diagonal rapids, no detours.                               | [Link profile](#link-profile)                                               |
| SL-E | **Clamps without a workholding model:** low links only over the setup's **cleared footprint** (where its program takes the tool below the stock top), elsewhere over the optional per-setup **clamp height**, else at the clearance height. Workholding items replace the clamp height later. | [Clamps](#clamps)                                                           |
| SL-F | Setup field **`retraction: 'minimum' \| 'full'`** (default `minimum`) and optional **`clampHeight`**; no other new fields (margins come from the retract height).                                                                                                                             | [Agent API and settings](#agent-api-and-settings)                           |
| SL-G | **Verification:** an export guard re-checks every rapid against the field; tests stream every program through the virtual machine and check every executed rapid against an independent stock simulation; seeded property tests.                                                              | [Verification on the virtual machine](#verification-on-the-virtual-machine) |
| SL-H | **Phase 2** applies the same field inside operations (retract-plane rapids and plunges through air), where long pocketing programs lose more time than between operations; after phase 1 has run on the real machine.                                                                         | [Phase 2: links inside an operation](#phase-2-links-inside-an-operation)    |

## Problem

Measured on the user's exported programs and the exit-criteria goldens with a throwaway script, [`scripts/measure-links.mjs`](../../scripts/measure-links.mjs) (it reads the gCode, not the plan: flat tool discs, stock flat at Z0, a 0.5 mm grid). Timing as GRBL plans rapids, per-axis rate and acceleration, rest to rest per chain of rapids (collinear legs merged), with the user's 3020 machine (X/Y 3000 mm/min and 150 mm/s², **Z 1000 mm/min** and 100 mm/s²); feed moves at their `F` without acceleration, so program times are approximate. Vertical margin 2 mm (the retract height), radial margin 1 mm.

**Links between operations** (excursions to the clearance height that are not tool changes, start or end):

| Program (clearance)                                  | Approx. time | Links | At clearance today | Lowest over the stock (no clamps) | Cleared footprint only (SL-E, no clamp height) | Clamp height 12 mm | Clamp height 0 |
| ---------------------------------------------------- | ------------ | ----- | ------------------ | --------------------------------- | ---------------------------------------------- | ------------------ | -------------- |
| User's enclosure, Setup 2 – top (20 mm)              | 72.4 min     | 6     | 25.7 s, Z 232 mm   | 11.7 s, Z 16 mm                   | 25.7 s (nothing lowered)                       | 21.4 s             | 11.7 s         |
| User's enclosure, Setup 1 – underside (20 mm)        | 15.3 min     | 8     | 42.0 s, Z 430 mm   | 16.4 s, Z 27 mm                   | 19.6 s                                         | 18.9 s             | 17.5 s         |
| Exit-criteria lid (10 mm)                            | 5.2 min      | 25    | 77.9 s, Z 612 mm   | 50.7 s, Z 212 mm                  | 76.8 s                                         | (above clearance)  | 50.7 s         |
| Exit-criteria enclosure 3 – top (10 mm)              | 16.1 min     | 2     | 10.6 s             | 8.2 s                             | 9.3 s                                          | (above clearance)  | –              |
| Exit-criteria bracket, shapes, enclosure 1–2 (10 mm) | 0.4–19.9 min | 0–3   | 0–13.2 s           | saves 1–3.4 s each                | –                                              | –                  | –              |

**Rapids inside an operation** (on the retract plane, with the plunge at the plunge rate from there down to the previous level, e.g. a pocket's re-entry at every level), measured the same way with the field updated move by move:

| Program                      | Rapids | Today             | Over the field    |
| ---------------------------- | ------ | ----------------- | ----------------- |
| User's Setup 2 (cavity)      | 82     | 265 s, Z 2 882 mm | 174 s, Z 1 376 mm |
| User's Setup 1               | 17     | 42.6 s            | 41.1 s            |
| Exit-criteria bracket        | 28     | 141.9 s           | 122.2 s           |
| Exit-criteria lid            | 41     | 82.1 s            | 65.6 s            |
| Exit-criteria shapes 2 – top | 15     | 71.1 s            | 46.0 s            |

What this says:

- **The time gain is real but modest.** On the user's two programs (≈ 88 min) links between operations cost 68 s; minimum retraction saves 22–40 s of it (depending on what is known about the clamps) and cuts their Z travel from 662 mm to 43 mm (nothing above the stock top) or 310 mm (cleared footprint only). Inside operations another ≈ 90 s (Setup 2's cavity: 49 rapids on the retract plane, each climbing back from the level just cut and plunging 2 mm + the depth at the plunge rate). Together ≈ 2 min, 2.5 %. Programs with many short operations (the lid: 25 links in 5 min) gain up to 9 % between operations alone. The radial margin matters inside operations: with 0 instead of 1 mm the cavity's rapids drop to 115 s, since the roughing rings run within 1 mm of the walls.
- **Without knowing the clamps, the gain between operations mostly vanishes** for the top setup: its links cross uncut stock top where a toe clamp may sit (the user clamps "on the X ends"). The underside gains anyway, because its links run inside the relief it cleared. Hence the clamp height ([Clamps](#clamps)).
- **The Z+ limit** (DF68) is not fixed by this: tool changes, the start and the end still go to the clearance height. Minimum retraction removes Setup 2's 6 climbs between operations (its 4 tool changes, the start and the end remain) and makes a generous clearance height cost nothing between operations.

## What changes

- **Links** between consecutive toolpaths of one tool run: today the end of toolpath _i_ (rapid up to clearance), the horizontal rapid at clearance and the descent of toolpath _i_ + 1 from clearance to its first working Z. They become one [link](#link-profile) from the **exit** (the last point of toolpath _i_ below the clearance height) to the **entry** (where toolpath _i_ + 1's first run of vertical rapids ends, usually its retract plane; a toolpath that feeds straight down from clearance has its entry at clearance, so that end stays high).
- **Stay at the clearance height:** the header's retract and the first toolpath's start; every tool change (retract, the rapid to the touch-off spot of [DF69](z-reference.md#exported-gcode), `M0`, the retract after it and the next toolpath's start from clearance, since the user re-zeroed Z and the post forgot the position); any other pause between two toolpaths (a manual spindle's "Set spindle to N rpm" `M0`: the operator reaches in); the footer. A spindle speed change without a pause (`M3 S…` and its dwell) is not a pause: the link stays low and the speed changes at its end, before the entry's descent.
- **Inside an operation** nothing changes in phase 1 ([phase 2](#phase-2-links-inside-an-operation)).
- **The cut does not change:** links remove nothing (the field guarantees it), so the heightmap after the setup is identical with `minimum` and `full` ([property 4](#verification-on-the-virtual-machine)).

## In-process stock height field

The **in-process stock** of a setup at a given time is the material left after the moves before it. For links an **upper bound of its top** per cell is enough (`StockHeights`, `src/core/toolpath/stock-heights.ts`): a link above it by the margin clears the real material.

- **Grid:** cells of 0.5 mm (`STOCK_CELL`), anchored at the setup's WCS origin (not at bounds, so an edit elsewhere never shifts cells), over the stock rectangle as it sits in the setup plus the tool's largest reach past it ([DF59 overreach](plan-v0.2.md#tool-reach-past-the-stock-and-clamps-hardening-df59-interim)). Outside the stock rectangle there is no material (−∞); the [clamp rule](#clamps) decides there. A 250 × 100 mm stock is 100 000 cells (0.8 MB as float64).
- **Start:** Z0 (the stock top in the setup's frame) everywhere inside the rectangle. Earlier setups only remove material (a facing of the same direction, through openings), so ignoring them is safe; using them is [later](#not-covered) ([Q104](#open-questions-for-the-user)).
- **Update:** every feed move, arc and drill cycle (`expandDrill`) of the setup's earlier toolpaths, in machining order, lowers the cells under it to the tool's lower envelope with the tool's **real profile** (flat, bull-nose, ball, drill point, chamfer cone from `ToolpathTool`). **Conservative rasterisation:** a cell is lowered only to the highest point of the tool's envelope anywhere over the cell (not at its centre), so a cell the tool covers only partly keeps its material. Rapids lower nothing.
- **Through cuts:** cells where a move reaches the setup's through depth (a through profile's kerf, a through hole) keep Z0: the piece it frees (a slug, the offcut, the part on its tabs) may shift, tilt or lift, so the kerf is not open air for a rapid ([Q99](#open-questions-for-the-user)).
- **Same code as the simulated cut:** [deviation.md](deviation.md) (DV-E) promotes the test oracle `Heightmap` (`src/core/toolpath/testing/oracles.ts`) to production code; this field is that heightmap in an **upper-bound mode** (the conservative rasterisation above), so the two never disagree about tool shapes. The test oracle itself stays separate, for [verification](#verification-on-the-virtual-machine).
- **Frame:** the setup frame (stock top Z0, toolpath coordinates). A tool run touching off on another surface ([DF69](z-reference.md#exported-gcode)) has its Z words shifted by the post afterwards, links included, like every other move.
- **Relation to DF61:** the material bands stay as they are (they decide which passes a generator writes); the field could later replace them (in-process stock for generation, [plan.md § Simulation](plan.md#simulation--prediction)), not in DF64.

## Clamps

No workholding model exists yet ([workholding.md](workholding.md), draft, Q37–Q40 open), and the DF59 interim note tells the operator: "Keep clamps below clearance Z h" ([grbl.md § Setup header](../architecture/grbl.md#setup-header-hardening-df58)). Links must keep that promise.

- **Cleared footprint** (`clearedFootprint`): every cell the tool's disc (radius R of the tool cutting there) covers at any feed move below the stock top, anywhere in **this setup's whole program** (earlier and later toolpaths). Clamps do not move within a setup ([WH-G](workholding.md#decisions)), and a clamp there would be hit by that cut, whose tool and shank fill the column above the tip. So low links over the cleared footprint cannot hit a clamp the program would not hit anyway. (Strictly: the column is clear up to the tip + the stickout; a link is at most the clearance height, which is below that unless the stickout is shorter than the clearance height + the cut's depth, then the cleared footprint does not count there.)
- **Outside the cleared footprint** (uncut stock top, outside the stock): workholding is unknown, so the link goes at the clearance height, as today and as the header note says.
- **Clamp height** (optional setup field `clampHeight`, from the stock top, ≥ 0): the user states how far anything that holds the stock rises above the stock top. Outside the cleared footprint the floor for links is then `clampHeight` everywhere (over the stock top too: toe clamps sit on its edges), so the level there is max(field, `clampHeight`) + margin. `0` means nothing rises above the stock top (vise jaws at or below it, double-sided tape, countersunk screws, vacuum): links fly over the uncut stock 2 mm above it. A `clampHeight` + margin at or above the clearance height changes nothing for links; it raises DF59's remaining warning instead ([Q96](#open-questions-for-the-user)).
- **Header:** without `clampHeight` the DF59 line stays. With it, the line becomes `Keep clamps below Z <clampHeight> <unit>: links pass <margin> above them` (the clearance line for tool changes stays).
- **With workholding (W1):** the obstacle prisms ([workholding.md § Obstacles](workholding.md#obstacles)) replace `clampHeight` as the floor outside the cleared footprint (over each item's keep-out zone its top + margin, elsewhere the field), and WH-C's hops become this pass ([workholding.md § Links and safe heights](workholding.md#links-and-safe-heights)). `clampHeight` stays as the fallback for a setup without items.

## Link profile

- **Corridor:** the cells under the tool's disc grown by the **radial margin** (1 mm, `LINK_RADIAL_MARGIN`) along the straight XY path from exit to entry, without the cells under the tool at either end (the tool stands at the exit, and the entry's column is the generator's own descent through air, so the radial margin applies only on the way).
- **Level:** z = max(field over the corridor, and the clamp floor where the corridor leaves the cleared footprint) + the **vertical margin** (the setup's `retractHeight`, default 2 mm: the same promise as a retract plane above its surface), then at least the entry's Z and at most the clearance height, rounded **up** to 0.1 mm (stable goldens). When the level equals the entry's Z the link is a rapid on the next operation's retract plane (the "direct" case: 19 of the lid's 25 links when nothing rises above the stock top).
- **Moves:** `G0` straight up at the exit to z (skipped when the exit is already there), `G0` across, `G0` straight down to the entry's Z. These are the only rapid shapes DFYOM writes today (vertical or horizontal).
- **Why one level:** with rapids that stop at every corner (GRBL decelerates to almost zero at a 90° junction with `$11` = 0.01), the Z travel of any up-and-over staircase is the same as of its peak, so one level at the corridor's peak is the fastest axis-aligned link. A **diagonal** `G0` (GRBL interpolates rapids linearly, so it is exact) or an **XY detour** round a boss would be faster and are [later](#not-covered) ([Q100](#open-questions-for-the-user)).
- **`retraction: 'full'`:** links at the clearance height, byte-identical to today's program.

## Where it runs

- **Post-pass:** `planLinks(setup, toolpaths, tools, stock, settings) → SetupLinks` (`src/core/toolpath/links.ts`), a pure function over the setup's ordered, current toolpaths: pass 1 builds the cleared footprint from the whole program; pass 2 walks the toolpaths in order, computes each link from the field, then stamps the toolpath into it. Toolpaths and their cache keys are unchanged; the result is cached per setup by the chain of toolpath hashes and the setup's link settings.
- **Program:** the export ([`plan-export.ts`](../../src/core/post/plan-export.ts) → `ExportInput`) trims each toolpath's clearance excursions at a link and inserts the link's rapids between them; `MachiningProgram` and the post are unchanged (they already write any `rapid` block; the post's `clearance` rule still holds, every Z ≤ clearance).
- **Stats:** the setup's time and the export stats use the linked program (`plan_get`'s setup summary, the setup inspector); per-operation stats stay per toolpath.
- **Preview:** the plan scene draws the links between operations as rapids (phase L3); until then it shows the toolpaths as generated.
- **Phase 2** runs in the same pass (move by move instead of toolpath by toolpath).

## Phase 2: links inside an operation

Inside an operation rapids run on the retract plane (`on` + `retractHeight`, [common rules](plan-v0.1.md#toolpath-generators-task-210)), and pockets and profiles plunge at the plunge rate from there to the previous level. In the user's Setup 2 cavity this costs 265 s of 72 min; over the field it would be 174 s ([Problem](#problem)).

- The same pass rewrites a **rapid excursion inside a toolpath** (rapid up, across, rapid or plunge down) as a link over the field updated move by move, and a **plunge through known air** as a rapid to the field + margin, then the plunge at the plunge rate from there. Peck retracts and the rapids of a drill cycle are not touched.
- The generators' property "rapids only on the retract plane" (`testing/rules.ts`) stays for generator output; the linked program is checked by [the link properties](#verification-on-the-virtual-machine) instead.
- With workholding this is where WH-C's hops over clamps live.
- After phase 1 has run on the real machine ([Q94](#open-questions-for-the-user)).

## Determinism and goldens

- `planLinks` is pure and deterministic: float64 in a fixed order (toolpath order, then move order, then cells row by row), squared distances instead of `Math.hypot` in the grid code, levels rounded up to 0.1 mm, no time or randomness. The same plan gives the same file, as [grbl.md § Determinism](../architecture/grbl.md#determinism-and-tests) requires.
- Every golden program with two or more operations in one tool run changes once (the exit-criteria bracket, lid, enclosure and shapes goldens, `multi-tool*.nc`); the change is reviewed in the diff: only link lines move, cut lines are identical (a test asserts the feed moves of `minimum` and `full` are the same lines).
- `retraction: 'full'` reproduces today's goldens byte for byte (a test keeps one golden per generator in `full`).

## Verification on the virtual machine

Every rapid of every program is checked against material, three ways:

1. **Export guard (in the app):** `plan.export` re-runs the corridor check of every rapid of the final program (links, and in phase 2 the rewritten rapids) against the field at that time; a rapid below the field + margin − 1 µm is the error `plan.links.collision` (blocks the export; it can only be a bug). Cheap: the field already exists.
2. **Replay through the virtual machine (tests, independent):** `replayRapids(program, stock, tools)` streams the exported text through `GrblSender` and the [virtual machine](../architecture/grbl.md#virtual-machine-task-38) as `emulator-run.test.ts` does (tool-change markers answered by re-zeroing Z at the same G54), takes every executed line's start and end from the emulator's [trace](../architecture/grbl.md#observability-for-tests) (so units, modal state, DF69 shifts and arcs as GRBL executes them), keeps an **independent** stock simulation (the test oracle `Heightmap` at 0.1 mm with exact tool profiles, lowered by every executed feed line) and asserts for every executed `G0`: the tool (its disc, from the tip up) never enters material (strict collision), its clearance over material is ≥ the vertical margin − one oracle cell, it is never above the clearance height, and below the clearance height it leaves the cleared footprint only with a `clampHeight` and then stays above it + margin. No `error:`, no alarm, the run's duration in virtual time ≤ the `full` program's.
3. **Property tests (seeded, `{ timeout: 60_000 }`):** 40 random setups from the region corpus ([plan-v0.3.md § Tests](plan-v0.3.md#tests): random pockets with islands, profiles, holes, chamfers, a facing; random order, tools, heights, margins, `clampHeight` or none), each replayed as in 2, plus:
   1. every link starts at its exit and ends at its entry, Z within [entry Z, clearance], rapids vertical or horizontal only;
   2. tool changes, pauses, start and end at the clearance height (the moves around every marker equal `full`'s);
   3. a link outside the cleared footprint without `clampHeight` is at the clearance height;
   4. the cut is unchanged: the oracle heightmap after `minimum` equals `full`'s cell by cell, and the feed lines are identical;
   5. never slower: the linked program's estimated time ≤ `full`'s, link by link;
   6. deterministic: two runs give the same bytes; reordering two independent operations changes only links;
   7. **mutation:** lowering any one link by margin + 0.5 mm makes the replay check fail (the check is sensitive), and raising the field's cell size to 2 mm never lowers a link (conservative rasterisation).
4. **Fixtures:** the exit-criteria programs (bracket, lid, three enclosure setups, two shapes setups) and the geometry test part replayed in `minimum` with every check above, and a two-setup enclosure like the user's (the exit-criteria enclosure with its underside relief) with `clampHeight` none, 0 and 12.
5. **First real cut:** an air pass of one setup with Z0 set 30 mm above the stock before the real cut ([Q105](#open-questions-for-the-user)).

## Performance

- The measurement script needs 2.8 s in Node for Setup 2's 148 615 lines (≈ 370 000 chords, every one stamped, single thread, parsing included). Phase 1 needs the field only between toolpaths and stamps each toolpath once; target < 1 s per setup on the toolpath worker for that program, < 100 ms for the exit-criteria programs, measured by a `*.perf.ts` like `region-pocket.perf.ts`.
- Memory: one field and one footprint bitmap per setup (≈ 1 MB for 250 × 100 mm); no snapshots (links are computed during the walk).
- Runs only when the setup's toolpaths are current (as `overreach`), cached by their hashes, so editing an operation recomputes only that setup's links.

## Agent API and settings

| Where                   | Change                                                                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup record            | `retraction?: 'minimum' \| 'full'` (left out = `minimum`), `clampHeight?: Quantity` (length ≥ 0, from the stock top; left out = unknown). Optional fields, so no `schemaVersion` change.                                                              |
| `plan.setup.update`     | `retraction?`, `clampHeight?` (`null` clears it).                                                                                                                                                                                                     |
| `plan_get` / `plan.get` | Per setup `links: { count, low, atClearance, seconds, savedSeconds }` (`null` until every toolpath of the setup is current, like `overreach`).                                                                                                        |
| Findings                | Info `plan.links.clampHeightUnknown` (per setup, when links stayed at the clearance height only because they cross outside the cleared footprint: "Enter the clamp height to lower 4 links, about 6 s"); error `plan.links.collision` (export guard). |
| `plan.export`           | Stats include link time; the header line of [Clamps](#clamps).                                                                                                                                                                                        |
| UI                      | Setup inspector: "Links: minimum / full" and "Clamp height" beside the clearance field (DF59's clamp note moves there), the saved time as a fact. Plan scene: links drawn as rapids (L3).                                                             |

## Implementation notes (L1–L2)

Implemented 2026-11-24 as specified above, with these decisions where the text left room:

- **Code:** `StockHeights` (`src/core/toolpath/stock-heights.ts`: the field and the clamp floor, `toolSurface` shared with the oracle), `planLinks` (`src/core/toolpath/links.ts`), the setup glue and cache (`src/core/plan/setup-links.ts`), the export (`src/core/post/plan-export.ts`, the links module stays separate from the post). The post is unchanged but for the [header line](../architecture/grbl.md#setup-header-hardening-df58).
- **Field stamping:** a cell is lowered only when its farthest corner is within the tool's reach of the move (exact for level pieces); sloped moves are split into pieces of at most 0.1 mm Z and stamped at each piece's highest Z, arcs become chords with a sagitta ≤ 0.01 mm (added to the distance), plunges and drill cycles stamp at their lowest Z. A move reaching the through depth pins the cells it lowers to Z0 (drilled through holes too).
- **Cleared footprint as a clamp floor:** pass 1 marks the cells a feed move below the stock top covers wholly (the same conservative stamping), except moves whose tool stickout is known and shorter than the clearance height + the depth there (the stickout rule of [Clamps](#clamps)).
- **End cells:** the cells wholly under the tool at the exit and at the entry need only their material (the tool stands there, and the full program climbs the same columns); the ring between the tool's radius and the radial margin around the ends counts as corridor, so a link from an exit at a wall, whose ring reaches uncut stock top, needs the clamp height.
- **Level:** also at least the exit's Z (never a rapid down from the exit). A link whose level reaches the clearance height leaves the toolpaths as generated (`full`'s bytes). The up and across moves end the earlier toolpath, the descent starts the later one, so a spindle speed change (`M3 S…`) comes before the descent.
- **Pauses:** a tool change, or a spindle speed change on a manual spindle (its `M0`), means no link.
- **Link times** for the summary: per leg the slowest axis at its maximum rate (no acceleration), like the toolpath stats.
- **`plan_get` summary:** `plan.warning.list` returns `links: [{ setupId, links }]` (every registry command is already an agent tool, so no new tool, ≈ 0 tokens of the [budget](../architecture/llm-api.md)); `plan_get`'s setup summary adds `retraction`, `clampHeight`, `links`, and subtracts `savedSeconds` from the setup's time.
- **Findings:** info `plan.links.clampHeightUnknown` (field `setup.clampHeight`) and DF59's remaining warning as a `plan.check` with rule `clampsAboveClearance` (field `setup.clearanceHeight`) when the clearance height is below the clamp height + the retract height. `plan.links.collision` is an error code (`ERROR_CODES`): the export guard re-checks the written link rapids (vertical or horizontal, at most the clearance height, across at or above the corridor's need) and blocks; it means a bug, and the message says to export with full retraction.
- **Cache:** the links are cached per setup by the chain of input hashes and the link settings; `retraction` and `clampHeight` are left out of the toolpath input hash, so editing them never regenerates toolpaths.
- **Air pass ([Q105](#open-questions-for-the-user)):** `plan.export` returns `linksNote` when a link runs low; the export dialog shows it.
- **Goldens:** only the exit-criteria bracket changed: after Drilling 1 and 2 the drill crosses at Z 2.5 instead of 10.5 (Z 2 in the setup frame, the tool run touches off on the Facing 1 floor 0.5 below the stock top; 2 = the through holes' pinned kerfs at Z0 + the 2 mm margin). The lid's 25 links, the enclosure top's 2 and the shapes' stay at the clearance height: they cross uncut stock top or start at walls whose ring leaves the cleared footprint, and the goldens have no clamp height ([Problem](#problem): "without knowing the clamps, the gain mostly vanishes"). `full` reproduces every golden byte for byte; the post goldens (`multi-tool*.nc`) never run links.
- **Tests:** `links.test.ts` (field, `planLinks`), `post/links.test.ts` and `post/links-seeded-{a,b}.test.ts` (40 seeded random setups, the geometry test part, an enclosure-like setup with clamp height none, 0 and 12: every program replayed through GrblSender and the virtual machine by `links-replay.fixture.ts`, properties 1–7 and the mutation test), `plan/setup-links.test.ts` (commands, findings, export).
- **Performance** (`links.perf.ts`, `npm run perf`): a 250 × 100 mm setup of 77 000 moves (25 operations, 24 links) 0.26 s; the geometry test part 13 ms.
- **Not yet:** the exit-criteria fixtures are replayed byte for byte (goldens), not through the replay oracle; L3 (links in the plan scene and the run's time estimate) and L4.

## Phases

| Phase | Content                                                                                                                                         | Needs             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| L1    | Field (DV-E heightmap in upper-bound mode), cleared footprint, `planLinks` between toolpaths, export, guard, replay and property tests, goldens | Q94–Q100, Q104    |
| L2    | `retraction`, `clampHeight`, header line, `plan_get` summary, findings, setup inspector                                                         | Q96, Q97, Q103    |
| L3    | Links in the plan scene and the run scene's time estimate                                                                                       | L1                |
| L4    | Phase 2 inside operations; WH-C hops share it when workholding lands                                                                            | L1 on the machine |

## Not covered

- Diagonal rapids, XY detours round obstacles, arcs in links.
- In-process stock across setups (the field starts flat at Z0 for every setup) and for generation (DF61 bands stay).
- The tool holder and collet nut (the tool counts as a disc from the tip up; WH-F's holder model later).
- The Z+ limit itself: [DF68](../architecture/grbl.md#z-headroom-hardening-df68) (tool changes, start and end still go to the clearance height).
- Resume from a line (machine lane): it must start at the clearance height, not assume a toolpath start there.

## Open questions for the user

1. **Q94 – Scope.** Phase 1 (between operations, L1–L3) now; phase 2 (rapids and air plunges inside operations, where the cavity loses ≈ 90 s) after phase 1 has cut on the real machine. _Recommendation:_ yes, both under DF64, phase 2 as L4.
2. **Q95 – Clamps without the workholding model.** Low links only over the setup's cleared footprint; elsewhere at the clearance height unless a clamp height is entered. _Recommendation:_ yes (the only rule that needs no promise from the operator; the underside keeps most of its gain, the top setup needs Q96).
3. **Q96 – Clamp height field.** Optional per setup `clampHeight` from the stock top (0 = nothing above the stock top), the floor for links everywhere outside the cleared footprint, including the stock top; it also gives DF59's remaining "clearance below clamp height" warning its value. _Recommendation:_ yes, per setup (clamps change between setups), no machine default.
4. **Q97 – Default and name.** `retraction: 'minimum' | 'full'` (the industry's retraction policy), default `minimum` for new and existing setups, `full` as the opt-out. _Recommendation:_ yes (instead of `links: 'safe' | 'clearance'`).
5. **Q98 – Margins.** Vertical margin = the setup's retract height (2 mm), radial margin 1 mm fixed, no new fields. _Recommendation:_ yes (0.5 mm measures the same; 0 would let rapids graze the walls the roughing rings left).
6. **Q99 – Loose pieces.** Kerfs of through cuts count at the stock top for links (the freed slug, offcut or tabbed part may move). _Recommendation:_ yes.
7. **Q100 – Rapid shapes.** Only vertical and horizontal rapids, one level per link; no diagonal `G0` (exact on GRBL, but harder to read and to check by eye) and no detours for now. _Recommendation:_ yes; revisit with numbers after L1.
8. **Q101 – Pauses and speed changes.** Any `M0` between two toolpaths (manual spindle speed) keeps the link at clearance; a speed change without a pause does not. _Recommendation:_ yes.
9. **Q102 – Export guard.** `plan.export` re-checks every rapid against the field and blocks on a hit; the independent oracle replay runs in tests only. _Recommendation:_ yes.
10. **Q103 – Header and inspector.** With a clamp height the header says `Keep clamps below Z h: links pass 2 mm above them`; the setup inspector shows the links setting, the clamp height and the saved time, and the info finding suggests entering the clamp height. _Recommendation:_ yes.
11. **Q104 – Earlier setups.** The field starts flat at Z0 in every setup, ignoring what earlier setups removed. _Recommendation:_ yes (always safe; in-process stock across setups comes with simulation).
12. **Q105 – First real cut.** The run guide for the first program with minimum retraction asks for an air pass (Z0 set 30 mm above the stock) of the setup before the real cut. _Recommendation:_ yes, once, then the virtual machine checks carry it.
