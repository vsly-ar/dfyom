# Run mode

Status: draft · Terms: [glossary.md](../glossary.md)

**Goal:** interact with the CNC machine. The baseline is running gCode; the mode goes far beyond that by integrating external devices.

The v0.1 subset (streaming to the virtual machine, utility process, run commands, progress) is specified in [run-v0.1.md](run-v0.1.md).

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
- **Navigator:** the plan list has "No plan (manual control)" first; the first runnable plan stays the default when one exists. With no plan, a "Machine" select lists the library machines and "Connect" uses it. Home, unlock, jog, work zero, Stop, Reset and the DRO work without a plan; only "Start run" needs one ("Choose a plan first.").

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
- **Repeated step jogs queue:** jog stays enabled while jogging (GRBL plans `$J=` lines behind each other); every click sends one `$J=G91 …` that GRBL appends; a click whose target leaves the travel is refused in words (above) and the earlier jogs continue. "Stop jog" (`0x85`) cancels them all. There is no continuous (hold-to-jog) mode yet ([hardening M3](../plans/hardening.md#5-real-machine)).

### Stop only when something can be stopped (DF35)

Stop is enabled while there is something to stop: a run job (any phase, including waits), or the machine moving or held without one (`Jog` → jog cancel; `Home` → reset, `ALARM:6`; `Run`, `Hold`, `Door` without a job → reset). Otherwise (Idle, Alarm, Check, not connected) it is disabled and says why ("Nothing to stop: the machine is not moving."). Feed hold (while streaming), Resume (while held) and "Reset (immediate)" (always, while connected) keep the other paths reachable.

### Run mode presentation (DF46)

Status: implemented (hardening DF46, UX audit 2026-11-23 items 7–9 and 23) · UI rules: [ui.md](../conventions/ui.md#run-mode-safety-ui)

What a first-timer sees from Connect to the first run. Only the presentation changes: every gate, refusal, confirmation and the Stop rules stay as they are.

- **The toolbar never changes height.** The main toolbar always reserves the height of the 44 px run controls (Stop, Feed hold, Resume), so connecting or disconnecting never moves the window content. The run controls stay 44 px.
- **Position unknown until homed.** While the machine is not homed (or not connected), the DRO shows "—" for every work and machine coordinate, with "Position unknown until homed." under the table. The numbers come back after a successful `$H` (or at once on a machine without homing, which counts as homed). After "Unlock" without homing the position stays unknown, as the unlock confirmation says. The tool marker in the 3D view is unchanged.
- **Needs homing, not an error.** GRBL with homing enabled starts locked in `Alarm` without an alarm code, because the position is unknown. While the state is `Alarm`, there is no alarm code and the machine is not homed, the badge says **"Needs homing"** (its own shape: a house in the hold colour, not the red octagon) and the navigator's Home is the primary action, with "Home the machine first." in the notice. Any `ALARM:n` (soft or hard limit, reset while moving, homing fail) stays the red "Alarm n: …" badge, and every control is gated exactly as in Alarm.
- **Connect** reads just "Connect", on one line (the audit saw "Connect to virtual machine" wrap in the 16 rem navigator); the hint under it says what it connects to ("To a virtual machine that simulates …"), and the "Virtual machine · 10×" chip says it once connected. "Connect to the virtual machine first." shows once, in the navigator's notice; the inspector's disabled "Start run" is described by its "No run yet. Connect, home, …" line instead of repeating it.
- **Program pause** (`M0`): the badge says "Paused by program"; the dialog says the program paused the run, then names `M0` in a small details line. "Later" becomes **"Close (stay paused)"** in the program-pause and tool-change dialogs (the run waits; the inspector's "Show instructions" reopens the dialog). The setup-change prompt keeps "Later": no run is paused there.
- **Stop jog** uses the default button look (bordered when enabled, dimmed when disabled), like the jog buttons.
- **Pre-flight shows the soft-limit result.** Opening "Start run?" runs `run.job.check` ([run-v0.1.md](run-v0.1.md#commands-and-queries)): the same checks and export as `run.job.start` up to the soft-limit check, without streaming. The Soft limits row says "Checking…", then "Inside the travel at this work zero." or, per axis, "X leaves the travel: the program spans −812.000 to −12.000 mm, the travel is −800 to 0 mm." "Start run" is enabled only when the check passed; with findings the dialog focuses Cancel and says to move the work zero. The check runs again when the work zero changes while the dialog is open. A failed check (e.g. the program cannot be exported) shows its error in the row and keeps "Start run" disabled, since the start would fail the same way; `run.job.start` still runs every check itself.

## Safety

To be specified before any real-machine control is implemented: e-stop semantics, what automation/LLMs may never do without confirmation, watchdogs.

## Open questions

- Controllers after the GRBL family ([ADR 0013](../decisions/0013-grbl-first-controller.md)).
- MCU communication protocol (serial, USB, network; message schema).
- Script sandboxing per language.
