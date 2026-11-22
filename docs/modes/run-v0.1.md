# Run mode v0.1: streaming to the virtual machine

Status: implemented ([below](#implementation-task-39); UI: [task 3.12](#implementation-task-312-run-mode-ui)) · Vision: [run.md](run.md) · Protocol, emulator, post: [grbl.md](../architecture/grbl.md) · Decisions: [ADR 0013](../decisions/0013-grbl-first-controller.md), [ADR 0016](../decisions/0016-compute-workers-in-dispatcher-process.md) · Jobs: [commands.md](../architecture/commands.md#long-running-commands-jobs) · Task: [v0.1 plan](../plans/v0.1.md) 3.9, 3.12

Run mode for [roadmap v0.1](../roadmap.md#v01--25d-basics-to-the-virtual-machine): connect to the **virtual machine** (the GRBL emulator, task 3.8), home it, set the work zero, stream a plan's gCode with GRBL's character-counting protocol, guide tool changes, pause, resume and stop, and report progress to the UI and to agents. The machine I/O runs in a utility process. Facts about GRBL and the emulator live in [grbl.md](../architecture/grbl.md); this doc specifies DFYOM's side.

## Decisions

Settled with the user when this doc was accepted; the sections below specify them.

1. **Virtual machine only.** No `SerialTransport` in 3.9; it comes with the real-machine milestone and the [safety spec](run.md#safety) ([grbl.md](../architecture/grbl.md#transport-and-sender)).
2. **Headless hosting:** the machine host runs in a `worker_threads` worker with the same protocol as the app's utility process ([Processes](#processes)).
3. **Time scale:** 1× by default; 1–100× or `max`, settable at connect and during a run ([Clocks](#clocks)).
4. **Runs start from a plan** (`run.job.start { planId }`), exported at start with the live G54 ([Run job](#run-job)).
5. **Every plan status except `archived`** may run on the virtual machine; real machines will require `finalized`/`inUse`.
6. **The virtual machine emulates the plan's machine copy**, given at connect; a job on another machine copy fails (`machineMismatch`).
7. **Realistic flow** (starts in Alarm; home, jog, set work zero) **plus an opt-in `prepare: true`** at connect that homes instantly and places G54 so the plan's stock sits centred on the table with its top at a valid Z.
8. **Soft-limit failure refuses the start** with `run.softLimit`; no override ([Work zero](#work-zero-and-the-soft-limit-check)).
9. **Guided wait at every tool change**, also on the virtual machine; agents and tests call `run.job.continue`.
10. **Emulator trace off** in the app and headless (`trace: false`); a capped ring buffer comes with a later debug view.
11. **No extra controls in v0.1:** no overrides, no raw gCode or `$` lines.
12. **Run-mode UI is task 3.12**, after the UI shell (3.3) and viewport (3.5); 3.9 delivers core, host, commands and the IPC status push ([implementation](#implementation-task-312-run-mode-ui)).

## v0.1 cut

| In v0.1                                                                                                 | Later                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GrblSender` (character counting, status polling, real-time commands, errors, alarms, tool-change rule) | Real serial connection ([decision 1](#decisions)), other controllers ([ADR 0013](../decisions/0013-grbl-first-controller.md)) |
| Real-time and scaled clocks                                                                             | Sensors, MCUs, automation scripts ([run.md](run.md))                                                                          |
| Machine host in a utility process (app) and its message protocol                                        | Watchdogs and confirmations for real machines ([run.md#safety](run.md#safety))                                                |
| `run.*` commands and queries; the run job                                                               | Feed/rapid/spindle overrides, raw MDI ([decision 11](#decisions)), probing, park position                                     |
| Progress and status for UI and agents; G54 for the export soft-limit check                              | Time-remaining estimate per line, material-removal simulation of the run                                                      |

## Processes

```text
renderer ──IPC push/commands──┐
MCP / CLI adapters ───────────┤
                              ▼
main (or headless process): dispatcher ─ run commands ─ MachineClient ──messages──▶ machine host
                                                                        ◀──────────  (utility process in the app)
                                                                                     VirtualGrblTransport + emulator
                                                                                     GrblSender, ScaledClock
```

- **Machine host** (`src/core/run/host/`, environment-neutral like the [worker loop](../architecture/workers.md#hosting)): owns the transport, the sender, the clock and all run state. It talks to its owner over an `Endpoint` (`post`, `onMessage`), the seam [workers.md](../architecture/workers.md#hosting) defines.
- **App:** the host runs in an Electron **utility process** (`utilityProcess.fork`, ADR 0016) started by `run.connection.open` and ended by `run.connection.close` or app quit; `src/main/machine/utility.ts` adapts `process.parentPort` to an `Endpoint`. A frozen or crashed window never touches it.
- **Headless/CLI:** there is no Electron utility process: the same host in a `worker_threads` worker, so the headless exit criterion exercises the same message protocol ([decision 2](#decisions)).
- **Tests:** the host in-process over a paired in-memory `Endpoint`.
- **Main** holds a `MachineClient` (implements the `MachineService` port in `ctx.services.machine`): it sends requests, matches replies by `requestId`, mirrors the latest status for queries and pushes it to renderers. Run state never enters `ProjectDoc` ([commands.md](../architecture/commands.md#project-state)).
- **One connection per app instance**, shared by the open projects' dispatchers; at most one run job on it.

## Clocks

The emulator, `VirtualGrblTransport` and `GrblSender` share one run `Clock` (`src/core/run/clock.ts`: `now()`, `schedule(at, fn)`; not the commands' `Clock`, which has only `now()`).

| Clock           | Where        | Behaviour                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VirtualClock`  | core, exists | Virtual time; moves only on `advance`. Unit tests.                                                                                                                                                                                                                                                                                                                |
| `ScaledClock`   | core, new    | `now() = v0 + (wall() − w0) × scale`; `schedule(at)` sets one wall timer for `(at − now()) / scale` (earliest timer only, re-armed). `setScale(s)` re-anchors `v0`/`w0` at the current time, so virtual time never jumps. Scale 1 is the **real-time clock**.                                                                                                     |
| `max` (stepped) | core, new    | Implemented as the `max` scale of `ScaledClock` ([implementation](#implementation-task-39)). "As fast as possible" on a live event loop: a `VirtualClock` advanced to its next timer in slices, yielding to the event loop (0 ms timer) after every 10 ms of wall time so messages, abort and pause get through. For tests and agents ([decision 3](#decisions)). |

- Wall time comes from an injected `TimerHost` port (`now()`, `setTimeout(fn, ms)` → cancel), so core stays headless and testable; the host entry binds it to `performance.now` and the global timers. Real controllers (later) always use scale 1.
- **Time scale** (virtual machine only): 1× by default, settable at connect and during a run with `run.timeScale.set` ([decision 3](#decisions)). The sender's 5 Hz status poll is in clock time; the host's forwarding to main is throttled in **wall** time (below), so a fast clock never floods main.

## Sender

`GrblSender` (`src/core/run/grbl/sender.ts`) implements the [transport and sender](../architecture/grbl.md#transport-and-sender) contract over a `ControllerTransport` and a `Clock`. Parsers for status reports, `$#`, `$G`, settings and responses live in `status.ts`.

```ts
// src/core/run/grbl/sender.ts (sketch; the code becomes the contract)
interface SenderOptions { mode?: 'charCount' | 'sendResponse'; pollMs?: number /* 200 */; log: Logger }
class GrblSender {
  constructor(transport: ControllerTransport, clock: Clock, opts: SenderOptions)
  connect(): AsyncAppResult<ControllerInfo>          // handshake below
  command(line: string): AsyncAppResult<string[]>    // one line when no program runs: $H, $X, $J=, G10, $#
  realtime(byte: RealtimeCommand): AsyncAppResult<void>
  run(program: SenderProgram, events: RunEvents): AsyncAppResult<RunSummary>
  hold(): void; resume(): void; continueProgram(): void; stop(): AsyncAppResult<void>
  onStatus(listener: (s: GrblStatus) => void): () => void
}
SenderProgram = { lines: readonly string[]; sections: readonly { fromLine: number; label: string }[] }
```

### Behaviour

| Topic          | Rule                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Handshake      | Wait ≤ 2 s (wall) for the banner `Grbl 1.1…`; if none, send `0x18` once and wait again, else `machine.connection`. Then `$I` (version must start with `1.1`, else `machine.connection` "unsupported controller"), `$$` (`$10`, `$13`, `$20`–`$27`, travel), `$#` (G54), `$G`. A banner later in the session means the controller reset: a running program fails with `machine.connection`. |
| Framing        | Each line is sent with `\n` only (CR+LF would give two `ok`s, [grbl.md](../architecture/grbl.md#protocol-subset)). Responses are split on `\r\n` across chunk boundaries; `ok`/`error:N` acknowledge the oldest unacknowledged line; `<…>`, `[…]`, `ALARM:N`, `$n=v` and the banner are not acknowledgements.                                                                              |
| Pre-flight     | Before streaming, every line must be ≤ 80 bytes as sent and printable ASCII without `?`, `!`, `~` (GRBL takes these as real-time commands anywhere, [grbl.md](../architecture/grbl.md#numbers-lines-and-comments)); else the run fails before sending anything (`run.program`, issue per line). Programs from `exportGrbl` always pass.                                                    |
| Char counting  | Default. A line is sent only when its bytes fit into the 128-byte RX buffer minus the bytes of unacknowledged lines. Send-response (one line in flight) is an option for debugging. Real-time bytes are not counted.                                                                                                                                                                       |
| Status polling | `?` every 200 ms of clock time while connected (one outstanding at a time); `MPos`/`WPos` both accepted, `WCO` cached and applied; positions kept in mm (reports in inch with `$13=1` are converted).                                                                                                                                                                                      |
| Real-time      | Hold `!`, resume `~`, reset `0x18`, jog cancel `0x85`; sent at once, never queued behind lines.                                                                                                                                                                                                                                                                                            |
| Marker rule    | Exactly the [grbl.md rule](../architecture/grbl.md#output-dialect): before a whole-line marker followed by exactly `M0`, stop sending, wait for every sent line's `ok` and `Idle`, raise `toolChange { n, name }`, wait for `continueProgram()`, then send the marker, skip the `M0` and continue. Anything else streams unchanged.                                                        |
| Program pause  | A plain `M0` (e.g. the manual-spindle prompts) puts GRBL in `Hold:0` with the `M0`'s `ok` outstanding: raise `programPause { message }` (the preceding comment line's text); `continueProgram()` sends `~`.                                                                                                                                                                                |
| End            | The run succeeds when every line is acknowledged and the state is `Idle`; `M30`'s `[MSG:Pgm End]` is informational.                                                                                                                                                                                                                                                                        |

### Run phases

| Phase                         | Entered by                                   | Left by                                                           |
| ----------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| `streaming`                   | `run()`, resume, continue                    | hold, marker, `M0`, error, alarm, stop, done                      |
| `held`                        | `hold()` (`!`); state `Hold:1` then `Hold:0` | `resume()` (`~`); `stop()`                                        |
| `programPause`                | plain `M0` reached (`Hold:0`)                | `continueProgram()` (`~`); `stop()`                               |
| `toolChange`                  | marker rule                                  | `continueProgram()`; `stop()`. Jog and work-zero commands allowed |
| `stopping`                    | `stop()`, error                              | `Idle` after the reset → `stopped` / `failed`                     |
| `done` · `failed` · `stopped` | end of program; error/alarm/connection; stop | – (terminal)                                                      |

### Stop, errors and alarms

- **Stop** (`job.abort`, also a refinement of grbl.md's `!` + `0x18`): send `!`, wait until `Hold:0` (≤ 5 s clock time), then `0x18`. A reset after motion has stopped keeps the position and raises no alarm; it flushes GRBL's RX and planner buffers and stops the spindle. If motion has not stopped in time, reset anyway: `ALARM:3`, the machine must be homed again. In `toolChange` (already Idle) only the reset is sent.
- **`error:N`:** stop sending, then the stop sequence above, because with character counting up to 128 bytes of later lines are already in GRBL's buffer and would execute. On real GRBL, lines already planned may begin before the hold has decelerated the machine; the emulator applies `!` at once, so its tests show no later line starting (the review's caveat). The run fails with `machine.error` (`data: { code, line, text }`, `line` 1-based; GRBL's message for `N` in `userMessage`).
- **`ALARM:N`:** GRBL has already stopped and locked; the run fails with `machine.alarm` (`data: { code, line? }`). `ALARM:1` (hard limit) and `ALARM:2` (soft limit) are **critical** in GRBL 1.1 (`[MSG:Reset to continue]`): GRBL answers nothing, not even status, until a reset; the sender suspends its status watchdog, fails every queued and pending command with `machine.alarm` and refuses new ones with `run.state` until the reset is sent. Both also need re-homing, as GRBL does ([grbl.md](../architecture/grbl.md#state-machine)).
- **Connection lost** (transport closed, host crash, banner mid-run, no status reply for 2 s wall, a command without a reply for 10 s of clock time (`$H` 10 min), or a lost `ok`: Idle in reports requested after the last line went out while a line still waits, for 5 s plus the dwells in flight): `machine.connection`. The host drops the connection; main marks it `closed`, ends the host and starts a fresh one on the next `run.connection.open`.
- New error codes ([registry](../conventions/error-handling/app-error.md#error-code-registry)): `machine.error` and `machine.alarm` (planned in grbl.md), `run.notConnected`, `run.busy` (a job runs; also connect while connected), `run.state` (command not possible in the machine's state, e.g. jog while streaming or in Alarm; `data.state`), `run.program` (pre-flight), `run.softLimit` ([below](#work-zero-and-the-soft-limit-check)).

## Machine host and protocol

`src/core/run/host/protocol.ts`: Zod discriminated unions on `type`, `PROTOCOL_VERSION = 1`, parsed on both sides with `parseWith` (the host and its owner are separate processes; malformed = `internal.unexpected`, logged, the host survives). Results cross as `ResultWire` ([boundaries.md](../conventions/error-handling/boundaries.md#async-workers-cancellation)).

### Main → host

| `type`       | Fields                                                                                                                        | Reply (`reply { requestId, result }`)                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`       | `protocol`, `logLevel`                                                                                                        | `ready { protocol }`                                                                                                                                 |
| `connect`    | `requestId`, `target: { kind: 'virtual', settings, homing, timeScale, machineKey, prepare? }`                                 | `ControllerInfo` (target as connected, version, settings, G54, homed)                                                                                |
| `disconnect` | `requestId`                                                                                                                   | `void`; the host may then exit                                                                                                                       |
| `machine`    | `requestId`, `action`: `home` · `unlock` · `jog { to \| by, feed }` · `jogCancel` · `setWorkZero { axes, values? }` · `reset` | `void` or `run.state`                                                                                                                                |
| `jobStart`   | `requestId`, `jobId`, `program: SenderProgram`, `expect: { workZero, machineKey, target }`                                    | `void` once streaming starts; `run.state` (rule `workZeroChanged`, `machineMismatch`, `targetMismatch`) if the host's fresh `$#` and report disagree |
| `jobControl` | `requestId`, `jobId`, `action`: `hold` · `resume` · `continue` · `stop`, `expect?: { toolChange \| pause }` (continue)        | `void`; continue only for the named wait                                                                                                             |
| `timeScale`  | `requestId`, `scale: number \| 'max'`                                                                                         | `void` (virtual only)                                                                                                                                |

### Host → main

| `type`     | Fields                                                                                 | Rate                                             |
| ---------- | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `status`   | `RunStatus` ([below](#status))                                                         | ≤ 10 per wall second, plus on every state change |
| `progress` | `jobId`, `done`, `total`, `label`                                                      | ≤ 10 per wall second, plus the last              |
| `phase`    | `jobId`, `phase`, `toolChange?: { n, name }`, `message?`                               | on change                                        |
| `jobEnd`   | `jobId`, `result: ResultWire<RunSummary>`                                              | once per job                                     |
| `event`    | `kind`: `alarm` · `error` · `message` (`[MSG:…]`) · `reset` · `connectionLost`, `data` | on occurrence                                    |
| `log`      | `batch` from `createLogForwarder` ([Logging](#logging))                                | per the forwarder                                |

- The program's lines travel once, in `jobStart` (a few hundred KB at most for v0.1 parts); the host streams without main, so main's event loop (Zod, workers' messages) never starves the sender.
- **Host exit** (crash or kill) while connected: main fails the job with `machine.connection`, marks the connection `closed`, logs `error`; no automatic reconnect (a controller's state after a host crash is unknown). The next `run.connection.open` starts a fresh host.
- `disconnect` stops a running job first (hold, then reset; a stop already under way is awaited) and closes the transport; `GrblSender.close()` during a run sends `0x18` before closing. **App quit** sends `disconnect` through `MachineClient.shutdown(3000)` and kills the host only after it answered or 3 s passed; quitting during a run asks first (3.12: a native message box "A run is in progress" with Cancel / "Stop run and quit"; `src/main/index.ts`, `before-quit`). A headless process (3.10) calls the same `shutdown` before it exits.

## Commands and queries

All `run.*` commands are `machine: true`; the [permission rule](../architecture/grbl.md#transport-and-sender) for virtual connections applies (every source allowed). Jog, home and unlock go through typed commands; there is no raw gCode command in v0.1 ([decision 11](#decisions)).

| Name                    | Kind   | Args                                                                           | Result / notes                                                                                                                                                                                                       |
| ----------------------- | ------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.connection.open`   | effect | `{ target: 'virtual', planId, homing?: true, timeScale?: 1, prepare?: false }` | `ControllerInfo`. Builds the emulator from the plan's machine copy with `machineSettings` ([decision 6](#decisions)); `run.busy` if connected. `prepare: true`: [decision 7](#decisions).                            |
| `run.connection.close`  | effect | `{}`                                                                           | `run.busy` while a job runs.                                                                                                                                                                                         |
| `run.machine.home`      | job    | `{}`                                                                           | `$H`; a job because homing takes seconds (9.6 s at 1× with defaults) and effects hold the project queue.                                                                                                             |
| `run.machine.unlock`    | effect | `{}`                                                                           | `$X` (Alarm → Idle, not homed).                                                                                                                                                                                      |
| `run.machine.jog`       | effect | `{ to?: Vec3 (machine), by?: Vec3, feed }`                                     | `$J=G53 G90 …` or `$J=G91 …`; resolves on GRBL's `ok` (accepted), motion continues. `run.state` outside Idle/Jog/`toolChange`.                                                                                       |
| `run.machine.jogCancel` | effect | `{}`                                                                           | `0x85`.                                                                                                                                                                                                              |
| `run.workZero.set`      | effect | `{ axes: ('x'\|'y'\|'z')[], values?: Vec3 }`                                   | `G10 L20 P1` at the current position (or `values` as WPos there), then `$#`; returns the new G54. Allowed in Idle and `toolChange`.                                                                                  |
| `run.machine.reset`     | effect | `{}`                                                                           | Immediate `0x18` (the emergency path; may raise `ALARM:3`). A running job fails with `machine.alarm` or `op.aborted`.                                                                                                |
| `run.job.start`         | job    | `{ planId }`                                                                   | [Run job](#run-job). `RunSummary` `{ lines, seconds, toolChanges, pauses }`.                                                                                                                                         |
| `run.job.continue`      | effect | `{ jobId, toolChange: n }` or `{ jobId, pause: n }`                            | Leaves the named tool change or program pause (`job.toolChange.n`, `job.pause` in the status); `run.state` for another wait, any other phase, a paused job, or while the machine is not Idle with nothing in flight. |
| `run.timeScale.set`     | effect | `{ scale: number \| 'max' }`                                                   | Virtual only, 1–100 or `max` ([decision 3](#decisions)).                                                                                                                                                             |
| `run.status.get`        | query  | `{}`                                                                           | `RunStatus` from main's mirror; `readsDocument: false`.                                                                                                                                                              |

- **Job control** stays the generic `job.pause` / `job.resume` / `job.abort` ([commands.md](../architecture/commands.md#long-running-commands-jobs)): hold `!`, resume `~`, stop. A run must react at once, not at the next `checkpoint()`, so the run job uses the job's pause state from [workers.md](../architecture/workers.md#contract-changes) (`PauseState`, exposed on `JobContext`) with a change listener, and `ctx.signal` for abort.
- `ctx.services.machine?: MachineService` is the new port ([commands.md](../architecture/commands.md#command-definition): "the machine port arrives with run mode"); absent → `run.notConnected`. The permission policy reads `services.machine` to know whether the connection is virtual.

## Run job

`run.job.start { planId }` ([decision 4](#decisions)):

1. **Checks** (fail before sending): connected, no other job (`run.busy`), state `Idle` and homed (`run.state`), plan exists and not `archived` ([decision 5](#decisions)), the plan's machine copy equals the connected one (`run.state`, rule `machineMismatch`, [decision 6](#decisions)).
2. **Program:** the same internal export path as `plan.export`, `exportPlan(doc, planId, services, { workZero, signal, progress })` ([grbl.md](../architecture/grbl.md#plan-export-command): regenerates missing or stale toolpaths on the toolpath lane, [workers.md](../architecture/workers.md#toolpath-cache); `exportGrbl` with the generator string) with `workZero` = the connected G54. `sections` come from the program's operation comments and tool changes, so the label reads `pocket1 · tool 2: 6 mm end mill`.
3. **Soft limits:** any `softLimit` finding fails the job with `run.softLimit` (findings in `data`) ([decision 8](#decisions)); other `plan.machine` warnings go into the job's progress label at start and into `RunSummary.warnings`.
4. **Stream:** `jobStart` to the host with what was checked (`expect`: G54, machine copy, target); the host re-reads `$#` and a fresh report and refuses any change. From the checks to the stream the connection is **reserved** for the job (`MachineService.reserve`): jog, work-zero and other machine actions answer `run.busy`, reset and jog cancel always pass. Progress, phase and status flow back; tool changes wait for `run.job.continue` ([decision 9](#decisions)).
5. **End:** `jobEnd` resolves the job: `Ok(RunSummary)`, `machine.*`, or `op.aborted` after a stop. No follow-up document command (a run changes no document in v0.1; marking a plan `inUse` stays manual).

- **Closing a project** whose dispatcher runs a job fails with `run.busy`; the job and its handle live in that dispatcher.
- The job's `startRevision` is irrelevant (no follow-up); later document edits never affect a running program (it was exported at start).

## Feedback

### Progress

While the job exports the program (step 2 of the [run job](#run-job)) progress is indeterminate: `done` 0, no `total`, `label` `Export: …`. From the stream on (a `started` tick, sent before `jobStart` so it never follows a host tick): `done` = lines acknowledged, `total` = program lines ([grbl.md](../architecture/grbl.md#transport-and-sender)); `label` = current section, or `Tool change 2: 6 mm end mill` / the `M0` message while waiting. Through `ctx.progress`, so the job's throttled progress stream reaches the UI, `job.get` and MCP like any job. Elapsed time is in `RunStatus`; a remaining-time estimate is later.

### Status

`RunStatus` (main's mirror, pushed to renderers over IPC and returned by `run.status.get`): `connection` (`closed` · `connecting` · `open`, `target`, `timeScale`), `state` (GRBL's, e.g. `Hold:0`), `homed`, `mpos`, `wpos`, `workZero` (G54 in MPos), `feed`, `spindle`, `buffer` (`Bf`), `alarm?`, `lastMessage?`, `job?` (`jobId`, `phase`, `line`, `toolChange?`, `startedAt`, `elapsedSeconds`). Status ticks are not action-log events ([commands.md](../architecture/commands.md#action-log)); MCP notifications come with 3.10 ([llm-api.md](../architecture/llm-api.md)). The 3D view's tool marker uses `wpos` (UI task, [decision 12](#decisions)).

### Work zero and the soft-limit check

- The host reads G54 with `$#` after connect, after `$H`, after every `run.workZero.set` and after a reset; `homed` is true after a successful `$H` in this connection (or a virtual machine started with `homing: false`), false after `ALARM:2/3/6`.
- **`plan.export`** (built in 2.9/2.11 without it, `softLimitChecked: false`) passes `workZero` = G54 when a connection is open, `homed`, and the connected machine equals the plan's machine copy; its result states whether the soft-limit check ran (`softLimitChecked`). Otherwise it exports without it, as today ([grbl.md](../architecture/grbl.md#export-checks)). Closes the known issue "export soft-limit check needs the work zero".
- `run.job.start` always runs the check (step 3 of the [run job](#run-job)).

### Logging

Per [logging.md](../conventions/logging.md#forwarding): the host's root logger has `proc: 'utility'` (headless worker: `proc: 'worker'`) and forwards batches with `createLogForwarder` as `log` messages; main receives them with `createForwardReceiver` (origin `utility`). Scopes `run.host`, `run.sender`, `run.client`.

| Level   | Events                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------- |
| `info`  | Host start/exit, connect/disconnect (target, version, time scale), homing done, job start/end (lines, s) |
| `warn`  | Hold timeout before reset, status reply missing, malformed message from the other side                   |
| `debug` | Phase changes, tool changes, work-zero changes, time-scale changes                                       |
| `trace` | Line numbers sent/acknowledged, status reports. Never the gCode text (logging rule 5: no toolpaths)      |

`machine.*` errors are logged once by the boundary, not by the sender. The emulator's trace is off in the app and headless (`trace: false`), which settles the unbounded-trace known issue for v0.1 ([decision 10](#decisions)).

## Safety (v0.1)

These rules cover the virtual machine; they are not the real-machine safety spec ([run.md#safety](run.md#safety)), which must be accepted before any serial connection can be selected.

1. Only `target: 'virtual'` exists in v0.1 ([decision 1](#decisions)). The permission policy allows non-UI sources only on a connection the host reported as virtual, or to open a virtual one when none is open; anything else (unknown or real targets, a connection still opening, no machine port) is denied ([grbl.md](../architecture/grbl.md#transport-and-sender)). The host re-checks target and machine copy at `jobStart`.
2. Every byte to the controller goes through `GrblSender`: lines are pre-flighted (no real-time characters, ≤ 80 bytes); no raw gCode or `$` command is exposed.
3. Streaming starts only from `Idle` and homed, after the soft-limit check with the current G54.
4. After `error:N` the sender never keeps streaming: hold, then reset to flush GRBL's buffers.
5. Stop is controlled (hold, then reset; at a tool change jog cancel, then reset) so the position survives; `run.machine.reset` is the immediate path. Reset, jog cancel and the `job.*` controls are **urgent**: they skip the project's command queue, so an effect waiting for the machine never blocks them.
6. Feed hold does not stop the spindle (GRBL); a stopped run stops it via the reset.
7. The host never reconnects on its own, and a lost connection fails the job rather than retrying lines.
8. Tool changes wait for an explicit `run.job.continue` naming the tool change; continue needs the machine Idle (a report requested after the last command) with nothing in flight; jogging is possible only while waiting or with no job.
9. Disconnect and app quit end a run with the reset (spindle off, GRBL's buffers flushed), never by just closing the port.

## Testing

Per [testing.md](../conventions/testing.md): unit → virtual machine; no hardware. Implemented in `clock.test.ts`, `grbl/status.test.ts`, `grbl/sender.test.ts`, `grbl/virtual-transport.test.ts`, `host/host.test.ts`, `commands.test.ts` (all `src/core/run/`), `src/core/post/grbl/emulator-run.test.ts` and `post.test.ts`, `src/core/commands/dispatcher.test.ts` (permission rule) and `src/main/machine/node-worker.test.ts`.

| Layer             | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parsers           | `status.ts` against report strings from the GRBL wiki and the emulator: MPos/WPos, `WCO` caching, `Ov`, `A:`, `FS`, `Bf`, inch reports, `$#`, `$G`, settings, `[MSG:…]`, banner.                                                                                                                                                                                                                                                                                                                                                                                 |
| Fake transport    | Byte-level edge cases: responses split mid-line and several per chunk, a banner mid-run, write errors, close; char counting arithmetic.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Sender on the VM  | `GrblSender` + `VirtualGrblTransport` + `VirtualClock`: every golden program and the test part stream with no `error:`, no RX-overflow violation in the emulator trace, final position as programmed (mm and inch); send-response mode; marker rule incl. the negative cases (malformed marker, marker inside a line, next line not `M0`); manual-spindle `M0` pauses; hold/resume; stop keeps the position without `ALARM:3`; stop timeout → `ALARM:3`; injected bad line → `machine.error` and no later line executed; soft-limit `ALARM:2` → `machine.alarm`. |
| Migration         | `emulator-run.test.ts` switches from `TestStreamer` to `GrblSender`; `TestStreamer` is removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Clocks            | `ScaledClock` with a fake `TimerHost`: scale changes re-anchor without jumps, timer order, cancel; `max` jumps while busy, runs at real time while idle, yields after each slice and stops on `dispose()`.                                                                                                                                                                                                                                                                                                                                                       |
| Host and protocol | Schemas accept/reject each message; host over in-memory endpoints: connect, home, jog, set zero, job with progress/phase/status throttling, tool change, stop, malformed messages, `run.busy`/`run.state`.                                                                                                                                                                                                                                                                                                                                                       |
| Commands          | Run commands with an in-process host: permission rule per source, preflight failures, `plan.export` with and without a connection (`softLimitChecked`), project close refused while running.                                                                                                                                                                                                                                                                                                                                                                     |
| Real host process | Headless host in a real `worker_threads` worker under Vitest (bundled entry as in [workers.md](../architecture/workers.md#testing)): a job at `max` speed end to end, host crash → `machine.connection`. The Electron utility-process entry is a thin adapter, covered by the Playwright smoke test (0.9) later.                                                                                                                                                                                                                                                 |
| End to end        | Task 3.11 (done headless, [testing.md](../conventions/testing.md#end-to-end)): the MCP and `batch` flows connect with `prepare` (homes, sets the work zero), run the test plan at `max` speed, continue each tool change and spindle pause, and check progress and the end position.                                                                                                                                                                                                                                                                             |

## Files

| File                                                        | Contents                                                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/core/run/clock.ts`                                     | `Clock`, `VirtualClock`, `TimerHost`, `systemTimerHost`, `clockTimers`, `ScaledClock` (incl. `max`)       |
| `src/core/run/grbl/sender.ts`, `status.ts`                  | `GrblSender`, `preflight`; response, status-report and `$` parsers, GRBL error and alarm texts            |
| `src/core/run/host/protocol.ts`                             | Message schemas, `PROTOCOL_VERSION`                                                                       |
| `src/core/run/host/host.ts`                                 | `runMachineHost`: environment-neutral machine host over an `Endpoint`                                     |
| `src/core/run/host/client.ts`                               | `MachineClient` (`MachineService` port), status mirror, `MachineHostFactory`                              |
| `src/core/run/host/in-process.ts`                           | `inProcessHostFactory`: the host over paired in-memory endpoints (tests)                                  |
| `src/core/run/service.ts`                                   | `MachineService` port, `RunStatus` schema                                                                 |
| `src/core/run/commands.ts`, `job.ts`, `machine-key.ts`      | `run.*` commands and queries, `prepareWorkZero`, `checkNoRunJob`; the run job; machine-copy identity      |
| `src/main/machine/utility.ts`, `node-worker.ts`, `serve.ts` | Utility-process entry; `worker_threads` entry; their shared host setup                                    |
| `src/main/machine/electron.ts`, `spawn.ts`, `bundled.ts`    | `utilityHostFactory`, status push to renderers; `workerHostFactory`, `createMachineClient`; bundled paths |
| `src/core/run/clock.fixture.ts`, `grbl/sender.fixture.ts`   | Test rigs: fake wall timers; the sender on the virtual machine, a counting and a scripted transport       |

## Implementation (task 3.9)

Decisions and findings of the implementation, where this doc left room or proved wrong:

- **One `ScaledClock` for every scale.** The scale changes mid-run (decision 3), so `max` is a scale of `ScaledClock`, not a separate `SteppedClock` class. At `max` the clock jumps to its next timer only while the machine has work (`busy`: an emulator event is pending, or the sender waits for a status report); otherwise it runs at real time, so an idle connection at `max` does not spin a core. Slices of 10 ms wall time with a 0 ms timer between them, as specified; `dispose()` stops it.
- **Sender is synchronous inside.** A line is booked against the RX buffer before it is written (an answer can only follow), and all protocol decisions happen in the data and timer callbacks; only the public API returns promises. Decisions that need the machine's state after a moment (tool change ready, end of program, motion stopped after `!`) wait for a status report requested after that moment (report ordinal), never re-polling from a report handler: on a virtual clock the reply comes at the same instant (livelock).
- **Sender additions:** `connect()` also waits for the first status report, so the state is known when it resolves; `freshStatus()` (the host uses it after `$H`, `$#` and work-zero changes so command replies find the mirror current); `readWorkZero()`; `needsStatus`. `RunSummary` gains `elapsedSeconds`; `seconds` excludes the waits for the user (tool changes, `M0` pauses, holds). A plain `M0` without a preceding comment pauses with the message `Program paused (M0)`. A `Hold:0` the sender did not cause (door, button) becomes phase `held`; `resume()` continues.
- **Resets and alarms:** a reset by someone else during motion makes GRBL send `ALARM:3` before the banner, so the run fails with `machine.alarm` (code 3), not `machine.connection`; during a dwell or idle it is `machine.connection` as specified. A stop whose hold times out ends in `machine.alarm` (`ALARM:3`). `homed` becomes false after every alarm that loses or questions the position (1, 2, 3, 6–10), not only 2/3/6. After `ALARM:1` or `ALARM:2` GRBL sends nothing until a reset, so the status watchdog is suspended until the banner.
- **Units of manual lines:** the host sends `G21 G10 L2/L20 P1 …` and `$J=G21 …`, so values are mm whatever units the program left modal (the program restates its modes after each tool change).
- **`prepare` (decision 7):** `run.connection.open` computes the G54 (`prepareWorkZero`): the stock centred on the table in XY and the clearance plane `PREPARE_TOP_MARGIN` = 5 mm below the top of the travel; the host homes at `max` and sends it (`target.prepare.workZero` in `connect`).
- **Machine identity (decision 6):** the hash of the machine copy's values (`machineKeyOf`); the client keeps the key of the plan it connected with.
- **Permission policy:** `PermissionPolicy.check` receives the dispatcher's `services`; deny by default (review of 3.9): non-UI sources only on a connection the host reported virtual, or `run.connection.open { target: 'virtual' }` with no connection; the policy is checked at `run.job.start`, and the host re-checks target and machine copy at `jobStart`.
- **`JobContext.jobId`:** the run job passes the dispatcher's job id to the host, so `run.status.get` and `run.job.continue { jobId }` use the id `run.job.start` returned. `run.job.start` joined the plan status table (every status but `archived`).
- **`run.machine.home`** returns `{ workZero }`; `run.workZero.set` returns `{ workZero }` (the new G54); effects without a value return `{}`.
- **Wired in 3.10:** every project dispatcher of the app host gets the instance's `MachineClient` as `services.machine` (utility process in the app, `workerHostFactory` + `createMachineClient` headless); `project.close` calls `checkNoRunJob`; app quit and CLI exit call `MachineClient.shutdown()` after closing the projects ([llm-api.md](../architecture/llm-api.md#implementation-task-310)). Main pushes every status change to renderers (`dfyom:run.status`, `window.dfyom.run.onStatus`).
- **Tests replaced `TestStreamer`:** `emulator-run.test.ts` and the golden runs in `post.test.ts` stream with `GrblSender`; other senders' `M0` behaviour is tested by turning the markers into plain comments. The transport tests' streaming cases moved to `sender.test.ts`; the 100 000-line test with a wall-clock assertion became a 20 000-line correctness test.
- **Measured:** the test part streams in 626.6 s of machine time on the `VirtualClock` (tool changes with jogs excluded); through a real `worker_threads` host at `max` it took 624.8 s of machine time in about 60 ms of wall time (no jogs at the tool changes, continued at once).

### Review of 3.9

An independent review found real-machine safety gaps; each was fixed test-first (probes in `sender.safety.test.ts`, `host.test.ts`, `commands.test.ts`, `dispatcher.test.ts`, `serve.test.ts`):

- **Stale G54:** the run job reserves the connection from its checks to the stream, and `jobStart` carries the checked G54, machine copy and target, which the host re-checks on a fresh report and `$#` (also closes a start on a 200 ms old report).
- **Emergency paths:** `run.machine.reset`, `run.machine.jogCancel` and `job.*` are urgent (skip the queue); commands time out; in a critical alarm commands are refused at once and pending ones fail.
- **Stop and close reach the reset:** `stop()` while stopping waits for the end; `close()` during a run sends `0x18` first; app quit uses `MachineClient.shutdown`. At a tool change the stop cancels a jog (`0x85`) and waits for Idle before the reset (no `ALARM:3`).
- **Continue:** only Idle (a report requested after the last command) with nothing in flight or queued; the marker goes through the RX budget; `run.job.continue` names the tool change or pause.
- **Stale `Hold:0` after `~`:** reports requested before the last cycle start are ignored for the hold/pause decision. `job.pause` during a wait keeps the run paused: continue is refused until `job.resume`.
- **ALARM:1** is critical like `ALARM:2`; a **lost `ok`** fails the connection; **WCO** comes from reports with `WCO` only (G54 + G92 + TLO), never seeded with G54; an **uncaught error** ends a worker-thread host like the utility process (`fatal`, exit); a **lost connection** closes it in main.

## Implementation (task 3.12: run-mode UI)

The renderer side of this doc; the rules are in [ui.md](../conventions/ui.md#run-mode-safety-ui). Code: `src/renderer/src/modes/run/`, `ui/StopControl/`, the viewport's run layer (`viewport/RunLayer.tsx`, `viewport/toolpath-lines.ts`), strings in `messages/run.ts`.

- **No new IPC or commands.** The UI uses the `run.*` commands, `job.pause/resume/abort` and the status push `window.dfyom.run.onStatus` (seeded by `run.status.get`) through the window's session. Progress (`done`/`total`/`label`) is read with `job.get` every 250 ms while the run job runs (`RUN_PROGRESS_POLL_MS`), since progress ticks are not pushed; elapsed time and the phase come from the pushed status. The finished job's `outcome` gives how the run ended (summary, `op.aborted` = stopped, `machine.*` = failure dialog). A run started elsewhere (another window, an agent) is followed from the status too.
- **Run store** (`run-store.ts`, Zustand, one per window bridge): the status, the chosen plan, time scale and jog step, the followed job, its progress and end, the open dialogs and the last refused action (shown with `ErrorMessage` in the navigator).
- **Connection:** the navigator picks the plan (every status but `archived`, decision 5; the first by default) and the time scale (1×, 10×, 100×, Max; changed live with `run.timeScale.set` once connected), then `run.connection.open { target: 'virtual', planId, timeScale }` without `prepare`: the realistic flow (Alarm → Home → jog → work zero, decision 7).
- **Jog:** relative step jogs (`run.machine.jog { by }`); steps 0.1/1/10/100 mm (0.001–1 in for inch projects); feeds 2000 mm/min in XY and 500 mm/min in Z (`JOG_FEED`, GRBL caps them at the axis' max rate); "Stop jog" sends jog cancel.
- **Work zero:** "Zero X", "Zero Y", "Zero Z", "Zero X Y Z" at the current position (`run.workZero.set { axes }`); the tool-change dialog offers "Set Z zero here".
- **Control gates** (`machine-state.ts`, `runGates`) mirror the host's `run.state` rules so a disabled control says why before the click ("Home the machine first.", "Not while a run is going.", after a critical alarm "Reset the machine first …"); the host still decides.
- **Stop without a run job** (decided by the user, 2026-11-21: keep this behaviour): with a run job Stop is `job.abort`; without one, a jog is cancelled (`run.machine.jogCancel`) and a homing cycle, which GRBL can only stop by a reset, is reset (`run.machine.reset`, raising `ALARM:6`); in any other state nothing moves and nothing is sent. The logic lives once, in `run-store.ts` (`stop()`).
- **Run dialogs carry their own Stop** (decided by the user, 2026-11-21): the pre-flight, tool-change, program-pause and failure dialogs show the same Stop as the toolbar (`modes/run/RunStop.tsx`: one `StopControl` wired to the store's `stop()`, used by the toolbar and by `RunDialogFooter`), so keyboard and screen-reader users never have to close a modal first. Details in [ui.md](../conventions/ui.md#run-mode-safety-ui).
- **Pre-flight** shows plan, machine copy, target and time scale, the live G54, the tools in machining order and the soft-limit rule; the soft-limit check itself runs at `run.job.start` (a refusal shows as `run.softLimit` in the navigator's banner), since no command checks without exporting.
- **Waits:** the tool-change dialog ("Tool change n") and the program-pause dialog ("Program pause n", the `M0` message from the progress label) open on every new wait, can be put off with "Later" (the inspector then offers "Show instructions"), and continue with `run.job.continue` naming the wait.
- **Quit during a run** asks in main (`before-quit`): Cancel, or "Stop run and quit" (the normal quit then stops the run with hold and reset, as before). It is the first of the quit questions; unsaved changes are asked next ([ui.md confirmations](../conventions/ui.md#confirmations)).
- **Tests:** `modes/run/RunMode.test.tsx` (the shell against the fake bridge with a scripted machine: connect, badge and chip, Stop in every mode, gates, jog and work zero, unlock confirmation, pre-flight focus, progress, `Escape` feed hold, resume, stop, tool-change dialog, failure dialog, the Stop in every run dialog by keyboard), `machine-state.test.ts`, `viewport/toolpath-lines.test.ts`, `ui/StopControl`; end to end the run part of `e2e/exit-criteria.e2e.ts` (was `e2e/run.e2e.ts`, joined in 3.11; [testing.md](../conventions/testing.md#app-playwright-for-electron)).
