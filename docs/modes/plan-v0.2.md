# Plan mode v0.2: setups from face directions, tools from design

Status: accepted (follows from user decisions D10 and D11 of 2026-11-21; details confirmed with the v0.2 review, D18 of 2026-11-22) · Vision: [plan.md](plan.md) · v0.1 subset: [plan-v0.1.md](plan-v0.1.md) · Design input: [design-v0.2.md](design-v0.2.md) · Apply (D13): [apply.md](../architecture/apply.md) · UI rules: [ui.md § Design and plan controls (v0.2)](../conventions/ui.md#design-and-plan-controls-v02) · Terms: [glossary.md](../glossary.md)

Plan consequences of [design-v0.2.md](design-v0.2.md): several setups, one per approach direction, and tool assignment from the design's tool field; plus plan-only edits of the design snapshot in the UI (strategy editing phase 2, [roadmap.md](../roadmap.md)). Everything not mentioned here stays as in [plan-v0.1.md](plan-v0.1.md). Tasks: [plans/v0.2.md](../plans/v0.2.md#3-plan-and-run).

## Decisions

Settled with the user when this doc was accepted (D18, 2026-11-22: Q15 as taken by D16, K–N as recommended by D12, O as drafted); the sections below specify them.

1. **No workholding, no in-process stock (Q15):** toolpaths of later setups use the design's analytic levels, so they may air-cut where an earlier setup already removed material, like the known facing/profile air-cutting.
2. **Setup rotation (K):** 0/90/180/270° about the spindle axis per setup if it is cheap (decided in task E1: built, see [§ Implementation (task E1)](#implementation-task-e1)): a long side face may only fit the travel rotated. If not, the orientation stays fixed by the face frame and the travel check warns ([§ Setups](#setups-from-face-directions)).
3. **Default setup order (L):** the bottom (`−z`) first, as a datum, then the sides, the top (`+z`) last, so through profiles with tabs run last ([§ Merge, split, reorder](#merge-split-reorder)).
4. **A design tool locked after a plan assignment (M):** the plan assignment wins and the stale flag `designToolChanged` shows; plans are snapshots and are tuned on their own ([§ Tool resolution](#tool-resolution-from-the-design-tool-field)).
5. **Through features (N):** one approach direction per operation, the design's. Machining a through hole or profile from the opposite face ("access directions") is later; it changes the setup derivation.
6. **Plan-only edits on rebuild (O):** a rebuild discards all plan edits, as in v0.1; the confirmation names what is lost. Keeping edits the design change did not touch is later, if users ask ([§ Plan-only edits](#plan-only-edits-and-the-snapshot-scene)).

## Setups from face directions

- **Derivation:** `plan.create` and every rebuild group the plan operations by the [approach direction](design-v0.2.md#face) of their design operation's `on` face: **one setup per direction** in use. A part with only top operations keeps exactly one setup, as in v0.1.
- **Setup record** (extends [plan-v0.1.md § Plan record](plan-v0.1.md#plan-record)): `{ id, name, direction, rotation?, workOffset, clearanceHeight, retractHeight, operations[] }` (`rotation` only if task E1 finds it cheap; absent = 0°). `direction` is the part direction that points up to the spindle (machine +Z). Default name: "Top", "Bottom", "Front", "Right", "Back", "Left" (a second setup of one direction: "Top 2").
- **Orientation:** the setup's machine axes are the [face frame](design-v0.2.md#face-frame) of its direction: `u` → machine +X, `v` → machine +Y, `n` → machine +Z. For `+z` this is v0.1's fixed orientation ([plan-v0.1.md § Setup](plan-v0.1.md#setup-orientation-work-zero-safe-heights)). A setup may be rotated 0/90/180/270° about the spindle axis if cheap ([decision 2](#decisions)): the rotation turns `u` and `v` about machine +Z, and the work zero moves to the lower-left corner of the rotated face (`plan.setup.update { rotation }`).
- **Work zero:** `G54` at the face frame origin (the lower-left corner of the up-facing stock face, seen from above on the machine), Z0 on that stock face. Each setup is re-zeroed by the operator after re-fixturing; each exports its own program. The stock's thickness tolerance after a flip absorbs into `breakthrough` for through cuts, as in v0.1.
- **Safe heights** per setup as in v0.1, measured from the setup's up-facing stock face and the operation's `on` face.
- **Machine checks per setup:** the stock size in the setup's orientation (extent along `u`, `v`, `n`) + `clearanceHeight` must fit the travel.

### Merge, split, reorder

| Action  | Rule                                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Split   | Move chosen plan operations of a setup into a new setup of the **same direction** (e.g. rough the top, flip, machine the bottom, flip back to finish the top).                           |
| Merge   | Join setups of the **same direction**. Merging different directions fails with `plan.setup` (new code): a 3-axis setup has one approach direction. (4th/5th axis and user planes later.) |
| Reorder | Setups in any order and plan operations across setups of the same direction, subject to the order checks below.                                                                          |

- **Default order** ([decision 3](#decisions)): `−z`, then the sides 0–3, then `+z` last, then repaired so every operation follows the operations its `on` references (as `repairOrder` in [plan-v0.1.md § Implementation](plan-v0.1.md#implementation-task-213)).
- **Order checks across setups:** `plan.order` (error) when an operation's `on` face is made in a later setup; warning `plan.cutoutBeforeSetup` when a through profile runs in a setup before another setup (the part is held only by its tabs while re-fixtured).
- **Rebuild keeps the user's structure:** a new operation of an existing direction joins the last setup of that direction; a new direction gets a new setup at its default position; a setup left empty by a rebuild is removed. An operation whose `on` changed direction moves to a setup of its new direction.

### Toolpaths per setup

Generators stay top-down ([plan-v0.1.md § Toolpath generators](plan-v0.1.md#toolpath-generators-task-210)): the seam (`planOperationInputs`) passes each operation in its face frame (`[u, v]` positions, levels along `n` relative to the setup's Z0, the stock extent along `n` as the thickness for through cuts). Toolpaths come out in the setup's WCS directly. Export and run work per setup: [`plan.export`](../architecture/grbl.md#plan-export-command) gains `setupId` (required when the plan has more than one setup) and writes one program per setup; run mode's setup-change prompt between programs is the [run-v0.1.md amendment](run-v0.1.md#amendment-v02-task-e2-one-program-per-setup) ([§ Implementation (task E2)](#implementation-task-e2)).

### Commands (setups)

| Command               | Args                                                                | Result        |
| --------------------- | ------------------------------------------------------------------- | ------------- |
| `plan.setup.split`    | `{ planId, setupId, planOperationIds, name? }` – new setup after it | `{ setupId }` |
| `plan.setup.merge`    | `{ planId, setupIds }` – same direction only; into the first        | `{ setupId }` |
| `plan.setup.move`     | `{ planId, setupId, toIndex }`                                      | `{}`          |
| `plan.operation.move` | as v0.1, plus `toSetupId?` (same direction)                         | `{}`          |
| `plan.setup.update`   | as v0.1, plus `name?` and `rotation?` (0/90/180/270, if built)      | `{}`          |

`plan.create` returns `{ planId, setupIds }`. Statuses as `plan.setup.update` in v0.1 (`draft`, `settledDesign`).

### Implementation (task E1)

Core only (`src/core/plan/setups.ts`, `build.ts`, `order.ts`); the setup panel is F6, toolpaths per setup C3, export per setup E2.

- **Record:** `direction` and `rotation` are optional and left out for `+z` and 0°, so v0.1 records load unchanged (no `schemaVersion` change); `setups` has no upper bound. New setups get the direction names ("Top", not v0.1's "Setup 1"; stored names stay).
- **Direction of a plan operation:** the stock face its first design operation's `on` chain starts from (surfaces inherit their `on` direction, so every `on` dependency lies within one direction). Drillings are grouped into one plan operation only within one direction.
- **Rotation is built** (decision 2): `plan.setup.update { rotation }` stores it and the machine check swaps the `u`/`v` extents for 90°/270°; turning the toolpaths and the work-zero corner is C3 ([below](#implementation-task-c3)).
- **Split / merge / move** (and `plan.operation.move` with `toSetupId`) refuse with `plan.order` when they add an order violation the plan did not have, like `plan.operation.move` in v0.1. A split must leave at least one operation in its setup (`input.malformed`, rule `allOperations`); the new setup keeps the source's heights and rotation. Merge joins into the first of the setups in machining order (operations concatenated in that order). A setup emptied by `plan.operation.move` is removed, like one emptied by a rebuild.
- **Findings:** `plan.order` runs over the machining order of all setups; `plan.loosePiece` compares only operations of one direction (face-frame positions); `plan.cutoutBeforeSetup` (warning, rule `cutoutLast`) is attached to every profile's plan operation in a setup followed by another setup (every v0.2 profile is through); `plan.machine` runs per setup and carries `params.setupId` when the plan has several setups.
- **Until E2,** `plan.export` of a plan with several setups failed with `plan.setup` (rule `severalSetups`) rather than writing one program across a re-fixture; E2 replaced it with export per setup ([below](#implementation-task-e2)).

### Implementation (task C3)

Core only (`src/core/plan/inputs.ts`, `src/core/toolpath/inputs.ts`, `request.ts`, `wcs.ts`); per-setup export is E2, the setup panel and per-setup preview F6.

- **Seam:** `PlanOperationInput.setup` carries the setup's `direction` and `rotation`. `toGeneratorInputs` passes each operation as geometry already reads it ([geometry.md § Non-top faces](../architecture/geometry.md#non-top-faces-v02)): positions in `[u, v]`, `onZ` relative to the setup's Z0, without `direction`; the stock as `localStock(direction)` (the face rectangle on X/Y, the extent along `n` as the thickness for through cuts and tabs). Generators are unchanged. The `faceNotSupported` stub of A1 is gone.
- **Direction check:** an operation whose face is not its setup's direction (possible after a plan-only edit of `on`, until a rebuild regroups it) fails with `plan.setup`, rule `setupDirection`.
- **Rotation:** turning the inputs instead would move the tabs (they start at the middle of `wall[0]`, as in geometry), so generators run in the face frame and the toolpath is turned afterwards: the `GeneratorRequest` gains `wcs { rotation, size }` (absent for 0°, so unrotated setups, every v0.1 plan, generate byte-identical toolpaths and gCode) and the worker applies the quarter turn about machine +Z, counter-clockwise seen from above (`turnToolpath`: positions and arc centers turn, Z, feeds and arc senses stay; stats are recomputed, since rapids are timed per axis). A face point `(u, v)` of a face `L × W` lands at `(W − v, u)` for 90°, `(L − u, W − v)` for 180°, `(v, L − u)` for 270°: the work zero is the lower-left corner of the turned face, as the machine check's swapped extents assume. The strategy's facing `axis` stays along the part (`x` = along `u`) and turns with it.
- **Drilling order** starts from the hole nearest the work zero of the turned WCS.
- **Preview data:** `setupFrame(direction, rotation, stock)` (`wcs.ts`) is the setup's WCS as a placement in the part frame (identity for an unrotated top setup), for drawing a setup's toolpaths on the part (F6) and run mode's work zero (E2).
- **Cache:** `inputHash` already covered the whole setup record, so a changed rotation regenerates.
- **Tests** (`src/core/toolpath/setups.test.ts`): quarter turns and their inverse, `setupFrame` against the face frame for every direction and rotation, side and bottom toolpaths landing on the part where the geometry has the hole and the pocket, rotated setups placing back onto the same path, drilling order in a turned WCS, the direction check; golden toolpaths of the bottom and right setups (and the bottom turned 90°) and the gCode of a bottom-only plan and of a right-side plan turned 90° (`src/core/toolpath/__golden__/setup-*`). The exit-criteria golden is unchanged.

## Tool resolution from the design tool field

The design's [tool field](design-v0.2.md#operation-tool) is an input to Plan's [tool assignment](plan-v0.1.md#tool-assignment-and-checks). It replaces "the design's tool requirement" as the only input to `plan.tool.suggest`; the plan check table itself is unchanged.

| Design tool         | Locked | `plan.create` / rebuild assigns                                                                                                                                                                                                                                                                |
| ------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Specific            | no     | That tool (a plan copy of the design's snapshot) if it passes the plan checks for the plan's machine; else the first `plan.tool.suggest`, with info `plan.designToolReplaced` naming the failed check.                                                                                         |
| Specific            | yes    | That tool, **always**. If it fails a plan check, it stays assigned and `plan.designToolFailed` (error, fails generation for that operation) names the check and lists the fitting alternatives. Never swapped.                                                                                 |
| Generalized         | no     | The first `plan.tool.suggest`, where library tools matching the generalized type and diameter (and RE) within 0.01 mm rank first.                                                                                                                                                              |
| Generalized         | yes    | The best matching library tool (type and diameter, and RE, within 0.01 mm) that passes the checks, ranked as `plan.tool.suggest`. None: no tool, `plan.toolUnresolved` (error) naming the generalized tool and the fitting non-matching alternatives. Never a different size or type silently. |
| None (v0.1 project) | –      | As v0.1: the first `plan.tool.suggest`.                                                                                                                                                                                                                                                        |

- **A locked tool failing in a plan warns, it never swaps.** The user resolves it explicitly: assign another tool in the plan (`plan.tool.assign`, a deliberate plan decision), change the machine, extend the stickout, or change the design. The fix list in `plan.warning.list` offers these.
- **Plan assignment wins inside the plan.** `plan.tool.assign` marks the plan operation `toolSource: 'plan'` (new optional field, no `schemaVersion` change); create and rebuild set `toolSource: 'design'`. A rebuild re-resolves the tool only for `toolSource: 'design'` operations whose design tool field changed (by value) since the snapshot; `plan` ones keep their tool and show the stale flag `designToolChanged` in `plan.stale.list`. A later design lock does not override a plan assignment ([decision 4](#decisions)).
- **Draft plans** follow the design tool field through the rebuild like any design change, on Apply ([below](#draft-plans-follow-on-apply)); a locked specific tool that fails reports `plan.designToolFailed`, never a blocked rebuild.
- `plan.tool.suggest` gains a reason per candidate for the design tool (`matchesDesign`, `designTool`), so the UI and agents see why a tool ranks first.

## Plan-only edits and the snapshot scene

Strategy editing phase 2 ([roadmap.md](../roadmap.md); phase 1 shipped the Strategy group and the feeds derivation). The core already has [plan-only edits](plan-v0.1.md#plans-are-snapshots) (`plan.design.operation.update` in `settledDesign`, the `editedInPlan` stale indicator, `discardPlanEdits` on rebuild); this section adds what the UI needs. No new data: the plan's design snapshot `{ taken, part }` already holds both versions.

- **New command `plan.design.operation.revert`** `{ planId, planOperationId }`: copies the `taken` version back into `part` for that operation (one undo step); allowed where `plan.design.operation.update` is. Agents and the CLI get it from the command layer.
- **Inspector:** in a `settledDesign` plan, a "Part (plan copy)" group under Tool shows the operation's design fields, reusing the Design inspector's per-kind field components (factored out of the Design inspector, not copied). An edited operation shows an "Edited in plan" badge and "Revert to design". In `draft` the group is read-only with the hint "Settle the design to edit it for this plan only"; in `finalized` and later it is read-only.
- **Rebuild with plan edits** asks first ([ui.md § Confirmations](../conventions/ui.md#confirmations)): "Rebuild discards 2 plan-only edits" with Rebuild and Cancel; agents still pass `discardPlanEdits: true`.
- **Snapshot scene:** the plan scene draws the **plan's** part (`design.part` of the plan), not the design's current mesh. The geometry worker evaluates a part DTO passed in (cached by the snapshot's hash, [workers.md](../architecture/workers.md)); edited operations are tinted, and the design's current part can be shown as a ghost for comparison (view toggle, off by default).
- **A rebuild discards all plan edits**, also those the design change did not touch ([decision 6](#decisions)).

**Implementation (task E3a, core):** `plan.design.operation.revert` returns `{ reverted }`, the design operation ids whose edits it reverted (empty, and no undo step, when the plan operation had none); it checks the reverted part against the plan's stock copy like `plan.libraryItem.update` (a copy updated since the snapshot can make the taken version not fit: `model.invariant`, the edit stays). The scene evaluation runs in the `EvaluationScheduler` as the plan's own subject ([workers.md](../architecture/workers.md#automatic-evaluation-after-design-edits)); the window push and drawing are task E3b.

**Implementation (task E3b, UI):** the per-kind design fields live in `modes/design/OperationFields.tsx`, used by the Design inspector and by `PlanCopyGroup` (each commit one `plan.design.operation.update`; read-only outside `settledDesign`, with the draft hint). The rebuild and the status change back to draft confirm when the plan has plan-only edits (the count is the design operations that differ from `taken`) and then pass `discardPlanEdits: true`. The app host pushes each plan's part evaluation to windows (`PartEvaluationView.planId`, `evaluation.getPlan` on bind, [overview.md § IPC](../architecture/overview.md#ipc)); the plan scene draws it on the plan's stock copy with edited operations tinted (`--info`, light). The plan copy has no pick mode (references from the field's list), and the design ghost toggle is deferred ([plans/v0.2.md](../plans/v0.2.md#known-issues-and-risks)).

## Setup change in Run

Run mode loads **one program per setup** ([§ Toolpaths per setup](#toolpaths-per-setup)). Between programs it shows a setup-change prompt, styled like the tool-change dialog ([run-v0.1.md](run-v0.1.md)): the next setup's name and direction, a picture of the stock in its new orientation, "Set the work zero on the new top" with the WCS corner, then Start. The virtual machine needs nothing new (a setup change is a pause with a new program). The [run-v0.1.md amendment](run-v0.1.md#amendment-v02-task-e2-one-program-per-setup) is part of plan task E2 ([plans/v0.2.md](../plans/v0.2.md#3-plan-and-run)); as built: [§ Implementation (task E2)](#implementation-task-e2).

### Implementation (task E2)

Core (`src/core/plan/setups.ts` `chooseSetup`, `src/core/post/plan-export.ts`, `src/core/run/job.ts`, `src/core/toolpath/wcs.ts` `setupOrientation`) and run-mode UI (`modes/run/`); Plan mode's per-setup export and preview stay F6.

- **One setup per call:** `plan.export { planId, setupId?, target }` and `run.job.start { planId, setupId? }` work on one setup; `exportPlan` takes `setupId` in its options. `setupId` may be left out only when the plan has one setup (every v0.1 plan, so single-setup flows and the exit-criteria golden are unchanged); with several it fails with `plan.setup`, rule `setupRequired` (`params.setupIds` in machining order), an unknown id with `input.malformed`, rule `unknownSetup`. The E1 guard (rule `severalSetups`) is gone. Both results carry `setupId`. An optional argument rather than new tools keeps the agent `tools/list` budget (D21).
- **Program:** the header names the setup (`(Setup: Bottom)`), the operations are the setup's in machining order, `clearanceHeight` is the setup's. Only the exported setup's error findings block it (as `plan.toolpath.generate` per operation): setup 1 can run while setup 3 still has a missing tool. The toolpath hash chain still runs over the whole machining order (a conservative cache key).
- **Setup change between run jobs:** a setup change is the gap between two run jobs, not a phase inside one: the operator re-fixtures, jogs and sets the new work zero with the machine idle and no job reserving the connection, and the next job's soft-limit check runs at the new G54 ([run-v0.1.md amendment](run-v0.1.md#amendment-v02-task-e2-one-program-per-setup)). `run.job.start`'s result adds `next` `{ setupId, name, direction, rotation }`, the setup after it in machining order (absent after the last), so agents chain the setups and the UI opens its prompt. The machine host, the sender and the emulator are unchanged.
- **Prompt (UI):** `SetupChangeDialog` (`modes/run/`) opens when the window's followed run ends `done` with a `next`: title "Setup change: setup 2, Top", the picture (`SetupPicture`: the stock as it sits on the machine in isometric view, extents from `setupOrientation`, the top face marked `--info`, the work zero ring at the front-left corner of the top, a legend of the part faces up, in front and on the right), the steps (raise, turn and clamp, set X/Y at the front-left corner and Z on the top, start), the jog pad, "Zero X/Y/Z" and "Zero X Y Z", the live G54, "Later", "Start setup 2" (the only primary, gated like Start run) and the run dialogs' Stop. "Later" leaves a note in the inspector with "Show instructions"; the inspector's "Start run" opens the prompt instead of the pre-flight while a setup change is pending. The badge shows "Setup change" with the tool-change token and shape while the machine is idle; the change is announced assertively. It never starts by itself; choosing another plan or setup or closing the connection drops it.
- **Navigator and pre-flight:** a plan with several setups shows a "Setup" select ("1. Bottom", "2. Top"; the first by default), the pre-flight a "Setup" row ("Bottom (1 of 2)"); the run starts the chosen setup.
- **Run scene placed per setup** (fixes C3's known issue for Run): toolpaths, the tool marker (`wpos`) and the work-zero ring stay in the setup's WCS and are drawn through `setupFrame` (`RunScene.frame`, a group matrix in `RunLayer`; framing bounds through `placeBox`), so a bottom or side setup's program lands on the part. Only the chosen setup's toolpaths are drawn (one program).
- **`prepare: true`** centres the stock of the **first** setup in its orientation (extents along the setup's X/Y, `setupStockSize`); the same as before for a top setup. Later setups set their work zero by jog and `run.workZero.set` (agents may pass `values`).
- **Tests:** `src/core/toolpath/setups.test.ts` (`setupOrientation` for every direction and rotation; `setupRequired`, `unknownSetup`, each setup's program with its own operations and header, findings of another setup not blocking, a single-setup plan unchanged with or without `setupId`), `src/core/run/commands.test.ts` (a Bottom + Top plan run setup by setup on the in-process host, `next` naming the top setup, none after it), `modes/run/RunMode.test.tsx` (setup select, pre-flight row, the prompt after a done run with picture, steps, controls, badge, Later and Show instructions, Start setup 2 naming the setup, axe), `machine-state.test.ts` (badge), `viewport/toolpath-lines.test.ts` (`placeBox`, `frameMatrix`). No e2e yet: a multi-face design is not yet buildable through the design UI (F1/F2); the headless multi-setup flow is X1.

## Draft plans follow on Apply

User decision D13 (2026-11-21), specified in [apply.md](../architecture/apply.md): the draft auto-rebuild no longer runs on every `design.*` commit. It becomes the apply hook `plan.draftFollow`, which runs once per Apply after the design's tool choice, so setups and tools are derived from the confirmed design, not from every keystroke or popover step.

- Between an edit and Apply, a `draft` plan shows "Design changes not applied yet" instead of a stale notice, its checks and toolpaths marked outdated ([apply.md § Stale derived results](../architecture/apply.md#stale-derived-results)).
- `plan.create`, `plan.rebuild` and `plan.status.set` into `draft` (and un-archiving) apply first ([implicit apply](../architecture/apply.md#implicit-apply)).
- Implemented by task P2 ([apply.md § Implementation (task P2)](../architecture/apply.md#implementation-task-p2)).
- Draft plans follow **library** edits on Apply too, and Apply regenerates stale toolpaths of plans whose toolpaths the user generated ([apply.md decisions](../architecture/apply.md#decisions) 4 and 5).
