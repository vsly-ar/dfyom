# Plan mode v0.1: one setup, tools, passes, toolpaths

Status: accepted · core implemented ([task 2.13](#implementation-task-213); toolpaths 2.10, job 2.9) · Vision: [plan.md](plan.md) · Design input: [design.md](design.md#operations-v01) · Library: [library.md](../architecture/library.md) · Post: [grbl.md](../architecture/grbl.md) · Terms: [glossary.md](../glossary.md) · Task: [v0.1 plan](../plans/v0.1.md) 1.9 (code: 2.10)

Plan mode for [roadmap v0.1](../roadmap.md#v01--25d-basics-to-the-virtual-machine): self-contained plans with their own design snapshot, one setup on one machine, one concrete tool per operation, basic passes, toolpaths as a job. gCode is out of scope: the [export boundary](#export-boundary-tasks-110-and-211) hands toolpaths to the GRBL post-processor.

## Plans are snapshots

A project has **several plans**. Each plan is a self-contained, runnable "version of the project": a tuned plan may make many finished parts, so later design or library edits never change it silently.

- **Design snapshot:** `plan.create` copies the part and its operations into the plan: `design = { partId, takenAt, hash, taken, part }` (`taken`: the part as copied, `hash` of its DTO; `part`: the plan's version with [plan-only edits](#plans-are-snapshots); both as in [design.md](design.md#part-and-stock-v01)). The plan reads only `part`, never the current design.
- **Library copies:** the plan holds its own snapshots ([persistence.md](../architecture/persistence.md#library-references)) of every library item it uses: stock (copied from the part's stock snapshot), machine and tools. Workholding joins later.
- **Stale indicators** (derived on every evaluation, never stored): per operation `changedInDesign`, `removedFromDesign` (deep compare with the current design) and `editedInPlan`; per library copy `libraryChanged` or `libraryRemoved` (deep compare with the current library item, as in [library.md](../architecture/library.md#snapshots)). A stale plan stays valid and runnable.
- **Rebuild is deliberate:** `plan.rebuild` replaces the design snapshot with the current design. Plan operations are matched by design operation id and keep tool, preset, overrides and strategy; operations gone from the design are dropped; new design operations get plan operations with a [suggested tool](#tool-assignment-and-checks). Plans never add operations outside a rebuild and never suggest doing so.
- **Library updates are per item:** `plan.libraryItem.update` replaces one copy's values from the library. `draft` plans follow library changes automatically: the app dispatches that command (source `system`, one undo step each) for every changed copy (`followLibraryChanges`, [Implementation](#implementation-task-213)).
- **Plan-only edits:** in `settledDesign` the design snapshot can be edited for this plan only (`plan.design.operation.update`, same parameter schemas as `design.*.update`); the operation is then `editedInPlan` (its `part` version differs from `taken`), and a rebuild discards such edits only with `discardPlanEdits: true`; without it a rebuild (and `settledDesign → draft`) fails with `input.malformed` (issue `discardPlanEdits`, rule `planEdits`).

### Plan status

| Status          | Meaning                               | Allowed                                                                                    | Next                                 |
| --------------- | ------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------ |
| `draft`         | Follows the design                    | Plan edits; **auto-rebuild** on every design change and **auto-update** on library changes | `settledDesign`, `archived`          |
| `settledDesign` | Design frozen as the snapshot; tuning | Plan edits, snapshot edits, rebuild, library updates                                       | `draft`¹, `finalized`, `archived`    |
| `finalized`     | Verified, ready to run                | Read-only except status; generate, export, run                                             | `settledDesign`, `inUse`, `archived` |
| `inUse`         | In production                         | As `finalized`; change it via `plan.duplicate`                                             | `finalized`, `archived`              |
| `archived`      | Retired                               | Read-only; hidden in `plan.list` unless `includeArchived`; no export                       | the status before archiving²         |

¹ Rebuilds from the current design; with plan edits it requires `discardPlanEdits: true`. Commands not allowed in the current status fail with `plan.status` (issue names status and command); setting the current status is a no-op. Per-command statuses: [Implementation](#implementation-task-213). `plan.create` and `plan.duplicate` start in `draft` and `settledDesign` respectively.

² Archiving stores `statusBeforeArchive`; un-archiving (`plan.status.set` without `status`) restores it and clears the field. An `inUse` plan is changed only through `plan.duplicate`.

### v0.1 cut

- **Core (commands, MCP, CLI):** several plans, all statuses and transitions, design snapshot, stale detection, rebuild, auto-rebuild of `draft`, per-item library update, duplicate, `plan.design.operation.update`.
- **UI:** one plan at a time with a plan picker, its status, stale badges, rebuild and library-update actions. Editing the snapshot in the UI is later.
- **Later:** adding/removing operations in a snapshot, per-operation rebuild, workholding copies, several setups and parts per plan, diff view of stale changes.

## Plan record

- Record `plans/<id>.json` ([persistence.md](../architecture/persistence.md#working-folder-layout)): `{ id, name, status, statusBeforeArchive?, design, snapshots[], machine?, setups[] }`; `machine` and tool references are ids into the plan's own `snapshots`. Assigning a library item whose values equal an existing copy reuses it.
- **Machine checks** (warnings, re-run on every change): stock length/width/thickness + `clearanceHeight` fit `travel` (the work-zero position on the table is unknown, so only sizes); every feed rate ≤ `maxFeedRate` of the axes it moves; every spindle speed within `spindle.minSpeed..maxSpeed` (GRBL clamps silently). Without a machine, toolpaths are still generated; the export requires one.
- One **setup** per plan in v0.1: `{ id, name, workOffset, clearanceHeight, retractHeight, operations[] }`.

## Setup: orientation, work zero, safe heights

- **Stock orientation** is fixed in v0.1: stock bottom on the table, part X along machine X, part Y along machine Y (no rotation, no flip).
- **Work zero (WCS):** `workOffset` is `G54` (only value in v0.1) at [part zero](design.md#part-and-stock-v01): stock front-left corner, Z0 on the stock top. Through cuts absorb the thickness tolerance with `breakthrough`.
- **Safe heights:** `clearanceHeight` is measured up from the stock top, `retractHeight` up from the operation's `on` surface. Plunges start at `retractHeight`; there is no separate feed height.

| Parameter         | Kind   | Default      | Constraints       | Use                                                     |
| ----------------- | ------ | ------------ | ----------------- | ------------------------------------------------------- |
| `clearanceHeight` | length | 10 mm / 0.4″ | > `retractHeight` | Rapids between operations, tool changes, start and end. |
| `retractHeight`   | length | 2 mm / 0.08″ | > 0               | Rapids between passes and pecks inside an operation.    |

## Plan operations and order

- A **plan operation** machines one operation of the design snapshot; drilling operations with equal `diameter`, `bottom` and `depth` share one: `{ id, designOperationIds[], tool?, stickout?, presetName?, overrides, strategy }`.
- The list order is the **machining order**. Default order: facing, drilling, pockets, profiles (cutouts last); within a group, design order. Plan operations with the same tool are kept adjacent to save tool changes.
- Order checks: an operation must follow every operation whose surface its `on` references (`plan.order` error); a profile before an operation inside its shape → warning ("the piece may be loose").

## Tool assignment and checks

`plan.tool.suggest` filters the tool library by the [design's tool requirement](design.md#generalized-tools) and the checks below, then ranks by: has a preset for the stock's material class → already used in this plan (fewer tool changes) → largest diameter. `plan.create` and `plan.rebuild` assign the first suggestion to new plan operations; none → "no tool" and generation fails for it. `stickout` (length, per plan operation) defaults to the tool's `stickout`, else its `fluteLength`; > 0, < `overallLength`.

| Operation | Tool type                        | Checks (failing = `plan.check` error)                                                                                        |
| --------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Facing    | `flatEndMill`                    | Stepdown ≤ `fluteLength`.                                                                                                    |
| Pocket    | `flatEndMill`, `bullNoseEndMill` | Radius ≤ `cornerRadius`; `floorRadius` > 0 needs a bull nose with RE = `floorRadius` within tolerance; depth ≤ stickout.     |
| Drilling  | `drill`                          | DC = `diameter` within tolerance; `drillPoint`: SIG = `pointAngle`; `flat` bottom not possible; depth + tip ≤ `fluteLength`. |
| Drilling  | `flatEndMill` (helical boring)   | `diameter`/2 < DC < `diameter` (no core is left); `bottom` is `flat` or `through`; depth ≤ stickout.                         |
| Profile   | `flatEndMill`                    | DC ≤ `slotWidth`; thickness + `breakthrough` ≤ `fluteLength` and ≤ stickout.                                                 |

Floor fillets are made only by a matching bull-nose end mill in v0.1; ball end mills with 3D passes are later.

## Feeds and speeds

- Each of `spindleSpeed`, `feedRate`, `plungeRate`, `stepdown`, `stepover` resolves as: per-operation **override** → **tool preset** ([library.md](../architecture/library.md#feeds-and-speeds-presets)) → **calculator suggestion** ([feeds-speeds.md](../architecture/feeds-speeds.md): surface speed, chip thinning, power) → strategy fallback (stepdown/stepover only, tables below). Nothing resolved → `plan.check` error naming the field.
- `presetName` default: the preset whose `materialClass` equals the stock's, else one without `materialClass`, else none. The UI shows which source each value came from.
- Chip load (feed ÷ (rpm × flutes)) is derived and shown next to the values, not stored. Ramps and helices feed at `feedRate`; straight plunges and drilling at `plungeRate`.

## Pass strategies (v0.1)

Quantities as in [quantities.md](../architecture/quantities.md); defaults metric / inch; `D` = tool diameter. Constraint violations are `model.invariant`. Common to all milling strategies: `direction` `climb` (default) or `conventional`.

### Facing

| Parameter   | Kind   | Default                   | Constraints                    |
| ----------- | ------ | ------------------------- | ------------------------------ |
| `pattern`   | –      | `zigzag`                  | `zigzag` or `oneWay`           |
| `axis`      | –      | `x`                       | `x` (along length) or `y`      |
| `stepover`  | length | preset, else 0.75 D       | 0 < s ≤ 0.9 D                  |
| `stepdown`  | length | preset, else facing depth | > 0                            |
| `overshoot` | length | 1 mm / 0.04″              | ≥ 0; tool edge past stock edge |

The tool starts and ends outside the stock, so facing enters from the side (no ramp). `oneWay` returns at `retractHeight` and cuts every row in `direction`.

### Pocket (offset clearing)

Concentric offset rings from the center outwards; the last ring follows the pocket wall. Adaptive clearing is later.

| Parameter         | Kind   | Default             | Constraints                                                                |
| ----------------- | ------ | ------------------- | -------------------------------------------------------------------------- |
| `stepover`        | length | preset, else 0.4 D  | 0 < s ≤ 0.9 D                                                              |
| `stepdown`        | length | preset, else 0.25 D | 0 < s ≤ `fluteLength`                                                      |
| `entry`           | –      | `helix`             | `helix`, `ramp` or `plunge`; falls back in this order when it does not fit |
| `helixDiameter`   | length | 0.8 D               | 0 < h; h + D ≤ narrowest pocket size                                       |
| `rampAngle`       | angle  | 3°                  | 0.5°–30°; also the helix pitch angle                                       |
| `finishAllowance` | length | 0.2 mm / 0.008″     | ≥ 0; 0 = no finishing pass; radial, walls only                             |
| `finishStepdown`  | length | pocket depth        | 0 < s ≤ `fluteLength`                                                      |

The floor is cut to size by the last roughing level; the finishing pass follows the wall contour at full radial size. A bull-nose tool with RE = `floorRadius` leaves the floor fillet in the same passes.

### Drilling

| Parameter       | Kind   | Default                                 | Constraints                                                              |
| --------------- | ------ | --------------------------------------- | ------------------------------------------------------------------------ |
| `cycle`         | –      | `peck` if depth > 3 × DC, else `simple` | drill: `simple`, `peck` (full retract) or `chipBreak`; end mill: `helix` |
| `peckDepth`     | length | DC                                      | > 0; `peck`/`chipBreak` only                                             |
| `chipBreakBack` | length | 0.5 mm / 0.02″                          | > 0; `chipBreak` only                                                    |
| `helixPitch`    | length | preset stepdown, else 0.25 DC           | > 0; `helix` only                                                        |
| `breakthrough`  | length | 0.5 mm / 0.02″                          | ≥ 0; `through` only                                                      |

Drill tip Z = hole depth (to full diameter) + tip length from SIG, plus `breakthrough` for `through`. Holes in one plan operation are visited in nearest-neighbour order from the previous position. `helix` ends with a full circle at the final depth to clean the wall.

### Profile with tabs

| Parameter         | Kind   | Default             | Constraints                            |
| ----------------- | ------ | ------------------- | -------------------------------------- |
| `stepdown`        | length | preset, else 0.25 D | 0 < s ≤ `fluteLength`                  |
| `stepover`        | length | preset, else 0.4 D  | 0 < s ≤ D; only when `slotWidth` > D   |
| `entry`           | –      | `ramp`              | `ramp` (along the contour) or `plunge` |
| `rampAngle`       | angle  | 3°                  | 0.5°–30°                               |
| `breakthrough`    | length | 0.5 mm / 0.02″      | ≥ 0; below `stock.bottom`              |
| `finishAllowance` | length | 0.2 mm / 0.008″     | ≥ 0; 0 = no finishing pass             |

The first pass runs on the part side of the slot (tool edge on the shape); a slot wider than D adds passes away from the part. In levels below `tabs.thickness` the tool lifts to the tab top over each tab (tab width + D, vertical moves); the finishing pass skips tabs the same way.

## Toolpath generation (job)

- `plan.toolpath.generate { planId, planOperationIds? }` is a `job` command ([commands.md](../architecture/commands.md#long-running-commands-jobs)); generators run through the `WorkerPort` ([ADR 0008](../decisions/0008-threading-split-by-job.md)), one checkpoint and progress tick per plan operation and level.
- Toolpaths are **derived data**: not in `ProjectDoc`, not persisted, so the job needs no follow-up document command. They are cached per plan operation under a hash of all inputs (the plan's snapshot operation, plan operation, library copies and setup); a changed input marks the toolpath stale. Export regenerates stale toolpaths.
- v0.1 shapes are axis-aligned rectangles and circles, so every offset (tool radius, rings, allowance) is again a rounded rectangle or a circle: generators compute them **analytically with exact arcs**. `clipper2-ts` enters with general shapes; `cavalier-contours-js` is not needed in v0.1 ([geometry.md](../architecture/geometry.md#layers)).

## Toolpath data model

Independent of the post-processor and of gCode; all numbers float64 mm in the setup's WCS (derived data, not quantities):

A `Toolpath` is `{ planOperationId, tool (snapshot id), spindleSpeed, passes[], stats }`; a pass is `{ kind: 'rough' | 'finish' | 'drill', moves[] }`; `stats` holds cut length, rapid length and estimated seconds.

| Move    | Fields                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------- |
| `rapid` | `to: [x, y, z]`                                                                                                 |
| `line`  | `to`, `feed`                                                                                                    |
| `arc`   | `to`, `center: [x, y]`, `cw`, `feed` – XY plane; a Z change makes it a helix                                    |
| `drill` | `at: [x, y]`, `top`, `bottom`, `cycle` (`simple` \| `peck` \| `chipBreak`), `peck?`, `back?`, `retract`, `feed` |

`drill` keeps the cycle semantic; the export expands it to rapid/feed moves (GRBL 1.1 has no canned cycles G81–G83; grblHAL has them – later). `estimatedSeconds` ignores acceleration in v0.1 and uses `maxFeedRate` for rapids.

## Commands and queries (v0.1)

Names follow [commands.md](../architecture/commands.md#naming); `document` unless noted. Quantities are passed as entered. Every command except `plan.create` checks the [status](#plan-status).

| Command                        | Args                                                                                    | Result                |
| ------------------------------ | --------------------------------------------------------------------------------------- | --------------------- |
| `plan.create`                  | `{ partId, name?, machineLibraryItemId? }` – design snapshot, one setup, all operations | `{ planId, setupId }` |
| `plan.duplicate`               | `{ planId, name? }` – deep copy incl. snapshots, status `settledDesign`                 | `{ planId }`          |
| `plan.update`                  | `{ planId, name }`                                                                      | `{}`                  |
| `plan.remove`                  | `{ planId, confirm: true }`                                                             | `{}`                  |
| `plan.status.set`              | `{ planId, status?, discardPlanEdits? }` – transitions above; no `status` = un-archive  | `{}`                  |
| `plan.rebuild`                 | `{ planId, discardPlanEdits? }` – snapshot from the current design                      | `{}`                  |
| `plan.libraryItem.update`      | `{ planId, snapshotId }` – one copy from the library                                    | `{}`                  |
| `plan.design.operation.update` | `{ planId, operationId, …parameters }` – `settledDesign` only                           | `{}`                  |
| `plan.machine.set`             | `{ planId, machineLibraryItemId }`                                                      | `{}`                  |
| `plan.setup.update`            | `{ planId, setupId, clearanceHeight?, retractHeight? }`                                 | `{}`                  |
| `plan.operation.update`        | `{ planId, planOperationId, presetName?, stickout?, overrides?, strategy? }`            | `{}`                  |
| `plan.operation.move`          | `{ planId, planOperationId, toIndex }`                                                  | `{}`                  |
| `plan.tool.assign`             | `{ planId, planOperationId, toolLibraryItemId }` – plan copy; resets `presetName`       | `{}`                  |
| `plan.toolpath.generate`       | `{ planId, planOperationIds? }` – `job`                                                 | `{ jobId }`           |

- Design commands of the part rebuild every `draft` plan of that part in the same command (one undo step), through a [document hook](../architecture/commands.md#document-hooks).
- Queries: `plan.list { includeArchived? }`, `plan.get`, `plan.operation.list`, `plan.stale.list { planId }` (stale operations and library copies), `plan.tool.suggest { planId, planOperationId }` (ranked tools with reasons), `plan.toolpath.get { planId, planOperationId }` (moves for preview; stale flag), `plan.warning.list`.
- New error codes (registered with task 2.13): `plan.check` (tool, feeds or machine check failed; issues name operation, field and rule), `plan.order`, `plan.status`. `plan.toolpath.generate` and `plan.toolpath.get` come with tasks 2.9/2.10 on the [seam](#implementation-task-213).

## Export boundary (tasks 1.10 and 2.11)

Export (`effect` command, task 2.11) turns the ordered `Toolpath[]` of one setup, the setup and the plan's machine copy (`programUnits`, `spindle.control`, `toolChanger`) into a `MachiningProgram` ([grbl.md](../architecture/grbl.md#input-boundary)): it expands `drill` moves into rapid/feed blocks, converts arc centers to `I`/`J` offsets (arcs and helices stay G2/G3) and adds tool-change and spindle blocks. `postGrbl` then writes the text; it owns the gCode text and its defaults (e.g. spindle dwell after `M3`, [grbl.md](../architecture/grbl.md#output-dialect)); plan mode never emits text.

## Files

| File                                                    | Contents                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/core/plan/plan.dto.ts`, `plan.ts`                  | Plan, setup, plan operation DTOs (Zod); `loadPlan` (models of the copies)  |
| `src/core/plan/snapshot.ts`, `status.ts`                | Design snapshot, hash, stale detection; status transitions and permissions |
| `src/core/plan/build.ts`                                | Create, rebuild, tool assignment with copy reuse, duplicate                |
| `src/core/plan/strategy.ts`                             | Strategy parameters per kind, parsing, defaults, constraints               |
| `src/core/plan/feeds.ts`                                | Strategy → engagement, the resolution order, `source` per field, presets   |
| `src/core/plan/checks.ts`, `suggest.ts`, `order.ts`     | Tool/machine checks, tool ranking, default order and order checks          |
| `src/core/plan/evaluate.ts`                             | Per-operation evaluation and `plan.warning.list` findings                  |
| `src/core/plan/commands.ts`                             | Commands and queries above; the draft auto-rebuild hook                    |
| `src/core/plan/follow.ts`                               | `followLibraryChanges`: draft plans follow the library                     |
| `src/core/plan/inputs.ts`                               | Seam to toolpaths: `planOperationInputs`, `ToolpathGenerator`              |
| `src/core/toolpath/model.ts`                            | `Toolpath`, `Pass`, `Move` (the contract above; task 2.10)                 |
| `src/core/geometry/contour.ts`                          | Analytic offsets of rounded rectangles and circles (task 2.10)             |
| `src/core/toolpath/{facing,pocket,drilling,profile}.ts` | Generators per strategy; tabs in `profile.ts` (task 2.10)                  |
| `src/core/toolpath/generate.ts`, `stats.ts`             | Job handler, input hash and cache, length/time estimates (tasks 2.9/2.10)  |

## Implementation (task 2.13)

Plans live in `ProjectDoc.plans` (record `plans/<id>.json`, registered in `PROJECT_LAYOUT`). Decisions made with the implementation, where this doc left room:

- **`takenAt` instead of `sourceRevision`.** The dispatcher's revision is outside `ProjectDoc` by design (it never appears in patches), so a document handler cannot read it. The snapshot records `takenAt` (like library snapshots); staleness is a deep compare anyway, `hash` serves caches.
- **`taken` and `part`.** The snapshot keeps the part as copied (`taken`) next to the plan's version (`part`), so `changedInDesign` (`taken` vs. design), `removedFromDesign` and `editedInPlan` (`part` vs. `taken`) stay derived. New design operations are never reported (`plan.stale.list` has no "added" entry).
- **Stock copy.** The plan's stock copy keeps the id of the part's stock snapshot, so `part.stock` resolves in the plan's own `snapshots`. It is a library copy: `plan.libraryItem.update` re-imports it (the plan's part is re-validated against the new stock, `model.invariant` if it no longer fits); a rebuild replaces it only when the part references another stock snapshot.
- **Statuses per command.** `plan.update`, `plan.rebuild`, `plan.libraryItem.update`, `plan.machine.set`, `plan.setup.update`, `plan.operation.update`/`.move`, `plan.tool.assign`: `draft` and `settledDesign`. `plan.design.operation.update`: `settledDesign`. `plan.duplicate`: every status. `plan.remove` (`confirm: true`): every status but `inUse` (archive it first). An archived plan can also be set to its `statusBeforeArchive` explicitly; an archived plan without one restores `draft`. Any transition into `draft` rebuilds when the design changed.
- **Draft auto-rebuild** is the document hook `plan.draftAutoRebuild` ([commands.md](../architecture/commands.md#document-hooks)): after every `design.*` command it rebuilds each `draft` plan whose `taken` differs from the part, on the same draft. Design command handlers are unchanged; a failing rebuild (a broken plan record) fails the design command rather than leaving a hidden stale draft.
- **Draft library follow.** Library edits are effect commands outside `ProjectDoc`, so no hook sees them. `followLibraryChanges(dispatcher, library.lookup)` (follow.ts) dispatches `plan.libraryItem.update` (source `system`, with `expectedRevision`) for every `libraryChanged` copy of a `draft` plan; the main process calls it on a library change event (task 3.x). Removed or unreadable items stay notices.
- **Rebuild matching.** Plan operations keep id, tool, stickout, preset, overrides and strategy. A drilling group whose holes no longer share diameter, bottom, depth and point angle splits; the split-off groups copy the settings. New design operations get new plan operations (equal new holes share one) with the first suggestion, inserted after the last operation of the same or an earlier group and after the operations whose surfaces they start from.
- **Grouping key** of holes also includes `pointAngle` (a drill makes one point angle).
- **Default order** is a stable topological order: group, then tool (first appearance in the group), then design order, never before an `on` dependency (a drilling on a pocket floor follows the pocket).
- **Strategy storage.** `strategy` stores only the parameters the user set (sparse; omitted = default at evaluation, so defaults follow the tool). `stepover`/`stepdown` are feeds fields: they are `overrides`, not strategy parameters. Args take values as entered; `null` resets to the default; a key of another kind is `input.malformed` (rule `notForKind`).
- **Constraint checks.** `plan.operation.update` checks overrides, stickout and strategy against the current tool (`model.invariant`). Tool-dependent rules can break later (another tool); `plan.warning.list` then reports them as `plan.check` errors.
- **Feeds** (`feeds.ts`): `stepover` resolves override → preset → strategy fallback (the calculator never suggests one in v0.1) and feeds the facing engagement; `stepdown` override → preset → calculator → fallback. Drilling resolves only `spindleSpeed`, `feedRate`, `plungeRate`; an end mill bores with `helix` engagement (`ap` = resolved `helixPitch`). Calculator warnings join only when the calculator supplies or misses a field. Results carry `source` per field (`override`, `preset`, `calculator`, `strategy`) and, for the calculator, its derivation.
- **`plan.warning.list`** returns `{ code, severity, message, planOperationId?, field?, rule, params }`: `plan.check` and `plan.order` with severity `error` (they fail generation), `plan.loosePiece` and `plan.machine` warnings, and the calculator's `feeds.*` codes. "Inside its shape" for the loose-piece warning tests the operation's centre (facing always counts).
- **Tool suggestion** filters by the tool checks (type, size, reach, flute length) with each candidate's default stickout and preset; missing feeds do not disqualify a tool. Ties after the three ranks go by library id.
- **Seam to toolpaths (2.9/2.10).** `planOperationInputs(doc, planId, planOperationIds?)` (inputs.ts) returns per plan operation everything a generator needs (snapshot operations, part, stock, setup heights in mm, tool copy and its id, stickout, resolved feeds and strategy, machine) plus `inputHash` (hash of the plan's part, the plan operation, the used copies and the setup) for the toolpath cache; error findings fail it with `plan.check`/`plan.order`. Generators implement `ToolpathGenerator<Toolpath>`; `plan.toolpath.generate` and `plan.toolpath.get` are added with them.
