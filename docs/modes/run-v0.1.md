# Run mode v0.1: streaming to the virtual machine

Status: draft · Vision: [run.md](run.md) · Protocol, emulator, post: [grbl.md](../architecture/grbl.md) · Decisions: [ADR 0013](../decisions/0013-grbl-first-controller.md), [ADR 0016](../decisions/0016-compute-workers-in-dispatcher-process.md) · Jobs: [commands.md](../architecture/commands.md#long-running-commands-jobs) · Task: [v0.1 plan](../plans/v0.1.md) 3.9

Run mode for [roadmap v0.1](../roadmap.md#v01--25d-basics-to-the-virtual-machine): connect to the **virtual machine** (the GRBL emulator, task 3.8), home it, set the work zero, stream a plan's gCode with GRBL's character-counting protocol, guide tool changes, pause, resume and stop, and report progress to the UI and to agents. The machine I/O runs in a utility process. Facts about GRBL and the emulator live in [grbl.md](../architecture/grbl.md); this doc specifies DFYOM's side.

**Draft:** nothing here is implemented. The [open questions](#open-questions) come first; each section names the question it depends on.

## v0.1 cut

| In v0.1                                                                                                 | Later                                                                                                                      |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GrblSender` (character counting, status polling, real-time commands, errors, alarms, tool-change rule) | Real serial connection ([Q1](#open-questions)), other controllers ([ADR 0013](../decisions/0013-grbl-first-controller.md)) |
| Real-time and scaled clocks                                                                             | Sensors, MCUs, automation scripts ([run.md](run.md))                                                                       |
| Machine host in a utility process (app) and its message protocol                                        | Watchdogs and confirmations for real machines ([run.md#safety](run.md#safety))                                             |
| `run.*` commands and queries; the run job                                                               | Feed/rapid/spindle overrides, raw MDI ([Q11](#open-questions)), probing, park position                                     |
| Progress and status for UI and agents; G54 for the export soft-limit check                              | Time-remaining estimate per line, material-removal simulation of the run                                                   |

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
- **Headless/CLI:** there is no Electron utility process. Recommended: the same host in a `worker_threads` worker, so the headless exit criterion exercises the same message protocol ([Q2](#open-questions)).
- **Tests:** the host in-process over a paired in-memory `Endpoint`.
- **Main** holds a `MachineClient` (implements the `MachineService` port in `ctx.services.machine`): it sends requests, matches replies by `requestId`, mirrors the latest status for queries and pushes it to renderers. Run state never enters `ProjectDoc` ([commands.md](../architecture/commands.md#project-state)).
- **One connection per app instance**, shared by the open projects' dispatchers; at most one run job on it.

## Clocks

The emulator, `VirtualGrblTransport` and `GrblSender` share one run `Clock` (`src/core/run/clock.ts`: `now()`, `schedule(at, fn)`; not the commands' `Clock`, which has only `now()`).

| Clock          | Where        | Behaviour                                                                                                                                                                                                                                                         |
| -------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VirtualClock` | core, exists | Virtual time; moves only on `advance`. Unit tests.                                                                                                                                                                                                                |
| `ScaledClock`  | core, new    | `now() = v0 + (wall() − w0) × scale`; `schedule(at)` sets one wall timer for `(at − now()) / scale` (earliest timer only, re-armed). `setScale(s)` re-anchors `v0`/`w0` at the current time, so virtual time never jumps. Scale 1 is the **real-time clock**.     |
| `SteppedClock` | core, new    | "As fast as possible" on a live event loop: a `VirtualClock` advanced to its next timer in slices, yielding to the event loop (0 ms timer) after every 10 ms of wall time so messages, abort and pause get through. For tests and agents ([Q3](#open-questions)). |

- Wall time comes from an injected `TimerHost` port (`now()`, `setTimeout(fn, ms)` → cancel), so core stays headless and testable; the host entry binds it to `performance.now` and the global timers. Real controllers (later) always use scale 1.
- **Time scale** (virtual machine only): 1× by default, settable at connect and during a run with `run.timeScale.set` ([Q3](#open-questions)). The sender's 5 Hz status poll is in clock time; the host's forwarding to main is throttled in **wall** time (below), so a fast clock never floods main.

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
- **`error:N`:** stop sending, then the stop sequence above, because with character counting up to 128 bytes of later lines are already in GRBL's buffer and would execute. The run fails with `machine.error` (`data: { code, line, text }`, `line` 1-based; GRBL's message for `N` in `userMessage`).
- **`ALARM:N`:** GRBL has already stopped and locked; the run fails with `machine.alarm` (`data: { code, line? }`). `ALARM:2` (soft limit) also needs a reset and re-homing, as GRBL does ([grbl.md](../architecture/grbl.md#state-machine)).
- **Connection lost** (transport closed, host crash, banner mid-run, no status reply for 2 s wall): `machine.connection`.
- New error codes ([registry](../conventions/error-handling/app-error.md#error-code-registry)): `machine.error` and `machine.alarm` (planned in grbl.md), `run.notConnected`, `run.busy` (a job runs; also connect while connected), `run.state` (command not possible in the machine's state, e.g. jog while streaming or in Alarm; `data.state`), `run.program` (pre-flight), `run.softLimit` ([below](#work-zero-and-the-soft-limit-check)).

## Machine host and protocol

`src/core/run/host/protocol.ts`: Zod discriminated unions on `type`, `PROTOCOL_VERSION = 1`, parsed on both sides with `parseWith` (the host and its owner are separate processes; malformed = `internal.unexpected`, logged, the host survives). Results cross as `ResultWire` ([boundaries.md](../conventions/error-handling/boundaries.md#async-workers-cancellation)).

### Main → host

| `type`       | Fields                                                                                                                        | Reply (`reply { requestId, result }`)            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `init`       | `protocol`, `logLevel`                                                                                                        | `ready { protocol }`                             |
| `connect`    | `requestId`, `target: { kind: 'virtual', settings, homing, timeScale }`                                                       | `ControllerInfo` (version, settings, G54, homed) |
| `disconnect` | `requestId`                                                                                                                   | `void`; the host may then exit                   |
| `machine`    | `requestId`, `action`: `home` · `unlock` · `jog { to \| by, feed }` · `jogCancel` · `setWorkZero { axes, values? }` · `reset` | `void` or `run.state`                            |
| `jobStart`   | `requestId`, `jobId`, `program: SenderProgram`                                                                                | `void` once streaming starts                     |
| `jobControl` | `requestId`, `jobId`, `action`: `hold` · `resume` · `continue` · `stop`                                                       | `void`                                           |
| `timeScale`  | `requestId`, `scale: number \| 'max'`                                                                                         | `void` (virtual only)                            |

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
- `disconnect` and app quit end the host after `transport.close()`; quitting the app while a job runs asks first in the UI; a headless process exiting runs the stop sequence first.

## Commands and queries

All `run.*` commands are `machine: true`; the [permission rule](../architecture/grbl.md#transport-and-sender) for virtual connections applies (every source allowed). Jog, home and unlock go through typed commands; there is no raw gCode command in v0.1 ([Q11](#open-questions)).

| Name                    | Kind   | Args                                                          | Result / notes                                                                                                                                                                             |
| ----------------------- | ------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run.connection.open`   | effect | `{ target: 'virtual', planId, homing?: true, timeScale?: 1 }` | `ControllerInfo`. Builds the emulator from the plan's machine copy with `machineSettings` ([Q6](#open-questions)); `run.busy` if connected. `prepare: true` option: [Q7](#open-questions). |
| `run.connection.close`  | effect | `{}`                                                          | `run.busy` while a job runs.                                                                                                                                                               |
| `run.machine.home`      | job    | `{}`                                                          | `$H`; a job because homing takes seconds (9.6 s at 1× with defaults) and effects hold the project queue.                                                                                   |
| `run.machine.unlock`    | effect | `{}`                                                          | `$X` (Alarm → Idle, not homed).                                                                                                                                                            |
| `run.machine.jog`       | effect | `{ to?: Vec3 (machine), by?: Vec3, feed }`                    | `$J=G53 G90 …` or `$J=G91 …`; resolves on GRBL's `ok` (accepted), motion continues. `run.state` outside Idle/Jog/`toolChange`.                                                             |
| `run.machine.jogCancel` | effect | `{}`                                                          | `0x85`.                                                                                                                                                                                    |
| `run.workZero.set`      | effect | `{ axes: ('x'\|'y'\|'z')[], values?: Vec3 }`                  | `G10 L20 P1` at the current position (or `values` as WPos there), then `$#`; returns the new G54. Allowed in Idle and `toolChange`.                                                        |
| `run.machine.reset`     | effect | `{}`                                                          | Immediate `0x18` (the emergency path; may raise `ALARM:3`). A running job fails with `machine.alarm` or `op.aborted`.                                                                      |
| `run.job.start`         | job    | `{ planId }`                                                  | [Run job](#run-job). `RunSummary` `{ lines, seconds, toolChanges, pauses }`.                                                                                                               |
| `run.job.continue`      | effect | `{ jobId }`                                                   | Leaves `toolChange` or `programPause`; `run.state` in any other phase.                                                                                                                     |
| `run.timeScale.set`     | effect | `{ scale: number \| 'max' }`                                  | Virtual only, 1–100 or `max` ([Q3](#open-questions)).                                                                                                                                      |
| `run.status.get`        | query  | `{}`                                                          | `RunStatus` from main's mirror; `readsDocument: false`.                                                                                                                                    |

- **Job control** stays the generic `job.pause` / `job.resume` / `job.abort` ([commands.md](../architecture/commands.md#long-running-commands-jobs)): hold `!`, resume `~`, stop. A run must react at once, not at the next `checkpoint()`, so the run job uses the job's pause state from [workers.md](../architecture/workers.md#contract-changes) (`PauseState`, exposed on `JobContext`) with a change listener, and `ctx.signal` for abort.
- `ctx.services.machine?: MachineService` is the new port ([commands.md](../architecture/commands.md#command-definition): "the machine port arrives with run mode"); absent → `run.notConnected`. The permission policy reads `services.machine` to know whether the connection is virtual.

## Run job

`run.job.start { planId }` ([Q4](#open-questions)):

1. **Checks** (fail before sending): connected, no other job (`run.busy`), state `Idle` and homed (`run.state`), plan exists and not `archived` ([Q5](#open-questions)), the plan's machine copy equals the connected one (`run.state`, rule `machineMismatch`, [Q6](#open-questions)).
2. **Program:** the same internal export path as `plan.export` (regenerates stale toolpaths through the toolpath job, [workers.md](../architecture/workers.md#toolpath-cache); `exportGrbl` with the generator string) with `workZero` = the connected G54. `sections` come from the program's operation comments and tool changes, so the label reads `pocket1 · tool 2: 6 mm end mill`.
3. **Soft limits:** any `softLimit` finding fails the job with `run.softLimit` (findings in `data`) ([Q8](#open-questions)); other `plan.machine` warnings go into the job's progress label at start and into `RunSummary.warnings`.
4. **Stream:** `jobStart` to the host; progress, phase and status flow back; tool changes wait for `run.job.continue` ([Q9](#open-questions)).
5. **End:** `jobEnd` resolves the job: `Ok(RunSummary)`, `machine.*`, or `op.aborted` after a stop. No follow-up document command (a run changes no document in v0.1; marking a plan `inUse` stays manual).

- **Closing a project** whose dispatcher runs a job fails with `run.busy`; the job and its handle live in that dispatcher.
- The job's `startRevision` is irrelevant (no follow-up); later document edits never affect a running program (it was exported at start).

## Feedback

### Progress

`done` = lines acknowledged, `total` = program lines ([grbl.md](../architecture/grbl.md#transport-and-sender)); `label` = current section, or `Tool change 2: 6 mm end mill` / the `M0` message while waiting. Through `ctx.progress`, so the job's throttled progress stream reaches the UI, `job.get` and MCP like any job. Elapsed time is in `RunStatus`; a remaining-time estimate is later.

### Status

`RunStatus` (main's mirror, pushed to renderers over IPC and returned by `run.status.get`): `connection` (`closed` · `connecting` · `open`, `target`, `timeScale`), `state` (GRBL's, e.g. `Hold:0`), `homed`, `mpos`, `wpos`, `workZero` (G54 in MPos), `feed`, `spindle`, `buffer` (`Bf`), `alarm?`, `lastMessage?`, `job?` (`jobId`, `phase`, `line`, `toolChange?`, `startedAt`, `elapsedSeconds`). Status ticks are not action-log events ([commands.md](../architecture/commands.md#action-log)); MCP notifications come with 3.10 ([llm-api.md](../architecture/llm-api.md)). The 3D view's tool marker uses `wpos` (UI task, [Q12](#open-questions)).

### Work zero and the soft-limit check

- The host reads G54 with `$#` after connect, after `$H`, after every `run.workZero.set` and after a reset; `homed` is true after a successful `$H` in this connection (or a virtual machine started with `homing: false`), false after `ALARM:2/3/6`.
- **`plan.export`** passes `workZero` = G54 when a connection is open, `homed`, and the connected machine equals the plan's machine copy; its result states whether the soft-limit check ran (`softLimitChecked`). Otherwise it exports without it, as today ([grbl.md](../architecture/grbl.md#export-checks)). Closes the known issue "export soft-limit check needs the work zero".
- `run.job.start` always runs the check (step 3 of the [run job](#run-job)).

### Logging

Per [logging.md](../conventions/logging.md#forwarding): the host's root logger has `proc: 'utility'` (headless worker: `proc: 'worker'`) and forwards batches with `createLogForwarder` as `log` messages; main receives them with `createForwardReceiver` (origin `utility`). Scopes `run.host`, `run.sender`, `run.client`.

| Level   | Events                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------- |
| `info`  | Host start/exit, connect/disconnect (target, version, time scale), homing done, job start/end (lines, s) |
| `warn`  | Hold timeout before reset, status reply missing, malformed message from the other side                   |
| `debug` | Phase changes, tool changes, work-zero changes, time-scale changes                                       |
| `trace` | Line numbers sent/acknowledged, status reports. Never the gCode text (logging rule 5: no toolpaths)      |

`machine.*` errors are logged once by the boundary, not by the sender. The emulator's trace is off in the app and headless (`trace: false`), which settles the unbounded-trace known issue for v0.1 ([Q10](#open-questions)).

## Safety (v0.1)

These rules cover the virtual machine; they are not the real-machine safety spec ([run.md#safety](run.md#safety)), which must be accepted before any serial connection can be selected.

1. Only `target: 'virtual'` exists in v0.1 ([Q1](#open-questions)). The permission policy allows every source on it ([grbl.md](../architecture/grbl.md#transport-and-sender)) and keeps denying non-UI sources for any other target.
2. Every byte to the controller goes through `GrblSender`: lines are pre-flighted (no real-time characters, ≤ 80 bytes); no raw gCode or `$` command is exposed.
3. Streaming starts only from `Idle` and homed, after the soft-limit check with the current G54.
4. After `error:N` the sender never keeps streaming: hold, then reset to flush GRBL's buffers.
5. Stop is controlled (hold, then reset) so the position survives; `run.machine.reset` is the immediate path.
6. Feed hold does not stop the spindle (GRBL); a stopped run stops it via the reset.
7. The host never reconnects on its own, and a lost connection fails the job rather than retrying lines.
8. Tool changes wait for an explicit `run.job.continue`; jogging is possible only while waiting or with no job.

## Testing

Per [testing.md](../conventions/testing.md): unit → virtual machine; no hardware.

| Layer             | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parsers           | `status.ts` against report strings from the GRBL wiki and the emulator: MPos/WPos, `WCO` caching, `Ov`, `A:`, `FS`, `Bf`, inch reports, `$#`, `$G`, settings, `[MSG:…]`, banner.                                                                                                                                                                                                                                                                                                                                                                                 |
| Fake transport    | Byte-level edge cases: responses split mid-line and several per chunk, a banner mid-run, write errors, close; char counting arithmetic.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Sender on the VM  | `GrblSender` + `VirtualGrblTransport` + `VirtualClock`: every golden program and the test part stream with no `error:`, no RX-overflow violation in the emulator trace, final position as programmed (mm and inch); send-response mode; marker rule incl. the negative cases (malformed marker, marker inside a line, next line not `M0`); manual-spindle `M0` pauses; hold/resume; stop keeps the position without `ALARM:3`; stop timeout → `ALARM:3`; injected bad line → `machine.error` and no later line executed; soft-limit `ALARM:2` → `machine.alarm`. |
| Migration         | `emulator-run.test.ts` switches from `TestStreamer` to `GrblSender`; `TestStreamer` is removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Clocks            | `ScaledClock` with a fake `TimerHost`: scale changes re-anchor without jumps, timer order, cancel; `SteppedClock` yields and honours abort.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Host and protocol | Schemas accept/reject each message; host over in-memory endpoints: connect, home, jog, set zero, job with progress/phase/status throttling, tool change, stop, malformed messages, `run.busy`/`run.state`.                                                                                                                                                                                                                                                                                                                                                       |
| Commands          | Run commands with an in-process host: permission rule per source, preflight failures, `plan.export` with and without a connection (`softLimitChecked`), project close refused while running.                                                                                                                                                                                                                                                                                                                                                                     |
| Real host process | Headless host in a real `worker_threads` worker under Vitest (bundled entry as in [workers.md](../architecture/workers.md#testing)): a job at `max` speed end to end, host crash → `machine.connection`. The Electron utility-process entry is a thin adapter, covered by the Playwright smoke test (0.9) later.                                                                                                                                                                                                                                                 |
| End to end        | Task 3.11: the headless MCP flow connects, homes, sets the work zero, runs the test plan at `max` speed and continues each tool change.                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Files (planned)

| File                                            | Contents                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `src/core/run/clock.ts`                         | `Clock`, `VirtualClock` (exist), `TimerHost`, `ScaledClock`, `SteppedClock` |
| `src/core/run/grbl/sender.ts`, `status.ts`      | `GrblSender`; response, status and `$` parsers                              |
| `src/core/run/host/protocol.ts`                 | Message schemas, `PROTOCOL_VERSION`                                         |
| `src/core/run/host/host.ts`                     | Environment-neutral machine host over an `Endpoint`                         |
| `src/core/run/host/client.ts`                   | `MachineClient` (`MachineService` port), status mirror                      |
| `src/core/run/commands.ts`, `job.ts`            | `run.*` commands and queries, the run job                                   |
| `src/main/machine/utility.ts`, `node-worker.ts` | Utility-process entry; headless worker entry; spawning                      |

## Open questions

Each has a recommendation (**A**) first; the sections above assume it.

1. **Real serial in v0.1.** **A:** virtual only; `SerialTransport` is not written in 3.9 (the roadmap puts real machines out of v0.1, and `serialport` is a native addon that needs rebuilding and packaging for Electron); grbl.md's "written and unit-tested" line moves to the real-machine milestone. B: write and unit-test `SerialTransport` against a fake port but keep it unselectable (grbl.md's current text): ready earlier, but a native dependency in v0.1 with no user. C: selectable behind a developer flag: earliest real-hardware feedback, but bypasses the unaccepted safety spec.
2. **Machine host in headless/CLI.** **A:** a `worker_threads` worker running the same host and protocol as the utility process: the headless E2E test covers the real protocol, and the sender's timers are not starved by the dispatcher. B: in-process (no endpoint): simplest, but the protocol is only tested in unit tests. C: `child_process.fork`: closest to a utility process, but slower to start and a third bundling path.
3. **Time scale for the virtual machine.** **A:** 1× default; 1–100× and `max` (as fast as possible), settable at connect and during a run; agents and tests use `max`. B: real time plus `max` only: fewer cases, but no watchable fast demo. C: real time only: the test part takes over 10 min, too slow for the headless exit test.
4. **What `run.job.start` runs.** **A:** a plan (`{ planId }`), exported at start through the `plan.export` path with the live G54: the streamed program always matches the plan and is checked against the current work zero. B: a gCode file path: runs any program, but no plan-aware checks or section labels. C: both (file runs with generic checks only): more surface for v0.1.
5. **Plan statuses that may run on the virtual machine.** **A:** every status except `archived`: the virtual machine is where a draft is verified before `finalized`; real machines will require `finalized`/`inUse`. B: only `finalized` and `inUse` (plan-v0.1.md lists "run" for `finalized`): stricter, but every trial needs status changes.
6. **Which machine the virtual machine emulates.** **A:** the plan's machine copy, given at connect (`planId`); a job on a different machine copy fails with `machineMismatch`: the emulator matches what was exported. B: a library machine by id: independent of plans, but can drift from the plan's copy. C: generic GRBL defaults: no setup, but timings and soft limits mean nothing.
7. **Homing and work zero on the virtual machine.** **A:** realistic flow (starts in Alarm; home, jog, set work zero), plus an opt-in `prepare: true` at connect that homes instantly and places G54 so the plan's stock sits centred on the table with its top at a valid Z: agents, demos and tests get a one-step setup, users learn the real flow. B: realistic flow only: more steps for every agent run. C: always prepared (`homing: false`): simplest, but the run UI never practises homing and zeroing.
8. **Soft-limit check at job start.** **A:** refuse to start with `run.softLimit` (no override): an `ALARM:2` mid-run would need re-homing, and fixing the work zero is quick. B: warn and stream anyway (GRBL stops with `ALARM:2`): shows the real alarm but wastes the run. C: refuse unless `force: true`: flexible, but an override invites mistakes on real machines later.
9. **Tool changes on the virtual machine.** **A:** the same guided wait as on a real machine; agents and tests call `run.job.continue` (with optional jog and Z zero meanwhile): one code path, tested end to end. B: additionally an opt-in `autoContinue` for virtual runs: shorter agent scripts, but the wait path is less exercised. C: auto-continue always on virtual: the tool-change flow would go untested until real machines.
10. **Emulator trace in the app.** **A:** off (`trace: false`) in app and headless; tests in-process keep it; a capped ring buffer comes with a later debug view. B: a capped ring buffer now plus a `run.trace.get` query for agents: richer diagnostics, more code in 3.9.
11. **Extra controls in v0.1.** **A:** none beyond the commands above. B: feed/rapid/spindle overrides (`run.override.set`, real-time `0x90–0x9E`; the emulator applies them): useful for demos, small. C: B plus raw gCode/`$` lines on virtual connections (`run.machine.send`): handy for agents, but a raw channel that must be fenced off before real machines.
12. **Run-mode UI.** **A:** a separate task 3.12 after the UI shell (3.3) and viewport (3.5): connect panel, home, jog, set zero, start/pause/resume/stop, tool-change dialog, progress bar and DRO; 3.9 delivers core, host, commands and the IPC status push. B: inside 3.9: one task for the whole feature, but 3.9 then waits for 3.3.
