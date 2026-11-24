# Run on a real machine

Status: draft (hardening 1.2, 2026-11-23; awaits the user's answers to [Q49–Q52](../plans/hardening.md#questions-for-the-user); [M1](#implementation-m1), [M2](#implementation-m2), [M3](#implementation-m3), [M4](#implementation-m4), [M5](#implementation-m5), [M6](#implementation-m6), [M7](#implementation-m7) and [M8](#fault-injection-m8) implemented, merged into main with the DF60–DF76 work on 2026-11-24 after the user's "machine ok") · Safety rules: [run.md § Safety](run.md#safety) · Base: [run-v0.1.md](run-v0.1.md) · Protocol facts: [grbl.md](../architecture/grbl.md) · Decision: [ADR 0013](../decisions/0013-grbl-first-controller.md) · Tasks: [hardening](../plans/hardening.md#5-real-machine) M1–M8

Run mode on a real GRBL controller over a USB serial port: the same sender, host, commands and UI as the [virtual machine](run-v0.1.md), with a `SerialTransport` under the sender, a port picker, the controller's settings checked against the machine copy, and the real-machine rules of [run.md § Safety](run.md#safety). This doc specifies DFYOM's side; GRBL facts stay in [grbl.md](../architecture/grbl.md).

## Assumptions

Until the user answers Q49–Q52, this doc assumes ([run.md § Safety](run.md#safety) A1–A5):

- **Machine (Q49):** a GRBL 1.1–compatible controller (an Arduino-class board: banner `Grbl 1.1…`, 115200 baud by default) on USB serial, with homing switches (`$22=1`) and soft limits on; a fixed-gantry router that homes to the **back right with Z up** (`$23=0`, the [`fixedGantry`](../architecture/library.md#machine) preset); a hand-switched router or a PWM spindle (`M3 S`). No probe is assumed; a Z touch plate on the controller's probe input is optional (M4).
- **Agents (Q50):** machine-moving commands on a real connection come from the UI only.
- **First cuts (Q51):** step 1 with the user's own sender (X0), step 2 through DFYOM (X1).
- **Scope (Q52):** as recommended ([Scope](#scope)).

## Scope

| In (hardening)                                                                                                      | Out                                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Serial connection and port picker; handshake and `$$` check (M1)                                                    | Raw MDI console, macros, writing `$x=` settings                                             |
| Real-machine run rules (M1, M2); jog by step and continuous, set zero per axis, alarm texts with the next step (M3) | Sensors, MCUs, automation scripts ([run.md](run.md))                                        |
| Z touch plate `G38.2`, also at tool changes and after a flip (M4)                                                   | Probing X/Y edges or corners, tool length sensors, tool tables                              |
| Resume a stopped run at a section boundary (M5)                                                                     | Restart at an arbitrary line                                                                |
| Feed and spindle overrides (M6); feed hold and resume (existing)                                                    | grblHAL tool changers and extensions, FluidNC, network (Wi-Fi/telnet) connections           |
| Fault injection in the emulator for these paths (M8)                                                                | Agent-started real runs ([run.md § Safety](run.md#2-who-may-command-a-real-connection-q50)) |

## Amendments to run-v0.1.md

The [v0.1 decisions](run-v0.1.md#decisions) these change; the others hold for real connections unchanged.

- **Decision 1 (virtual machine only)** becomes: **virtual or serial.** `run.connection.open` takes `target: 'virtual' | 'serial'`; the serial target uses `SerialTransport` in the machine host ([below](#serial-transport)). Selectable now that [run.md § Safety](run.md#safety) exists (draft; the branch merges once it is accepted).
- **Decision 5 (every status but `archived`)** becomes: on the **virtual machine** every status except `archived` may run; on a **real machine** only `finalized` and `inUse` (`run.job.start` refuses others with `plan.status`, `data: { status, target: 'serial' }`).
- **Decision 11 (no extra controls)** becomes: feed and spindle overrides (M6) and the Z probe (M4) are added as typed commands; still **no raw gCode or `$` lines** and no settings writes.
- Decision 3 (time scale) applies to the virtual machine only: a serial connection always runs at 1× (`run.timeScale.set` → `run.state`, rule `virtualOnly`). Decision 6 (machine identity) holds: the connection's machine key is the plan's machine copy or the library machine it was opened with, and the controller's `$$` is checked against that machine ([Settings check](#settings-check)).

## Serial transport

`SerialTransport` (`src/main/machine/serial-transport.ts`) implements the [`ControllerTransport`](../architecture/grbl.md#transport-and-sender) port over the [`serialport`](https://serialport.io) package (MIT; [packaging.md](../conventions/packaging.md#native-modules)).

- **Where:** only in the machine host: the Electron utility process in the app, the `worker_threads` worker headless ([run-v0.1.md § Processes](run-v0.1.md#processes)). Main and the renderer never load `serialport`. The host gets it through an injected `SerialPorts` port (`src/core/run/serial.ts`: `list()`, `open(path, baud)`), so `src/core` stays headless; the host entries pass the Node implementation (`src/main/machine/serve.ts`), tests pass a loopback.
- **Lazy:** `serialport` is loaded on the first `list()` or `open()`, so a virtual connection never loads the native module.
- **Port settings:** 8 data bits, no parity, 1 stop bit, no flow control (GRBL's defaults); baud from the connect call (default 115200). Opened with DTR/RTS as the OS leaves them: on most Arduino boards opening resets the controller, whose bootloader then needs about 1–2 s before the banner.
- **`write(bytes)`** resolves once the bytes were handed to the OS (`write` + `drain`); a write error is `machine.connection`.
- **`onData`** delivers the raw chunks; the sender frames them ([run-v0.1.md § Sender](run-v0.1.md#behaviour)).
- **`onClose`** (an optional member of `ControllerTransport`, added for serial): the port closed without DFYOM asking (cable pulled, board unpowered) → the sender fails the connection at once (`machine.connection`, "port closed"), not only after the 2 s status watchdog.
- **`close()`** closes the port; errors closing an already gone port are ignored.

## Ports and the port picker

- **Command `run.ports.scan {}`** (an `effect` with `machine: false`, not a query: queries are synchronous and the OS is asked each time; nothing is opened) → `{ ports: [{ path, manufacturer?, serialNumber?, vendorId?, productId?, usb }] }`, answered by the machine host (spawned for the scan if none runs; it stays for the next connect). `usb` is true when the OS reports a USB vendor id; USB ports sort first, then by path. No `serialport` in the process → `machine.connection`, "serial ports are not available here". Every source may scan.
- **UI:** the Run navigator's Connection section gets a **Connect to** choice: "Virtual machine" (default) or "Serial port". For a serial port it shows a port select (USB ports first, labelled `path · manufacturer`), a refresh button and a baud select (115200 default; 250000, 230400, 57600, 38400, 19200, 9600); the time-scale select is shown for the virtual machine only. The chosen port and baud are remembered per window while the app runs. The connect button reads "Connect to machine" for a serial port. Connected, the machine badge's chip reads "Serial · /dev/cu.usbmodem1101" instead of "Virtual machine · 1×".
- No port: the select says "No serial ports found. Connect the controller by USB and refresh."

## Connect

`run.connection.open { target: 'serial', path, baud?: 115200, planId | machineId }` (UI only, [run.md § Safety](run.md#2-who-may-command-a-real-connection-q50)): `homing` and `timeScale` apply to the virtual machine only and are ignored; `prepare: true` with `serial` is `input.malformed` (rule `virtualOnly`); `path` is required for `serial` (`input.malformed`, rule `required`).

1. Main spawns the host (if none) and sends `connect { target: { kind: 'serial', path, baud, machineKey } }`.
2. The host opens the port (`machine.connection` with the OS message on failure, e.g. "Resource busy" when another sender holds it) and runs the sender's handshake ([run-v0.1.md § Behaviour](run-v0.1.md#behaviour)) with a **3 s** banner wait for serial (an Arduino's reset on open), then one `0x18` and 3 s more; `$I` must report `1.1…`; `$$`, `$#`, `$G`, a first status report.
3. The reply's `ControllerInfo` has `target: 'serial'` and `port: { path, baud }`; `homed` is false (a real controller is never assumed homed; `$22=1` starts it in Alarm).
4. `run.connection.open` adds the **settings check** ([below](#settings-check)) to its result; a mismatch does not refuse the connection (jog, home and reading the DRO still work) but refuses runs.

`RunStatus.connection` gains `target: 'serial'` and `port?: { path, baud }`; `envelope` comes from the controller's `$$`, as for the virtual machine.

## Settings check

At connect, `run.connection.open` compares the controller's `$$` with the machine copy the connection was opened with (the plan's machine copy, or the library machine) through the [`$$` import's](../architecture/library.md#grbl--import) `machineSettingsDiff`: every setting the import maps whose controller value differs from a value the machine copy **sets** is a **difference**. A mapped setting the machine copy leaves unset (acceleration, steps/mm, junction deviation, …: optional machine fields) is listed in `notInMachine` and does not block: the controller's value applies, and importing the `$$` fills it in.

```ts
settingsCheck: {
  against: 'plan' | 'machine'   // the plan's machine copy, or the library machine (manual control)
  matches: boolean              // no difference and homing enabled
  differences: { setting: '$130', field: 'travel.x', controller: '400 mm', machine: '300 mm' }[]
  notInMachine: string[]        // e.g. ['$120', '$121', '$122']: unset in the machine copy, informational
  homingEnabled: boolean        // $22 = 1
}
```

- Checked settings: everything the import maps: `$11`, `$12`, `$20` (soft limits), `$23` (homing corner), `$27`, `$30`, `$31` (gcode spindle only), `$100–$102`, `$110–$112`, `$120–$122`, `$130–$132` (with soft limits on). Settings the import skips (a manual spindle's `$30`) are not differences.
- **A run on a real connection needs `matches`** (`run.job.start` → `run.state`, rule `settingsMismatch`, `data.differences`). The fix is the user's: import the controller's `$$` into the library machine ([library.md](../architecture/library.md#grbl--import), "Import $$…") and update the plan's copy (`plan.libraryItem.update`), or change the controller with another tool. DFYOM never writes `$x=`.
- The run store keeps the check of the open connection; the navigator shows a hard warning under the connection: "The controller's settings differ from the plan's machine: $130 travel X is 400 mm on the controller, 300 mm in the plan. Runs are refused until they match." with a "Review" link that opens the Library window on the machine (M3 adds the inline diff view). It names the first three differences and counts the rest ("; and 4 more").
- With homing disabled (`$22=0`) the check fails with "Homing is off on the controller ($22=0): DFYOM runs only on a homed machine."

## Real-machine run rules

[run.md § Safety](run.md#4-before-a-real-run-streams) lists them; on top of the [v0.1 run job](run-v0.1.md#run-job): plan `finalized`/`inUse`, the settings check, and the target in `jobStart.expect` (`serial`; the host refuses a job checked for another target, `targetMismatch`). In order, as `run.job.start` checks them (main), the host re-checking 3–4 at `jobStart`:

1. **Plan status** `finalized` or `inUse` (M1).
2. **Settings check** matches (M1).
3. **Homed in this connection** (M2): `homed` is false at connect (a real controller is never assumed homed), after a position alarm (`ALARM:1–3`, `6–10`), after an **unexpected controller reset** (a banner DFYOM did not cause with `0x18`: power glitch, USB reset, the board's own watchdog), and after `$X` without `$H`. Refused with `run.state` (`data.homed: false`).
4. **Soft-limit check** (existing, [run-v0.1.md](run-v0.1.md#work-zero-and-the-soft-limit-check)): the program's extent at the live G54 against the travel; any `softLimit` finding refuses with `run.softLimit` before a byte is sent. The travel is the plan's machine copy, which the settings check holds equal to the controller's `$130–$132` (with soft limits on), so DFYOM's check and GRBL's agree.
5. **Confirmation** (M2): the pre-flight is the UI's only way to start a setup's first run job; on a real connection it shows more and words its button for the machine ([below](#pre-flight-on-a-real-machine)). The setup-change prompt's "Start setup n" confirms the later setups (existing). `run.job.start` itself takes no confirmation flag: on a real connection only the UI may call it ([run.md § Safety 2](run.md#2-who-may-command-a-real-connection-q50)).

### Pre-flight on a real machine

On a serial connection the pre-flight ([ui.md](../conventions/ui.md#run-mode-safety-ui)) adds, beyond the target line (M1):

- A **Plan status** row ("Finalized" / "In use"); a plan in any other status disables the start with "A real machine runs only finalized plans. Finalize the plan in Plan mode first."
- A settings mismatch disables the start with "The controller's settings differ from the plan's machine (see Connection)."
- The **air-cut hint** as a note above the facts: "First run of this program? Run it in the air: spindle off, Z zero raised above the stock."
- The primary button reads **"Start on the machine"** (virtual: "Start run").

### Lost connection (M2)

`RunStatus.connection.lost?: { target, port? }` is set when the host reports the connection lost (port closed, status watchdog, controller silent) or the host exits while a connection is open; the next connect clears it. It tells the windows that the machine was let go of without a reset ([run.md § Safety 6](run.md#6-lost-connection-disconnect-and-reconnect)):

- A run that failed with `machine.connection` on a real connection opens the failure dialog titled **"Connection to the machine lost"** with "It may still be moving and the spindle may still be on: use the emergency stop." and the next step "Check the cable and the controller's power, then connect again and home the machine before the next run."
- Without a run (jogging, idle), the navigator shows the same warning at its end ([DF34](run.md#messages-never-move-controls-repeated-jog-clicks-df34)) until the next connect.
- A lost virtual connection (the host crashed) keeps the existing texts: no hardware moved.

## Machine readiness (M3)

What the operator needs before a run, in the Run navigator and inspector; the same controls serve the virtual machine.

- **DRO** (existing since 3.12): work and machine coordinates per axis in the inspector's "Position" table, feed and spindle.
- **Set zero per axis** (existing): "Zero X", "Zero Y", "Zero Z", "Zero X Y Z" (`run.workZero.set`), the live G54 under them; Z alone in the tool-change dialog.
- **Jog by step** (existing, DF34): each click one `$J=G91 …`, queued; refused outside the travel in words.
- **Continuous jog** (hold to jog): a "Step / Continuous" choice above the jog pad (`Jog mode`, per window). In Continuous, pressing and holding a jog button (pointer, or `Space`/`Enter` held on a focused button) sends `run.machine.jog { by, feed, continuous: true }`; releasing it sends `run.machine.jogCancel` (`0x85`), which stops the axis with GRBL's deceleration.
  - **Host:** `continuous: true` takes the direction of `by` (exactly one axis non-zero, else `input.malformed`, rule `oneAxis`) and jogs to the **travel edge** in that direction as an absolute machine move, `$J=G21 G53 G90 X0 F2000` (`0` or `−travel` on that axis, from the controller's `$$`), so a held button never runs past the travel. At the edge already (within 0.001 mm) → `run.travel`. No envelope known → `run.state`.
  - **Stops:** release (`pointerup`), `pointercancel`, lost pointer capture, `keyup`, the button's blur, the window's blur or `visibilitychange` to hidden, the button turning disabled or unmounting: each sends the jog cancel once. If the release comes before GRBL accepted the jog line, the cancel is sent again once it is accepted (the real-time `0x85` can overtake a `$J` line still in the serial buffer). One continuous jog at a time per window.
  - In Continuous the step control is replaced by the hint "Hold to jog; release to stop." at the same height (the pad does not move). Feeds as step jogs (2000 mm/min XY, 500 Z, capped by GRBL's max rates). Every source may jog the virtual machine continuously; on a real one only the UI ([run.md § Safety 2](run.md#2-who-may-command-a-real-connection-q50)).
- **Alarm with the next step:** while the machine is in Alarm, an **alarm panel** at the end of the navigator ([DF34](run.md#messages-never-move-controls-repeated-jog-clicks-df34): below the work zero, with a refused action's message) names the alarm, says what happened in plain words and lists what to do next; GRBL's own text follows in muted type. The notice line above the homing section keeps its short reason ("Home the machine first.", or for a critical alarm "Reset the machine first (Reset (immediate)), then home it."). The assertive announcement is unchanged (the run dialogs' announcer). GRBL's start-up lock (Alarm without an alarm code, not homed) is the next step, not an error ([run.md DF46](run.md#run-mode-presentation-df46)): the panel is then titled and named "Needs homing" like the badge, in neutral colours with an info icon, and lists the same steps; any `ALARM:n` keeps the red panel.

| Alarm                           | What happened                                                                       | Next steps                                                                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| none (locked at start, `$22=1`) | The controller starts locked until it is homed.                                     | Home the machine. Unlock only to jog an axis off a limit switch first.                                                                                                |
| 1 hard limit                    | A limit switch tripped while moving; the position is lost.                          | Reset (immediate). Check what tripped it: a crash, chips, a loose wire. If an axis rests on its switch, unlock and jog it off. Home the machine.                      |
| 2 soft limit                    | A move would have left the travel; the controller stopped it and kept the position. | Reset (immediate). Home the machine. Check the work zero and the program before the next run.                                                                         |
| 3 reset while moving            | The controller was reset during motion; steps may be lost.                          | Home the machine. Check the work zero.                                                                                                                                |
| 4 probe fail                    | The probe was already triggered before probing.                                     | Check the probe or plate wiring and that nothing touches it. Unlock.                                                                                                  |
| 5 probe fail                    | The probe made no contact within its travel.                                        | Check the plate and its clip on the bit. Unlock and probe again.                                                                                                      |
| 6 homing fail                   | Homing was reset before it finished.                                                | Home the machine again.                                                                                                                                               |
| 7 homing fail                   | The safety door opened during homing.                                               | Close the door. Home the machine again.                                                                                                                               |
| 8 homing fail                   | Homing could not pull off a limit switch.                                           | Check the limit switch and its wiring. Unlock, jog the axis off the switch, home again. The pull-off (`$27`) may be too short: change it with your controller's tool. |
| 9 homing fail                   | Homing found no limit switch within the search distance.                            | Check the limit switches and their wiring. Home again.                                                                                                                |
| 10 homing fail                  | Homing found no second switch for a self-squared axis.                              | Check both switches of the axis. Home again.                                                                                                                          |
| other                           | –                                                                                   | Reset (immediate), then home the machine.                                                                                                                             |

## Homing on a real controller

Real GRBL sends no status report during `$H` ([grbl.md](../architecture/grbl.md#homing-and-machine-coordinates)). The sender suspends the status watchdog while `$H` is in flight and gives the outstanding poll a fresh limit when `$H` ends ([run.md § Watchdogs](run.md#5-watchdogs)); the DRO shows the last position and the badge "Homing" until the `ok`. The 3D view's tool marker does not move during a real homing cycle. The virtual machine keeps reporting during homing by default (its documented deviation); its option `silentHoming: true` behaves like GRBL, for the tests of this path.

## Probing and re-zero (M4)

A Z touch plate replaces the nominal-thickness assumption for Z0 ([v0.2 known issues](../plans/v0.2.md#known-issues-and-risks)): the plate lies on the stock, its clip on the bit, and a probe move stops on contact. Implemented with M4 ([below](#implementation-m4)).

- **Plate thickness** is a machine field, `probePlateThickness` ([library.md](../architecture/library.md#machine)), set once in the Library window ("Touch plate thickness", group "Z height", beside DF69's "Touch plate size"). Run mode takes it from the plan's machine copy, else from the library machine the copy was taken from (the plate belongs to the workshop, not the plan; setting it in the library needs no plan update), and on a manual connection from the chosen library machine. Without a plate thickness no probe control shows; "Set Z zero here" stays.
- **Command** `run.machine.probeZ { plateThickness, maxTravel?: 25, feed?: 50, retract?: 2 }` (a `job`, like homing: a probe takes up to half a minute; `machine: true`, UI only on a real machine, [run.md § Safety 2](run.md#2-who-may-command-a-real-connection-q50)) → `{ workZero, contact }` (G54 and the contact point, machine coordinates, mm).
- **Host sequence:**
  1. Allowed when Idle without a run, or while a run waits at a tool change; else `run.state`. The spindle must report 0 rpm (`FS`), else `run.state`, rule `spindleOn` (a hand-switched router is the operator's: the confirmation asks). With soft limits on, the probe distance is cut to the travel (the probe never targets below `−$132`); less than 1 mm left → `run.travel`.
  2. `$G` is read (the modal state to restore), then `G21 G90 G38.2 Z<wpos.z − distance> F<feed>`, with a command timeout of the probe's duration plus 10 s.
  3. GRBL stops on contact and answers `[PRB:x,y,z:1]` (machine coordinates of the contact) and `ok`. The host sets G54 Z so the contact is at Z = plate thickness: `G10 L2 P1 Z<prb.z − plateThickness>` (exact: independent of how far the machine coasted past the contact while decelerating).
  4. Retract: `G53 G0 Z<min(prb.z + retract, 0)>`.
  5. Restore the modal state `$G` reported: units (`G20`/`G21`), distance (`G90`/`G91`) and motion: `G1 F<feed>` when it was `G1`–`G3` with a feed set, else `G0` (GRBL cannot set `G2`/`G3` without an arc; DFYOM's post restates the motion word after a tool change anyway, [grbl.md](../architecture/grbl.md#output-dialect)). Then `G4 P0` (its `ok` waits for the retract: `$#` needs Idle) and `$#` is read again.
- **Probe fails:** no contact within the distance → GRBL's `ALARM:5`; the probe input already closed before moving (the clip touches the plate, a wiring fault) → `ALARM:4`. `run.machine.probeZ` fails with `machine.alarm` (`data.code`); the alarm panel says what to do ([alarm table](#machine-readiness-m3): check the plate and clip, unlock, probe again). Neither alarm loses the position: `homed` stays. The modal state is restored after the unlock (`$X`), since GRBL refuses gCode in Alarm.
- **At a tool change** a probe alarm does not end the run: nothing of the program is in GRBL's buffers while it waits there (the sender waits for every `ok` and Idle first), so the sender keeps the run waiting; the operator unlocks, fixes the clip, probes again (or sets Z by hand) and continues. Any other alarm during a run still fails it.
- **Confirmation:** "Probe Z?" with "Put the touch plate on the stock under the bit and the clip on the bit. The spindle must be off. The bit moves down until it touches the plate (at most 25 mm)." and the plate thickness; confirm "Probe" ([run.md § Safety 3](run.md#3-confirmations-before-motion)). Every probe is confirmed, on the virtual machine too (the same muscle memory).
- **Where:** the Work zero section ("Probe Z", under the zero buttons), the tool-change dialog (next to "Set Z zero here") and the setup-change prompt (after a flip the stock's top is at its real thickness, not the nominal one). The live G54 under the controls shows the result; the alarm panel shows a failure.
- **Z reference surface (DF69):** at a tool change whose tool run touches off on a surface other than the stock top, the dialog names the surface and the spot, offers "Move to touch-off spot" when the machine is off it, and the probe's confirmation names the surface; the contact is still Z = plate thickness on that surface ([z-reference.md § Implementation notes](z-reference.md#implementation-notes-df69)).
- **Virtual machine:** the emulator learns `G38.2`–`G38.5` with a simulated plate ([grbl.md](../architecture/grbl.md#probing)); the host lays the virtual plate on the stock top at the current work zero Z (plate top = G54 Z + plate thickness; at a tool change onto a lower surface, on that surface: [z-reference.md](z-reference.md#implementation-notes-df69)), or 10 mm below the tool when that is not below it (an unset work zero), just before probing. The loopback port of the end-to-end tests has a fixed plate (top at MPos Z −60).

## Section resume (M5)

After a run stopped or failed, the operator restarts the setup's program at the **start of an operation** (its tool change included), never in the middle of one. Implemented with M5 ([below](#implementation-m5)).

- **Command:** `run.job.start { planId, setupId?, from: planOperationId }` (one optional argument on the existing command, not a new tool: the agent tool list is near its budget). `from` names a plan operation of the setup; another id is `input.malformed` (rule `unknownOperation`). Without `from` the whole program runs, as before. Every other rule of `run.job.start` applies unchanged (Idle and homed, the real-machine rules, the soft-limit check at the live G54, Q50: UI only on a real connection).
- **The resumed program** is exported by the post, not spliced from the full program's text, so modal suppression never leaves a word unstated. The operations before `from` are left out; the rest is the full program's from that operation on, behind a **re-entry**:
  1. The header: comments (the tools from `from` on, numbered as in the full program), `G90 G94 G17 G21|G20`, `G54`, `G0 Z<clearance>` (units, distance mode, feed mode, plane and WCS stated; Z up first, at the current XY).
  2. The operation's label comment, `M5`, then its tool's **tool-change marker and `M0`**: a resume always waits at the tool, whether or not it changes. A stop is often a broken or worn bit, the bit may have been pulled to clear chips, and the wait is the place to check it, change it and re-zero Z (by hand or with the touch plate, [M4](#probing-and-re-zero-m4)). DFYOM's sender guides it like any tool change ("Tool change n: name", Continue).
  3. After the wait (the post's existing post-`M0` restatement): `G90 G94 G17 G21|G20`, `G54`, `G0 Z<clearance>`, then the spindle: `M3 S<rpm>` and the spin-up dwell `G4 P<s>` (a manual spindle: the set-speed prompt and `M0`).
  4. `G0 X<x> Y<y>` to the operation's first point at the clearance height, then the operation's own moves: its rapid down to the retract height, the plunge, its first feed move carrying `G1` and `F`.
  - Modal state restored: units, distance mode, feed mode, plane, WCS, spindle direction and speed, feed (with the first feed move), the motion word. Coolant: DFYOM's post emits none, so there is none to restore.
- **The soft-limit check** runs on the resumed program at the live G54, like any run; as after any tool change that waits, Z is not checked past the wait (the operator may re-zero there, [grbl.md](../architecture/grbl.md#export-checks)).
- **Progress** counts the resumed program's lines; the section labels are its own (the same labels as in the full program).
- **Where the run stopped:** `RunStatus.lastRun` (kept until the next run starts, also across a lost connection and a reconnect) names the run that ended last: `{ jobId, planId, setupId, outcome: 'done' | 'stopped' | 'failed', planOperationId? }`. `planOperationId` is the **earliest operation GRBL may still have been executing**: the operation holding the line 16 lines before the last acknowledged one (GRBL plans up to 15 motion blocks ahead of the one moving, [run.md § Safety 6](run.md#6-lost-connection-disconnect-and-reconnect)), or the operation of the tool change the run waited at. Erring early re-cuts air; erring late would leave material.
- **UI:** after a stopped or failed run of the chosen plan and setup, the inspector shows **"Resume from…"** under "Start run" (and the failure dialog a "Resume from…" button next to Close). It opens the pre-flight in resume mode: title "Resume run?", a **"Resume at"** select of the setup's operations in machining order (`label · tool n: name`, the stopped one preselected and marked "(stopped here)"), the note "The run waits at the tool first: check or change it and set Z zero, then continue. The spindle starts and the machine moves to the operation's start at the clearance height.", the usual facts and gates (on a real machine: plan status, settings, air-cut hint not shown), and the primary button **"Resume run"** (real machine: "Resume on the machine"). Everything else as the [pre-flight](#pre-flight-on-a-real-machine).
- **Checked on the emulator:** for each operation of the [test part](../architecture/geometry.md#testing), the resumed program streamed through the virtual machine moves exactly as the full program from that operation's first point on (the end position of every motion line, in work coordinates, within the text resolution), including a resume whose tool-change wait re-zeroes Z with a `G38.2` probe on the emulator's plate; and end to end through the commands: a run stopped mid-operation, `lastRun`, a resume at that operation with Probe Z at the wait, run to the end.

## Run status and the zero to set (M7)

A run started in another window or by an agent, and the setup change after it, must say which plan and setup it is. Implemented with M7 ([below](#implementation-m7)).

- **`RunStatus.job.plan`** `{ planId, planName, setupId, setupName, setup, setups }` (`setup` the 1-based number of the setup, `setups` their count) and `job.planOperationId` (the operation of the line being acknowledged): set by `run.job.start` for the host's job, so every window and agent reads them from the status, also a window of another project (whose `job.get` cannot reach the job).
- **Inspector:** while a run job runs, the progress section names it above the bar: "Plan 1 · setup 2 of 2: Top" ("Plan 1" alone for a one-setup plan), and for a run this window did not start "Started in another window or by an agent." The navigator's plan and setup selects stay as the user left them.
- **Setup change after a run started elsewhere:** when the run this window follows ends with a `next` setup, the window's plan becomes the run's plan (`planId` in the result), so the prompt describes the right plan.
- **The zero to set:** the setup-change prompt adds a **"Zero to set"** row: "X0 Y0 at the front-left corner of the top, Z0 on the top surface" and the part corner that is (from the setup's work zero definition, [plan-v0.2.md § WCS corner](plan-v0.2.md#implementation-task-e2)): "This is the part's back-left corner." (the corner named by the part faces that meet there besides the up face), plus the stock's size on the machine "X 120 × Y 80 × Z 20 mm" to check the clamping. The picture's work-zero ring gets the label "X0 Y0". `run.job.start`'s `next` gains `corner` (that part corner, e.g. `back left`) for agents.

## Overrides (M6)

Feed, rapid and spindle overrides through GRBL's real-time bytes, while a run streams or the machine is idle. Implemented with M6 ([below](#implementation-m6)).

- **Command** `run.override.set { feed?, spindle?, rapid? }` (`effect`, `urgent`: it skips the project queue like the stop paths and runs during a run job; `machine: true`; one command rather than three keeps the agent tool list within its budget): `feed` and `spindle` take `'reset' | '+10' | '-10' | '+1' | '-1'` (`0x90`–`0x94`, `0x99`–`0x9D`), `rapid` takes `100 | 50 | 25` (`0x95`–`0x97`); at least one, sent in that order → `{ overrides? }` as next reported. GRBL clamps feed and spindle to 10–200 %; DFYOM sends the byte and shows what GRBL reports. Allowed while connected (`run.notConnected` otherwise), not during a critical alarm (`run.state`).
- **Permission (Q50):** on a real machine UI only, every action including `reset` (back to 100 % can speed a machine up: it is not a stop path); on the virtual machine every source.
- **Status:** `RunStatus.overrides { feed, rapid, spindle }` (percent) from the status report's `Ov` field, which GRBL sends every 10–20 reports and on the next report after a change; DFYOM keeps the last values between reports; a controller reset sets them to 100 % (GRBL restores them then, and at program end `M2`/`M30`, which the next `Ov` reports). Absent until the first `Ov`.
- **UI:** an "Overrides" section in the run inspector under the progress, while connected: two rows, "Feed" and "Spindle", each with the percentage in mono digits, "−10 %", "+10 %" and "Reset" (small text buttons with full accessible names; the 1 % steps are for agents and the API only), and "Rapids" as a segmented control 100 / 50 / 25 %. A value other than 100 % is marked in the warning tone with the hint "Overrides apply until reset or the program ends." The 3D view and the progress estimate are not rescaled.
- The machine toolbar's chip is unchanged; overrides are run-mode controls, not a global safety control.

## Fault injection (M8)

The new failure paths are tested end to end without hardware: commands → dispatcher → `MachineClient` → machine host → sender → loopback serial port → GRBL emulator.

- **Emulator hooks** ([grbl.md](../architecture/grbl.md#fault-injection)): `setProbePlate(z | undefined)` (the plate's top in MPos Z, or no plate: a probe finds nothing → `ALARM:5`; a tool already at or below the plate → `ALARM:4`), `triggerHardLimit()` (a limit switch closes: `ALARM:1`, critical, `[MSG:Reset to continue]`, like GRBL's limit pin interrupt) and `setSilent(true)` (the controller stops answering: no `ok`, no status report, as a hung board).
- **Loopback hooks:** `unplug()` (the port closes, existing) and the emulator's hooks above; `timeScale` runs the loopback's emulator faster than real time (`'max'`), so a whole program runs in a test while the sender keeps its real-time watchdogs.
- **Paths covered** (`src/core/run/commands.test.ts`, "fault injection on a real run"; the probe paths of the host in `host-serial.test.ts`, the emulator's in `emulator/probe.test.ts`): a lost connection mid-run (cable pulled: `machine.connection`, `connection.lost`, the run fails at once; a silent controller: the status watchdog's `machine.connection`); an alarm mid-run (hard limit: `machine.alarm` code 1, not homed, critical until reset); probe fail (`ALARM:5` on an idle machine, `ALARM:4` in the emulator; `ALARM:5` at a tool change keeps the run waiting, then unlock, probe again and continue to the end). The UI paths have component tests (`RunMode.test.tsx`) and the loopback e2e (`e2e/run-serial.e2e.ts`: a probe that misses, the alarm panel, unlock, a probe that touches).

## Testing

Per [testing.md](../conventions/testing.md); no hardware in CI.

- **Loopback serial:** `loopbackSerialPorts` (`src/core/run/grbl/loopback.fixture.ts`) is a `SerialPorts` whose `open()` returns a `ControllerTransport` wired to a `GrblEmulator` like a serial line: bytes are delivered asynchronously and in arbitrary chunks, the emulator may start silent (no banner until `0x18`) or with a delayed banner (Arduino reset), and the port can be "unplugged" (close event). The host, `MachineClient` and the run commands run over it in-process: connect with handshake, settings check (match and mismatch), homing with the silent-homing emulator (no watchdog failure), jog, a job on a finalized plan, refusals (draft plan, mismatch), unplug mid-run → `machine.connection`, disconnect sends `0x18`.
- **SerialTransport itself** (`serial-transport.test.ts`): against `serialport`'s `MockBinding` (`@serialport/binding-mock`, shipped with `serialport`): open, write and drain, data, close by DFYOM and by the device (`onClose`), open failure → `machine.connection`.
- **Permission:** `permission.test.ts` and `dispatcher.test.ts`: the [table](run.md#2-who-may-command-a-real-connection-q50) per source, including `job.resume` of a run job.
- **In the app (e2e):** with `DFYOM_LOOPBACK_SERIAL=1` the machine host offers one loopback port (`/dev/cu.usbmodem1101`, an emulator with GRBL's default settings, silent homing, a 300 ms banner delay) instead of the OS's ports; only end-to-end tests set it (`e2e/run-serial.e2e.ts`: picker, connect, chip, settings warning, Home confirmation; renders `design/features/renders/m1-{serial-picker,settings-warning,home-confirm}-{light,dark}.png` with `DFYOM_RENDERS=1`; M4/M6: a probe that misses, unlock, jog, a probe that touches, the overrides, renders `m4-probe-{confirm,alarm}` and `m6-overrides`). It also keeps the OS's device names out of committed renders. The loopback controller has a touch plate with its top at MPos Z −60; `DFYOM_LOOPBACK_TIMESCALE=<1–100>` runs its clock faster than real time (the probe test: a 50 mm/min probe that misses would take 30 s).
- **Manual with hardware:** the checklist in [testing.md](../conventions/testing.md) (hardening 1.3) before X1.

## Files

| File                                                      | Contents                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/core/run/serial.ts`                                  | `SerialPorts` port, `SerialPortInfo`, port sorting                 |
| `src/core/run/transport.ts`                               | `ControllerTransport` (+ optional `onClose`)                       |
| `src/core/run/settings-check.ts`                          | `settingsCheck(machine, settings)`: the `$$` comparison at connect |
| `src/core/run/grbl/loopback.fixture.ts`                   | Loopback serial ports over the emulator (tests)                    |
| `src/main/machine/serial-transport.ts`                    | `SerialTransport`, `nodeSerialPorts` (lazy `serialport`)           |
| `src/main/machine/serve.ts`                               | Passes `nodeSerialPorts` to the host                               |
| `src/renderer/src/modes/run/SerialPicker.tsx`             | Connect-to choice, port and baud selects, settings warning         |
| `src/core/run/commands.ts`                                | `run.connection.open` serial target, `run.ports.scan`              |
| `src/core/run/job.ts`                                     | Real-machine run checks (`realMachineChecks`)                      |
| `src/core/commands/permission.ts`                         | Q50 policy (`STOP_COMMANDS`)                                       |
| `src/renderer/src/modes/run/AlarmPanel.tsx`               | Alarm panel: what happened and the next steps (M3)                 |
| `src/renderer/src/modes/run/JogPad.tsx`                   | Step and continuous jog (M3)                                       |
| `src/core/run/grbl/emulator/emulator.ts`                  | Probe cycles, simulated plate, fault hooks (M4, M8)                |
| `src/core/run/host/host.ts`                               | `probeZ` sequence, modal restore, override bytes (M4, M6)          |
| `src/renderer/src/modes/run/ProbeZButton.tsx`             | "Probe Z" with its confirmation (M4)                               |
| `src/renderer/src/modes/run/OverridesSection.tsx`         | Inspector "Overrides" section (M6)                                 |
| `src/core/post/export.ts`, `src/core/post/plan-export.ts` | Resumed program (`resumeFrom`), `operationLines` (M5)              |
| `src/core/run/host/client.ts`                             | `job.plan`, `lastRun`, `stoppedOperation` (M5, M7)                 |
| `src/renderer/src/modes/run/RunDialogs.tsx`               | Pre-flight resume mode, failure dialog "Resume from…" (M5)         |
| `src/renderer/src/modes/run/SetupChangeDialog.tsx`        | Zero to set, part corner, stock on the machine (M7)                |

## Implementation (M1)

Decisions and findings of M1, where this doc left room:

- **Dependency:** `serialport` 13.0.0 (exact), loaded lazily in the machine host only; MIT; N-API prebuilds, no rebuild ([packaging.md](../conventions/packaging.md#native-modules)). Verified to load in Node, a worker thread and Electron's Node (`ELECTRON_RUN_AS_NODE`).
- **Port listing is an effect** (`run.ports.scan`), not a query: queries are synchronous.
- **Settings check:** any difference in a setting the machine copy sets blocks real runs; unset optional fields do not (`notInMachine`). `$20` and `$23` are now mapped by the `$$` import too ([library.md](../architecture/library.md#grbl--import)); `$23` bit 2 (Z homes down) is skipped (`zHomesDown`), DFYOM assumes Z homes up.
- **Check order in `run.job.start`:** plan status and the settings check come before "Idle and homed", so a draft plan or a mismatch is reported first (it is the fix the user needs to make before homing helps).
- **Done in M1 beyond the transport:** the plan status gate for real runs, disconnect = reset (`0x18`), the Home confirmation on a real unhomed machine, the pre-flight's target line, the Q50 policy including `job.resume` of a run job (the dispatcher checks the job's command). The rest of the real-run pre-flight (air-cut hint, "Start on the machine") stays M2.
- **Watchdog during `$H`:** suspended while `$H` is in flight; the outstanding poll gets a fresh limit when it ends. Covered with the emulator's `silentHoming`.
- **Not verified on hardware:** no controller was attached; the serial path ran over `MockBinding` (transport) and the loopback (host, commands, app).

## Implementation (M2)

- **Unexpected reset → not homed:** the host clears `homed` on a controller banner it did not cause (`reset` event with `expected: false`); an expected reset (Stop, `run.machine.reset`) keeps it unless GRBL raises a position alarm.
- **Lost connection:** `MachineClient` keeps `connection.lost` in the closed status after `connectionLost` or an unexpected host exit with a connection open; `connect` clears it.
- **Pre-flight:** plan status row, air-cut note, the two extra gates (plan status, settings mismatch) and "Start on the machine" on serial; the virtual pre-flight is unchanged.
- **Soft limits and homing** were already enforced for every target by the v0.1 run job; M2 adds serial-path tests (not homed after connect, after unlock and after an unexpected reset; a program outside the travel refused before streaming).
- **No confirmation flag on `run.job.start`:** the confirmation is the pre-flight in the UI, and agents cannot start real runs (Q50); a flag would only be ceremony for the one allowed source.
- **Not verified on hardware** (as M1).

## Implementation (M3)

- **DRO and per-axis zero** already existed (3.12, E2); M3 adds continuous jog and the alarm panel.
- **Continuous jog as an absolute move to the travel edge** rather than a long relative jog: the target is exact (`0` or `−travel`), so GRBL's own soft-limit check (`target > 0` or `< −travel`) never trips on rounding, and the host's travel estimate (`jogEnd`) is exact too.
- **Jog mode per window**, in the run store (`jogMode`), shared by the navigator's and the tool-change and setup-change dialogs' jog pads.

## Implementation (M4)

- **Plate thickness in the model:** `Machine.probePlateThickness` (Option, positive length), DTO `probePlateThickness` (flat, like DF69's `probePlateSize`); optional, so existing machine keys are unchanged.
- **Probe defaults** (`PROBE_DEFAULTS` in `host/protocol.ts`): 25 mm down, 50 mm/min, 2 mm retract; the UI uses them, agents may pass others on the virtual machine.
- **Unlock at a tool-change wait** is allowed (the only alarm that can be pending there is a probe's); `$X` then puts the modal state back and the host waits for a fresh status, so a probe right after the unlock sees Idle.
- **Emulator:** the contact is found on the executing block's motion profile (bisection on distance), the stop decelerates like a motion cancel, `[PRB]` holds the latched contact. G38.x in a jog is `error:16` as GRBL's `$J=` accepts only G1-style moves.
- **Not verified on hardware:** the sequence follows GRBL 1.1's documented probe behaviour; a real plate's debounce and probe pin polarity (`$6`) are untested.

## Implementation (M6)

- **One command** (`run.override.set`) instead of three: the agent tool list is close to its size budget.
- **Overrides pass a reserved client** (a job checking its program) like the stop paths: a real-time byte never interleaves with a line.
- **The reply** waits for one fresh status report, so it carries the `Ov` after the change.

## Implementation (M5)

- **In the post's input, not the text:** `ExportInput.resumeFrom` (an index into the operations) makes `toMachiningProgram` leave out the operations before it (tools keep their numbers) and prepend `M5`, the forced tool change and spindle blocks and a rapid to the first point at the clearance height; `exportPlan({ resumeFrom: planOperationId })` maps the id and passes `firstToolLoaded: false`, so the post's own tool-change path writes the marker, `M0` and the restated modes. No new post code path; the machine checks look at the operations that run.
- **Always a tool-change wait** rather than an option to skip it: one argument instead of two in the tool list (+118 characters, 119,350 of 120,000), and the wait is where the bit is checked and Z re-zeroed after a stop. The cost: as after any waiting tool change, Z is not soft-limit checked past it.
- **`PlanExport.operationLines`** (each operation's first line, matched on its label comment in order) feed `JobAbout`, which `run.job.start` hands to `MachineService.startJob`; `MachineClient` keeps the acknowledged line count from the progress and the last waiting phase, and records `lastRun` when the job ends (`PLANNER_LINES` = 16 lines back, or the tool change's operation).
- **UI:** "Resume from…" in the inspector (under "Start run", gated like it) and in the failure dialog; the pre-flight's resume mode is `resumeFrom` in the run store (`openResume()`), the points from `resumePoints(plan, setupId)` (`plan-info.ts`).
- **Tests:** `src/core/post/grbl/resume-run.test.ts` (the re-entry lines; every operation of the test part resumed and compared with the full run's motion on the emulator, one with a `G38.2` re-zero at its wait), `commands.test.ts` ("a stopped run is resumed at its operation": stop at a tool change, `lastRun`, `unknownOperation`, resume with Probe Z at the wait, to the end), `host/resume-point.test.ts`, `RunMode.test.tsx` (inspector and failure dialog paths, axe).
- **Not verified on hardware** (as M1).

## Implementation (M7)

- **The status carries the names** (`job.plan`), not only ids: a window of another project cannot look the plan up.
- **"Started elsewhere"** is any followed run whose job id this window did not start (`startedHere` in the run store).
- **The part corner** moved to core (`setupZeroCorner` in `toolpath/wcs.ts`), shared by Plan's setup inspector, the setup-change prompt and `run.job.start`'s `next.corner`.
