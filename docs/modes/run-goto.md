# Run: Go to coordinates

Status: draft (hardening [DF128](../plans/hardening.md#intake-user-feedback-goes-here), the user's TG #413: "Run mode: when clicking work or machine coordinates, open a "GO TO" dialog that allows entering coordinates to move to in the selected frame of reference (ignore jog hotkeys while this dialog is open)"; awaits [Q154–Q157](#questions-for-the-user)) · Base: [run.md § Machine frame and manual control](run.md#machine-frame-and-manual-control-hardening-df31df35), [run-machine.md § Machine readiness](run-machine.md#machine-readiness-m3) (jog, DRO) · UI: [ui.md § Jog, position and probing](../conventions/ui.md#jog-position-and-probing-df88), [§ Jog hotkeys](../conventions/ui.md#jog-hotkeys) · Safety: [run.md § Safety](run.md#safety) · GRBL facts: [grbl.md](../architecture/grbl.md#homing-and-machine-coordinates) · Terms: [glossary.md](../glossary.md)

Clicking a coordinate in the Run inspector's Position table (the DRO) opens a **Go to** dialog: type where the spindle should go, in work or machine coordinates, see the move before it happens, press Enter. It replaces "jog 10, jog 10, jog 1, jog 0.1 …" for the common moves: back to the work zero, above a feature, to a measured point, to the front of the table to change a bit.

## What the user does

1. **Click a value** in the Position table: a work coordinate ("Work X 120.400") opens the dialog in the **work** frame, a machine coordinate in the **machine** frame, with that axis's field focused and its text selected. Each value is a button (accessible name "Go to: X 120.400 work"; the per-axis "0" zero buttons stay where they are, [ui.md DF88](../conventions/ui.md#jog-position-and-probing-df88)).
2. **Type** the target. The X, Y and Z fields start at the current position in the chosen frame, so an axis left as it is does not move. Fields are quantity fields in the project unit and take expressions (`120.4 + 3/8in`, [quantities.md](../architecture/quantities.md)).
3. **Check the preview** (below): the steps, the path drawn in the 3D view, the time.
4. **Enter** (in any field) or **"Go"** starts the move. The dialog stays open while the machine moves, showing the step it is on, and closes itself on arrival.

| Control                   | Behaviour                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frame**                 | Segmented control "Work (G54)" / "Machine (G53)". Switching converts the fields' values (through the live work offset), so the target point stays the same.                                                                                                                                                                                                                 |
| **Absolute / Relative**   | Absolute (default): the fields are the target. Relative: the fields start at 0 and are the distance to move; the frame does not matter then (the work offset is a translation), so the frame control is disabled with "Relative moves are the same in both frames."                                                                                                         |
| **Shortcuts**             | Small buttons under the fields that fill them (nothing moves until Go): "Work zero XY" (X 0, Y 0, Z unchanged, work frame), "Work zero" (X 0, Y 0, Z = the safe height above the zero, [Q154](#questions-for-the-user)), "Machine top Z" (machine Z −pull-off, the highest point Z can reach without touching its switch).                                                  |
| **Lift to the top first** | Checkbox: raise Z to the machine top before any X/Y move, whatever the target. Off by default, remembered per window ([Q154](#questions-for-the-user)).                                                                                                                                                                                                                     |
| **Go**                    | The primary button, enabled when every field is valid and the move passes the checks below; Enter in a field is the same.                                                                                                                                                                                                                                                   |
| **Stop** (while moving)   | Replaces Go: the jog cancel (`0x85`), which stops with GRBL's deceleration and drops the remaining steps; the dialog then says "Stopped at X … Y … Z …" and offers Go again. `Escape` does the same and closes the dialog (`Escape` already stops a jog and closes the top overlay, [ui.md § Jog hotkeys](../conventions/ui.md#jog-hotkeys)). The toolbar's Stop works too. |

## The move: safe order

A go-to never drags the tool sideways lower than it has to be. The steps (each one straight line):

1. **Up first** when the target Z is higher than the current Z: Z alone to the target Z.
2. **Lift for X/Y** when X or Y changes and the tool is below the **safe height** (the work zero Z plus the clearance of the chosen plan's setup, else 5 mm; capped at the machine top): Z alone up to the safe height. After a stopped run the tool can sit in the stock; this keeps it from cutting a trench on its way out. "Lift to the top first" raises to the machine top instead.
3. **X and Y together** to the target, at the Z reached so far.
4. **Down last** when the target Z is lower than the Z reached: Z alone to the target.

So a move that only lowers Z is one step, a move from inside the stock to the work zero is three (up, across, down), and nothing moves X/Y below `max(current Z, target Z, safe height)`, except a pure X/Y move already above the safe height. The order is computed again from the live position when Go is pressed (the machine may have moved since the dialog opened).

**Feed:** X/Y at the jog feed slider's value, Z at the lower of it and the machine's Z max rate, as the jog pad ([ui.md DF88](../conventions/ui.md#jog-position-and-probing-df88); [Q155](#questions-for-the-user)). The dialog shows it ("at 2000 mm/min").

## Preview

- **Steps list** in the dialog, one line per step in the dialog's frame and the project unit: "1 · Up to Z 15.000", "2 · To X 0.000 Y 0.000", "3 · Down to Z 1.000", each with its length, and the total time at the jog feed (trapezoid-free estimate, rounded up to the second: "about 6 s").
- **3D view:** while the dialog is open the run scene draws the path as a dashed polyline from the tool marker through each step's end to a target marker (accent colour, the one accent of the view; eased in with `--motion-fast`, instant under reduced motion), and updates it as the fields change. The dialog has no scrim and sits over the inspector, so the view stays visible; focus is held in the dialog like any modal.
- **Screen readers:** the steps list is the preview's text equivalent (`aria-describedby` of Go).

## Checks

Checked in the dialog on every change, with each finding next to its field and Go disabled; the host checks again ([run.md DF33](run.md#machine-coordinates-and-the-homing-corner-df33)).

| Check                                   | Refusal (dialog wording)                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Inside the travel**, every step's end | "X would leave the travel: the target is at machine 12.000, the travel is −800 to 0 mm." Checked against the controller's travel (`RunStatus.envelope`, from `$130–$132`) whether soft limits are on or not; the host's check (soft limits on) and GRBL's `error:15` stay.                                                                                                                                         |
| **Position known**                      | Not homed ("—" in the DRO, [run.md DF46](run.md#run-mode-presentation-df46)): the coordinate buttons are disabled with "Home the machine first: the position is unknown." No go-to from an unknown position, unlocked or not.                                                                                                                                                                                      |
| **Nothing else moving or running**      | Only with no run job (not at a tool-change or pause wait either: those dialogs have their own jog pad and "Move to touch-off spot", [z-reference.md](z-reference.md#implementation-notes-df69)) and in `Idle`. In `Jog` the dialog opens but Go waits for Idle ("The machine is still jogging."). Alarm, Hold, Door, Home, Check, not connected: disabled with the state's reason, the same texts as the jog gate. |
| **Spindle off**                         | The status reports a running spindle (`FS` rpm > 0): "Stop the spindle first." (rule `spindleOn`, as `run.align.goto`). A hand-switched router reports nothing; the dialog's footer says "Make sure the spindle is off." on a real machine.                                                                                                                                                                        |
| **Something to do**                     | The target equals the position (within 0.001 mm): Go disabled, "Already there."                                                                                                                                                                                                                                                                                                                                    |

A real connection follows the jog rules: no confirmation beyond the dialog itself (the steps list and Go are the confirmation, [run.md § 3](run.md#3-confirmations-before-motion)), UI only ([run.md § 2](run.md#2-who-may-command-a-real-connection-q50)).

## Keyboard

- **Jog hotkeys are off while the dialog is open**, wherever the focus is (the user's request): the hotkey hook is inactive while the run store's `goToOpen` is set, not only when focus is in a text field. So `Space` (Z+ in the WASD style) types nothing and jogs nothing, and `Shift` while typing never jogs Z−.
- `Enter` in a field: Go (after the field commits its expression). `Escape`: while idle closes the dialog; while moving stops (jog cancel) and closes. `Tab` order: frame, absolute/relative, X, Y, Z, shortcuts, lift checkbox, Go, Cancel.
- A field holding an invalid value keeps Go disabled; `Escape` inside the field first restores its value (quantity field rule), a second `Escape` closes.

## G-code

Every step is one GRBL jog with an **absolute machine target**, whatever frame the user typed in:

```
$J=G21 G53 G90 X-412.300 Y-233.000 Z-1.000 F2000
```

- **Why `$J=` and not `G0`/`G53 G0`:** a jog is cancellable at once with `0x85` (a `G0` needs a feed hold and a reset to drop), refused with `error:15` instead of `ALARM:2` when it would leave the travel, leaves the program's modal state alone, and runs only in Idle/Jog, so it can never sneak into a run. GRBL queues several `$J=` lines and runs them in order, so the steps follow each other without stopping between them; one `0x85` cancels them all.
- **Why machine targets:** the dialog converts a work target with the work offset of the last status report (`WCO`, which also contains any `G92` a file left), so the travel check is exact and the controller's active work coordinate system (G54 in DFYOM, [run.md DF93](run.md#run-an-external-g-code-file-df93)) cannot surprise. The existing `run.machine.jog { to }` already sends exactly this line (`src/core/run/host/host.ts`) and checks it against the travel; "Move to touch-off spot" and the alignment pointer use it the same way ([alignment.md](alignment.md)).
- Units: always `G21` (commands take mm; the dialog converts inch input).

## Agent API

None new ([Q156](#questions-for-the-user)). The dialog is a UI composition of `run.machine.jog { to, feed }`, one call per step (the run store's `moveTo`, as `TouchOffButton`), which agents already have: on the virtual machine an agent goes to a point with the same tool; on a real machine motion stays UI only (Q50). The step order lives in a headless function (`goToMoves`, below), so a later agent tool could reuse it; `tools/list` is unchanged.

## Files

- `src/core/run/goto.ts` (headless): `goToMoves({ from: mpos, wco, target, frame, mode, safeZ, liftToTop, envelope })` → `Ok(steps: { to: Vec3 /* machine */, axis: 'z' | 'xy' }[])` or `Err` with the per-axis travel finding; the safe height from the plan's setup clearance or 5 mm. Pure, unit tested.
- `src/renderer/src/modes/run/GoToDialog.tsx`, the DRO buttons in the Position table, the path in the run scene, `goToOpen` in `run-store.ts` read by `useJogHotkeys`.
- Messages in `messages/run.ts` (`goTo`).

## Questions for the user

Numbering continues after [tapered-ball-nose.md](tapered-ball-nose.md#questions-for-the-user)'s Q153. "Q154 ok" takes the recommendation; "all ok" takes every one.

1. **Q154 – Order and safe height.** (1) **Z up first unless going down, plus a lift to the safe height (work Z0 + setup clearance, else 5 mm) before any X/Y move made below it; "Lift to the top first" as an opt-in checkbox.** (2) Only "Z up first unless going down" (X/Y at the current Z when going down). (3) Always via the machine top for any X/Y move. _Recommendation: (1)._ (2) drags a tool that stopped inside the stock through the material; (3) is safest but turns every small reposition into a long trip to the top and back.
2. **Q155 – Feed.** (1) **The jog feed slider (Z capped at the Z max rate), shown in the dialog.** (2) The machine's max rates, like a rapid. (3) A feed field in the dialog. _Recommendation: (1)._ It is the speed the user already chose for moving by hand, and a jog cannot rapid anyway (`$J=` needs `F`); (3) adds a field to every move for a rare need: the slider is one control away.
3. **Q156 – Agent API.** (1) **None: the dialog sends `run.machine.jog { to }` per step, which agents already have.** (2) A `run.machine.goTo { target, frame }` tool that applies the safe order. _Recommendation: (1)._ The tool list is near its budget (≈ 116.9 K of 120 K) and no agent may move a real machine; an agent on the virtual machine can already send the steps.
4. **Q157 – Where the dialog opens from.** (1) **The DRO values only (the user's request), plus a "Go to…" item in the jog section's menu for keyboard users (`G` while no field has focus).** (2) DRO only. (3) Also from the 3D view: double-click a point to go above it. _Recommendation: (1)._ (3) is attractive but needs picking on the run scene and a Z rule for a clicked surface; it can follow once the dialog exists.

## Slices

Each slice keeps `npm run check` green, updates this doc (an implementation section) and the [hardening plan](../plans/hardening.md) DF128 row, and can merge on its own. The doc moves to `accepted` when the questions are answered.

| Slice | What                                                                                                                                                                                                                                                                                   | Done when                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GT1   | **Core and dialog.** `goToMoves` (frames, absolute/relative, safe order, travel findings), the DRO buttons, the dialog (fields with current values, frame, mode, shortcuts, lift checkbox, steps list, checks and gates, Go/Stop, Enter/Escape), `goToOpen` silencing the jog hotkeys. | Unit tests of `goToMoves` (up / down / from inside the stock / lift to top / relative / work↔machine with a non-zero WCO / every travel edge / already there); component tests with axe (opens on the clicked frame and axis, gates, Enter goes, Escape stops, WASD and `Space` do nothing while open); on the virtual machine (commands test) a go-to from inside the stock ends at the target with Z never below the safe height during the X/Y step. |
| GT2   | **Preview and polish.** The dashed path and target marker in the run scene, the time estimate, the "Go to…" menu item and `G` key (Q157), light and dark captures.                                                                                                                     | Hidden e2e `run-goto.e2e.ts` on the virtual machine: click Work X, type a target, see the path, Enter, the machine arrives and the dialog closes; Stop mid-move leaves "Stopped at …"; renders `df128-goto-{light,dark}.png`.                                                                                                                                                                                                                           |
