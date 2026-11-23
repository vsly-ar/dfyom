# Run mode

Status: draft · Terms: [glossary.md](../glossary.md)

**Goal:** interact with the CNC machine. The baseline is running gCode; the mode goes far beyond that by integrating external devices.

The v0.1 subset (streaming to the virtual machine, utility process, run commands, progress) is specified in [run-v0.1.md](run-v0.1.md); the real machine over a serial port in [run-machine.md](run-machine.md), under the [safety rules](#safety).

## Devices

- **Sensors:** cameras, vibration, temperature, weight/pressure, distance, power consumption, flow meters, encoders, external RPM monitor (when the spindle doesn't report RPM).
- **Actuators:** servos, solenoids, relays, alarms, …
- Usually reached through **external controllers (MCUs)** the app communicates with.

## What this enables

1. **Detection of things going wrong** – chatter, loose parts, air-cutting where the tool should be engaging, collisions; machine vision for humans and other foreign objects.
2. **Extended machine capabilities** – external tool-changer automation; coolant / mist / compressed air / vacuum cleaning / vacuum table / ventilation / temperature automations.
3. **Lights-out cycles** – automatic setup changes, collecting finished parts, replacing stock and restarting the cycle.
4. **Calibration, measurement, testing, troubleshooting** – (semi-)automatic: resonant frequencies, motor load, thermal behaviour, tolerances/precision.

## Automation and LLMs

Automations can be scripts (JS/TS/Python/Lua) authored by users or LLMs, and/or an active LLM session watching the run via hooks and periodic checks. → [architecture/llm-api.md](../architecture/llm-api.md)

## Machine frame and manual control (hardening DF31–DF35)

Status: implemented (hardening, dogfood batch 1: DF31–DF35) · Spec of the v0.1 flow: [run-v0.1.md](run-v0.1.md) · GRBL facts and the virtual machine: [grbl.md](../architecture/grbl.md#homing-and-machine-coordinates) · Machine fields: [library.md](../architecture/library.md#machine) · UI: [ui.md](../conventions/ui.md#run-mode-safety-ui)

Manual control (position read-out, homing, jog, work zero) must work before and without a plan, and the 3D view must show where the spindle, the travel and the stock really are.

### Connect without a plan (DF31)

- `run.connection.open` takes **either** `planId` (the plan's machine copy, as in v0.1) **or** `machineId` (a library machine), exactly one (`input.malformed`, rule `oneOf`). The machine key of a library machine is the hash of its values, the same hash a plan's unchanged snapshot of it has ([run-v0.1.md decision 6](run-v0.1.md#decisions)), so a plan whose machine copy equals the connected library machine can be run on that connection; any other plan fails with `machineMismatch` as before.
- **Navigator:** the plan list has "No plan (manual control)" first; the first runnable plan stays the default when one exists. With no plan, a "Machine" select lists the library machines and "Connect to virtual machine" uses it. Home, unlock, jog, work zero, Stop, Reset and the DRO work without a plan; only "Start run" needs one ("Choose a plan first.").

### Machine coordinates and the homing corner (DF33)

GRBL 1.1 without `HOMING_FORCE_SET_ORIGIN` (the default build) always puts the travel in **negative space**: machine coordinates span `[−travel, 0]` on every axis, whatever the homing direction ([grbl.md](../architecture/grbl.md#homing-and-machine-coordinates)). Where the machine homes only decides the machine position after `$H`:

| Axis homes towards      | `$23` bit | Switch at MPos | MPos after `$H`    |
| ----------------------- | --------- | -------------- | ------------------ |
| + (right, back, top)    | clear     | 0              | −pull-off (`$27`)  |
| − (left, front, bottom) | set       | −travel        | −travel + pull-off |

- The machine profile names the **homing corner** in XY (`backRight` = GRBL's default `$23=0`, `backLeft`, `frontRight`, `frontLeft`; Z always homes up), the **pull-off** (`$27`) and **soft limits** (`$20`), next to the travel (`$130–$132`) it already had ([library.md](../architecture/library.md#machine)). They configure the virtual machine; for a real controller they must match its `$$` (checked on connect with the real-machine lane, [hardening M1](../plans/hardening.md#5-real-machine)).
- Example (the dogfood machine, top-right homing, i.e. `backRight`, pull-off 1 mm): after homing the DRO reads −1/−1/−1. +X can move 1 mm (to 0); a further +X jog would leave the travel. That is correct; what was wrong was the view and the message.
- **Soft-limit refusals in words:** before sending a jog, the host computes its target (relative jogs from the last report, or from the end of the jogs it already queued while jogging) and, with soft limits on, refuses one outside `[−travel, 0]` with `run.travel` (`data: { axis, target, min, max }`), e.g. "X would leave the travel: max 0 mm, the jog would end at 1 mm." If GRBL still answers `error:15` (the estimate can lag a queued jog), the reply becomes the same `run.travel`. The navigator words it with the project's units.
- **3D view:** the run scene draws the **machine travel** (the work envelope `[−travel, 0]`, as a box outline) and the home position (a marker at the homing corner), placed through the work zero: in work coordinates the travel is `[−travel, 0] − G54`, so the travel, the stock at its work zero and the spindle at `wpos` are consistent with machine coordinates. A stock outside the travel shows where it is; with G54 still at 0 (never set) the Work zero section's G54 line adds "The work zero is at machine 0, the home corner: jog to the stock's zero corner and set it." The travel box widens the framing bounds.
- The travel, homing mask, pull-off and soft-limit flag come from the controller's `$$` at connect (`RunStatus.envelope`), never from the plan, so the view shows what the controller enforces.

### Homing on the virtual machine moves (DF32)

The virtual machine plays GRBL's homing cycle in time (Z, then X and Y together; seek, pull-off, locate, pull-off at `$25`/`$24`) and reports the moving position in `Home` state, so the tool marker travels to the home corner. It powers up at the centre of its travel (the app passes the start position; real GRBL reports 0,0,0 until homed, and the position is unknown either way). Details and the deviation from GRBL (which sends no status reports during homing) in [grbl.md](../architecture/grbl.md#homing-and-machine-coordinates).

### Messages never move controls; repeated jog clicks (DF34)

- The navigator's notice of why controls are disabled sits between the connection and homing sections in a **reserved status line** (two lines high, always present, `role="status"`; with nothing disabled it says "Ready to jog." — short texts only, so it never grows), so a reason appearing while the machine jogs or homes never shifts the jog pad.
- A refused action (`ErrorMessage`) shows **at the end of the navigator**, below the work-zero section, never above the controls.
- **Repeated step jogs queue:** jog stays enabled while jogging (GRBL plans `$J=` lines behind each other); every click sends one `$J=G91 …` that GRBL appends; a click whose target leaves the travel is refused in words (above) and the earlier jogs continue. "Stop jog" (`0x85`) cancels them all. A continuous (hold-to-jog) mode jogs to the travel edge while a button is held and cancels on release ([run-machine.md § Machine readiness](run-machine.md#machine-readiness-m3), M3).

### Stop only when something can be stopped (DF35)

Stop is enabled while there is something to stop: a run job (any phase, including waits), or the machine moving or held without one (`Jog` → jog cancel; `Home` → reset, `ALARM:6`; `Run`, `Hold`, `Door` without a job → reset). Otherwise (Idle, Alarm, Check, not connected) it is disabled and says why ("Nothing to stop: the machine is not moving."). Feed hold (while streaming), Resume (while held) and "Reset (immediate)" (always, while connected) keep the other paths reachable.

## Safety

Status: draft (hardening 1.1, 2026-11-23; awaits the user's answers to [Q49–Q52](../plans/hardening.md#questions-for-the-user)) · Real-machine lane: [run-machine.md](run-machine.md) · Virtual-machine rules: [run-v0.1.md § Safety (v0.1)](run-v0.1.md#safety-v01) · Protocol facts: [grbl.md](../architecture/grbl.md#transport-and-sender)

The rules every connection to a **real machine** (a controller on a serial port) follows, for every source and every window. The [virtual machine](run-v0.1.md#safety-v01) keeps its looser rules (no hardware moves). Each rule names where it is implemented: M1 (done on this branch) or the [hardening task](../plans/hardening.md#5-real-machine) that still implements it.

**Assumptions until Q49–Q52 are answered** (a different answer reopens this section):

- **A1 (Q49):** a GRBL 1.1–compatible controller (banner `Grbl 1.1…`, `$I` `1.1…`) on USB serial, with homing switches (`$22=1`), on a fixed-gantry machine that homes to the back right with Z up (`$23=0`); a spindle switched by hand or by `M3 S`. grblHAL extras and FluidNC are out.
- **A2:** the machine has a **hardware emergency stop** within the operator's reach that removes power from the spindle and the stepper drivers (at least the spindle) without software. DFYOM's Stop is not an emergency stop.
- **A3 (Q50):** machine-moving commands on a real connection come **from the UI only**; agents read, wait, hold and stop.
- **A4 (Q51):** the first cuts happen in two steps: DFYOM's exported program through the user's existing sender first, then through DFYOM's sender.
- **A5 (Q52):** the real-machine lane has the scope Q52 recommends ([run-machine.md § Scope](run-machine.md#scope)).

### 1. Emergency stop, stop and reset

| Control                                       | What it does                                                                                                                                                                                                                                                            | Who may use it on a real connection |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Hardware e-stop** (A2)                      | Cuts power outside DFYOM; works when the app, the USB link or the controller hangs. The only stop the operator can rely on once DFYOM has lost the connection.                                                                                                          | The operator                        |
| **Stop** (`job.abort`, toolbar, every dialog) | Controlled stop: feed hold `!`, wait for `Hold:0` (≤ 5 s), then soft reset `0x18`; the position survives, the spindle stops, GRBL's buffers are flushed ([run-v0.1.md](run-v0.1.md#stop-errors-and-alarms)). Without a job: jog cancel, or a reset while homing (DF35). | Every source                        |
| **Feed hold** (`job.pause`, `Esc`)            | `!`: decelerates and holds; the **spindle keeps turning** (GRBL). Resume (`~`) is motion and follows the motion rules of § 2.                                                                                                                                           | Every source                        |
| **Jog cancel** (`run.machine.jogCancel`)      | `0x85`: ends every queued jog.                                                                                                                                                                                                                                          | Every source                        |
| **Reset (immediate)** (`run.machine.reset`)   | `0x18` at once. During motion GRBL raises `ALARM:3` (position lost: home again).                                                                                                                                                                                        | Every source                        |

- **Stopping is never refused and never confirmed** ([ui.md](../conventions/ui.md#confirmations)): stop, hold, jog cancel and reset are allowed for every source on every connection, skip the command queue (`urgent`) and need no plan, no homing and no reservation.
- **Reset:** GRBL keeps G54 over a reset (EEPROM) and loses the position only when the reset interrupts motion (`ALARM:3`); after any position alarm DFYOM marks the machine **not homed**, which blocks runs until `$H` ([run-v0.1.md](run-v0.1.md#implementation-task-39)). A reset never restarts a program.
- **Critical alarms** (`ALARM:1` hard limit, `ALARM:2` soft limit): GRBL answers nothing until a reset; DFYOM refuses every other command until then and shows the alarm with the next step (reset, then home; wording: [run-machine.md § Machine readiness](run-machine.md#machine-readiness-m3), M3).

### 2. Who may command a real connection (Q50)

The permission policy ([commands.md](../architecture/commands.md#dispatcher-pipeline) step 5, `src/core/commands/permission.ts`) decides per command and source. **M1.**

| Command                                                                                                                                             | UI (a person at the app) | Agents, CLI, automation, system                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| Reading: `run.status.get`, `run.ports.scan`, `job.get`, `job.list`, `job.wait`; plan and export commands                                            | yes                      | yes                                                                      |
| Stop paths: `job.pause`, `job.abort`, `run.machine.jogCancel`, `run.machine.reset`                                                                  | yes                      | yes                                                                      |
| `run.connection.open { target: 'serial' }`; `run.connection.close` of a real connection                                                             | yes                      | **no** (`permission.denied`)                                             |
| Motion and machine state: `run.machine.home`, `.unlock`, `.jog`, `run.workZero.set`, `run.job.start`, `run.job.continue`, `job.resume` of a run job | yes                      | **no** (`permission.denied`)                                             |
| Anything on the virtual machine                                                                                                                     | yes                      | yes (unchanged, [grbl.md](../architecture/grbl.md#transport-and-sender)) |

- Deny by default: a command the table does not name, a connection still opening, an unknown target or a process without a machine port counts as real.
- `job.resume` is not a machine command, but resuming a held run is motion: before resuming a job whose command is a machine command, the dispatcher asks the policy with that command (`run.job.start`).
- The refusal says why: `permission.denied`, `data: { command, source, target }`, message "agent sources may not run run.machine.jog on a real machine; the user runs it from the app". The exit criterion's agent variant ends at `plan.export`; the user runs it from the app.
- **Later** (not in hardening): agent-started real runs, each confirmed in the app by the user, with a watchdog that holds the run when the agent stops polling.

### 3. Confirmations before motion

Machine motion the operator has not seen coming is confirmed once, where it starts.

| When                                             | Asks                                                                                                                                                                                                                                                                    | Status                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Home** on a real connection while not homed    | "Home the machine? It moves to its home corner. Keep hands clear and know where the emergency stop is." Confirm "Home".                                                                                                                                                 | M1                                                                                      |
| Unlock without homing                            | As today ([ui.md](../conventions/ui.md#run-mode-safety-ui)): the position is unknown until homed.                                                                                                                                                                       | existing                                                                                |
| **Start run** on a real connection               | The pre-flight names the real target ("Serial port /dev/cu.usbmodem1101 at 115200 baud") and, beyond today's contents, the plan status and the air-cut hint ("First run: spindle off, Z zero raised above the stock"); its primary button reads "Start on the machine". | M1 target line; rest M2 ([run-machine.md](run-machine.md#pre-flight-on-a-real-machine)) |
| **Continue** after a tool change or setup change | The dialog states the Z zero to set and that the spindle starts again; continuing is the confirmation.                                                                                                                                                                  | existing                                                                                |
| Resume after a feed hold                         | No dialog; a deliberate click, never a single key ([ui.md](../conventions/ui.md#confirmations)).                                                                                                                                                                        | existing                                                                                |

Jogs are not confirmed: they are short, cancellable, refused outside the travel (`run.travel`) and start only from a click.

### 4. Before a real run streams

Checked by `run.job.start` (main) and again by the host at `jobStart` ([run-v0.1.md § Run job](run-v0.1.md#run-job)); any failure refuses the start before a byte is sent.

1. The plan is `finalized` or `inUse` ([run-machine.md amendment of decision 5](run-machine.md#amendments-to-run-v01md)). **M1.**
2. The controller's `$$` matches the connection's machine copy in every mapped setting and has homing enabled ([run-machine.md § Settings check](run-machine.md#settings-check)); else `run.state`, rule `settingsMismatch`. **M1.**
3. Idle, homed in this connection (not after an unexpected controller reset: M2), the work zero re-read (`$#`) and unchanged since the check, the soft-limit check passed (existing; covered on the serial path in M2).
4. The connection is reserved for the job from its checks to its stream (existing).

### 5. Watchdogs

| Watchdog             | Limit                                                                                                                                                                                                                                                       | On expiry                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Status reply         | 2 s wall per `?` (polled at 5 Hz)                                                                                                                                                                                                                           | `machine.connection` ("no status reply"): a lost connection (§ 6)                                                             |
| **Homing exception** | none while `$H` is in flight: real GRBL runs no realtime protocol inside the homing cycle and answers `?` only after it ([grbl.md](../architecture/grbl.md#homing-and-machine-coordinates)). After `$H` ends the outstanding poll gets a fresh 2 s. **M1.** | The `$H` command timeout still applies; Stop (reset → `ALARM:6`) always works, since GRBL checks for a reset inside the cycle |
| Command reply        | 10 s; `$H` 10 min                                                                                                                                                                                                                                           | `machine.connection`                                                                                                          |
| Lost `ok`            | Idle reported while a line waits, for 5 s plus the dwells in flight                                                                                                                                                                                         | `machine.connection`                                                                                                          |
| Port closed          | the serial port reports `close` (cable pulled, board without power). **M1.**                                                                                                                                                                                | `machine.connection` at once                                                                                                  |
| Critical alarm       | the status watchdog is suspended until the reset (GRBL is silent)                                                                                                                                                                                           | –                                                                                                                             |
| Banner mid-session   | the controller restarted on its own                                                                                                                                                                                                                         | a running job fails (`machine.connection`, or `machine.alarm` 3 during motion); not homed                                     |
| Host exit            | the machine host process ended                                                                                                                                                                                                                              | as a lost connection                                                                                                          |

The windows are not watched: the host streams without them ([run-v0.1.md § Processes](run-v0.1.md#processes)), a frozen window never stops a run, and every window offers Stop. No agent watchdog is needed while agents cannot start motion (§ 2).

### 6. Lost connection, disconnect and reconnect

A lost USB link **cannot be made safe by DFYOM**: GRBL keeps executing what is in its buffers (up to 15 planned motion blocks and 128 bytes of lines: seconds of cutting, more for long moves) with the spindle on, then stops with the spindle still on (no `M5` arrives).

- DFYOM fails the job with `machine.connection`, closes the connection (no automatic reconnect: the controller's state is unknown) and says so: "Connection to the machine lost. It may still be moving and the spindle may still be on: use the emergency stop." (the real-target failure dialog and the navigator: [run-machine.md § Lost connection](run-machine.md#lost-connection-m2), M2).
- **Reconnect = reset:** opening the port resets most Arduino-based GRBL boards (DTR); otherwise the handshake sends `0x18` when no banner comes. Either way buffered motion ends and GRBL starts locked (`$22=1`): the new connection is **not homed** and must home before a run.
- **Disconnect = reset:** closing a real connection on purpose (`run.connection.close`, app quit) sends `0x18` before closing the port, also when Idle, so no queued jog or line runs on after DFYOM let go. A running job is stopped first (hold, then reset), as on the virtual machine. **M1.**
- App quit during a run asks first, then stops the run (existing, [run-v0.1.md](run-v0.1.md#implementation-task-312-run-mode-ui)).

### 7. What DFYOM never does on a real machine

- Write GRBL settings (`$x=`), send raw gCode or `$` lines (no MDI console, Q52), restart a program at an arbitrary line, or reconnect on its own.
- Stream a program it did not export, in the same job, from a finalized plan at the live work zero.
- Change a plan's machine copy to match the controller silently ([library.md](../architecture/library.md#grbl--import)).

### Testing the rules

Without hardware: the sender and the host over a loopback serial stream against the GRBL emulator in its GRBL-exact silent-homing mode ([run-machine.md § Testing](run-machine.md#testing)); the permission table per source (`permission.test.ts`); fault injection (lost port, alarm mid-run) with M8. With hardware: the manual checklist of [testing.md](../conventions/testing.md) (hardening 1.3) before X1.

## Open questions

- Controllers after the GRBL family ([ADR 0013](../decisions/0013-grbl-first-controller.md)).
- MCU communication protocol (serial, USB, network; message schema).
- Script sandboxing per language.
