# Plan mode v0.1: one setup, tools, passes, toolpaths

Status: implemented · core implemented ([task 2.13](#implementation-task-213); toolpaths 2.10, job 2.9) · UI implemented ([task 3.7](#plan-mode-ui-task-37)) · locks and auto mode: implemented ([task 3.14](#implementation-task-314)) · strategy editing and [feeds explanation](#feeds-explanation-v02): implemented (v0.2 phase 1) · Vision: [plan.md](plan.md) · Design input: [design.md](design.md#operations-v01) · Library: [library.md](../architecture/library.md) · Post: [grbl.md](../architecture/grbl.md) · Terms: [glossary.md](../glossary.md) · Task: [v0.1 plan](../plans/v0.1.md) 1.9 (code: 2.10)

Plan mode for [roadmap v0.1](../roadmap.md#v01--25d-basics-to-the-virtual-machine): self-contained plans with their own design snapshot, one setup on one machine, one concrete tool per operation, basic passes, toolpaths as a job. gCode is out of scope: the [export boundary](#export-boundary-tasks-110-and-211) hands toolpaths to the GRBL post-processor.

## Plans are snapshots

A project has **several plans**. Each plan is a self-contained, runnable "version of the project": a tuned plan may make many finished parts, so later design or library edits never change it silently.

- **Design snapshot:** `plan.create` copies the part and its operations into the plan: `design = { partId, takenAt, hash, taken, part }` (`taken`: the part as copied, `hash` of its DTO; `part`: the plan's version with [plan-only edits](#plans-are-snapshots); both as in [design.md](design.md#part-and-stock-v01)). The plan reads only `part`, never the current design.
- **Library copies:** the plan holds its own snapshots ([persistence.md](../architecture/persistence.md#library-references)) of every library item it uses: stock (copied from the part's stock snapshot), machine and tools. Workholding joins later.
- **Stale indicators** (derived on every evaluation, never stored): per operation `changedInDesign`, `removedFromDesign` (compare by value with the current design) and `editedInPlan`; for the part `partChanged` (part-level fields such as `generalTolerance`); per library copy `libraryChanged` or `libraryRemoved` (deep compare with the current library item, as in [library.md](../architecture/library.md#snapshots)). A stale plan stays valid and runnable.
- **Rebuild is deliberate:** `plan.rebuild` replaces the design snapshot with the current design. Plan operations are matched by design operation id and keep tool, preset, overrides and strategy; operations gone from the design are dropped; new design operations get plan operations with a [suggested tool](#tool-assignment-and-checks). Plans never add operations outside a rebuild and never suggest doing so.
- **New design operations:** only `draft` plans get them automatically (the auto-rebuild adds them with a suggested tool). `settledDesign`, `finalized`, `inUse` and `archived` plans never get them automatically and are never told about them: no suggestion, no entry in `plan.stale.list`. A `settledDesign` plan takes them only through a deliberate `plan.rebuild` (or by returning to `draft`).
- **Library updates are per item:** `plan.libraryItem.update` replaces one copy's values from the library. `draft` plans follow library changes automatically: the app dispatches that command (source `system`, one undo step each) for every changed copy (`followLibraryChanges`, [Implementation](#implementation-task-213)).
- **Plan-only edits:** in `settledDesign` the design snapshot can be edited for this plan only (`plan.design.operation.update`, same parameter schemas as `design.*.update`); the operation is then `editedInPlan` (its `part` version differs from `taken`), and a rebuild discards such edits only with `discardPlanEdits: true`; without it a rebuild (and `settledDesign → draft`) fails with `input.malformed` (issue `discardPlanEdits`, rule `planEdits`).

### Plan status

| Status          | Meaning                               | Allowed                                                                                    | Next                                 |
| --------------- | ------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------ |
| `draft`         | Follows the design                    | Plan edits; **auto-rebuild** on every design change and **auto-update** on library changes | `settledDesign`, `archived`          |
| `settledDesign` | Design frozen as the snapshot; tuning | Plan edits, snapshot edits, rebuild, library updates                                       | `draft`¹, `finalized`, `archived`    |
| `finalized`     | Verified, ready to run                | Read-only except status; generate, export, run                                             | `settledDesign`, `inUse`, `archived` |
| `inUse`         | In production; never steps back       | As `finalized`; change it via `plan.duplicate`                                             | `archived`                           |
| `archived`      | Retired                               | Read-only; hidden in `plan.list` unless `includeArchived`; no export                       | the status before archiving²         |

¹ Rebuilds from the current design; with plan edits it requires `discardPlanEdits: true`. Commands not allowed in the current status fail with `plan.status` (issue names status and command); setting the current status is a no-op. Per-command statuses: [Implementation](#implementation-task-213). `plan.create` and `plan.duplicate` start in `draft` and `settledDesign` respectively.

² Archiving stores `statusBeforeArchive`; un-archiving (`plan.status.set` without `status`) restores it and clears the field. An `inUse` plan has no way back to `finalized` or earlier: its only exit is `archived`, un-archiving returns it to `inUse`, and any change needs `plan.duplicate`.

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

`plan.tool.suggest` filters the tool library by the [design's tool requirement](design.md#generalized-tools) (v0.2: also the design's tool field, [plan-v0.2.md](plan-v0.2.md#tool-resolution-from-the-design-tool-field)) and the checks below, then ranks by: has a preset for the stock's material class → already used in this plan (fewer tool changes) → largest diameter. `plan.create` and `plan.rebuild` assign the first suggestion to new plan operations; none → "no tool" and generation fails for it. `stickout` (length, per plan operation) defaults to the tool's `stickout`, else its `fluteLength`; > 0, < `overallLength`.

| Operation | Tool type                        | Checks (failing = `plan.check` error)                                                                                                    |
| --------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Facing    | `flatEndMill`                    | Stepdown ≤ `fluteLength`.                                                                                                                |
| Pocket    | `flatEndMill`, `bullNoseEndMill` | Radius ≤ `cornerRadius`; `floorRadius` > 0 needs a bull nose with RE = `floorRadius` within 0.01 mm; depth ≤ stickout.                   |
| Drilling  | `drill`                          | DC = `diameter` within tolerance; `drillPoint`: SIG = `pointAngle` within 0.5°; `flat` bottom not possible; depth + tip ≤ `fluteLength`. |
| Drilling  | `flatEndMill` (helical boring)   | `diameter`/2 < DC < `diameter` (no core is left); `bottom` is `flat` or `through`; depth ≤ stickout.                                     |
| Profile   | `flatEndMill`                    | DC ≤ `slotWidth`; thickness + `breakthrough` ≤ `fluteLength` and ≤ stickout.                                                             |

Floor fillets are made only by a matching bull-nose end mill in v0.1; ball end mills with 3D passes are later.

## Feeds and speeds

- Each of `spindleSpeed`, `feedRate`, `plungeRate`, `stepdown`, `stepover` resolves as: per-operation **entered value** (`overrides`) → in [auto mode](#locks-and-auto-mode) the **calculator's recommendation** ([feeds-speeds.md](../architecture/feeds-speeds.md): surface speed, chip thinning, power; around the locked values), otherwise the **tool preset** ([library.md](../architecture/library.md#feeds-and-speeds-presets)) → strategy fallback (stepdown/stepover only, tables below). Nothing resolved → `plan.check` error naming the field.
- `presetName` default: the preset whose `materialClass` equals the stock's, else one without `materialClass`, else none (auto mode). The UI shows which source each value came from.
- Chip load (feed ÷ (rpm × flutes)) is derived and shown next to the values, not stored. Ramps and helices feed at `feedRate`; straight plunges and drilling at `plungeRate`.

### Feeds explanation (v0.2)

Status: implemented (v0.2, strategy editing phase 1). `plan.operation.feeds.get { planId, planOperationId }` (query) explains one plan operation's feeds for the inspector's "Show calculation" and for agents: `auto` (as in `plan.operation.list`); `inputs` (null without a tool): `materialClass`, `toolMaterial` (null when not set), `diameter`, `fluteCount`, effective `cornerRadius` (mm), the calculator's `engagement` (`{ kind, ae?, ap? }`: facing's strategy stepover or a locked one, helix pitch), the machine's `rigidity` (the default without a machine) and `spindlePower` (W, null: power check skipped); `fields` per feeds field `{ value, unit, source, derivation }` with `derivation` the calculator's steps (`{ step, formula, inputs, result, unit, sources? }`, as [`feedsSpeeds.suggest`](../architecture/feeds-speeds.md#api)) for `source: calculator`, else null; `used`: `{ dCalc, vc, fz, chipThinning, Q, Pc, spindleLoad }` at the values that will be used, entered ones included (as the [final-value check](../architecture/feeds-speeds.md#final-value-check) sees them; `fz` after chip thinning, drills `fn`; `Q`/`Pc` null for drills, `spindleLoad` null without spindle power), null without calculator data. Canonical units (mm, m/min, mm/min, mm³/min, kW). `plan.operation.list` stays values and sources only (its rows are read for every operation on every revision).

### Locks and auto mode

Status: accepted (the user's rule; open questions answered 2026-11-21, [decisions](#lock-decisions-2026-11-21)) · implemented in task 3.14 ([implementation](#implementation-task-314)). Replaces the "override" rule of the [3.7 UI](#plan-mode-ui-task-37). Calculator side: [feeds-speeds.md § Locked inputs](../architecture/feeds-speeds.md#locked-inputs); field look: [ui.md § Field](../conventions/ui.md#field).

The user's rule: locks appear only while a recommendation (auto) mode is on. In it, values can be entered, and are otherwise assigned automatically or suggested. A lock means "use this value as a starting point": the other recommendations adjust to it (lock the spindle speed and the feed follows). The lock can be disabled when its value is wrong, contradicts another value or makes the calculation impossible. Without a recommendation, or with it switched off, locks mean nothing and are hidden.

**Auto mode (recommendation).** A plan operation's feeds come either from the **calculator** (auto mode) or from a **cutting preset** (fixed values, no recommendation, no locks). The "Cutting preset" control is that choice: "Default (…)", "Auto (calculator)" or one of the tool's presets. Default when the user chose nothing: the preset for the stock's material class, else one without a class, else auto (a user-curated preset wins). Auto mode is **unavailable** when the calculator has no data for the tool and stock (`feeds.noData`): the option is disabled with that reason shown, and the fields show preset, strategy or entered values without locks. The strategy fallback (stepdown, stepover) is the recommendation of fields the calculator does not suggest in v0.1.

**Field states in auto mode** (per field with a recommendation):

| State       | Stored                             | Value used                                                                | Shown                                                                                                      |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Recommended | nothing                            | the recommendation; it follows tool, stock, machine and the locked fields | "Recommended by the calculator." (or "Strategy default."); lock not pressed                                |
| Entered     | `overrides[f]`                     | the entered value; **no other field adjusts to it**                       | "Entered by you. Recommended 18000 rpm." with the fix "Use 18000 rpm" (clears the entry); lock not pressed |
| Locked      | `overrides[f]` and `f` in `locked` | the entered value; the other recommendations are computed from it         | "Locked: the other values follow it."; lock pressed                                                        |

- **Typing never locks** (entered values are allowed in auto mode; locking is a separate act). Pressing the lock of a Recommended field pins the shown value and locks it (one command). Unlocking keeps the value as Entered; "Use …" returns to the recommendation.
- **Lockable fields:** milling `spindleSpeed`, `feedRate`, `stepdown`, and `stepover` for facing only; drilling `spindleSpeed`, `feedRate`. `plungeRate` and the stepover of pockets and profiles have a recommendation but nothing depends on them: Recommended and Entered only, no lock.
- **Several locks** are all inputs at once; the [table](../architecture/feeds-speeds.md#locked-inputs) gives what is recommended for every combination. A lock is **disabled** (with its reason: invalid value, outside the machine's spindle or feed range, deeper than the tool, or the power rule when every input of the power check would be locked) per [Impossible locks](../architecture/feeds-speeds.md#impossible-locks); individually valid combinations only warn (chip load outside the data range: `feeds.rubbing`, `feeds.chipLoadHigh`). A stored lock that a later change makes impossible turns inactive with a `feeds.lockInactive` warning.
- **Outside auto mode** (a preset chosen, or auto unavailable): values are entered, preset or strategy default; no recommendation, no locks. Choosing a preset or leaving auto mode clears `locked` in the same command (no hidden state); entered values stay.
- **Checks** run on the values that will be used, entered ones included ([final-value check](../architecture/feeds-speeds.md#final-value-check)).

**Data model** (minimal; optional fields, so no `schemaVersion` change and no migration): plan operation `{ …, presetName?, auto?: true, locked?: FeedField[] }`. Invariants (`model.invariant`, checked by `plan.operation.update` and when a plan loads): `auto` and `presetName` are exclusive; `locked` only with `auto`, a subset of the `overrides` keys and of the lockable fields of the kind, no duplicates. Plans saved before this keep their overrides as Entered values (a stepdown override then stops adjusting the feed until it is locked).

**Commands and queries** (agents get the same through MCP/CLI; [llm-api.md](../architecture/llm-api.md) needs no change, tools follow the command layer):

- `plan.operation.update` gains `auto?: boolean` (`true`: auto mode, clears `presetName`; `false`: back to the default rule, clears `locked`) and `locks?: Partial<Record<FeedField, boolean>>`. `locks[f]: true` without a value for `f` (stored or in the same call's `overrides`) pins the current recommendation. An unavailable lock fails with `model.invariant`, rule `lockUnavailable`, `params.reason` = the [rule id](../architecture/feeds-speeds.md#impossible-locks) (or `autoOff`, `noData`, `notLockable`, `noTool`) and the message as shown. `overrides[f]: null` also unlocks `f`. Setting `presetName` clears `auto` and `locked`; `auto: true` with a `presetName` in one call is `input.malformed` (rule `autoAndPreset`).
- `plan.operation.list` per field: `{ value, unit, source, locked, recommended, lock }` with `source` `override | preset | calculator | strategy`, `locked: boolean`, `recommended: { value, unit } | null` (auto mode only; what the field would be without its entry), `lock: { state: 'hidden' } | { state: 'available' } | { state: 'unavailable', rule, reason }`; per operation `auto: 'on' | 'off' | { unavailable: reason }` (`unavailable` whenever the calculator has no data, whatever was chosen) and `presetName` (null in auto mode).

#### Lock decisions (2026-11-21)

The user answered the six open questions of the draft with the recommended option:

1. **Switch:** auto mode is the "Auto (calculator)" option of the existing Cutting preset control. A tool preset means fixed values, so no locks. Auto is disabled, with the reason shown, when the calculator has no data for the tool and stock.
2. **Entered engagement values:** an entered (unlocked) stepdown or stepover applies to that field only; the other recommendations adjust only to locked values. The final-value check (`checkCutting`) warns, e.g. about spindle power.
3. **Contradictions:** only hard limits disable a lock (machine spindle and feed range, tool length, facing stepover > D, power with nothing left to adjust). Chip load out of the data range only warns.
4. **Leaving auto mode** clears the locks.
5. **Unlocking** keeps the value as an entered one.
6. **No lock** on plunge rate or on pocket/profile stepover. Stickout loses its lock (a tool default, not a recommendation); the design system page drops the locks from its design-field examples.

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

| Parameter         | Kind   | Default             | Constraints                                                                 |
| ----------------- | ------ | ------------------- | --------------------------------------------------------------------------- |
| `stepover`        | length | preset, else 0.4 D  | 0 < s ≤ 0.9 D                                                               |
| `stepdown`        | length | preset, else 0.25 D | 0 < s ≤ `fluteLength`                                                       |
| `entry`           | –      | `helix`             | `helix`, `ramp` or `plunge`; falls back in this order when it does not fit  |
| `helixDiameter`   | length | 0.8 D               | 0 < h; used as min(h, D); that + D + 2 × `finishAllowance` ≤ narrowest size |
| `rampAngle`       | angle  | 3°                  | 0.5°–30°; also the helix pitch angle                                        |
| `finishAllowance` | length | 0.2 mm / 0.008″     | ≥ 0; 0 = no finishing pass; radial, walls only                              |
| `finishStepdown`  | length | pocket depth        | 0 < s ≤ `fluteLength`                                                       |

The floor is cut to size by the last roughing level; the finishing pass follows the wall contour at full radial size. A bull-nose tool with RE = `floorRadius` leaves the floor fillet in the same passes.

### Drilling

| Parameter       | Kind   | Default                                 | Constraints                                                              |
| --------------- | ------ | --------------------------------------- | ------------------------------------------------------------------------ |
| `cycle`         | –      | `peck` if depth > 3 × DC, else `simple` | drill: `simple`, `peck` (full retract) or `chipBreak`; end mill: `helix` |
| `peckDepth`     | length | DC                                      | > 0; `peck`/`chipBreak` only                                             |
| `chipBreakBack` | length | 0.5 mm / 0.02″                          | > 0; `chipBreak` only                                                    |
| `helixPitch`    | length | preset stepdown, else 0.25 DC           | > 0; `helix` only                                                        |
| `rampAngle`     | angle  | 3°                                      | 0.5°–30°; `helix` only: steepest helix slope (direction always climb)    |
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

- `plan.toolpath.generate { planId, planOperationIds? }` is a `job` command ([commands.md](../architecture/commands.md#long-running-commands-jobs)); generators run through the `WorkerPort` on the `toolpath` worker lane ([workers.md](../architecture/workers.md#toolpath-cache)), one checkpoint per plan operation and one step per level, pass and hole. A failed plan operation does not stop the job: the result lists each one as `generated`, `cached` or `failed`.
- Toolpaths are **derived data**: not in `ProjectDoc`, not persisted, so the job needs no follow-up document command. They are cached per plan operation under a hash of all inputs (the plan's snapshot operation, plan operation, library copies and setup); a changed input marks the toolpath stale. Export regenerates missing and stale toolpaths ([`plan.export`](../architecture/grbl.md#plan-export-command)).
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

## Toolpath generators (task 2.10)

Implemented in [`src/core/toolpath/`](../../src/core/toolpath/): pure, headless functions, one per operation kind, `generateFacing | generatePocket | generateDrilling | generateProfile(input) → AppResult<Toolpath>`. The contract lives in `model.ts`.

- **Input** (`GeneratorInput`): `planOperationId`; `tool` (`ToolpathTool`: snapshot id, type, `diameter`, effective `cornerRadius`, `fluteLength`, drill `pointAngle`); `cutting` (resolved [feeds and speeds](#feeds-and-speeds): `spindleSpeed`, `feedRate`, `plungeRate`, `stepdown`, `stepover`; drilling only the first three); `heights` (the setup's `clearanceHeight`, `retractHeight`); `stock`; `operation` (the snapshot operation as geometry's `OperationGeometry`, float64 mm); `strategy` (resolved [strategy values](#pass-strategies-v01) without stepdown/stepover); optional `maxFeedRate` per axis.
- **Errors:** invalid numbers and strategy constraints → `model.invariant`; a tool that cannot make the operation (wider than the pocket, slot or opening; drill ≠ hole; drill with `flat` bottom; drill SIG ≠ `pointAngle` beyond 0.5°; helix tool outside `diameter`/2 < DC < `diameter`; cycle/tool mismatch; no flat bottom; `floorRadius` > 0 without a bull nose of RE = `floorRadius` within 0.01 mm) → `plan.check`. The rest of the [check table](#tool-assignment-and-checks) (flute length, stickout, machine limits) is task 2.13's `checks.ts`. **Fit tolerance:** a tool up to 0.01 mm (`TOOL_FIT_TOLERANCE`, as the DFM tool checks) wider than a pocket's narrowest size, an opening or a slot is accepted; it overcuts the opposite wall by at most that much.
- **Common rules:** every toolpath starts with a horizontal rapid at clearance (`clearanceHeight` above Z0) and ends with a rapid up to it; inside an operation rapids run horizontally only on the retract plane (`on` + `retractHeight`; facing and profile: Z0 + `retractHeight`). Levels are equal steps of at most `stepdown`, the last one exactly at the bottom; one `rough` pass per level, then one `finish` pass. Arcs come exact from `contourElements` and sweep at most 180° (full circles are split). Lifts and plunges (every purely vertical feed move, also the lifts over tabs) feed at `plungeRate`, everything with XY motion at `feedRate`. `stats` skip the first move (the position before it is unknown); rapids are timed at the slowest axis (|Δ| ÷ `maxFeedRate` per axis), not at all without a machine copy. `expandDrill` (in `stats.ts`) is the grbl.md drill expansion, shared with the export.
- **Facing:** rows over the stock, spaced ≤ min(`stepover`, flat diameter); the first and last rows put the tool's flat edge `overshoot` past the stock edge, each row runs from tool-fully-outside to tool-fully-outside, so plunges and zigzag steps happen outside the stock. With M3 climb milling keeps the uncut material on the right: rows along X run −X, rows along Y run +Y.
- **Pocket:** rings start at the middle of `wall[0]` (circle: the front) and run counter-clockwise for climb. Ring offsets go from R + `finishAllowance` (clamped to the inradius) inwards in equal steps ≤ min(`stepover`, 2·flat radius for circles, √2·flat radius for rectangles, whose inner rings have sharp corners); the innermost lies within half a step of the collapse offset, so the center is covered. Each level: retract, re-enter at the pocket center from the previous level's Z, cut the rings from the innermost outwards, linked by straight moves. Entry fallback, keeping the finishing allowance (a = R + `finishAllowance`, clamped): the helix diameter is min(`helixDiameter`, D), so its bore leaves no post at the center and the link to the innermost ring never cuts at full width; `helix` fits when that + 2a ≤ the narrowest size (full turns from the front point, pitch angle ≤ `rampAngle`, then one flat circle); `ramp` fits when the long size − 2a ≥ D (zigzag of that length along the long axis, then one flat leg back to clean the wedge); else `plunge` at the center. Finishing: the wall ring at offset R in levels of `finishStepdown`, straight lead-in and lead-out from the roughed ring; only when the clamped allowance is > 0.
- **Drilling:** one hole per call. Drill: one `drill` move (`top` = `on`, `bottom` = tip Z, `retract` = `on` + `retractHeight`, `feed` = `plungeRate`). Helical boring: circle radius ρ = (`diameter` − DC)/2 around the hole, from the front point; each turn descends at most min(`helixPitch`, 2πρ·tan(`rampAngle`)), and the helix feed is capped so its vertical speed is ≤ `plungeRate`; then one flat circle at the bottom, to the center, rapid out. Below ρ = 0.1 mm (`HELIX_MIN_RADIUS`; a Ø6 tool in a Ø6.2 hole at 3° would need about 30 turns per mm) the tool plunges straight down at `plungeRate` in steps of `helixPitch` instead. `through` holes end `breakthrough` below the stock bottom.
- **Profile:** slot passes are distances from the shape: the part side at R + `finishAllowance` (clamped), then away from the part in equal steps ≤ `stepover` (inside rectangles ≤ √2·R) up to `slotWidth` − R. At each level the passes run from the offcut (slug) side to the part side, so breakthrough frees the offcut with no pass beside it afterwards. An inside slot's far pass runs round the slug (the slug offset by R, rounded corners); an inside slot that covers the opening is cleared like a pocket, from the center outwards, without tabs; if its only ring collapses to a point (tool ≈ opening) every level is a straight plunge at `plungeRate` at the center, as boring. Climb runs clockwise outside and counter-clockwise inside; all passes run the same way. Every level starts half a tab spacing after the first tab (no tabs: the middle of `wall[0]`): retract, plunge through air to the previous level, ramp along the first (offcut-side) pass by Δz ÷ tan(`rampAngle`) (lapping as often as needed), one full lap at the level, then the other passes, linked along the shape normal. Finishing: the part-side ring at the final depth in one level, lead-in and lead-out from the part-side rough pass.
- **Tabs:** the tool lifts wherever its disk overlaps a nominal tab band – geometry's `offsetBand` across exactly the slot, so the lift points match the tab ends of the evaluated part, including the bent end faces of [geometry.md](../architecture/geometry.md#offset-loft). There Z = max(level, tab top): vertical lift and drop at `plungeRate` (like every purely vertical feed move, so Z never feeds faster than the plunge rate and stays within the Z `maxFeedRate` a sensible plunge rate respects), ramps clamped. Boundaries are found by sampling (≤ min(R/4, 0.5 mm)) and bisection, kept on the safe side.
- **Tests:** generic properties on every generator (`testing/rules.ts`: starts and ends at clearance, arcs continuous and ≤ 180°, no plunge or vertical lift faster than `plungeRate` and no rising feed move whose Z speed exceeds it, ramps ≤ `rampAngle`, rapids only on the retract plane, every feed move within the removal region, the deepest cut exactly at the target depth, stepdown per level; also on every test-part toolpath), stepover per strategy, roughing never enters a pocket's finishing allowance, tabs probed up to the full tool radius (− 1 µm) with an independent oracle, 30 random pockets and 40 random profiles, golden files (`__golden__/*.txt`, update with `vitest -u`), and a heightmap simulation of the [geometry test part](../architecture/geometry.md#testing) compared cell by cell with its analytic removal (no gouge anywhere; flat areas exact).

**Wired later:** task 2.13 resolves the inputs (strategy schemas, defaults and fallbacks in `strategy.ts`, the full checks, cutting values via presets and the calculator, the tool and machine copies → `ToolpathTool` and `maxFeedRate`) and orders a plan operation's holes (one call per hole, nearest neighbour); task 2.9 maps the inputs (`toGeneratorInputs`, [workers.md](../architecture/workers.md#plan-operation-to-generator-input)), runs the generators as the `plan.toolpath.generate` job (`generate.ts`: cache by input hash, `WorkerPort`, progress) and serves `plan.toolpath.get`.

## Commands and queries (v0.1)

Names follow [commands.md](../architecture/commands.md#naming); `document` unless noted. Quantities are passed as entered. Every command except `plan.create` checks the [status](#plan-status).

| Command                        | Args                                                                                                                        | Result                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `plan.create`                  | `{ partId, name?, machineLibraryItemId? }` – design snapshot, one setup, all operations                                     | `{ planId, setupId }` |
| `plan.duplicate`               | `{ planId, name? }` – deep copy incl. snapshots, status `settledDesign`                                                     | `{ planId }`          |
| `plan.update`                  | `{ planId, name }`                                                                                                          | `{}`                  |
| `plan.remove`                  | `{ planId, confirm: true }`                                                                                                 | `{}`                  |
| `plan.status.set`              | `{ planId, status?, discardPlanEdits? }` – transitions above; no `status` = un-archive                                      | `{}`                  |
| `plan.rebuild`                 | `{ planId, discardPlanEdits? }` – snapshot from the current design                                                          | `{}`                  |
| `plan.libraryItem.update`      | `{ planId, snapshotId }` – one copy from the library (v0.1 also `followOnly?`, removed by v0.2 P2)                          | `{ updated }`         |
| `plan.design.operation.update` | `{ planId, operationId, …parameters }` – `settledDesign` only                                                               | `{}`                  |
| `plan.machine.set`             | `{ planId, machineLibraryItemId }`                                                                                          | `{}`                  |
| `plan.setup.update`            | `{ planId, setupId, clearanceHeight?, retractHeight? }`                                                                     | `{}`                  |
| `plan.operation.update`        | `{ planId, planOperationId, presetName?, auto?, stickout?, overrides?, locks?, strategy? }` ([locks](#locks-and-auto-mode)) | `{}`                  |
| `plan.operation.move`          | `{ planId, planOperationId, toIndex }`                                                                                      | `{}`                  |
| `plan.tool.assign`             | `{ planId, planOperationId, toolLibraryItemId }` – plan copy; resets `presetName`                                           | `{}`                  |
| `plan.toolpath.generate`       | `{ planId, planOperationIds? }` – `job`                                                                                     | `{ jobId }`           |

- Design commands of the part rebuild every `draft` plan of that part in the same command (one undo step), through a [document hook](../architecture/commands.md#document-hooks).
- Queries: `plan.list { includeArchived? }`, `plan.get`, `plan.operation.list`, `plan.operation.feeds.get { planId, planOperationId }` ([explanation](#feeds-explanation-v02)), `plan.stale.list { planId }` (stale operations and library copies), `plan.tool.suggest { planId, planOperationId }` (ranked tools with reasons), `plan.toolpath.get { planId, planOperationId }` (moves for preview; stale flag), `plan.warning.list`.
- New error codes: `plan.check` (tool, feeds or machine check failed; issues name operation, field and rule; registered with the generators in task 2.10), `plan.order`, `plan.status` (registered with the plan commands, task 2.13). `plan.toolpath.generate` and `plan.toolpath.get` come with task 2.9 on the [seam](#implementation-task-213).

## Export boundary (tasks 1.10 and 2.11)

Export (`effect` command, task 2.11) turns the ordered `Toolpath[]` of one setup, the setup and the plan's machine copy (`programUnits`, `spindle.control`, `toolChanger`) into a `MachiningProgram` ([grbl.md](../architecture/grbl.md#input-boundary)): it expands `drill` moves into rapid/feed blocks, converts arc centers to `I`/`J` offsets (arcs and helices stay G2/G3) and adds tool-change and spindle blocks. `postGrbl` then writes the text; it owns the gCode text and its defaults (e.g. spindle dwell after `M3`, [grbl.md](../architecture/grbl.md#output-dialect)); plan mode never emits text. Implemented (task 2.11) as the pure `exportGrbl` in `src/core/post/export.ts`, with the [export checks](../architecture/grbl.md#export-checks) (machine required, feed rates, spindle range, travel, soft limits); the `plan.export` effect command (`exportPlan`) regenerates missing or stale toolpaths, feeds them to it and writes the file ([grbl.md](../architecture/grbl.md#plan-export-command)).

## Files

| File                                                    | Contents                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/core/plan/plan.dto.ts`, `plan.ts`                  | Plan, setup, plan operation DTOs (Zod); `loadPlan` (models of the copies)                                  |
| `src/core/plan/snapshot.ts`, `status.ts`                | Design snapshot, hash, stale detection; status transitions and permissions                                 |
| `src/core/plan/build.ts`                                | Create, rebuild, tool assignment with copy reuse, duplicate                                                |
| `src/core/plan/strategy.ts`                             | Strategy parameters per kind, parsing, defaults, constraints                                               |
| `src/core/plan/feeds.ts`                                | Strategy → engagement, auto mode, presets, locks, `source` per field                                       |
| `src/core/plan/checks.ts`, `suggest.ts`, `order.ts`     | Tool/machine checks, tool ranking, default order and order checks                                          |
| `src/core/plan/evaluate.ts`                             | Per-operation evaluation and `plan.warning.list` findings                                                  |
| `src/core/plan/commands.ts`                             | Commands and queries above; the draft auto-rebuild hook                                                    |
| `src/core/plan/follow.ts`                               | `followLibraryChanges` (removed by v0.2 P2: draft plans follow on Apply, `plan/pending.ts`)                |
| `src/core/plan/inputs.ts`                               | Seam to toolpaths: `planOperationInputs`                                                                   |
| `src/core/toolpath/model.ts`                            | `Toolpath`, `Pass`, `Move` (the contract above) and the generator inputs                                   |
| `src/core/geometry/contour.ts`                          | Analytic offsets of rounded rectangles and circles                                                         |
| `src/core/toolpath/{facing,pocket,drilling,profile}.ts` | Generators per strategy                                                                                    |
| `src/core/toolpath/path.ts`, `tabs.ts`, `common.ts`     | Rings with exact arcs, the move builder; tab bands and lifts; input checks                                 |
| `src/core/toolpath/stats.ts`                            | Length/time estimates, drill-cycle expansion                                                               |
| `src/core/toolpath/testing/`                            | Fixtures, property rules, heightmap simulation, golden-file rendering                                      |
| `src/core/toolpath/generate.ts`                         | `plan.toolpath.generate` job and `plan.toolpath.get` (2.9); `cache.ts`, `inputs.ts` (mapper), `request.ts` |

## Implementation (task 3.14)

[Locks and auto mode](#locks-and-auto-mode) in `src/core/feeds-speeds/` (`suggest.ts`: `locked` inputs, `checkCutting`, `noDataFor`; `locks.ts`: impossible-lock rules), `src/core/plan/feeds.ts` (auto mode, lock states, recommendations, invariants), `plan.operation.update`/`.list` and the plan inspector. Decisions made with the implementation, where the docs left room; all eight confirmed by the user (2026-11-21):

- **When auto mode is on.** Requested = `auto: true`, or no `presetName` and no default preset for the stock's material class. On = requested and the calculator has data; `presetName` in `plan.operation.list` is then null. Requested but without data: the default preset applies (if any), stored locks stay stored and each reports `feeds.lockInactive` (rule `noData`); `feeds.noData` itself is reported only when a field is left without a value (as before).
- **Preset mode has no calculator.** Outside auto mode a field is entered → preset → strategy fallback; a preset without stepdown now gets the strategy stepdown, not the calculator's (a preset means fixed values).
- **Locking in the default auto mode** (no preset, nothing chosen) stores `auto: true`, so the invariant "locks only with `auto`" holds and the choice survives a later preset added to the tool.
- **Stored locks that break a rule** stay stored and are ignored by the calculator; their `lock` state is `unavailable` with the rule and reason (the UI keeps a pressed lock clickable, so it can always be released, and offers "Unlock" on the warning). The `power` rule only refuses new locks: a stored lock set never turns inactive for power (no single lock can be blamed); the final-value check warns instead.
- **Fixed stepdown and power.** With a locked stepdown (or the helix pitch, which is a strategy value), a power excess reduces an unlocked feed (n kept, chip load drops); with the feed locked too it only warns. This replaces the old "given `ap` only warns" rule.
- **Final-value check** (`checkCutting`) covers chip load (`feeds.rubbing`, `feeds.chipLoadHigh`, on `feedRate`) and power (`feeds.powerExceeded`, on `stepdown`; helix: `feedRate`) on the used values, in auto and preset mode, whenever the calculator has data. Spindle range and feed limits on the used values stay the existing `plan.machine` checks (no duplicate warning). In `plan.warning.list` the calculator's own `feeds.rubbing`, `feeds.chipLoadHigh` and `feeds.powerExceeded` are replaced by the check's; its other warnings (rpm clamps, feed clamp, power skipped) join as before when it supplies a value.
- **Pinned values** are rounded to the field's display precision in the project units (rpm whole, 0.1 mm/min or 0.01 in/min, 0.001 mm or 0.0001 in) and stored as entered text, like a typed value.
- **Lock reasons** are English with canonical units (rpm, mm/min, mm, kW), like the other plan messages (project units in messages are deferred past v0.1, low priority: [roadmap](../roadmap.md#later-unordered)).

## Implementation (task 2.13)

Plans live in `ProjectDoc.plans` (record `plans/<id>.json`, registered in `PROJECT_LAYOUT`). Decisions made with the implementation, where this doc left room:

- **`takenAt` instead of `sourceRevision`.** The dispatcher's revision is outside `ProjectDoc` by design (it never appears in patches), so a document handler cannot read it. The snapshot records `takenAt` (like library snapshots); staleness is a deep compare anyway, `hash` serves caches.
- **`taken` and `part`.** The snapshot keeps the part as copied (`taken`) next to the plan's version (`part`), so `changedInDesign` (`taken` vs. design), `removedFromDesign` and `editedInPlan` (`part` vs. `taken`) stay derived. New design operations are never reported (`plan.stale.list` has no "added" entry).
- **Stock copy.** The plan's stock copy keeps the id of the part's stock snapshot, so `part.stock` resolves in the plan's own `snapshots`. It is a library copy: `plan.libraryItem.update` re-imports it (the plan's part is re-validated against the new stock, `model.invariant` if it no longer fits); a rebuild replaces it only when the part references another stock snapshot.
- **Statuses per command.** `plan.update`, `plan.rebuild`, `plan.libraryItem.update`, `plan.machine.set`, `plan.setup.update`, `plan.operation.update`/`.move`, `plan.tool.assign`: `draft` and `settledDesign`. `plan.design.operation.update`: `settledDesign`. `plan.duplicate`: every status. `plan.remove` (`confirm: true`): every status but `inUse` (archive it first). An archived plan can also be set to its `statusBeforeArchive` explicitly; an archived plan without one restores `draft`. Any transition into `draft` rebuilds when the design changed.
- **Draft auto-rebuild** (v0.1; since v0.2 P2 the apply hook `plan.draftFollow`, [apply.md](../architecture/apply.md#implementation-task-p2)) is the document hook `plan.draftAutoRebuild` ([commands.md](../architecture/commands.md#document-hooks)): after every `design.*` command it rebuilds each `draft` plan of the command's part whose `taken` differs from the part (by value), on the same draft, and writes only the changed fields and operations (small patches). Design command handlers are unchanged, and **a design command never fails because of a plan**: the plan is downstream of the design, and the design must stay editable whatever its plans hold. A draft that cannot follow (the rebuilt part does not fit its own stock copy, or the record is broken) is left as it was; `plan.stale.list` reports `rebuildBlocked` with the reason and `plan.warning.list` a `plan.rebuildBlocked` warning (or `plan.broken` for a record that does not load).
- **Draft library follow** (v0.1; since v0.2 P2 part of `plan.draftFollow` on Apply). Library edits are effect commands outside `ProjectDoc`, so no hook sees them. `followLibraryChanges(dispatcher, library.lookup)` (follow.ts) dispatches `plan.libraryItem.update` with `followOnly: true` (source `system`, with `expectedRevision`) for every `libraryChanged` copy of a `draft` plan; the app host calls it for every open project on a library change event (task 3.10). `followOnly` re-checks the status inside the command: a plan that is no longer a draft is left unchanged (`{ updated: false }`). On `command.conflict` the follow re-reads the pending copies and retries, up to `FOLLOW_RETRIES` (3) rounds. A copy that fails (e.g. a new stock the part no longer fits) does not stop the others: it is listed in the result's `failed` and stays a notice; `plan.stale.list` gives the reason per copy (`blocked`, e.g. "library update of stock X can't be applied: the part doesn't fit (…)") and `plan.warning.list` a `plan.libraryBlocked` warning. Removed or unreadable items stay notices.
- **Rebuild matching.** Plan operations keep id, tool, stickout, preset, overrides and strategy. A drilling group whose holes no longer share diameter, bottom, depth and point angle splits; the split-off groups copy the settings. New design operations get new plan operations (equal new holes share one) with the first suggestion, inserted after the last operation of the same or an earlier group; then the whole order is repaired (`repairOrder`: a stable topological order by list position with `defaultOrder`'s dependency rule), so kept operations whose `on` changed move after the operations they now start from. The rebuilt part must fit the plan's own stock copy, as for `plan.libraryItem.update`: `plan.rebuild` (and `→ draft`) fail with `model.invariant` otherwise.
- **Comparison by value.** Stale flags, `hasPlanEdits` and the auto-rebuild trigger compare quantities by exact value and tolerance deviations, not `source`: retyping `8` as `8.0 mm` changes nothing. The design keeps the user's notation for display only.
- **Grouping key** of holes also includes `pointAngle` (a drill makes one point angle).
- **Default order** is a stable topological order: group, then tool (first appearance in the group), then design order, never before an `on` dependency (a drilling on a pocket floor follows the pocket).
- **Strategy storage.** `strategy` stores only the parameters the user set (sparse; omitted = default at evaluation, so defaults follow the tool). `stepover`/`stepdown` are feeds fields: they are `overrides`, not strategy parameters. Args take values as entered; `null` resets to the default; a key of another kind is `input.malformed` (rule `notForKind`).
- **Constraint checks.** `plan.operation.update` checks overrides, stickout and strategy against the current tool (`model.invariant`). Tool-dependent rules can break later (another tool); `plan.warning.list` then reports them as `plan.check` errors.
- **Feeds** (`feeds.ts`): see [Locks and auto mode](#locks-and-auto-mode) and its [implementation](#implementation-task-314) (task 3.14 replaced the 2.13 order, where every stepdown/stepover override fed the calculator). `stepover` is never suggested by the calculator in v0.1 (strategy fallback). Drilling resolves only `spindleSpeed`, `feedRate`, `plungeRate`; an end mill bores with `helix` engagement (`ap` = resolved `helixPitch`). Results carry `source` per field (`override`, `preset`, `calculator`, `strategy`) and, for the calculator, its derivation.
- **`plan.warning.list`** returns `{ code, severity, message, planOperationId?, field?, rule, params }`: `plan.check` (incl. rule `stockFit`: the part does not fit the plan's stock copy), `plan.order` and `plan.broken` with severity `error` (they fail generation), `plan.libraryBlocked` and `plan.rebuildBlocked` warnings, `plan.loosePiece` and `plan.machine` warnings, the v0.3 shape findings `plan.restMaterial` (warning) and `plan.stepoverClamped` (info, [plan-v0.3.md § Wiring](plan-v0.3.md#wiring-t1-t2)), and the calculator's and lock `feeds.*` codes (`feeds.lockInactive`, and the final-value check's, with `field`). "Inside its shape" for the loose-piece warning tests the operation's centre (facing always counts).
- **Tool suggestion** filters by the tool checks (type, size, reach, flute length) with each candidate's default stickout and preset; missing feeds do not disqualify a tool. Ties after the three ranks go by library id.
- **Seam to toolpaths (2.9/2.10).** `planOperationInputs(doc, planId, planOperationIds?)` (inputs.ts) returns per plan operation everything a generator needs (snapshot operations, part, stock, setup heights in mm, tool copy and its id, stickout, resolved feeds and strategy, machine) plus `previousPlanOperationId` (where the tool starts) and `inputHash` for the toolpath cache: chained over the machining order (position and the hash of the operation before), with the plan's part, the plan operation, the used copies and the setup; error findings fail it with `plan.check`/`plan.order`. `toGeneratorInputs` (task 2.9) maps each to the generators' plain inputs; `plan.toolpath.generate` and `plan.toolpath.get` run and serve them ([workers.md](../architecture/workers.md#toolpath-cache)).

## Plan mode UI (task 3.7)

The [v0.1 UI cut](#v01-cut) in `src/renderer/src/modes/plan/`; layout, controls and tests in [ui.md](../conventions/ui.md#plan-mode-task-37). Everything goes through the commands and queries above (the UI adds no plan logic); the native "Export gCode" save dialog is the only new window plumbing (`window.dfyom.files.chooseExport`, IPC `dfyom:file.chooseExport`). Decisions made with the UI, where this doc left room:

- **One plan at a time, per window.** The picker offers every plan, archived ones last; choosing or creating one also makes it run mode's plan (unless a run is going). `plan.create` takes the library's first machine; the machine `Select` changes it.
- **Source per field.** Each feeds field shows the resolved value of `plan.operation.list` and its `source` (entered, preset by name, calculator, strategy default). The 3.7 lock (pressed = an override, unlock = `null`) and the stickout lock were replaced by [Locks and auto mode](#locks-and-auto-mode) in task 3.14. Chip load is shown under the fields; "Show calculation" opens the calculator's derivation (`plan.operation.feeds.get`, [Feeds explanation](#feeds-explanation-v02), v0.2).
- **Tool picker** = `plan.tool.suggest` (only tools that pass the checks, ranked, with reasons) plus the current tool; assigning resets the preset (`plan.tool.assign`). "New tool…" under it adds a tool to the library (`library.tool.add`) and assigns it to the operation; "New machine…" in the machine section (and, with an empty machine library, next to "Create plan") adds a machine (`library.machine.add`) and sets it on the plan. So a fresh install can plan through the UI alone; editing or removing library items needs the library editor (later milestone, [ui.md](../conventions/ui.md#plan-mode-task-37)).
- **Stale handling:** design changes → "Rebuild plan" (`plan.rebuild`; the UI makes no plan-only edits, so `discardPlanEdits` is not offered: a plan edited by an agent shows the `input.malformed` error); changed library copies → "Update from library" per copy; blocked rebuilds and updates show their reason; rows carry "Changed in design", "Removed from design" or "Edited in plan".
- **Toolpaths are generated on request** ("Generate toolpaths", the job), not automatically; each operation shows ready, outdated, none or failed from `plan.toolpath.get`. Export regenerates missing and stale ones anyway.
- **Strategy parameters** (v0.2): the inspector's Strategy group edits `plan.operation.update { strategy }` ([ui.md](../conventions/ui.md#plan-mode-task-37)).
- **Not in the UI yet:** snapshot edits (`plan.design.operation.update`, plan-only edits) and drawing the plan's snapshot part in the scene; agents and the CLI have the command ([roadmap](../roadmap.md#v02--faces-setups-placement-tools)).
