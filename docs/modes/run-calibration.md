# Run: calibration cuts

Status: accepted (v0.5 [RV9](../plans/v0.5-run.md#slices), delegation D88; Q221, Q222), implemented ([§ Implementation](#implementation)) · Plan: [v0.5-run.md § 2](../plans/v0.5-run.md#2-calibration-cuts-with-the-open-stock) · Rules: [run.md § Safety](run.md#safety) · Post: [grbl.md](../architecture/grbl.md#post-processor-task-211)

A calibration cut is a small test program DFYOM generates for the open plan's setup and cuts on a free spot of its stock, before the real part: the **dimension test** tells what the machine and tool really cut (tool Ø, X/Y scale, backlash, depth), the **feed ladder** which feed (or stepdown) cuts best. Results are suggestions the user applies; nothing changes by itself.

## The dialog

Run navigator → **Calibration cut…** (shown with a plan chosen, disabled while a job runs). An end-placed dialog:

- **Test:** Dimension test / Feed ladder, with one line saying what it measures.
- **Tool:** the setup's flat end mills with their milling feeds resolved (the first one by default; a select when there are several).
- **Centre X / Y** (WCS, project unit): filled with the suggested spot when the dialog opens, after **Suggest a free spot**, after a test or tool change and after each cut; the user may type any spot.
- **Size** (dimension test, default 15 mm, 6–50 mm and at least 2 × tool Ø), **Depth** (default min(2 mm, D/2), at most D and the flute length); **Spread ±%** (default 30, 5–60), **Steps** (default 5, 3–9) and **Vary** Feed / Stepdown (feed ladder).
- The check result, again 0.2 s after every change: "184 lines, about 53 s. Shown in the viewport.", each placement problem ("Overlaps Pocket 1: move the spot.", "Not on the stock top…", "Overlaps an earlier calibration cut…", a workholding finding), a soft-limit or work-area finding, or "Connect and home to check the soft limits and the work area."
- **Run calibration cut** (primary) is enabled only connected, homed, Idle, with a check that has no problem and no finding and checked the travel; its reason is its description. A real machine's cut is confirmed once ("Run the calibration cut": it first waits for the tool and its Z zero). While it runs: the progress, the app's tool-change and pause dialogs (and **Continue** in the dialog too), **Stop** in the footer.
- **Measured:** the last cut of the chosen test for this machine ("Last cut <date> with <tool>."): the dimension test's six readings (Pocket X/Y, Boss X/Y, Slot width, Depth; any subset), the ladder's **Best step** (a select: "Step 3: 1040 mm/min (+30 %)"). **Suggestions** follow the readings live; **Save results** keeps the readings or step and the suggestion text with the cut.

The viewport draws the checked program instead of the plan's while the dialog is open (as an external file's moves, [run.md § DF93](run.md#run-an-external-g-code-file-df93)); closing it draws the plan again.

## The programs

Generated in core (`src/core/run/calibration.ts`) from the existing generators, in the setup's WCS (Z0 = the stock top), with the tool's **resolved feeds** of the plan (presets adapted to the machine, DF139, and their power check, DF141) and the setup's clearance and retract heights. Every program begins with the tool change (`firstToolLoaded: false`): it always waits for the tool and its Z zero, whatever is in the spindle.

- **Dimension test** (left to right, `CALIBRATION_WALL` = 4 mm between features): a square **pocket** N × N (helix entry, corner radius = the tool radius, finishing allowance 0.2 mm, so the walls get a light finishing pass); a square **boss** N × N with sharp corners cut as an outside profile (finishing allowance 0.2 mm) in a groove `g` = max(D + 4, 1.5 D) wide (room for the caliper jaws, no tabs, ramp entry); a **slot** of the tool's width along Y, N long (zigzag ramp). Footprint: (N + 4 + N + 2g + 4 + D) × (N + 2g).
- **Feed ladder:** `steps` parallel slots along X, 20 mm long, D + 4 mm apart, each a zigzag ramp (≤ 3° per level, at the lower of the step's feed and the preset) then a flat full-depth pass at the step's feed. Factors evenly spaced over ±spread (5 steps at 30 %: 0.7, 0.85, 1, 1.15, 1.3). Feed varies: the step's feed is factor × the resolved feed, capped by the machine's max feed. Stepdown varies: each slot one pass at min(factor × base, D, flute length), base = min(stepdown, D/2, depth).
- The post is the plan's (`exportGrbl`); the setup line reads "Calibration: dimension test" or "Calibration: feed ladder". Goldens: `src/core/run/__golden__/calibration-*.nc`.

## Where it may cut

The footprint (every feed move below Z0, tool radius included, arcs with their bulge) must be:

1. **On the stock top,** 2 mm (`CALIBRATION_CLEARANCE`) inside its edges, in the setup's frame.
2. **Clear of every operation of the setup,** cut or not (a cut region has no material left to measure), by 2 mm: the reach of each operation's toolpath. A **facing** is not kept out of: it skims the whole top, and the test sits below it either way.
3. **Clear of earlier calibration cuts** on this plan (the saved footprints of this machine), by 2 mm.
4. **Clear of workholding:** the export's workholding guard on the program's moves (DF133); an error-level finding is a problem.
5. **Inside the soft limits and the work area** at the live G54 (`fileSoftLimits`, RV7), checked once connected and homed.

**Suggest a free spot** searches a 1 mm grid over the stock top for the first footprint that passes 1–3, nearest the work zero first; none found is `plan.check` (rule `noFreeSpot`: "make the test smaller or clear room on the stock").

## Running

`run.calibration.start` makes every check `run.job.start` makes before it exports ([run.md § 4](run.md#4-before-a-real-run-streams)): the plan runnable on this connection (finalized on a real machine), the `$$` check, Idle and homed, the alignment gate, the connection reserved; then it builds the program again at the live work zero and refuses on any placement problem (`plan.check`) or soft-limit or work-area finding (`run.softLimit`). **Run.md § 7 gains "a calibration program DFYOM generated"** (Q222).

A calibration job carries **no plan or file about** it: it marks no operation cut (DF135), and leaves no run to resume (DF129): an interrupted cut is cut again on a fresh spot (the dialog says so). `job.pause` is a feed hold, as a plan run's.

## Suggestions

From the dimension test's readings (nominal N, depth d, tool Ø D), per axis with pocket P and boss B:

- **Scale** s = (P + B) / (2N) − 1: both grow with the axis' scale, the tool's width cancels. Beyond 0.05 mm over N, "X moves 1.00 % off: correct its steps/mm." with the line `$100=<current / (1 + s)>` to **copy** (`$101` for Y), from the connected controller's `$$`; not connected: no line, a note. DFYOM never writes the setting ([run.md § 7](run.md#7-what-dfyom-never-does-on-a-real-machine), Q219).
- **Tool Ø:** ΔD = (P − B) / 2 per axis and W − D from the slot, averaged; beyond 0.02 mm "The tool cuts as Ø 6.1 mm (0.1 mm off the library)." with **Set library Ø to 6.1 mm**, which writes the library tool (`library.tool.update`) and becomes **Undo** (writes the previous value back: library edits have no history, as the Machine group's). A tool copy not from the library says to edit it in the plan.
- **Backlash:** X and Y ΔD that differ by 0.04 mm or more: "check for backlash or a loose belt" on the wider axis.
- **Depth:** beyond 0.05 mm off d: "check the Z zero and the Z steps/mm."
- Nothing beyond the tolerances: "Every reading is within tolerance: nothing to correct."

From the feed ladder's best step: "Set the tool's feed preset to 1040 mm/min (+30 % of the current)." and that presets follow the calculator unless locked, so the user edits the preset in the Library. **Decided:** the preset is not written from here: a preset may follow the calculator, and the plan adapts it to the machine (DF139), so writing one number would be undone or misapplied silently.

## Saved results

App settings `calibration` (per library machine id, newest last, at most 50; not copied into plans, [ui.md § Settings](../conventions/ui.md#settings)): date, test, the tool's name and Ø as cut, plan and setup, footprint (WCS), size and depth, the ladder's steps and what varied, then the readings or the chosen step and the suggestion text once saved. A cut is saved when it ends normally.

## Implementation

- Core: `src/core/run/calibration.ts` (programs, placement, free spot, suggestions; `calibration.test.ts`: goldens, a height-map oracle per test that cuts only inside the footprint at the depth with the nominal sizes, the work area, refusals, ladder values, placement, suggestion math), `src/core/run/calibration-job.ts` (`run.calibration.check`, effect, and `run.calibration.start`, job; UI commands, not agent tools; `applyFirst`, [apply.md](../architecture/apply.md); `calibration-job.test.ts` on the virtual machine).
- Renderer: `CalibrationDialog.tsx` (+ test with axe), the navigator button, `calibrationOpen` / `calibrationPreview` in the run store, the viewport preview in `useRunScene`.
- e2e: `e2e/run-calibration.e2e.ts` (virtual machine: free spot, refused spot, run through the tool change, readings → `$100` line and tool Ø, saved).
- Waits for the user: a real cut and readings on the user's machine.
