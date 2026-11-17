# GRBL post-processor and virtual machine

Status: implemented (post 2.11, virtual machine 3.8; sender 3.9 pending) · Decision: [ADR 0013](../decisions/0013-grbl-first-controller.md) · Processes: [ADR 0008](../decisions/0008-threading-split-by-job.md) · Machine model: [library.md](library.md#machine) · Terms: [glossary.md](../glossary.md) · Tasks: [v0.1 plan](../plans/v0.1.md) 1.10 (post: 2.11, virtual machine: 3.8, streaming: 3.9)

Primary sources (GRBL 1.1, gnea/grbl): [Interface](https://github.com/gnea/grbl/wiki/Grbl-v1.1-Interface) · [Commands](https://github.com/gnea/grbl/wiki/Grbl-v1.1-Commands) · [Configuration](https://github.com/gnea/grbl/wiki/Grbl-v1.1-Configuration) · [Jogging](https://github.com/gnea/grbl/wiki/Grbl-v1.1-Jogging) · [error codes](https://github.com/gnea/grbl/blob/master/doc/csv/error_codes_en_US.csv) · [alarm codes](https://github.com/gnea/grbl/blob/master/doc/csv/alarm_codes_en_US.csv) · [config.h](https://github.com/gnea/grbl/blob/master/grbl/config.h) (buffer sizes). Facts below come from these; DFYOM rules are marked as such.

## Post-processor (task 2.11)

### Input boundary

Two pure, synchronous steps in `src/core/post/`, composed by `exportGrbl` (the export `effect` command calls it, see [Implementation](#implementation-task-211)):

1. **Export** (`toMachiningProgram(input, machine): AppResult<MachiningProgram>`) takes plan mode's [export boundary](../modes/plan-v0.1.md#export-boundary-tasks-110-and-211): the ordered `Toolpath[]` of one setup ([toolpath data model](../modes/plan-v0.1.md#toolpath-data-model), float64 mm in the setup's WCS), each with its tool copy (`ProgramTool`: name, diameter) and a label, the setup (name, `clearanceHeight`) and the machine snapshot. It expands `drill` moves, converts arc centers to `I`/`J` offsets and inserts tool-change and spindle blocks.
2. **Post** (`postGrbl(program: MachiningProgram, opts: PostOptions): AppResult<string>`; `postGrblLines` returns the lines) turns that program into gCode text. It never sees design, geometry or the plan.

```ts
// src/core/post/export.ts
exportGrbl(input: ExportInput, opts: PostOptions): AppResult<GrblExport>
ExportInput = { name, setup: { name, clearanceHeight }, operations: { toolpath, tool, label }[],
                machine: Option<Machine>, workZero?: Vec3 }
GrblExport  = { program, lines, text, stats, warnings }   // warnings: plan.machine findings
PostOptions = { generator: string, spinUpSeconds?: number /* 3 */, firstToolLoaded?: boolean /* true */ }
```

`lines` are the gCode lines without line ends (what a sender streams, progress `total`), `text` the file (LF, final newline). `stats` = `{ cutLength, rapidLength, estimatedSeconds, dwellSeconds, toolChanges }`: lengths and time as the [toolpath stats](../modes/plan-v0.1.md#toolpath-generators-task-210) (no acceleration, rapids at the slowest axis) over the whole program incl. the moves between operations, plus the spin-up dwells; moves from an unknown position (program start, after a tool change's `M0`) are not counted. One file per setup, i.e. one per plan in v0.1.

| `MachiningProgram` field  | Content                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `setupName`       | Plain text for the header comment.                                                                                                                                     |
| `units`, `spindleControl` | From the machine snapshot (`programUnits`, `spindle.control`); coordinates stay mm, the post converts to inch (÷ 25.4).                                                |
| `clearanceZ`              | Stock top in the WCS + `clearanceHeight`: rapids between operations, tool changes, start and end.                                                                      |
| `blocks`                  | `toolChange` (tool snapshot: name, diameter), `spindle` (rpm or off), `rapid { to }`, `feed { to, feed }`, `arc { to, i, j, cw, feed }` (Z change = helix), `comment`. |

**Drill expansion** (GRBL 1.1 has no `G81–G83`): `simple` = rapid to `retract`, feed to `bottom`, rapid to `retract`; `peck` = feed by `peck`, rapid up to `retract`, rapid back to 0.5 mm / 0.02″ above the last depth, repeat; `chipBreak` = after each peck rapid up by `back` only. Implemented once, as `expandDrill` in `src/core/toolpath/stats.ts`; the export passes 0.508 mm (0.02″) for inch programs.

**Tools and spindle blocks:** a `toolChange` block whenever the toolpath's tool copy (`Toolpath.tool`) differs from the previous one, tools numbered 1, 2, … by first use (a tool used again keeps its number); a `spindle` block after every tool change and whenever the speed changes; a `comment` block with the operation's label before each operation.

### Output dialect

| Item           | Emitted                                                                                                                                      | Why                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Motion         | `G0`, `G1`, `G2`/`G3` with `I`/`J` (never `R`)                                                                                               | IJK is unambiguous for near-180° arcs; all in GRBL's supported list.     |
| Modes          | `G17`, `G21`/`G20`, `G90`, `G94`, `G54`                                                                                                      | Explicit state; never rely on controller defaults.                       |
| Spindle        | `M3 S<rpm>`, `M5`; spin-up `G4 P<s>` after `M3` (`opts.spinUpSeconds`, default 3)                                                            | GRBL does not wait for spindle speed. `M4` (CCW) not emitted.            |
| Pause          | `M0` preceded by a comment with the message                                                                                                  | GRBL pauses in `Hold:0`; `~` resumes.                                    |
| Tool change    | No `M6`, no `T` word: `M5`, `G0 Z<clearanceZ>`, marker comment `(DFYOM TOOL CHANGE n: name)`, `M0`, `G0 Z<clearanceZ>`, then `M3 S…` + dwell | `M6` is not in GRBL 1.1's supported list; GRBL has no tool table or ATC. |
| Manual spindle | `spindle.control = 'manual'`: `M3 S<rpm>`, `(Set spindle to N rpm)`, `M0` before cutting; no dwell                                           | [library.md](library.md#machine).                                        |
| Never emitted  | `G28`/`G30`, `G53`, `G92`, `G43.1`, coolant, `N` line numbers, `%`                                                                           | Depend on stored or machine state the export cannot know; not needed.    |

- **Modal suppression:** a word is emitted only when it changes (motion code, unchanged axis words, `F`). "Unchanged" compares the written text, so a move whose every axis word is unchanged after rounding is dropped (its `F` stays pending for the next feed move). The first `G1`/`G2`/`G3` after any `F` change always carries `F` (GRBL has no default feed: `error:22`). An arc needs at least one axis word in the plane (GRBL `error:32` otherwise): a full circle in the program (end = start in X and Y) writes both `X` and `Y`. `I` and `J` are always written.
- **Arcs as GRBL reads them:** `I`/`J` = center − the _written_ start, so GRBL's center is the intended one within rounding. Toolpath arcs sweep at most 180°, so an arc whose written chord is under 10 resolution steps (0.01 mm, 0.001″) is written as `G1`: GRBL would read near-equal ends as a full circle. If GRBL's end-on-circle check (`error:33`: 0.005 mm and 0.1 % of the radius) would fail after rounding (possible with 4 inch decimals at radii under ~5 mm), the post takes the neighbouring `I`/`J` (± one step) closest to the end; an arc that still fails, or whose sweep as GRBL computes it moves the end by more than 0.005 mm, fails the export with `model.invariant`.
- **Header:** comment lines (`Program:`, `Setup:`, `Units:`, `Tool n: name, dia D mm|in` in order of use, `Generator:` from `opts`), then `G90 G94 G17 G21|G20`, `G54`, `G0 Z<clearanceZ>`.
- **First tool:** treated like a tool change without the `M0` when `opts.firstToolLoaded` (default true): the marker comment (informational: no `M0` follows, so no sender stops), `M3 S…`, dwell. With `firstToolLoaded: false` it pauses like any tool change.
- **After a tool change's `M0`** the user has jogged and re-zeroed Z, so the post forgets the position, motion code and `F`: it writes `G0 Z<clearanceZ>` (in the new WCS, before the spindle starts) and the next move carries `X`, `Y` and `F` again. The retracts before a tool change and in the footer are suppressed like any move when Z is already at clearance (toolpaths end there); the header's and the post-`M0` retract are always written.
- **Validation:** non-finite values or magnitudes over 99 999 (in text units), a feed that rounds to 0, an `S` that rounds to 0, a feed move with the spindle off, an arc without a radius or from an unknown position, and `spinUpSeconds` outside 0–3600 fail with `model.invariant` (issues name the block).
- **Tool change in DFYOM:** one file per setup. GRBL accepts no jog or zeroing while paused by `M0` (it reads no lines in Hold:0), so DFYOM's sender stops streaming before the marker comment, waits for Idle, guides the user (jog, change tool, zero Z with `G10 L20 P1 Z0`), sends the marker, skips the `M0` and continues. Other senders pause at `M0`.
- **Marker rule for the sender (task 3.9):** a tool change is a whole line matching exactly `(DFYOM TOOL CHANGE n: name)` (`n` digits, `name` without parentheses) whose next line is exactly `M0`. Anything else (a malformed marker, a marker inside a longer line, a next line other than `M0`) is streamed unchanged, so GRBL's plain `M0` pause applies. `TestStreamer` in `src/core/run/grbl/emulator.fixture.ts` implements this rule.
- **Footer:** `G0 Z<clearanceZ>`, `M5`, `M30`. No park move: the safe XY position is machine-specific and unknown in v0.1.

### Export checks

`exportGrbl` fails with **`post.noMachine`** when the plan has no machine copy. Every other machine check is a warning (`plan.machine` findings in the shape of `plan.warning.list`, [plan-v0.1.md](../modes/plan-v0.1.md#plan-record)); the program is still written:

| Rule           | Check                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxFeedRate`  | Per operation, the worst move: its speed along each axis (feed × that axis' share of the direction; an arc counts its full XY speed on X and Y) ≤ the axis' `maxFeedRate` – where GRBL starts to slow it down. |
| `spindleRange` | Each operation's spindle speed within `spindle.minSpeed..maxSpeed` (GRBL clamps silently).                                                                                                                     |
| `travel`       | The program's extent per axis (all visited points incl. arc bulges and `clearanceZ`) ≤ the travel; the work zero on the table is unknown.                                                                      |
| `softLimit`    | Only with `workZero` (MPos of the work zero, e.g. from a connected controller): every point in machine coordinates within [−travel, 0] (GRBL's default homing direction, as the virtual machine).              |

### Numbers, lines and comments

- **Precision:** mm 3 decimals, inch 4 decimals for coordinates and `I`/`J`; `F` 1 decimal; `S` integer; `P` 2 decimals. Round half away from zero from the decimal value, strip trailing zeros and a trailing `.`, normalize `-0` to `0`, no exponent, keep the leading `0` (`0.5`). `F` must be > 0 after rounding, else `Err('model.invariant')`.
- **Line length:** GRBL's line buffer is 80 chars (`LINE_BUFFER_SIZE`, overflow = `error:11`); the 128-byte RX buffer counts every byte sent. DFYOM rule: every line ≤ 70 bytes including comments; longer comments are truncated, code lines never exceed it.
- **Character set (safety):** GRBL picks realtime commands out of the stream at any position, including inside comments: `?`, `!`, `~` and every byte ≥ 0x80 (overrides, door, jog cancel). The post therefore emits **printable ASCII only**, and comment text drops `?!~()`, `;` and non-ASCII (`″` → `in`, `ø` → `dia`, others → `_`).
- **Comments:** `(text)` on their own line, no nesting; no `;` comments.

### Determinism and tests

Same input and options → byte-identical output: LF line endings, final newline, no dates, no app version (the generator string is passed in; tests use a fixed one), fixed word order `G M X Y Z I J F S P`. Golden files: `src/core/post/grbl/__golden__/*.nc` (`facing`, `pocket-circle-helix`, `drilling-peck-chipBreak`, `profile-tabs`, `multi-tool`, `multi-tool-inch-manual-spindle`); update with `vitest -u`. Each golden file is also streamed through the virtual machine in tests (no `error:` lines, ends `Idle`).

- **Properties** (`post.test.ts`, on the golden programs, the test part and 40 random toolpaths per unit with tiny, 180° and helical arcs): every line ≤ 70 bytes of printable ASCII, every word in its precision (no `-0`, exponent or trailing zero), fixed word order, nothing from the never-emitted list (no `G81`–`G83`), every arc line with an in-plane axis word; and the text re-parsed with the virtual machine's `parseBlock` makes exactly the intended moves (targets within half a resolution step, rapid/feed mode, feed, arc circle, direction and sweep), so modal suppression never loses state.
- **End to end** (`emulator-run.test.ts`): the [geometry test part](geometry.md#testing)'s program (5 tools, the drill twice) streamed with character counting through the virtual machine after `$H` and a `G54` 750/750/50 mm into the table: no `error:` and no alarm, no protocol violation, the final position as programmed (mm and inch); with the DFYOM tool-change rule the sender stops at all 5 markers, the test jogs and re-zeroes Z, and each resumes with `G0 Z<clearanceZ>` before `M3`; another sender's run pauses at each `M0` (Hold:0) and resumes with `~`; a machine with too little Z travel gets the `softLimit` warning and `ALARM:2`.
- **Time:** with 400/400/200 mm/s² acceleration the virtual machine needs 623.2 s for the test part (without the tool-change pauses) against 586.9 s estimated (`stats.estimatedSeconds`, incl. 18 s of dwells): **ratio 1.06** (1.10 against the sum of the toolpath estimates, 568.0 s, which leave out dwells and the moves between operations). The test asserts 1 < ratio < 1.5.

### Implementation (task 2.11)

- **No command yet.** Toolpaths are derived data generated and cached by the 2.9 job (`plan.toolpath.generate`, which also owns the `PlanOperationInput` → `GeneratorInput` mapping), so the `plan.export` effect command comes with task 2.9: it regenerates stale toolpaths, maps the plan's tool copies to `ProgramTool` (name, diameter) and operation names to labels, calls `exportGrbl` and writes `text`. The pure post is complete and tested without it.
- **One file per plan:** v0.1 plans have one setup, so "one file per setup" is one per plan; DFYOM's sender guides the tool changes inside it.
- **Error code** `post.noMachine` (registered with the post). Machine checks reuse `plan.machine`.

## Virtual machine (task 3.8)

A GRBL 1.1 emulator: a pure, deterministic state machine in `src/core` fed bytes and a clock, producing bytes. It answers **exactly like GRBL** for the subset below so the same sender works against it and a real controller. Banner after reset: `Grbl 1.1h ['$' for help]`.

### Protocol subset

| Area          | Emulated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Responses     | `ok`, `error:N`, `ALARM:N`, `[MSG:…]` (`'$H'\|'$X' to unlock`, `Reset to continue`, `Caution: Unlocked`, `Enabled`/`Disabled`, `Pgm End`, `Check Door`, `Restoring spindle`), `[HLP:…]`, settings, `$G`/`$#`/`$I` lines.                                                                                                                                                                                                                                                                                                                                      |
| Buffers       | RX 128 bytes (`RX_BUFFER_SIZE`, all usable: GRBL's ring has `RX_BUFFER_SIZE + 1` slots; `Bf` reports 128 − used), line 80 chars (`error:11` once 79 characters remain after stripping spaces and comments, like GRBL), planner 15 free blocks (`BLOCK_BUFFER_SIZE` 16; `Bf:15,128` when idle). Bytes beyond the RX buffer are dropped and recorded. Both `\r` and `\n` end a line, so CRLF gets two `ok`s.                                                                                                                                                    |
| Realtime      | `?` status, `!` feed hold, `~` cycle start/resume, `0x18` soft reset, `0x84` safety door, `0x85` jog cancel, `0x90–0x97` feed/rapid overrides (applied to timing), `0x99–0x9E` spindle (state only).                                                                                                                                                                                                                                                                                                                                                          |
| Status report | `<State\|MPos:x,y,z\|Bf:b,r\|FS:f,s\|WCO:x,y,z\|Ov:f,r,s\|A:S>`; `$10` selects MPos/WPos and `Bf`; `WCO` every 10 reports (30 while busy) and `Ov` (with the accessory field `A:S`/`A:C` while the spindle runs) every 10 (20) as in GRBL's report counters, and on the next report after a change. Positions in mm with 3 decimals (`$13=1`: inch, 4 decimals); `FS` is the current speed in mm/min (no decimals) and the running spindle rpm after override and `$30/$31` clamping. No reports while waiting for a reset after `ALARM:2` (GRBL busy-waits). |
| `$` commands  | `$`, `$$`, `$x=val` (session only), `$G`, `$I` (`[VER:1.1h.20190830:]`, `[OPT:V,15,128]`), `$#` (G54 from `G10`; G55–G59, G28, G30, G92, TLO and PRB printed as zero), `$H`, `$X`, `$C` (check mode), `$J=` (G20/G21, G90/G91, G53, X/Y/Z, F required; the jog's modes do not persist). `$N`, `$SLP`, `$RST` and `$I=` are not emulated → `error:3`.                                                                                                                                                                                                          |
| gCode         | `G0–G3` (IJ or R arcs, G17 only), `G4`, `G10 L2/L20 P0\|P1` (missing `P` = 0, the active system), `G17`, `G20/G21`, `G53`, `G54`, `G90/G91`, `G94`, `M0`, `M2`, `M30`, `M3/M4/M5`, `S`, `F`, `T` (accepted, ignored), `N` (ignored), comments. Anything else → `error:20` (including `G81–G83`, which the post expands). `S`/`M3–M5`, `G4`, `G10`, `M0`, `M2`/`M30` wait for the planner to empty (GRBL's buffer synchronization), so they end look-ahead.                                                                                                    |
| Errors        | GRBL's codes for the checks of this subset: 1–5, 8–11, 15, 16, 20–26, 28, 30, 32–36, 38 with GRBL's meanings and precedence (e.g. `G0 G1` and `G0 G1.5` are 24; in R mode `I`/`J` are unused words, 36; `G10 L2 R…` is 20; `T` > 255 is 38). 6, 7, 12–14, 17, 27, 29, 31, 37 are not produced.                                                                                                                                                                                                                                                                |
| Alarms        | 2 soft limit (then `[MSG:Reset to continue]`), 3 reset during motion, 6 reset during homing, plus homing-lock at startup when `$22=1`.                                                                                                                                                                                                                                                                                                                                                                                                                        |

Settings: `$100–$132` and `$30/$31` come from the machine snapshot ([library.md](library.md#machine)); DFYOM defaults `$10=1`, `$11=0.010`, `$12=0.002`, `$20=1`, others GRBL defaults. Steps/mm are reported but not used.

Emulator option `homing` (sets `$22`): `true` (default in the app) starts in Alarm with `[MSG:'$H'|'$X' to unlock]` and needs `$H`; `false` starts Idle, already homed at MPos `0,0,0`, for tests and demos. Without homing `$20` is 0, as GRBL forces it (`$20=1` → `error:10`).

`$H` takes a modelled time: a Z cycle, then an XY cycle, each seeking from the current position to 0 at `$25` plus locating and pulling off twice `$27` at `$24` (9.6 s from MPos 0,0,0 with GRBL defaults). Its `ok` comes when it is done. Homing is towards positive (GRBL default `$23=0`) without `HOMING_FORCE_SET_ORIGIN`, so it ends at MPos −`$27` on every axis.

### State machine

| State           | Entered by                                               | Left by                                                            |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| Alarm           | startup with `homing`; `ALARM:N`                         | `$H` → Home; `$X` → Idle; reset after ALARM:2/3 → Alarm (lock)     |
| Home            | `$H` (Idle or Alarm)                                     | done → Idle with MPos −`$27` per axis                              |
| Idle            | homing done, motion done, `$X`, jog cancel, reset        | first planned block → Run; `$J=` → Jog                             |
| Run             | blocks in the planner                                    | buffer empty → Idle; `!` or `M0` → Hold                            |
| Hold:1 / Hold:0 | `!` (decelerating / stopped); `M0` (Hold:0 once stopped) | `~` → Run; `0x18` → Idle, or ALARM:3 if still moving               |
| Jog             | `$J=` from Idle or Jog                                   | done or `0x85` → Idle; `!` cancels the jog                         |
| Door:0–3        | `0x84`, door pin (test hook)                             | `~` once stopped and closed (no pin: at once) → resume; no parking |
| Check           | `$C`                                                     | `$C` again → soft reset → Idle                                     |

`M0` waits for the planner to empty, enters Hold:0 and sends its `ok` only after `~`. While a feed hold decelerates (Hold:1) GRBL keeps reading, planning and acknowledging lines; once stopped (Hold:0) and in Door it reads none, so the RX buffer fills. Door details: decelerating Door:2, restoring Door:3; once stopped, `0x84` alone (no door pin) counts as closed, Door:0, and `~` resumes; the test hook `setDoorPin(open)` emulates GRBL's door switch (open: Door:1 until closed). A door during a jog stays Jog until the jog cancel completes, then enters Door. The spindle stops once motion has, and `~` restarts it with GRBL's 4 s `SAFETY_DOOR_SPINDLE_DELAY` before motion resumes. `M2`/`M30` also restore the feed, rapid and spindle overrides to 100 % (`RESTORE_OVERRIDES_AFTER_PROGRAM_END`). `0x9E` stops and restores the spindle in Hold:0 (`[MSG:Restoring spindle]`).

Soft limits as in GRBL's default homing direction: after `$H`, machine coordinates span `[-$13x, 0]` per axis. A gCode target outside → `ALARM:2` with feed hold; a jog target outside → `error:15`, no alarm.

### Motion timing

Motion follows GRBL's planner: a trapezoidal velocity profile per block from `$110–$112` (max rate, also for G0) and `$120–$122` (acceleration), with **junction-deviation look-ahead** (`$11`) over the 15-block planner buffer for corner speeds. `G2`/`G3` (incl. helices) are split into chords within `$12` like GRBL, since plan mode emits arcs in v0.1. Overrides scale feed (and rapid) rates. Time comes from an injected `Clock` (`src/core/run/clock.ts`: `now()`, `schedule(at, fn)`): tests step a `VirtualClock` in virtual time (`advance(ms)`, as fast as the CPU allows); the app runs it at real time (or a user time scale for demos; that clock comes with task 3.9).

Model details (from GRBL planner.c and stepper.c, in mm and seconds instead of steps): block acceleration and rapid rate are limited per axis along the move; the junction speed is `√(a·$11·sin(θ/2)/(1 − sin(θ/2)))` with `a` limited along the junction vector, and at most the smaller neighbouring nominal speed; reverse and forward passes run over the whole buffer whenever a block is added or an override changes, with the executing block re-planned from its current speed. A feed hold decelerates at each block's acceleration, across block boundaries; `~` restarts from rest. Feed overrides do not apply to jogs. Arc chords follow mc_arc()'s segment count, with exact points on the arc.

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
- Implementations: `VirtualGrblTransport` (wraps the emulator and a `Clock`, schedules the emulator's next event, delivers output by a clock timer at the current time, never inside `write()`, so a sender can book a line after awaiting `write()` as over serial; in-process in tests and headless tests, in the utility process in the app) and `SerialTransport` (`serialport`, utility process only, [ADR 0008](../decisions/0008-threading-split-by-job.md)).
- **v0.1 connects to the virtual machine only.** `SerialTransport` is written and unit-tested (against a fake port) but cannot be selected until [run.md#safety](../modes/run.md#safety) is accepted.
- Run commands (`run.connection.open { target: 'virtual' }`, `run.job.start` as a `job`, [commands.md](commands.md#long-running-commands-jobs)) are `machine: true`.
- **Permission rule** (for the `PermissionPolicy`, [commands.md](commands.md#dispatcher-pipeline) step 5): a machine command whose connection is virtual is allowed for every source (UI, agent, CLI, automation, system), since no real machine is affected; on a real connection the strict policy stays (only UI sources until [run.md#safety](../modes/run.md#safety) says otherwise). This makes the headless MCP exit criterion possible.
- Progress: `done` = lines acknowledged with `ok`, `total` = program lines; the position from status reports drives the 3D view.

### Observability for tests

The emulator records a trace readable in-process (`GrblEmulator.trace`): executed lines (text with comments, received/acknowledged time and response, start/end time of the line's motion or dwell), position samples (time, MPos, state, speed) at block boundaries and stops, every response sent, every state transition, and protocol violations (RX overflow, a byte ≥ 0x80 inside a line, a line over 80 bytes as sent). The trace is unbounded; `trace: false` records nothing. Material removal against the stock comes later, via plan-mode simulation.

### Not emulated in v0.1

Hard limits and limit pins, probing (`G38.x`, `$#` PRB), `G28`/`G30`/`G92`/`G93`, `G55–G59`, coolant effect, laser mode (`$32`), parking, sleep (`$SLP`), startup lines (`$N`), EEPROM persistence, `$RST`, step pulses and step-rate limits, backlash and missed steps, spindle physics, grblHAL/FluidNC extensions, fault injection (later: [testing.md](../conventions/testing.md)).

## Files

Implemented (task 3.8): `src/core/run/clock.ts`, `transport.ts`, `grbl/emulator/*.ts` (`emulator.ts` state machine, `gcode.ts` parser subset, `planner.ts` and `profile.ts` timing, `settings.ts`, `trace.ts`), `grbl/virtual-transport.ts`; `grbl/emulator.fixture.ts` holds a test-only streamer. Implemented (task 2.11): `src/core/post/program.ts`, `export.ts`, `grbl/post.ts`, `grbl/format.ts`; `post.fixture.ts` holds test inputs. The others are planned.

| File                                       | Contents                                                      |
| ------------------------------------------ | ------------------------------------------------------------- |
| `src/core/post/program.ts`                 | `MachiningProgram` and block types (the plan → post contract) |
| `src/core/post/export.ts`                  | `exportGrbl`, `toMachiningProgram`, export checks, stats      |
| `src/core/post/grbl/post.ts`, `format.ts`  | `postGrbl`, number and comment formatting                     |
| `src/core/run/clock.ts`                    | `Clock` port and `VirtualClock`                               |
| `src/core/run/transport.ts`                | `ControllerTransport` port                                    |
| `src/core/run/grbl/sender.ts`, `status.ts` | Streaming sender; status-report and response parsers          |
| `src/core/run/grbl/emulator/*.ts`          | Parser subset, planner/timing, state machine, trace           |
| `src/core/run/grbl/virtual-transport.ts`   | `VirtualGrblTransport`                                        |
| `src/main/machine/utility.ts`              | Utility-process entry hosting sender and transports           |
| `src/main/machine/serial-transport.ts`     | `SerialTransport` (Node `serialport`)                         |
