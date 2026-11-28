# Run: probing cycles

Status: accepted (v0.5 [RV3–RV5](../plans/v0.5-run.md#slices), delegation D88), RV3–RV5 implemented ([§ Implementation (RV3)](#implementation-rv3), [§ (RV4)](#implementation-rv4), [§ (RV5)](#implementation-rv5)) · Plan: [v0.5-run.md § 4](../plans/v0.5-run.md#4-xy-probing) (Q220: RV4+ assume a corner plate or the bit as the probe) · Base: [run-machine.md § Probing and re-zero (M4)](run-machine.md#probing-and-re-zero-m4) · GRBL facts and the virtual machine: [grbl.md § Probing](../architecture/grbl.md#probing), [§ Probe scene](../architecture/grbl.md#probe-scene-rv3) · Safety: [run.md § Safety](run.md#safety)

Every probing feature of v0.5 (edges, corners, hole centres, the X/Y zero, the alignment Measure, homing repeatability, surface maps) is a sequence of single-axis probes. This doc defines the one runner they share, the Test probe readout, RV4's edge, corner and centre routines built from it and RV5's Set X/Y zero dialog.

## The cycle runner (RV3)

`runProbeCycle(port, spec, hooks?)` in `src/core/run/probe-cycle.ts` (headless core) probes along one axis and returns the contact as a value with an uncertainty. The machine host gives it a `ProbePort` over the connection's sender: a fresh status report, `command(line)` (the reply lines, `[PRB]` among them), the `ALARM:n` events and `unlock()` (`$X`, clearing the host's alarm).

- **Spec:** `axis` (`x`/`y`/`z`), `direction` (−1/+1), `maxDistance` (mm from the start), `fastFeed`, optional `slow { feed, backOff, repeats = 1 }`, `retract`, optional `travel` (the MPos travel when soft limits are on), `inches` (`$13=1`), `onAlarm` (`'recover'` default, `'stay'`), `cancelled()`, `resolution` (default 0.001 mm, 0.00254 in inch). Malformed numbers are `input.malformed` before anything is sent.
- **Guards, before any line:** a fresh report must say `Idle` (`run.state`, "cannot probe in state Run"); the spindle 0 rpm (`run.state`, rule `spindleOn`); the probe input open, `Pn:` without `P` (`run.state`, rule `probeTouching`: "The probe reads as touching: check the clip, the plate and the probe wire before probing."). With `travel`, the distance is cut so the target stays 0.01 mm inside it; under 1 mm left → `run.travel` ("Z is at the bottom of its travel: no room to probe"; X/Y: "the minimum/maximum").
- **Sequence:**
  1. `$G` (the modal state to restore, as Probe Z: units, distance mode, motion).
  2. **Seek:** `G21 G90 G38.2 <axis><start − WCO + direction × distance> F<fast>`, timeout the move's duration plus 10 s. GRBL rejects `G53` with `G38.x`, so probe targets are work coordinates (WCO from the report); every result is MPos.
  3. **Slow re-probe** (with `slow`, `repeats` times): a rapid `G21 G53 G0 <axis><contact − direction × backOff>` back, then `G38.2` toward `contact + direction × backOff` at the slow feed. Each slow contact is a sample.
  4. **Retract:** `G21 G53 G0 <axis><contact − direction × retract>`; Z down retracts up to at most MPos 0 (the travel top), X/Y and Z up at most back to the start.
  5. The modal state back, then `G4 P0` (its `ok` waits for the retract).
- **Never past the distance:** every target lies on the segment from the start to `start + direction × distance` (the slow probe's target is clamped to it), so no move goes beyond what the spec and the travel allow.
- **Back-off and retract are rapids, not `G38.3`:** they retrace the path the seek just travelled along the same axis, where nothing can be touched; the plan's rule ([v0.5-run.md § Rules](../plans/v0.5-run.md#rules-for-every-item)) that positioning moves below the safe Z are `G38.3` applies to moves into untravelled space (RV4's corner step-out), which RV4 adds as its own step. A `G38.4` back-off ("until open") would stop microns from the surface and leave the slow probe no room to reach its feed.
- **Result:** `{ axis, value, uncertainty, contact, seek, samples, start }`: `value` is the mean of the slow samples (else the seek's contact) on the axis, MPos; `uncertainty` is ± the larger of the reading resolution and half the samples' spread. The probe's radius and plate offsets are applied by the cycles (RV4), not here.
- **Failures:**
  - `ALARM:5` (no contact) or `ALARM:4` (the input closed at a probe's start despite the guard) → `machine.alarm` with `data { code, text, recovered }`. `'recover'` (the v0.5 cycles): `unlock()`, a rapid back to the start (the failed probe moved along the axis only, so this retraces it), the modal state back; the position is kept (neither alarm loses it) and nothing is written. `'stay'` (Probe Z, M4's behaviour): the alarm stays for the operator and the restore lines go to `hooks.restorePending`, sent after the unlock.
  - **Cancel:** `cancelled()` is checked before every line; once true, `op.aborted` and nothing more is sent. Stop itself is the existing feed hold + reset ([run.md § 1](run.md#1-emergency-stop-stop-and-reset)), which fails the line in flight; the runner returns that error and sends nothing after it.
  - Any other command error (`error:N`, a lost connection) comes back as it is.
- **Probe Z** (M4) runs through it: one pass (no `slow`), `onAlarm: 'stay'`, the travel from the envelope with soft limits; the host then writes `G10 L2 P1 Z<contact − plate thickness>` and reads `$#`. Its lines and results are M4's, except that the G54 write now follows the retract and the modal restore (it does not depend on the position), the status is a fresh report, and a probe input that reads touching is refused before sending instead of becoming `ALARM:4`.

## Test probe (RV3)

The navigator's Probing section shows the probe input live while connected, from `Pn:P` of each report: "Probe input: open. Touch the clip to the plate to test it." or "Probe input: touching. Probing waits until it reads open." (a polite `role="status"`, so touching the clip to the plate is announced). It is the check before the first cycle; on the virtual machine `Pn:P` comes from the probe scene ([grbl.md](../architecture/grbl.md#probe-scene-rv3)).

## Probe settings (RV4)

The probe is one optional object field `probe` on the library machine ([library.md](../architecture/library.md#machine)), edited in the Run inspector's Machine settings › Probe and the Library window's Machine tab; unset is a Z touch plate with the defaults. No `schemaVersion` change: every part is optional.

| Field                        | Meaning                                                                                                                                                              | Default                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `kind`                       | `zPlate` (Z only, today's plate), `xyzPlate` (corner plate), `tool` (the bit itself, clipped, on a conductive stock), `3d` (touch probe) — Q220 keeps it a parameter | `zPlate`                                    |
| `wallOffsetX`, `wallOffsetY` | `xyzPlate`: how far the wall the bit touches sits out from the stock edge the plate hooks on                                                                         | none (required to probe X/Y with the plate) |
| `tipDiameter`                | `3d`: the stylus ball Ø                                                                                                                                              | none (required for `3d`)                    |
| `fastFeed`, `slowFeed`       | seek and re-probe feeds                                                                                                                                              | 100, 20 mm/min                              |
| `retract`                    | back-off off a contact and the clearance between moves                                                                                                               | 2 mm                                        |

The plate's thickness (its top above the stock top) and size stay `probePlateThickness` and `probePlateSize` (shared with Probe Z). The bit's Ø (`tool`, and `xyzPlate` whose walls the bit touches) is not a machine field: it comes from the tool in the spindle (Q189's rule) or is entered in the dialog ([§ Set X/Y zero](#set-xy-zero-rv5)).

## X/Y probing (RV4)

`runProbeRoutine(port, spec)` in `src/core/run/probe-routines.ts`, run by the host as one `run.machine.probe { routine, probe, … }` job (Idle, no run; a feed hold pauses it, Stop resets; not an agent tool, Q229). It **writes nothing**: the result is machine coordinates with the probe's radius and the plate's offsets applied; [Set X/Y zero](#set-xy-zero-rv5) writes.

- **Routines:**
  - **Edge** (`axis` x/y, `side` −1 the stock's X−/Y− edge, +1 its X+/Y+): from a start above the top within `reach` (default 10 mm) of the edge.
  - **Corner** (`corner` [sx, sy]): the same start, X then Y.
  - **Centre** (`feature` hole/boss, `diameter` nominal): `tool` and `3d` only (the plate cannot touch a hole). Hole: the start inside it at the probing depth, ±X then ±Y from the start, each up to the Ø. Boss: Z on its top first, then from outside on four sides like an edge. Centre = chord midpoints, Ø = the chord geometry ± the tip Ø. No UI yet: it waits for a 3D probe (Q220); the command and core have it.
- **Sequence of an edge (a corner does it per axis):**
  1. **Z first** (runner, `G38.2` down up to `zDistance` 25 mm, two slow re-probes at a 1 mm back-off): the top under the start; `xyzPlate`: the stock top is this minus `probePlateThickness`.
  2. Up to `lifted` = contact + clearance (rapid, the travelled path).
  3. **Step out** (`G38.3`, positioning feed 300 mm/min): along the axis away from the stock by `reach + r + clearance`.
  4. **Down** (`G38.3`) to `depth` (3 mm) below the top just measured.
  5. **Side probe** (runner, `G38.2` toward the stock, up to the step-out distance, two slow re-probes); the retract goes back to the out point.
  6. Rapids up to `lifted`, back over the start.
  7. The modal state back (`$G` read before the first line), `G4 P0`.
- **Values:** edge = contact − side × (r + wall), where r is the tip's radius (the bit or the ball) and wall the plate's `wallOffset` (`xyzPlate`, else 0). Each value carries the runner's ± uncertainty (the reading resolution or half the slow samples' spread); the entered Ø's own error is not in it (the dialog says "with the bit Ø 6.350 as entered").
- **Never an unbounded move:** every probing move is `G38.2` with a max distance; every positioning move below the lifted height is `G38.3` (it stops on an unexpected contact without an alarm). The way back after a failure is rapids along the path already travelled.
- **Refusals** (`run.state` with a rule, nothing sent, each says what to do):
  - `probeKind`: a `zPlate` asked for X/Y ("…Set the probe kind in Machine settings, or touch the edge with the bit instead."); a plate asked for a centre.
  - `probeGeometry`: `xyzPlate` without its thickness or wall offsets.
  - The runner's guards (state, spindle on, `probeTouching`: the clip already closed).
  - `input.malformed`: a non-positive distance or feed.
- **Failures mid-routine:**
  - An unexpected `G38.3` contact (a clamp, a chip, a start too far from the edge): rapid back along the path to the start, then `run.state` rule `unexpectedContact` ("The probe touched something on a positioning move at X … (machine): it went back to the start. Check for clamps and chips, and that the edge is within the reach of the start, then probe again.").
  - No contact (`ALARM:5`, the edge beyond the reach or the clip off): the runner unlocks and backs out, the routine retraces its path to the start; `machine.alarm` comes back with `recovered: true`.
- **Guard and preview:** `routinePath(spec, start, surface?)` lists the MPos points the routine may pass through (each probe to its full distance); the dialog checks them with the workholding guard ([run-workholding.md](run-workholding.md#go-to-and-the-touch-off-spot)) before it starts, with "Go anyway" as Go to.

## Set X/Y zero (RV5)

The Probing section's **Set X/Y zero…** opens a dialog (at the window's end edge, the 3D view beside it visible, as Go to) that writes G54 X and/or Y so a stock edge or corner lands where the plan's setup puts it, wherever the plan's zero is (Q225; Q61: even off the stock). It is the plan's item 7 ([v0.5-run.md § 7](../plans/v0.5-run.md#7-assistance-setting-the-work-zero-in-xy)); the plan named a new run-zero.md, the section lives here beside the routines it uses. Connected and Idle (the work-zero gate); a run in progress disables it.

1. **Pick** an edge or a corner on the **stock top picture** (the setup's stock seen from above, front at the bottom, its X/Y proportions): four corner and four edge buttons (a radio group, arrows move). The plan's zero is a ring (outside the stock when it is), and the first pick is the corner nearest it ("Plan zero: this corner" when it is on it). **Without a plan** (manual control, a gCode file): the same picture as a square and, per picked axis, "This edge is X =" (default 0).
2. **Method:** **Probe** (an RV4 routine: edge or corner) or **Touch** (the bit by hand). Probe is offered for the `xyzPlate`, `tool` and `3d` kinds; with a Z plate it is disabled with "Probe X/Y needs an XYZ corner plate, the bit on a conductive stock or a 3D probe: set the probe kind in Machine settings (Probe), or touch the edge." The default is Probe when it can, else Touch.
3. **Bit Ø:** from the tool in the spindle (Q189's rule: the setup's first tool, or the last tool change) and editable (a measured Ø); `3d` uses the machine's ball Ø instead (shown, not edited here). Lengths take the project unit and expressions.
4. **Probe:** the steps in words ("Put the bit over the plate within 10 mm of the corner, the clip on the bit; it probes Z, then X, then Y") and the workholding guard over `routinePath` (each probe to its full distance; a contact is a finding with "Go anyway", as Go to). **Probe** starts `run.machine.probe` (the dialog itself is the confirmation: nothing moves until that press). A failure keeps the dialog on this step with the routine's message and its next step; Stop stops it as any job.
5. **Touch:** the jog pad inside the dialog (its hotkeys work there), a **feeler** thickness (default 0; paper ≈ 0.1 mm), the probe input as a live readout ("touching" with a clip on the bit; a real operator feels it, the virtual machine's stock closes the input while the touch step is open) and per picked axis a **"Touching X− edge"** button that records the position. A corner records X, then Y (jog away and to the other edge between). The edge = position − side × (Ø/2 + feeler).
6. **Confirm:** the measured edge(s) with their ± uncertainty, then the new zero: "G54 X: −412.300 → −409.100 (+3.200)" per axis (machine coordinates, project unit). **Set zero** writes `G10 L20 P1` for the picked axes only (`run.workZero.set` at the current position, Idle: nothing moves); **Back** returns to the method. A changed G54 clears the alignment ticks as today.
7. **Undo:** after a set, the Probing section shows **Undo zero change** until the next set or the connection closes: G54 X/Y back to what they were before the last set (the window's last change; another window's or a run's later change is not tracked).

- **The value written:** a measured edge e (MPos) on an axis gets the plan's work coordinate w of that edge (the setup frame has the stock on `[0, L] × [0, W]`, the work coordinates are it less the setup's zero): G54 = e − w (X− edge: w = −zero_x; X+ edge: w = L − zero_x). Without a plan, w is the entered value.
- **Not here:** hole and boss centres (no UI until a 3D probe, Q220), Z (Probe Z stays the Z method), rotated stock (RV6's alignment check measures it; an edge probe on a rotated stock measures where the probe touched).

## Implementation (RV3)

- **Emulator:** `probe-scene.ts` (targets, tips, `firstChange`, `seededBumps`), `emulator.ts` (the scene replaces the plate, `Pn:P`, `setProbeScene`/`setProbeTip`/`setProbeShorted`/`probeTouching`); `probePlate`/`setProbePlate` keep working as the scene's plane.
- **Runner:** `src/core/run/probe-cycle.ts` (also `modalRestore` and `probeResult`, moved from the host); the host's `probePort()` and `probeZ()` in `src/core/run/host/host.ts`.
- **App virtual machine:** the host lays the plate before Probe Z as before and takes it away after the cycle (the operator puts the plate away), so a later cut below the old plate top does not report `Pn:P`.
- **Tests:** `emulator/probe-scene.test.ts` (geometry; a box top and side with a cylinder and a ball, a rotated box, the corner plate's top and walls, a hole from inside, a height field; `G38.3` stopping on an unexpected contact, `G38.4`/`G38.5` backing off and missing, the shorted probe, the plate beside a scene), `probe-cycle.test.ts` (Z with two slow probes, an X edge with the bit, a G54 offset, no contact → `ALARM:5` → unlock → back at the start with nothing written, `'stay'`, already touching refused before sending, spindle on and busy state, the travel cut and edge, cancel between lines, Stop mid-probe, a malformed spec); the existing Probe Z tests (`host-serial.test.ts`, `host.test.ts`, `commands.test.ts`, `e2e/run-serial.e2e.ts`, `e2e/tool-changes.e2e.ts`) pass unchanged; `RunMode.test.tsx` (the Test probe line).
- **Not verified on hardware:** a real probe pin's debounce and polarity (`$6`); the real-machine row is RV4's corner check.

## Implementation (RV4)

- **Library:** `probe` on the machine DTO and model (`ProbeDtoSchema`, `ProbeSettings`, `checkProbe`: wall offsets ≥ 0, the rest > 0) in `src/core/library/machine.dto.ts` and `machine.ts`; the fields in `src/renderer/src/library/MachineFields.tsx` (Run variant Probe group and the full form's Machine tab), the plate walls shown for `xyzPlate` only, the ball Ø for `3d` only.
- **Core:** `src/core/run/probe-routines.ts` (`runProbeRoutine`, `routinePath`, `checkRoutine`, `XY_PROBE_KINDS`).
- **Host and command:** `probeRoutine` in `src/core/run/host/host.ts` (protocol action `probeRoutine`), `run.machine.probe` in `src/core/run/commands.ts` (`ROUTINE_DEFAULTS`). It adds about 370 characters to `tools/list` (the `probe` field in the machine schemas; 110 793 of the 120 000 budget, `tools.test.ts`); the command itself is not an agent tool.
- **App virtual machine:** the host lays what the routine probes before it runs and takes it away after, as Probe Z's plate: `tool` and `3d` probe the stock box the virtual operator laid (`run.virtual.stock`, [§ Set X/Y zero](#set-xy-zero-rv5)); `xyzPlate` gets a corner plate hooked on that stock's corner (or along the probed edge) with the machine's thickness, size (default 50 mm) and walls; the tip is a cylinder of the bit's radius or the 3D probe's ball.
- **Tests:** `probe-routines.test.ts` (edges with the bit on all four sides and with a ball; corners with the XYZ plate in all four facings, the bit and a ball; a stock rotated 0.5°; no contact on the top or the side, already touching, a clamp on the step-out, kind and geometry refusals; a hole and a boss centre; `routinePath`), `machine.test.ts` (the probe round trip and invariants), `host.test.ts` (a corner probe on the virtual stock with the plate, nothing written). The shared emulator port moved to `probe-port.fixture.ts`.
- **Not verified on hardware:** the plan's real-machine row (a corner repeated 5× within 0.05 mm) waits for the user's probe (Q220).

## Implementation (RV5)

- **Core:** `src/core/run/xy-zero.ts` (`planEdge`, `g54For`, `touchedEdge`, `zeroCorner`, `virtualStockBox`, `VIRTUAL_MISPLACEMENT`), pure.
- **Renderer:** `SetXyZeroDialog.tsx` (mounted with the run dialogs; `xyZeroOpen` in the run store), the button and Undo in `RunNavigator.tsx`'s Probing section; store actions `probeRoutine`, `setXyZero` (G54 = MPos − the new work position through `run.workZero.set`, as `restoreWorkZero`), `undoXyZero`, `layVirtualStock`, `setVirtualTouch`; `machineProbe` in `plan-info.ts` reads the probe settings.
- **Virtual machine:** `run.virtual.stock { stock?, touch }` (virtual only, not an agent tool): the virtual operator lays the plan's stock once per connection and setup when the dialog opens, at the place G54 says plus `VIRTUAL_MISPLACEMENT` (3.2, −1.7) mm (the plan row's case: probing must move G54), or under the bit when G54 was never set; `touch: true` (with `toolDiameter`, the dialog's bit Ø: the tip becomes that cylinder) while the touch step is open closes `Pn:P` when the bit touches it.
- **Tests:** `xy-zero.test.ts` (the plan's edges for a zero on a corner, inside and off the stock; a corner probe on the misplaced stock sets G54 within 0.01 mm of the truth for three zeros; a touch-off with a 0.1 mm feeler), `SetXyZeroDialog.test.tsx` (picking, the probe kinds, the confirmation, without a plan; axe), `e2e/run-xy-zero.e2e.ts` (hidden: on the virtual machine a corner probe sets G54 so "→0" X/Y lands on the stock corner within 0.01 mm; a touch-off by jogging; Undo).
