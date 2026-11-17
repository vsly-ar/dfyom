# GRBL post-processor and virtual machine

Status: accepted · Decision: [ADR 0013](../decisions/0013-grbl-first-controller.md) · Processes: [ADR 0008](../decisions/0008-threading-split-by-job.md) · Machine model: [library.md](library.md#machine) · Terms: [glossary.md](../glossary.md) · Tasks: [v0.1 plan](../plans/v0.1.md) 1.10 (post: 2.11, virtual machine: 3.8, streaming: 3.9)

Primary sources (GRBL 1.1, gnea/grbl): [Interface](https://github.com/gnea/grbl/wiki/Grbl-v1.1-Interface) · [Commands](https://github.com/gnea/grbl/wiki/Grbl-v1.1-Commands) · [Configuration](https://github.com/gnea/grbl/wiki/Grbl-v1.1-Configuration) · [Jogging](https://github.com/gnea/grbl/wiki/Grbl-v1.1-Jogging) · [error codes](https://github.com/gnea/grbl/blob/master/doc/csv/error_codes_en_US.csv) · [alarm codes](https://github.com/gnea/grbl/blob/master/doc/csv/alarm_codes_en_US.csv) · [config.h](https://github.com/gnea/grbl/blob/master/grbl/config.h) (buffer sizes). Facts below come from these; DFYOM rules are marked as such.

## Post-processor (task 2.11)

### Input boundary

Two pure steps in `src/core`, both inside the export `effect` command (task 2.11):

1. **Export** (`toMachiningProgram`) takes plan mode's [export boundary](../modes/plan-v0.1.md#export-boundary-tasks-110-and-211): the ordered `Toolpath[]` of one setup ([toolpath data model](../modes/plan-v0.1.md#toolpath-data-model), float64 mm in the setup's WCS), the setup and the machine snapshot. It expands `drill` moves, converts arc centers to `I`/`J` offsets and inserts tool-change and spindle blocks.
2. **Post** (`postGrbl(program: MachiningProgram, opts: PostOptions): AppResult<string>`) turns that program into gCode text. It never sees design, geometry or the plan.

| `MachiningProgram` field  | Content                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `setupName`       | Plain text for the header comment.                                                                                                                                     |
| `units`, `spindleControl` | From the machine snapshot (`programUnits`, `spindle.control`); coordinates stay mm, the post converts to inch (÷ 25.4).                                                |
| `clearanceZ`              | Stock top in the WCS + `clearanceHeight`: rapids between operations, tool changes, start and end.                                                                      |
| `blocks`                  | `toolChange` (tool snapshot: name, diameter), `spindle` (rpm or off), `rapid { to }`, `feed { to, feed }`, `arc { to, i, j, cw, feed }` (Z change = helix), `comment`. |

**Drill expansion** (GRBL 1.1 has no `G81–G83`): `simple` = rapid to `retract`, feed to `bottom`, rapid to `retract`; `peck` = feed by `peck`, rapid up to `retract`, rapid back to 0.5 mm / 0.02″ above the last depth, repeat; `chipBreak` = after each peck rapid up by `back` only.

### Output dialect

| Item           | Emitted                                                                                                                  | Why                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Motion         | `G0`, `G1`, `G2`/`G3` with `I`/`J` (never `R`)                                                                           | IJK is unambiguous for near-180° arcs; all in GRBL's supported list.     |
| Modes          | `G17`, `G21`/`G20`, `G90`, `G94`, `G54`                                                                                  | Explicit state; never rely on controller defaults.                       |
| Spindle        | `M3 S<rpm>`, `M5`; spin-up `G4 P<s>` after `M3` (`opts.spinUpSeconds`, default 3)                                        | GRBL does not wait for spindle speed. `M4` (CCW) not emitted.            |
| Pause          | `M0` preceded by a comment with the message                                                                              | GRBL pauses in `Hold:0`; `~` resumes.                                    |
| Tool change    | No `M6`, no `T` word: `M5`, `G0 Z<clearanceZ>`, marker comment `(DFYOM TOOL CHANGE n: name)`, `M0`, then `M3 S…` + dwell | `M6` is not in GRBL 1.1's supported list; GRBL has no tool table or ATC. |
| Manual spindle | `spindle.control = 'manual'`: `M0` with "Set spindle to N rpm" before cutting; `S` still emitted                         | [library.md](library.md#machine).                                        |
| Never emitted  | `G28`/`G30`, `G53`, `G92`, `G43.1`, coolant, `N` line numbers, `%`                                                       | Depend on stored or machine state the export cannot know; not needed.    |

- **Modal suppression:** a word is emitted only when it changes (motion code, unchanged axis words, `F`). The first `G1`/`G2`/`G3` after any `F` change always carries `F` (GRBL has no default feed: `error:22`).
- **Header:** comment lines (program, setup, units, tools in order of use, generator string from `opts`), then `G90 G94 G17 G21|G20`, `G54`, `G0 Z<clearanceZ>`.
- **First tool:** treated like a tool change without the `M0` when `opts.firstToolLoaded` (default true).
- **Tool change in DFYOM:** one file per setup. GRBL accepts no jog or zeroing while paused by `M0`, so DFYOM's sender stops streaming before the marker comment, waits for Idle, guides the user (jog, change tool, zero Z with `G10 L20 P1 Z0`), skips the `M0` and continues. Other senders pause at `M0`.
- **Footer:** `G0 Z<clearanceZ>`, `M5`, `M30`. No park move: the safe XY position is machine-specific and unknown in v0.1.

### Numbers, lines and comments

- **Precision:** mm 3 decimals, inch 4 decimals for coordinates and `I`/`J`; `F` 1 decimal; `S` integer; `P` 2 decimals. Round half away from zero from the decimal value, strip trailing zeros and a trailing `.`, normalize `-0` to `0`, no exponent, keep the leading `0` (`0.5`). `F` must be > 0 after rounding, else `Err('model.invariant')`.
- **Line length:** GRBL's line buffer is 80 chars (`LINE_BUFFER_SIZE`, overflow = `error:11`); the 128-byte RX buffer counts every byte sent. DFYOM rule: every line ≤ 70 bytes including comments; longer comments are truncated, code lines never exceed it.
- **Character set (safety):** GRBL picks realtime commands out of the stream at any position, including inside comments: `?`, `!`, `~` and every byte ≥ 0x80 (overrides, door, jog cancel). The post therefore emits **printable ASCII only**, and comment text drops `?!~()`, `;` and non-ASCII (`″` → `in`, `ø` → `dia`, others → `_`).
- **Comments:** `(text)` on their own line, no nesting; no `;` comments.

### Determinism and tests

Same input and options → byte-identical output: LF line endings, final newline, no dates, no app version (the generator string is passed in; tests use a fixed one), fixed word order `G … X Y Z I J F S P`. Golden files: `src/core/post/grbl/__golden__/*.nc`, one per v0.1 operation plus a multi-tool program; update with `vitest -u`. Each golden file is also streamed through the virtual machine in tests (no `error:` lines, ends `Idle`).

## Virtual machine (task 3.8)

A GRBL 1.1 emulator: a pure, deterministic state machine in `src/core` fed bytes and a clock, producing bytes. It answers **exactly like GRBL** for the subset below so the same sender works against it and a real controller. Banner after reset: `Grbl 1.1h ['$' for help]`.

### Protocol subset

| Area          | Emulated                                                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Responses     | `ok`, `error:N`, `ALARM:N`, `[MSG:…]` (`'$H'\|'$X' to unlock`, `Reset to continue`), settings and `$G` lines.                                                                                        |
| Buffers       | RX 128 bytes (`RX_BUFFER_SIZE`), line 80 chars (`error:11`), planner 15 free blocks (`BLOCK_BUFFER_SIZE` 16; `Bf:15,128` when idle). Bytes beyond the RX buffer are dropped and recorded.            |
| Realtime      | `?` status, `!` feed hold, `~` cycle start/resume, `0x18` soft reset, `0x84` safety door, `0x85` jog cancel, `0x90–0x97` feed/rapid overrides (applied to timing), `0x99–0x9E` spindle (state only). |
| Status report | `<State\|MPos:x,y,z\|Bf:b,r\|FS:f,s\|WCO:x,y,z\|Ov:f,r,s>`; `$10` selects MPos/WPos and `Bf`; `WCO`/`Ov` periodically as in GRBL. Positions in mm with 3 decimals.                                   |
| `$` commands  | `$$`, `$x=val` (session only), `$G`, `$I`, `$#` (G54 only), `$H`, `$X`, `$C` (check mode), `$J=` (G20/G21, G90/G91, G53, X/Y/Z, F required).                                                         |
| gCode         | `G0–G3`, `G4`, `G10 L2/L20 P1`, `G17`, `G20/G21`, `G53`, `G54`, `G90/G91`, `G94`, `M0`, `M2`, `M30`, `M3/M4/M5`, `S`, `F`, `T` (accepted, ignored), comments. Anything else → `error:20`.            |
| Errors        | 1, 2, 3, 8, 9, 10, 11, 15, 16, 20, 21, 22, 33 with GRBL's meanings; others are not produced.                                                                                                         |
| Alarms        | 2 soft limit (then `[MSG:Reset to continue]`), 3 reset during motion, plus homing-lock at startup when `$22=1`.                                                                                      |

Settings: `$100–$132` and `$30/$31` come from the machine snapshot ([library.md](library.md#machine)); DFYOM defaults `$10=1`, `$11=0.010`, `$12=0.002`, `$20=1`, others GRBL defaults. Steps/mm are reported but not used.

Emulator option `homing` (sets `$22`): `true` (default in the app) starts in Alarm with `[MSG:'$H'|'$X' to unlock]` and needs `$H`; `false` starts Idle, already homed at MPos `0,0,0`, for tests and demos.

### State machine

| State           | Entered by                                               | Left by                                                        |
| --------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| Alarm           | startup with `homing`; `ALARM:N`                         | `$H` → Home; `$X` → Idle; reset after ALARM:2/3 → Alarm (lock) |
| Home            | `$H` (Idle or Alarm)                                     | done → Idle with MPos `0,0,0`                                  |
| Idle            | homing done, motion done, `$X`, jog cancel, reset        | first planned block → Run; `$J=` → Jog                         |
| Run             | blocks in the planner                                    | buffer empty → Idle; `!` or `M0` → Hold                        |
| Hold:1 / Hold:0 | `!` (decelerating / stopped); `M0` (Hold:0 once stopped) | `~` → Run; `0x18` → Idle, or ALARM:3 if still moving           |
| Jog             | `$J=` from Idle or Jog                                   | done or `0x85` → Idle; `!` cancels the jog                     |
| Door:0–3        | `0x84`                                                   | `~` once "closed" (test hook) → resume; no parking             |
| Check           | `$C`                                                     | `$C` again → soft reset → Idle                                 |

Soft limits as in GRBL's default homing direction: after `$H`, machine coordinates span `[-$13x, 0]` per axis. A gCode target outside → `ALARM:2` with feed hold; a jog target outside → `error:15`, no alarm.

### Motion timing

Motion follows GRBL's planner: a trapezoidal velocity profile per block from `$110–$112` (max rate, also for G0) and `$120–$122` (acceleration), with **junction-deviation look-ahead** (`$11`) over the 15-block planner buffer for corner speeds. `G2`/`G3` (incl. helices) are split into chords within `$12` like GRBL, since plan mode emits arcs in v0.1. Overrides scale feed (and rapid) rates. Time comes from an injected `Clock`: tests step it in virtual time (`advance(ms)`, as fast as the CPU allows); the app runs it at real time (or a user time scale for demos).

### Transport and sender

```ts
// src/core/run/transport.ts – byte stream, same for serial and emulator
interface ControllerTransport {
  write(bytes: Uint8Array): AsyncAppResult<void>
  onData(listener: (bytes: Uint8Array) => void): () => void
  close(): AsyncAppResult<void>
}
```

- `GrblSender` (`src/core/run/grbl/sender.ts`, headless) owns the protocol: line framing, **character counting** against the 128-byte RX buffer, `?` polling (5 Hz), mapping `job.pause`/`job.resume`/`job.abort` to `!`/`~`/`!`+`0x18`, and `error:N`/`ALARM:N` to `AppError`s (planned codes `machine.error`, `machine.alarm`, `machine.connection`). On the first `error:N` it stops sending and feed-holds. Send-response mode is a sender option for debugging.
- Implementations: `VirtualGrblTransport` (wraps the emulator; in-process in tests and headless tests, in the utility process in the app) and `SerialTransport` (`serialport`, utility process only, [ADR 0008](../decisions/0008-threading-split-by-job.md)).
- **v0.1 connects to the virtual machine only.** `SerialTransport` is written and unit-tested (against a fake port) but cannot be selected until [run.md#safety](../modes/run.md#safety) is accepted.
- Run commands (`run.connection.open { target: 'virtual' }`, `run.job.start` as a `job`, [commands.md](commands.md#long-running-commands-jobs)) are `machine: true`.
- **Permission rule** (for the `PermissionPolicy`, [commands.md](commands.md#dispatcher-pipeline) step 5): a machine command whose connection is virtual is allowed for every source (UI, agent, CLI, automation, system), since no real machine is affected; on a real connection the strict policy stays (only UI sources until [run.md#safety](../modes/run.md#safety) says otherwise). This makes the headless MCP exit criterion possible.
- Progress: `done` = lines acknowledged with `ok`, `total` = program lines; the position from status reports drives the 3D view.

### Observability for tests

The emulator records a trace readable in-process: executed lines (line, start/end time), position samples (time, MPos, state) at block boundaries, every response sent, every state transition, and protocol violations (RX overflow, non-ASCII byte in a line, line over 80 chars). Material removal against the stock comes later, via plan-mode simulation.

### Not emulated in v0.1

Hard limits and limit pins, probing (`G38.x`, `$#` PRB), `G28`/`G30`/`G92`/`G93`, `G55–G59`, coolant effect, laser mode (`$32`), parking, sleep (`$SLP`), startup lines (`$N`), EEPROM persistence, `$RST`, step pulses and step-rate limits, backlash and missed steps, spindle physics, grblHAL/FluidNC extensions, fault injection (later: [testing.md](../conventions/testing.md)).

## Files (planned)

| File                                       | Contents                                                      |
| ------------------------------------------ | ------------------------------------------------------------- |
| `src/core/post/program.ts`                 | `MachiningProgram` and block types (the plan → post contract) |
| `src/core/post/grbl/post.ts`, `format.ts`  | `postGrbl`, number and comment formatting                     |
| `src/core/run/transport.ts`                | `ControllerTransport` port                                    |
| `src/core/run/grbl/sender.ts`, `status.ts` | Streaming sender; status-report and response parsers          |
| `src/core/run/grbl/emulator/*.ts`          | Parser subset, planner/timing, state machine, trace           |
| `src/core/run/grbl/virtual-transport.ts`   | `VirtualGrblTransport`                                        |
| `src/main/machine/utility.ts`              | Utility-process entry hosting sender and transports           |
| `src/main/machine/serial-transport.ts`     | `SerialTransport` (Node `serialport`)                         |
