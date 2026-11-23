# Run on a real machine

Status: draft (hardening 1.2, 2026-11-23; awaits the user's answers to [Q49–Q52](../plans/hardening.md#questions-for-the-user); [M1](#implementation-m1), [M2](#implementation-m2) and [M3](#implementation-m3) implemented on branches) · Safety rules: [run.md § Safety](run.md#safety) · Base: [run-v0.1.md](run-v0.1.md) · Protocol facts: [grbl.md](../architecture/grbl.md) · Decision: [ADR 0013](../decisions/0013-grbl-first-controller.md) · Tasks: [hardening](../plans/hardening.md#5-real-machine) M1–M8

Run mode on a real GRBL controller over a USB serial port: the same sender, host, commands and UI as the [virtual machine](run-v0.1.md), with a `SerialTransport` under the sender, a port picker, the controller's settings checked against the machine copy, and the real-machine rules of [run.md § Safety](run.md#safety). This doc specifies DFYOM's side; GRBL facts stay in [grbl.md](../architecture/grbl.md).

## Assumptions

Until the user answers Q49–Q52, this doc assumes ([run.md § Safety](run.md#safety) A1–A5):

- **Machine (Q49):** a GRBL 1.1–compatible controller (an Arduino-class board: banner `Grbl 1.1…`, 115200 baud by default) on USB serial, with homing switches (`$22=1`) and soft limits on; a fixed-gantry router that homes to the **back right with Z up** (`$23=0`, the [`fixedGantry`](../architecture/library.md#machine) preset); a hand-switched router or a PWM spindle (`M3 S`). No probe is assumed; a Z touch plate is optional (M4).
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
- **Alarm with the next step:** while the machine is in Alarm, an **alarm panel** at the end of the navigator ([DF34](run.md#messages-never-move-controls-repeated-jog-clicks-df34): below the work zero, with a refused action's message) names the alarm, says what happened in plain words and lists what to do next; GRBL's own text follows in muted type. The notice line above the homing section keeps its short reason ("Home the machine first.", or for a critical alarm "Reset the machine first (Reset (immediate)), then home it."). The assertive announcement is unchanged (the run dialogs' announcer).

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

Planned design; implemented with M4 and accepted with it.

- **Command** `run.machine.probeZ { plateThickness, maxTravel?: 25, feed?: 50, retract?: 2 }` (UI only on a real machine): `G38.2 Z-<maxTravel> F<feed>` from the current position, then on contact the host reads `[PRB:x,y,z:1]`, sets G54 Z so the contact point is `plateThickness` (`G10 L20 P1 Z<thickness>`), and retracts `G91 G0 Z<retract>`. No contact within `maxTravel` → GRBL's `ALARM:5` (probe fail) → `machine.alarm` with the next step ("Check the plate and its clip, then unlock").
- Before probing the UI asks "Is the plate under the tool and the clip on the bit?" (confirm "Probe"); the spindle must be off (GRBL refuses nothing here, so the host checks `FS` spindle = 0, else `run.state`).
- **Where:** the Work zero section ("Probe Z"), the tool-change dialog (after a tool change: replaces "Set Z zero here" when a plate thickness is set) and the setup-change prompt (after a flip). The plate thickness is a machine field (`probe.plateThickness`, library.md) so it is set once.
- The emulator learns `G38.2`/`G38.3` with a test hook for the plate height and `[PRB:…]` in `$#` (grbl.md's "not emulated" list shrinks).

## Section resume (M5)

Planned design; implemented with M5.

- After a run stopped or failed, `run.job.start { planId, setupId, from: { section } }` restarts the setup's program at a **section boundary**: a tool change marker or an operation start ([`programSections`](run-v0.1.md#progress)). The sections are offered in the failure dialog and the pre-flight ("Resume at: pocket1 · tool 2"), defaulting to the section the run stopped in.
- **Safe re-entry** (prepended by the post, not hand-written): the program's preamble (units, modes, `G54`), the section's tool change prompt when the tool differs from the one in the spindle, spindle on with its dwell, a rapid to the clearance height, then XY to the section's first point, then the section. Lines before the section are not sent; their modal state is restated by the preamble.
- Checked on the emulator: the resumed program's motion from the section on equals the full program's (trace comparison).

## Overrides (M6)

Planned design; implemented with M6.

- Commands `run.override.feed { action: 'reset' | '+10' | '-10' | '+1' | '-1' }` and `run.override.spindle { … }` (the same steps) send GRBL's real-time bytes (`0x90–0x94`, `0x99–0x9D`); rapid overrides (`0x95–0x97`) as `run.override.rapid { percent: 100 | 50 | 25 }`. Allowed while connected; on a real machine UI only, except `reset` (back to 100 %), which every source may send.
- `RunStatus.overrides { feed, rapid, spindle }` from the status report's `Ov` field (every 10–20 reports, and after each change); the inspector shows them next to the progress with − / + / reset buttons.

## Testing

Per [testing.md](../conventions/testing.md); no hardware in CI.

- **Loopback serial:** `loopbackSerialPorts` (`src/core/run/grbl/loopback.fixture.ts`) is a `SerialPorts` whose `open()` returns a `ControllerTransport` wired to a `GrblEmulator` like a serial line: bytes are delivered asynchronously and in arbitrary chunks, the emulator may start silent (no banner until `0x18`) or with a delayed banner (Arduino reset), and the port can be "unplugged" (close event). The host, `MachineClient` and the run commands run over it in-process: connect with handshake, settings check (match and mismatch), homing with the silent-homing emulator (no watchdog failure), jog, a job on a finalized plan, refusals (draft plan, mismatch), unplug mid-run → `machine.connection`, disconnect sends `0x18`.
- **SerialTransport itself** (`serial-transport.test.ts`): against `serialport`'s `MockBinding` (`@serialport/binding-mock`, shipped with `serialport`): open, write and drain, data, close by DFYOM and by the device (`onClose`), open failure → `machine.connection`.
- **Permission:** `permission.test.ts` and `dispatcher.test.ts`: the [table](run.md#2-who-may-command-a-real-connection-q50) per source, including `job.resume` of a run job.
- **In the app (e2e):** with `DFYOM_LOOPBACK_SERIAL=1` the machine host offers one loopback port (`/dev/cu.usbmodem1101`, an emulator with GRBL's default settings, silent homing, a 300 ms banner delay) instead of the OS's ports; only end-to-end tests set it (`e2e/run-serial.e2e.ts`: picker, connect, chip, settings warning, Home confirmation; renders `design/features/renders/m1-{serial-picker,settings-warning,home-confirm}-{light,dark}.png` with `DFYOM_RENDERS=1`). It also keeps the OS's device names out of committed renders.
- **Manual with hardware:** the checklist in [testing.md](../conventions/testing.md) (hardening 1.3) before X1.

## Files

| File                                          | Contents                                                           |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `src/core/run/serial.ts`                      | `SerialPorts` port, `SerialPortInfo`, port sorting                 |
| `src/core/run/transport.ts`                   | `ControllerTransport` (+ optional `onClose`)                       |
| `src/core/run/settings-check.ts`              | `settingsCheck(machine, settings)`: the `$$` comparison at connect |
| `src/core/run/grbl/loopback.fixture.ts`       | Loopback serial ports over the emulator (tests)                    |
| `src/main/machine/serial-transport.ts`        | `SerialTransport`, `nodeSerialPorts` (lazy `serialport`)           |
| `src/main/machine/serve.ts`                   | Passes `nodeSerialPorts` to the host                               |
| `src/renderer/src/modes/run/SerialPicker.tsx` | Connect-to choice, port and baud selects, settings warning         |
| `src/core/run/commands.ts`                    | `run.connection.open` serial target, `run.ports.scan`              |
| `src/core/run/job.ts`                         | Real-machine run checks (`realMachineChecks`)                      |
| `src/core/commands/permission.ts`             | Q50 policy (`STOP_COMMANDS`)                                       |
| `src/renderer/src/modes/run/AlarmPanel.tsx`   | Alarm panel: what happened and the next steps (M3)                 |
| `src/renderer/src/modes/run/JogPad.tsx`       | Step and continuous jog (M3)                                       |

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
