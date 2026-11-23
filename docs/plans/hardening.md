# Hardening plan – bugs, UX, AX and the real machine (after v0.4)

Status: draft (proposed 2026-11-22; awaits the user's dogfood feedback and answers to [Q49–Q56](#questions-for-the-user)) · Scope: [roadmap.md § Hardening](../roadmap.md#hardening--make-existing-features-work-well-draft) · Last updated: 2026-11-22

**Draft.** User direction **D43** (2026-11-22): after v0.4, find and fix bugs, improve UX and AX (agentic experience) and interact with a real machine – "get existing features/app to work well". The user dogfoods the installed app and sends feedback; it lands in the [intake](#intake-user-feedback-goes-here) and drives the order of sections 3–5. No new modelling features: anything that needs a new model, kind or operation goes to the [v0.4 follow-up](v0.4-llm-first.md) or later. Once accepted, this is the living plan: update it in the same commit as the work. [plans/v0.4.md](v0.4.md) is closed.

Status values: `done` · `doing` · `todo` · `blocked` (say on what) · `dropped` (say why). Issue class: `bug` · `UX` · `AX` · `machine` · `perf` · `test` · `later` (not in this plan, kept where it is).

## Questions for the user

Each with a recommendation; "Q49 ok" takes it. Numbering continues after the [v0.4 follow-up](v0.4-llm-first.md#questions-for-the-user)'s Q46.

1. **Q49 – Your machine.** Which machine and controller (GRBL 1.1, grblHAL, FluidNC), connected how (USB serial), with homing switches, a Z touch plate or probe, and which spindle (router switched by hand, or PWM `M3 S`)? _Recommendation: tell us; the plan assumes a GRBL 1.1–compatible controller over USB with homing and a hand-switched or PWM spindle ([ADR 0013](../decisions/0013-grbl-first-controller.md)); grblHAL extras stay out._
2. **Q50 – Who may drive a real machine.** The [safety spec](../modes/run.md#safety) must say what agents may do on a real connection. _Recommendation:_ in hardening, machine-moving commands on a real connection come **from the UI only**; agents may read status, wait (`job.wait`) and prepare plans and exports. The exit criteria's agent variant is designed, planned and exported over MCP and then run by you from the app. Agent-started real runs (with a confirmation in the app) come later with watchdogs.
3. **Q51 – First cuts in two steps.** Step 1: the lid's program exported by DFYOM, run by the sender you use today (air cut, then cut) – proves the CAM output alone. Step 2: the same program through DFYOM's own serial sender. _Recommendation: yes;_ it separates "the G-code is wrong" from "the sender is wrong" and gives you a fallback.
4. **Q52 – Machine lane scope.** In: serial connection and port picker, real-machine run checks, jog and work zero in the UI, Z zeroing with a touch plate (`G38.2`), Z re-zero at tool changes and after a flip, feed hold and resume, alarms explained with the next step, resume a stopped run **at a section boundary** (tool change or operation start, with a safe re-entry), feed and spindle overrides. Out: raw MDI console, macros, sensors, automation, arbitrary-line restart, grblHAL tool changers. _Recommendation: yes._
5. **Q53 – What moves in from the LLM-first follow-up.** The fixes to existing features: result compaction and no stacks in results (A2), `job.wait` at operator waits (A3), frames in the primer and `placed` bounds (A4), the launcher and "Connect an agent" (A5), unknown-argument hints (A6), region-offset robustness (S10 + K-R), plus headless snap and measure (v0.3 backlog). Workholding, reference query, offset item, scale, partial-depth profiles, DFM in waste and the deviation check stay there ([§ What stays in the follow-up](#what-stays-in-the-follow-up)). _Recommendation: yes._
6. **Q54 – Feedback loop.** Send findings in any form (message, screenshot, project file); each becomes an intake row with a severity: **S1** blocks the golden path or risks the machine or data, **S2** wrong result or confusing with a workaround, **S3** polish. S1 fixed first and installed the same day, S2 in batches, S3 collected for one design review. _Recommendation: yes._
7. **Q55 – Workholding for the lid.** No workholding model before the follow-up: hold the 6 mm plywood with screws or double-sided tape in the waste outside the outline and the tabs; the run shows the stock outline and the toolpath extent so you can place screws clear of them. _Recommendation: yes;_ the clamp model and collision check stay in the follow-up (W1–W4).
8. **Q56 – Flaky tests and slow paths.** Flaky tests are fixed at the root (real waits, no larger timeouts, [testing.md](../conventions/testing.md)); the Clones limit stays 100 and the quadratic paths (S6) are fixed only if dogfood hits them. _Recommendation: yes._

## Next up

Waiting for the dogfood feedback and Q49–Q56. Meanwhile (no user input needed): 1.1–1.3 doc drafts, P1–P3 (flaky tests), the known bugs B1–B6.

## Exit criteria

- **The user cuts the [v0.4 lid](v0.4.md#exit-criteria) on their machine using only the app:** design (or open the saved project) → plan → Run over the serial connection: connect, home, jog, zero X/Y and Z (touch plate if present), three tool changes with Z re-zero, one feed hold and resume, finish without an alarm. The lid fits the v0.3 enclosure: holes and cutout where the drawing puts them (within 0.2 mm), countersinks flush with M3 screws.
- **One variant through an agent over MCP:** a fresh agent with the installed app's launcher and the MCP tools only (no outside scripts) changes the lid (e.g. M4 bolt circle, eight vents, a second cutout), plans and exports it; the user runs it from the app (Q50). No result over 64 KB, no stack trace, ≤ 60 tool calls; recorded as a dated research note.
- **Intake closed:** every S1 and S2 finding is fixed or deferred by the user's decision; S3 findings went through one design review.
- **Health:** `npm run check` passes 10 runs in a row under load (load average ≥ 25), the hidden e2e suite 5 in a row; `tools/list` ≤ 120 K; flaky tests listed below fixed.
- The virtual machine keeps passing every exit flow of v0.1–v0.4 (the serial work changes no golden program).

## Order and lanes

| Lane              | Order                                                                          |
| ----------------- | ------------------------------------------------------------------------------ |
| Intake and triage | I1 now → I2 per feedback batch, all milestone long                             |
| Bugs              | S1 intake rows first; B1–B6 meanwhile                                          |
| UX and AX         | after the first triage: U1–U8, A1–A8 by severity; one design review (U9)       |
| Machine           | 1.1 accepted → M1 → M2, M3 → M4–M8 → X1 (machine needs Q49)                    |
| Test health, perf | P1–P3 now; P4, P5 only if dogfood hits them                                    |
| Acceptance        | X0 (step 1 of Q51) as soon as the user can cut; X1 after M1–M6; X2 after A1–A6 |

## 1. Docs (accepted before implementation)

| #   | Task                                                                                                                                                                                                                | Status | Notes                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------- |
| 1.1 | Real-machine safety spec in [run.md § Safety](../modes/run.md#safety) → accepted: e-stop and reset semantics, who may command a real connection (Q50), confirmations, watchdogs, what a lost connection does        | todo   | Blocks M1 ([grbl.md](../architecture/grbl.md#transport-and-sender)) |
| 1.2 | Run on a real machine (new `modes/run-machine.md`): `SerialTransport`, port picker, real-machine checks, probing, re-zero, section resume, overrides; amends [run-v0.1.md](../modes/run-v0.1.md) decisions 1, 5, 11 | todo   | Q49, Q52                                                            |
| 1.3 | [llm-api.md](../architecture/llm-api.md) amendment for A1–A6 and snap/measure queries; [testing.md](../conventions/testing.md) real-machine row (manual checklist, opt-in)                                          | todo   | Q53                                                                 |
| 1.4 | [ui.md](../conventions/ui.md) amendment for the run panel on a real machine (connect, probe, overrides, resume) and the UX fixes that change behaviour                                                              | todo   | With 1.2                                                            |

## 2. Dogfood intake

| #   | Task                                                                                                                                                                                                                         | Status | Notes        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------ |
| I1  | Dogfood script for the user: the v0.4 lid golden path step by step in the installed app, with what to watch (wrong numbers, dead ends, slow steps, unclear text)                                                             | todo   | Optional aid |
| I2  | Triage each batch: an intake row per finding (severity, class, repro), a failing test before the fix where possible, reinstall the app after S1 fixes (`npm run install:local`, [packaging.md](../conventions/packaging.md)) | todo   | Q54          |

### Intake (user feedback goes here)

Batch 1: TG #196 (2026-11-22, from the installed 0.3.2). One row per finding; ids `DF1`, `DF2`, … Severity per [Q54](#questions-for-the-user).

| Id   | Finding (user's words, short)                                                                                                                                                                                                             | Severity | Class | Task      | Status                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| DF1  | Tool library: secondary parameters (material, coating, …) under an accordion when creating/editing a tool                                                                                                                                 | S3       | UX    | DFB-lib   | done: "Details" accordion (material, coating, notes), open state kept per window                                                       |
| DF2  | Reference selected → stock semi-transparent to see the model inside; a checkbox (on by default) in the reference panel                                                                                                                    | S2       | UX    | DFB-ref   | done: "See through stock" (on by default), stock at 35 % while the Reference panel shows a reference                                   |
| DF3  | Reference panel: toolbar Reference button toggles a right-sidebar Reference panel (closes when something else needs the sidebar); import/delete STL there; visibility toggle                                                              | S2       | UX    | DFB-ref   | done: Reference is a right-sidebar panel toggled from the toolbar; import, replace, remove, visibility there                           |
| DF4  | Facing depth: suggest the depth that faces the stock top down to the reference's closest (top) point                                                                                                                                      | S2       | UX    | DFB-face  | done: Add facing takes the depth down to the reference top; the Depth adjust panel recommends it ("Use …")                             |
| DF5  | "Fit to stock" sat below the fold; expected it to scale the model too. Fit becomes a mode in the right sidebar: fit settings (scale, anchor, height Top/Centre/Bottom with hints), 3D preview, Apply/Cancel; closing the panel cancels it | S2       | UX    | DFB-ref   | done: Fit mode (scale to fit, fit within axes, margin, anchor, height, live preview, Apply/Cancel); API `fit.margin`/`fit.scaleTo`     |
| DF6  | Show the scaled reference size in the reference panel                                                                                                                                                                                     | S3       | UX    | DFB-ref   | done: Size line (scaled) next to File                                                                                                  |
| DF7  | Anchor unclear (no hint, far from Scale); Height unclear and not grouped with Fit; add (i) hints                                                                                                                                          | S3       | UX    | DFB-ref   | done: Scale group (Scale + Anchor, scaling keeps the anchor point), Height inside Fit, (i) hints; Replace STL is two undo steps (open) |
| DF8  | Reference name field unimportant: drop it, use the file name                                                                                                                                                                              | S3       | UX    | DFB-ref   | done: Name field removed; file name is the title                                                                                       |
| DF9  | Value fields: focusing opens the pencil (expression/pick) dropdown with the input kept focused; clicks inside keep focus; hide the pencil button (fixes Tab stopping on it)                                                               | S2       | UX    | DFB-field | done: the adjust panel opens on focus (input keeps focus, combobox); pencil gone, Tab goes field to field                              |
| DF10 | "Pick X in the viewport" doesn't toggle off on a second click (only Esc)                                                                                                                                                                  | S2       | bug   | DFB-field | done: the pick toggle in the adjust panel turns picking off on a second press                                                          |

## 3. Bugs (known before dogfood)

| #   | Task                                                                                                                                                          | Status | Notes                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| B1  | Closing a project with no part hangs Electron teardown                                                                                                        | todo   | [v0.4](v0.4.md#known-issues-found-in-v04) U4                                                              |
| B2  | Region offsets fail with raw stack traces at specific offsets (F3); 2D growing regions with non-tangent concave arcs give `resultInvalid`                     | todo   | Follow-up S10 + K-R moved here (Q53)                                                                      |
| B3  | `dfm.cloneOutsideStock` checks reference points, not footprints; `dfm.cloneOverlap` uses bounding boxes                                                       | todo   | v0.4 F5                                                                                                   |
| B4  | `dfm.chamferTooDeep` misses a chamfer through a thin pocket floor                                                                                             | todo   | v0.4 C2                                                                                                   |
| B5  | Tolerances: a countersink's derived chamfer width has none; the drill below a blind counterbore ignores the counterbore depth's tolerance (stack-up decision) | todo   | v0.4 L2-C, F3                                                                                             |
| B6  | Projects saved before D45 must show the pre-alpha reset prompt, not a raw load error                                                                          | todo   | [migrations.md](../conventions/error-handling/migrations.md#pre-alpha-exception-no-data-preservation-yet) |

## 4. UX and AX

| #   | Task                                                                                                                                                                              | Class | Status | Notes                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ---------------------------------------------------------------- |
| U1  | Escape closes the dialog before a toast (one press)                                                                                                                               | UX    | todo   | v0.4 L2-A                                                        |
| U2  | Shape row actions reachable by keyboard, not hover only; live announcement for tab markers                                                                                        | UX    | todo   | v0.4 X2, v0.3 U2                                                 |
| U3  | Drag reorder auto-scrolls near list edges; plan setups and operations reorder by drag too                                                                                         | UX    | todo   | v0.4 L2-B                                                        |
| U4  | "New shape…" is one undo step                                                                                                                                                     | UX    | todo   | v0.3 U2                                                          |
| U5  | Open `.dfyom` files from Finder (file association, `open-file`, second launch)                                                                                                    | UX    | todo   | [v0.1](v0.1.md#known-issues-and-risks)                           |
| U6  | Defaults reviewed against the first real cuts: pocket `finishStepdown`, tab height, wood feeds (F9 `u`, `kPlunge`), chamfer feeds F10                                             | UX    | todo   | Follow-up F14, v0.1 2.12, v0.4 C1; after X0                      |
| U7  | Lid tool runs: a second Flat 6 run (D44) costs a manual tool change on a real machine; revisit the order rule                                                                     | UX    | todo   | v0.4 X2; only if the user minds                                  |
| U8  | Grid row end (zigzag-last cell, D46): keep or change after dogfood                                                                                                                | UX    | todo   | v0.4 L2-B                                                        |
| U9  | Design review in one batch for S3 findings and U1–U8 visuals                                                                                                                      | UX    | todo   | Like v0.4 L2                                                     |
| A1  | Result compaction: no `stack` in agent results, warnings as a delta plus a count, one copy per result, `detail: 'summary'` on `plan.get`, `plan.toolpath.get`, `design.shape.get` | AX    | todo   | Follow-up A2                                                     |
| A2  | `job.wait` returns at operator waits; `run.job.continue` defaults to the only waiting run                                                                                         | AX    | todo   | Follow-up A3; also M-lane                                        |
| A3  | Frames in the server primer; `placed` bounds in operation results                                                                                                                 | AX    | todo   | Follow-up A4                                                     |
| A4  | Launcher: `bin/dfyom` in the bundle, Help → "Connect an agent" with a ready `claude mcp add` line                                                                                 | AX    | todo   | Follow-up A5                                                     |
| A5  | Unknown-argument hints; `project.close` defaults to the bound project                                                                                                             | AX    | todo   | Follow-up A6                                                     |
| A6  | Headless snap and measure for existing UI actions (query only)                                                                                                                    | AX    | todo   | v0.3 X1 backlog                                                  |
| A7  | Error messages reviewed for agents: every refusal names the field, the rule and a next step                                                                                       | AX    | todo   | From X2's agent run                                              |
| A8  | `tools/list` at 112.7 K of 120 K: A1–A6 fit without new tools; fold or consolidate (Q32 option B) only if a fix needs more                                                        | AX    | todo   | [llm-api.md](../architecture/llm-api.md#implementation-task-310) |

## 5. Real machine

What exists ([run-v0.1.md](../modes/run-v0.1.md)): `GrblSender` (character counting, status, hold/resume/stop, `error`/`ALARM` handling, tool-change and `M0` waits), the machine host, `run.*` commands for home, unlock, jog, work zero, reset, the run job with the soft-limit check, the Run UI with jog pad and stop, the `$$` import. Missing: everything that talks to hardware.

| #   | Task                                                                                                                                                                                                  | Status | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| M1  | `SerialTransport` (`serialport` in the utility process), port list and picker, `run.connection.open { target: 'serial', path, baud }`, handshake and `$$` checked against the plan's machine copy     | todo   | 1.1, 1.2   |
| M2  | Real-machine rules: plan `finalized`/`inUse` only, homed, soft-limit check, the permission policy of Q50, confirmation before the first motion, disconnect = reset                                    | todo   | M1         |
| M3  | Machine readiness in the UI: DRO in work and machine coordinates, jog by step and continuous with cancel, set zero per axis, alarm text with the next step (home, unlock, check limit)                | todo   | M1         |
| M4  | Z touch plate: `G38.2` probe with plate thickness, also at tool changes and after a flip (replaces the nominal-thickness assumption, [v0.2](v0.2.md#known-issues-and-risks)); emulator learns `G38.x` | todo   | M3         |
| M5  | Resume at a section boundary after a stop: pick the tool change or operation, safe re-entry (spindle, clearance Z, modal state), checked on the emulator                                              | todo   | M2         |
| M6  | Feed and spindle overrides (real-time bytes), shown with the status `Ov` field                                                                                                                        | todo   | M1         |
| M7  | Run status names the setup of a run started elsewhere; the setup-change prompt shows the zero to set                                                                                                  | todo   | M2         |
| M8  | Fault injection in the emulator for the new paths (lost connection, alarm mid-run, probe fail) so they are tested without hardware                                                                    | todo   | M1, M4     |

## 6. Test health and performance

| #   | Task                                                                                                                                                         | Class | Status | Notes                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------ | ---------------------------------------- |
| P1  | Flaky under load: `run/commands.test.ts` "app quit stops a running job" and the work-zero-moved run test; `src/main/host/app-host.test.ts`                   | test  | todo   | v0.4, v0.2 backlog                       |
| P2  | Flaky under load: `storage.test.ts` (core and main), the enclosure tests (`src/core/design/enclosure-*.test.ts`, `src/core/import/svg/enclosure.test.ts`)    | test  | todo   | Reproduce at load ≥ 25 first             |
| P3  | e2e `golden-path-v0.2` flaky under full-suite load ("Add tool" dialog stays visible)                                                                         | test  | todo   | v0.4 P1                                  |
| P4  | Clones scale: `plan.create` and export linear in operations; fresh evaluation (quadratic, [S6](../research/s6-clone-budgets.md)); clone layer step 90–220 ms | perf  | todo   | Only if dogfood hits it; limit 100 stays |
| P5  | `recalculateFeatures` per update, the Clones follow hook's part load per command, resolve + checks at 2.9 of 3 ms                                            | perf  | todo   | Only if dogfood hits it                  |

## 7. Acceptance

| #   | Task                                                                                                              | Status | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| X0  | First real cut, Q51 step 1: the lid exported by DFYOM, run with the user's own sender; findings into the intake   | todo   | Q49        |
| X1  | The lid through DFYOM's serial sender ([Exit criteria](#exit-criteria)), measured against the drawing; dated note | todo   | M1–M6, X0  |
| X2  | Agent variant over MCP with the installed app; dated research note; findings into the intake                      | todo   | A1–A6      |
| X3  | Health runs (10× check, 5× e2e under load); docs → `implemented`; plan closed                                     | todo   | all        |

## Known issues

Classified from the open rows of [v0.1](v0.1.md#known-issues-and-risks), [v0.2](v0.2.md#known-issues-and-risks), [v0.3](v0.3.md#known-issues-and-risks) and [v0.4](v0.4.md#known-issues-found-in-v04) ([carried over](v0.4.md#known-issues-carried-over)). Rows taken by a task above are not repeated; these stay where they are unless dogfood raises them.

| Issue (source)                                                                                           | Class   | Status                                 |
| -------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------- |
| Feeds F10 has no published chart; power check over-estimates cone cuts (v0.4 C1)                         | machine | risk – watch in X0/X1                  |
| `dwell` strategy for plunged chamfers (v0.4 T1)                                                          | later   | backlog                                |
| No in-process stock; plan-only edits lost on rebuild; plan scene ghost of the current part (v0.2)        | later   | backlog                                |
| No workholding model (v0.1, v0.2)                                                                        | later   | follow-up W1–W5; Q55 for the lid       |
| Align a named shape to the reference exactly; rotation/fillet handles; point-to-edge measure (v0.3)      | later   | assisted recreation, Shape Editor pass |
| SVG import: quadratic fill repair, `use`/`<style>` (v0.3)                                                | later   | raise if the user's SVGs fail          |
| Rotated reference conservative box; ghost mesh copy and edges on the renderer (v0.2)                     | later   | backlog                                |
| Export estimate 9–16 % under the virtual run (follow-up F14)                                             | later   | backlog                                |
| Stale lock after sleep, "retry in 2 min" for a crashed lock, library changes by another instance (v0.1)  | UX      | backlog; raise if hit                  |
| Status bar and Apply both poll `job.list`; plans evaluated at open; pending keys derived per read (v0.2) | perf    | backlog                                |
| `leadRadius` strategy parameter (v0.3)                                                                   | later   | backlog                                |
| Plan checks in English with canonical units (v0.1, roadmap Later)                                        | UX      | backlog                                |

## What stays in the follow-up

[v0.4-llm-first.md](v0.4-llm-first.md) keeps workholding (W1–W6), reference query (R1–R5), offset item, scale and partial-depth profiles (D1–D3), DFM in waste (D4), the deviation check (V1–V3), their UI and its X1–X3. Its A2–A6, S10 and K-R move here (Q53) and are marked there when this plan is accepted.

## Risks

| Risk                                                                 | Mitigation                                                                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A real machine moves unexpectedly (wrong zero, stale program, agent) | 1.1 accepted before M1; UI-only motion (Q50); finalized plans; soft-limit check; air cut first (X0)             |
| Dogfood feedback outgrows the milestone                              | Severity triage (Q54); S3 batched; new features go to the follow-up, not here                                   |
| Serial quirks per board (USB chips, resets on open, baud)            | Handshake with retry and a clear error; the user's existing sender as fallback (Q51); a hardware note per board |
| Hardware paths can't run in CI                                       | Same `ControllerTransport` for serial and emulator; fault injection (M8); a manual checklist in testing.md      |
| Fixes break goldens or the exit flows of earlier milestones          | Goldens byte-equal unless a fix explains the change; all X1/X2 flows stay in CI                                 |
| `tools/list` headroom (7.3 K)                                        | AX fixes shrink results, not schemas (A8)                                                                       |
