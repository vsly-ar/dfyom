# Alignment between setups (phase 1)

Status: accepted (alignment phase 1 docs 1.1–1.5, written 2026-11-23 after the user answered [Q58–Q69](../plans/proposal-multi-setup-alignment.md#questions-for-the-user), AL1–AL4 decided 2026-11-23; accepted by the user 2026-11-24, "alignment p1 go"; hardening DF78). **Implemented (slice 1):** see [§ Implementation (slice 1)](#implementation-slice-1). **Not yet:** alignment aids and their helpers (A3–A6), viewport picking of points · Proposal: [plans/proposal-multi-setup-alignment.md](../plans/proposal-multi-setup-alignment.md) · Research: [research/2026-11-23-multi-setup-alignment.md](../research/2026-11-23-multi-setup-alignment.md) · Base: [plan-v0.2.md § Setups](plan-v0.2.md#setups-from-face-directions), [plan-v0.2.md § Setup change in Run](plan-v0.2.md#setup-change-in-run), [workholding.md](workholding.md) (draft), [z-reference.md](z-reference.md) (DF69), `run-machine.md` and [run.md § Safety](run.md#safety) on branch `machine-lane` (draft) · Terms: [glossary.md](../glossary.md)

Phase 1 of the proposal: a stock **flipped or turned** between setups of one plan is lined up with points that already exist on it. A setup names its **alignment points**; earlier setups may cut **alignment aids** for them (a V-bit witness mark, a registration hole); in Run, after the operator zeroes the setup, the spindle (off) acts as a **pointer**: DFYOM moves it at the clearance height over each point in turn, the setup's work zero first, the operator jogs Z to sight, turns and slides the stock by hand until every point lines up, ticks each one and confirms. **Nothing is measured or compensated**: no program rotation, no coordinate-system rotation (GRBL has neither; [research § Considered and rejected](../research/2026-11-23-multi-setup-alignment.md#considered-and-rejected-user-2026-11-23)). Probing (phase 2), tiling (phase 3) and split parts (phase 4) are out of this doc.

The sections under [§ Amendments](#amendments-proposed-alignment-phase-1) were proposed with this doc; since its acceptance (2026-11-24) they are **in force**: plan-v0.2.md carries them in [§ Alignment (phase 1)](plan-v0.2.md#alignment-phase-1), and the rows for run.md § Safety join its tables when `machine-lane` (where § Safety is drafted) is on `main`.

## Decisions

From the user's answers of 2026-11-23 (all recommendations taken, Q61 amended, Q65 withdrawn).

| Id   | Decision                                                                                                                                                                                                                                                                               | Source | Section                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| AL-A | Phase 1 = flipped and turned setups of one stock, two aid kinds (witness mark, registration hole), the physical pointer step; no measurement, no compensation                                                                                                                          | Q58    | this doc                                                                |
| AL-B | Aids are **plan operations without a design operation** (`source: 'aid'`), kept across rebuilds, drawn in their own colour                                                                                                                                                             | Q59    | [Alignment aids](#alignment-aids)                                       |
| AL-C | An alignment point must exist when the setup starts (cut earlier in machining order, or a stock feature) and be reachable from the setup's direction; otherwise an error finding                                                                                                       | Q60    | [Validity](#validity-already-cut-and-reachable)                         |
| AL-D | The setup's **work zero is the user's free choice** (any point; DFYOM may suggest one, never requires it); parts may lie partly or wholly in negative X/Y. The zero is the **first entry of the cycle**; "Set zero here" at it clears the ticks. Zero on an alignment point is offered | Q61    | [Setup work zero](#setup-work-zero-q61), [Run](#run-the-alignment-step) |
| AL-E | V-bit marks last in their setup, the same V-bit as the pointer in the next: a suggestion (info finding), not a forced order                                                                                                                                                            | Q62    | [V-bit sequencing](#v-bit-sequencing)                                   |
| AL-F | The operator ticks "lines up" per point; "Confirm alignment" once every entry is ticked since the last zero change; confirming with unticked entries asks once                                                                                                                         | Q63    | [Ticks and the confirm gate](#ticks-and-the-confirm-gate)               |
| AL-G | On a real machine the step's moves, ticks, zero writes and confirmation come from the UI only; agents add points and aids, read the step and run it whole on the virtual machine                                                                                                       | Q64    | [Agent API](#agent-api)                                                 |

## Frames

- **Setup frame:** as [workholding.md § Frame](workholding.md#frame): the face frame of the setup's up face, turned by the setup's rotation ([plan-v0.2.md § C3](plan-v0.2.md#implementation-task-c3), `setupFrame`); seen from above on the machine its origin is the **front-left corner of the up face**, the stock occupies `[0, L] × [0, W] × [−T, 0]`. Alignment points, aids and workholding are stored and drawn in this frame, so they never move when the zero moves.
- **WCS (G54):** the setup frame shifted by the setup's **work zero** `zero = [zx, zy]` (in the setup frame; default `[0, 0]`, today's corner): a setup-frame point `p` has the work coordinates `p − zero`. Z0 stays on the up face. Programs, the pointer targets and every number the operator sees in Run are in the WCS.

## Setup work zero (Q61)

User's answer (2026-11-23): "automatic zero may be placed whenever you like or not placed at all, but user may still select where he wants the setup's zero to be, even if this puts some of the part into negative X/Y coordinates or all of it."

- **Record:** the setup gains `zero?: { at: [x, y] } | { point: alignmentPointId }` (absent = `[0, 0]`, the front-left corner of the up face, so every existing plan and golden is unchanged). `at` is in the setup frame, any finite value: inside the stock, on a corner, on a mark, or outside the stock. `point` puts the zero on one of the setup's alignment points (its expected position; [Q61's](../plans/proposal-multi-setup-alignment.md#questions-for-the-user) "zero on this point" for an unusable stock corner).
- **No automatic placement is required.** DFYOM keeps today's default; it may suggest another zero (e.g. on an aid when the corner is cut away) as an info finding with a fix, never by itself.
- **Negative work coordinates are valid everywhere**: the plan, its checks, the export and Run accept a program that lies partly or wholly in negative X/Y. The only limit is the machine's travel at the live work zero (the soft-limit check, which works in machine coordinates). What must change for that: [§ Negative work coordinates](#negative-work-coordinates).
- **Command:** `plan.setup.update { zero }` (an arg on the existing tool; `zero: null` resets to the corner). Allowed where `plan.setup.update` is (draft and settled design); a finalized plan keeps its zero, and Run's [zero on a point](#zero-on-a-point-in-run) covers the case without a plan edit.
- **Toolpaths:** generators stay in the face frame; after the quarter turn (`turnToolpath`) the toolpath is **shifted** by `−zero` (`shiftToolpath`, positions and arc centres; arcs, Z and feeds unchanged). Absent or `[0, 0]` → no shift, byte-identical toolpaths and gCode. The setup's `inputHash` covers the field, so a changed zero regenerates.
- **Text:** the Plan inspector and the setup-change prompt name the zero: a stock corner by its part faces as today ("back left"), otherwise "X 40 Y 25 mm from the front-left corner of the top" or "on Witness mark 1".

## Alignment points

A setup's `alignment: AlignmentPoint[]` (absent = none; order = the cycle order after the zero). Each point:

| Field    | Values                                                                                                                                                                                                                                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`     | `al1`, `al2`, … per plan                                                                                                                                                                                                                                                                                                                                 |
| `name`   | default from the source: "Front-left corner", "Witness mark 1", "Hole 2 of Drilling 3"                                                                                                                                                                                                                                                                   |
| `kind`   | `point` (a vertex, a corner, a mark's tip), `hole` (a hole's centre), `edge` (a point on an edge: checks only across the edge)                                                                                                                                                                                                                           |
| `source` | `{ stock: corner }` (one of the eight stock corners by part faces, e.g. `top front left`), `{ stock: edge, t }` (one of the twelve edges, `t` ∈ [0, 1] along it), `{ operation: planOperationId, vertex \| hole \| edge, index, t? }` (geometry of an earlier operation's surface, by index in its outline or its hole list), `{ aid: planOperationId }` |

- The **expected position** is derived, never stored: the source's part-frame point, through the setup's `setupFrame` into the setup frame, then into the WCS. A design edit that moves the source moves the point.
- Picking in the setup inspector uses the existing snap ([design-v0.3.md § Measure and snap](design-v0.3.md#measure-and-snap)) restricted to valid sources: stock corners and edges, earlier operations' vertices and hole centres, aids.
- **Spacing:** points far apart show a small turn of the stock at the pointer ([research § Physical alignment](../research/2026-11-23-multi-setup-alignment.md#physical-alignment-by-pointer-the-chosen-approach)); the helpers place them as far apart as the waste allows.

### Validity: already cut and reachable

Findings in `plan.warning.list`, derived per call (`plan.alignment`, error unless noted; `params.setupId`, `params.alignmentPointId`):

| Rule              | When                                                                                                                                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notYetCut`       | The source operation or aid runs in this setup or a later one (machining order), so it does not exist when the setup starts                                                                                                                                                                                    |
| `missingSource`   | The source is gone (operation removed by a rebuild, aid removed, design edge index out of range)                                                                                                                                                                                                               |
| `notReachable`    | The point cannot be sighted from above: it is neither on the up face (Z 0 in the setup frame), nor on the stock's outline in XY (a side face: the pointer can be lowered beside the wall, e.g. an edge notch cut in an earlier setup on the edge that is now at the bottom), nor a hole through to the up face |
| `outsideTravel`   | The points and the zero do not fit the travel together (sizes only, like the stock fit: the work zero's place on the table is unknown in Plan); Run checks each move against the travel at the live zero                                                                                                       |
| `none` (info)     | A setup after the first has no alignment points: "Bottom is zeroed on the stock corner only; add alignment points to check it against what Top cut."                                                                                                                                                           |
| `markLast` (info) | [V-bit sequencing](#v-bit-sequencing)                                                                                                                                                                                                                                                                          |

Errors block the setup's export and `run.job.start` like every error finding (only the setup's own, [plan-v0.2.md § E2](plan-v0.2.md#implementation-task-e2)).

## Alignment aids

An aid is a plan operation cut only so a later setup can align: `{ id, source: 'aid', aid: AidParams, designOperationIds: [], tool?, strategy… }`. It is not part of the design, so a rebuild keeps it ([§ Amendment to plan-v0.2.md](#amendment-to-plan-v02md-proposed-alignment-phase-1)). Default names "Witness mark 1", "Registration hole 2"; drawn in their own colour (an `--aid` token, [ui.md](../conventions/ui.md)) in the scene and the operation list.

| Kind               | Parameters (defaults)                                                                                                               | Toolpath                                                                                                                                                       | Tool                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `witnessMark` spot | `at` `[u, v]` (setup frame), `markDiameter` (1 mm)                                                                                  | One plunge to `d = markDiameter / (2·tan(α/2))` (α the V-bit's included angle), then up: the [chamfer plunge](plan-v0.4.md#chamfer-toolpath) without a contour | A pointed V-bit (tip Ø 0); else error `plan.aid`, rule `pointedVBit` |
| `witnessMark` line | `from`, `to` `[u, v]` (a short line, default 6 mm, across an edge and 2 mm past it), `markDiameter` (1 mm: the groove width)        | One straight cut at depth `d`; across an edge it leaves a V notch on the side face that a flipped or turned setup sees                                         | As the spot                                                          |
| `registrationHole` | `center` `[u, v]`, `diameter` (from a dowel size: dowel + 0.2 mm, e.g. 6.2 mm for a 6 mm dowel), `spoilboardDepth` (10 mm, ≤ 15 mm) | Through the stock plus `spoilboardDepth`: today's drilling (peck) with a drill of that Ø, or a helical bore with an end mill                                   | Drill or flat end mill, resolved as any drilling's tool              |

- **Waste only:** an aid whose footprint (mark Ø, hole Ø) touches the part's removal-free volume is the warning `plan.aid`, rule `inPart` ("Registration hole 2 cuts the part"); a line across an edge the design chamfers anyway is allowed.
- **Into the supporting material** (proposal A6): a registration hole needs a sacrificial `base` in its setup ([workholding.md](workholding.md#model)): a fixture plate → the existing error `plan.workholding.breakthrough`; no base item → warning `plan.aid`, rule `noBase` ("Add a spoilboard to Top: the hole goes 10 mm into the table"). Until workholding (v0.4 follow-up W1) is merged, `noBase` is the only check.
- **Placement helpers** (UI and agents, proposal A4): "Add marks for the next setup" places two line marks across the edges the two setups share, in the waste, as far apart as possible; "Add registration holes" places two holes on the flip axis, or mirrored about it, in the waste (three or an asymmetric pair make a wrong flip impossible). Each also adds the matching alignment points to the next setup.
- **Order:** an aid runs in a setup **before** every setup whose points reference it (else `notYetCut` on the point). Inside its setup the default order puts registration holes right after facing (before the part is cut free) and witness marks last ([V-bit sequencing](#v-bit-sequencing)).

## V-bit sequencing

When a setup cuts witness marks for a later setup, the V-bit should be its **last tool**: the next setup's alignment step then uses the V-bit still in the spindle as the pointer, and the first tool change of the next program happens anyway, so marks cost no extra tool change.

- Info `plan.alignment`, rule `markLast` on the setup when it has witness marks referenced by a later setup and its last tool is not their V-bit: "Cut the witness marks last in Top: the V-bit stays in for Bottom's alignment (one tool change less)." with the fix "Move to end" (`plan.operation.move`).
- Not a forced order (Q62): a chamfer with the same V-bit may come last instead, which is equally good; the rule checks the last **tool**, not the last operation.
- The plan summary shows the tool-change count per setup, so the saving is visible.

## Run: the alignment step

Part of the setup-change prompt ([plan-v0.2.md § Setup change in Run](plan-v0.2.md#setup-change-in-run); on `machine-lane` the prompt also has M7's "Zero to set" row and Probe Z; [amendment](#amendment-to-the-setup-change-prompt-proposed-alignment-phase-1)), after the work zero is set, for a setup with alignment points. A setup without points has no step (today's prompt).

### The cycle

1. The operator turns and clamps the stock and sets the work zero as today (jog to the zero, "Zero X Y"; Z on the top, by hand or Probe Z).
2. **Start alignment** (confirmed once per step, [§ Safety](#amendment-to-runmd--safety-proposed-alignment-phase-1)) moves the pointer to the **first entry, the work zero** (WCS 0, 0).
3. **Previous / Next** move to the neighbouring entry, wrapping (zero → point 1 → … → point n → zero). Each move: Z up to the setup's clearance height (`$J=G21 G53 Z<min(G54.z + clearance, −0.5)>`), then XY (`$J=G21 G90 X<x> Y<y>`, WCS): **jog moves**, so the existing jog cancel and Stop end them, and the host refuses one outside the travel in words (`run.travel`, [run.md DF33](run.md#machine-coordinates-and-the-homing-corner-df33)) before sending it. Feeds: the jog feeds (2000 mm/min XY, 500 Z, capped by the machine's max rates).
4. At an entry the operator may jog Z down to sight the tip against the mark, hole or edge (the jog pad; Z only is expected, an XY jog un-ticks nothing but leaves the entry, [below](#ticks-and-the-confirm-gate)), nudges the stock, and ticks **"Lines up"**.
5. If nudging moved the stock off the zero, the operator returns to the zero and presses **"Set zero here"** (`run.workZero.set { axes: ['x', 'y'] }`, `G10 L20 P1 X0 Y0`): every pointer position follows the zero, so this **clears every tick** and the cycle starts again.
6. **Confirm alignment** ends the step; "Start setup n" is enabled after it.

- **Spindle off:** every move is refused while the status reports a spindle speed (`run.state`, rule `spindleOn`, as Probe Z on `machine-lane`); a hand-switched router is the operator's: the step's confirmation says so.
- **Allowed** in Idle, between run jobs (the setup change), on a homed machine; never while a run job runs or waits.
- **The setup picture** shows the points and the zero on the stock and highlights the current entry; the list beside it names each entry with its WCS X/Y, the tick and the current one.

### Zero on a point (in Run)

On any entry the operator may choose **"Zero on this point"**: `run.workZero.set { axes: ['x', 'y'], values: [x, y, …] }` with the entry's expected WCS coordinates (`G10 L20 P1`), for a stock corner that is sawn, chamfered or cut away. That entry then counts as the zero for the ticks (a zero change clears them as in step 5). It writes the same G54 as moving the plan's zero to that point would ([Setup work zero](#setup-work-zero-q61)), without editing a finalized plan.

### Ticks and the confirm gate

- A tick belongs to an entry and records the G54 XY at the time; **any change of G54 X or Y clears all ticks** and the confirmation (also a change from another window or by an agent). A position alarm, a reset that loses the position, a closed connection, or choosing another plan or setup drops the step.
- **Ticking needs the pointer at the entry:** the current WPos XY within 0.01 mm of the entry's target; else `run.state`, rule `notAtPoint` ("Go to Witness mark 1 first").
- **Confirm alignment** is enabled when every entry, the zero included, is ticked since the last zero change. With unticked entries the UI asks once: "2 of 4 points not checked. Continue anyway?" (Continue / Cancel), and the confirmation records them as skipped.
- **Gate:** `run.job.start` of a setup that has alignment points refuses until its step is confirmed at the current G54 (`run.state`, rule `alignmentPending`, `data: { setupId, unticked }`), on every connection (the same flow on the virtual machine).

### State

`RunStatus.alignment?` (main's run service; the host knows only jogs and `G10`): `{ planId, setupId, entries: [{ id: 'zero' | alignmentPointId, name, target: [x, y], ticked }], current?, confirmed: boolean, skipped: string[], zeroAt: [x, y] }` (`zeroAt` is G54 XY in machine coordinates when the ticks were taken). Every window and agent reads it with `run.status.get`.

## Commands

| Command              | Kind   | Args → result                                                                                                                                                                                                                                                 | Machine |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `plan.alignment.set` | doc    | `{ planId, setupId, points: AlignmentPointInput[] }` (the setup's whole list, in cycle order; ids kept by `id`, new ones get one) → `{ alignmentPointIds }`                                                                                                   | no      |
| `plan.aid.set`       | doc    | `{ planId, setupId?, planOperationId?, aid?, forSetupId? }`: without `planOperationId` adds an aid to `setupId` (and, with `forSetupId`, its alignment point to that setup); with it and `aid` updates; with it and no `aid` removes → `{ planOperationId? }` | no      |
| `plan.setup.update`  | doc    | existing, plus `zero?: { at } \| { point } \| null`                                                                                                                                                                                                           | no      |
| `run.align.goto`     | effect | `{ planId, setupId, to: 'zero' \| alignmentPointId \| 'next' \| 'previous' }` → `{ current, target }`; starts the step when none runs for that setup                                                                                                          | yes     |
| `run.align.tick`     | effect | `{ entry?: 'zero' \| alignmentPointId, ticked?: boolean, confirm?: true, skipUnticked?: true }` → the step state                                                                                                                                              | yes     |
| `run.workZero.set`   | effect | existing; "Set zero here" and "Zero on this point" use it; clears the ticks                                                                                                                                                                                   | yes     |

- Aid tools, strategies and feeds use the existing `plan.tool.assign`, `plan.operation.update` and `plan.operation.move`.
- Doc commands are undoable like every plan edit; `run.align.*` are not document commands.
- Errors: `plan.alignment` and `plan.aid` (new codes in the [registry](../conventions/error-handling/app-error.md#error-code-registry)) for refused edits (`notYetCut` on an add is allowed and reported as a finding, not refused); `run.state` rules `spindleOn`, `notAtPoint`, `alignmentPending`, `noAlignment` (a setup without points); `run.travel`.

## Agent API

`tools/list` cost (proposal 1.5; logged in [llm-api.md § Amendment (alignment phase 1)](../architecture/llm-api.md#amendment-alignment-phase-1-proposed)):

| Tool                               | Estimate | Why this shape                                                                                        |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `plan.alignment.set`               | ≈ 1.0 K  | One tool for the list (no add/update/remove trio); the source union shared in `$defs`                 |
| `plan.aid.set`                     | ≈ 1.1 K  | Folded add/update/remove ([llm-api.md](../architecture/llm-api.md#implementation-task-310), Q32 rule) |
| `plan.setup.update { zero }`       | ≈ 0.2 K  | An arg on an existing tool                                                                            |
| `run.align.goto`, `run.align.tick` | ≈ 0.6 K  | Two tools so the permission policy decides per command, not per arg                                   |
| **Total**                          | ≈ 2.9 K  | Target ≤ 3 K; measured when built (proposal A8)                                                       |

- **Results:** `plan.alignment.set` and `plan.aid.set` return the ids and, like other plan edits, the delta of findings ([A1](../architecture/llm-api.md#a1-compact-results)), so an agent sees `notYetCut` or `notReachable` at once. `plan.get` (summary) lists each setup's points with their expected WCS X/Y and its zero.
- **Q64, real machine:** `run.align.goto`, `run.align.tick` and `run.workZero.set` are `machine: true` and **UI only** on a real connection (sightings and confirmation are the operator's: an agent cannot see the stock). Agents read the step through `run.status.get` and `job.wait` at the setup change ([A2](../architecture/llm-api.md#a2-jobwait-at-operator-waits)). On the **virtual machine** every source runs the whole step (goto, tick, zero, confirm); the emulator knows nothing of marks, so a tick there only asserts the pointer's position.
- The primer gains one line: points and aids, the WCS = setup frame minus the zero, negative X/Y valid.

## Export

The setup header ([grbl.md § Setup header (DF58)](../architecture/grbl.md#setup-header-hardening-df58)) names the zero and lists the points, so an operator with any sender can set the zero and check the points by hand (jog to each X/Y and sight). Without a moved zero and without points the header is unchanged (goldens byte-identical).

```text
(Corner: back-left corner of the bottom face)
(That corner sits front left on the machine)
(Work zero G54 X0 Y0: X 40 Y 25 mm from that corner)
(Work zero on Witness mark 1)
(Align 2 points after zeroing, spindle off:)
(Align 1: Front-left corner at X -40 Y -25)
(Align 2: Hole 1 of Drilling 3 at X 60 Y 25)
(Z0 on the bottom face: the stock surface facing up)
```

- **Zero:** with a zero other than `[0, 0]` the corner line becomes `Corner: …` and a third line gives the zero's offset from that corner along machine X and Y in program units (signed: a zero left of or in front of the corner is negative); `Work zero on <name>` only for `{ point }`.
- **Points:** one line per point in cycle order, its WCS X/Y in program units, the name cut to fit 70 bytes (`commentLine`).
- `plan.export` refuses a setup with an error finding of its own as today, so a point with `notYetCut`, `missingSource` or `notReachable` blocks the export.

## Negative work coordinates

**Rule (Q61):** a setup's work zero may be anywhere; a program partly or wholly in negative X/Y (or beyond the stock) is valid. Plan checks judge sizes only; the only position limit is the travel at the live work zero, checked in machine coordinates (`[−travel, 0]`, [run.md DF33](run.md#machine-coordinates-and-the-homing-corner-df33)) by the export's `softLimit` rule and `run.job.start` / `run.job.check`.

**Audit of `main` (2026-11-23, read-only).** Nothing refuses negative work coordinates today, because nothing can produce them from a plan: the work zero is fixed at the front-left corner of the up face, so programs lie in `[0, L] × [0, W]` by construction. Accepting the rule means making the zero movable and fixing the places that assume it sits on that corner.

Already sign-agnostic (no change):

| Where                                                                                                             | Why it holds                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/core/plan/checks.ts:301-321` `stockFindings`                                                                 | Stock + clearance against the travel by size only                                                                  |
| `src/core/post/export.ts:396-450` `machineChecks` (`travel`, `softLimit`)                                         | `travel` compares the span `hi − lo`; `softLimit` adds G54 and compares in machine coordinates with `[−travel, 0]` |
| `src/core/post/grbl/format.ts:29`                                                                                 | Negative numbers formatted (`-0` normalised)                                                                       |
| `src/core/run/job.ts:202-229`, `:295-302` (`run.job.check`)                                                       | The start's soft-limit check uses the export check at the live G54                                                 |
| `src/core/run/host/host.ts:362-372` (`setWorkZero`), `protocol.ts:14-15` (`Num`)                                  | `G10 L20 P1` with any finite values                                                                                |
| `src/core/run/grbl/emulator/gcode.ts:243-262`, `src/core/run/grbl/envelope.ts`                                    | `G10 L2/L20` and the travel in machine coordinates, sign-free in work coordinates                                  |
| Run scene travel box (`[−travel, 0] − G54`, [run.md DF33](run.md#machine-coordinates-and-the-homing-corner-df33)) | Placed through the work zero                                                                                       |

Assumes the zero at the corner (tasks; none is a refusal, each gives a wrong place or wrong words once the zero moves):

| #   | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Assumption                                                                                                         | Change                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| N1  | `src/core/plan/plan.dto.ts:157-171` (`SetupDtoSchema`), `src/core/plan/setups.ts:45`, `src/core/plan/inputs.ts:42-44,114`                                                                                                                                                                                                                                                                                                                                                                                           | No zero field: `workOffset: 'G54'` only                                                                            | Optional `zero` ([Setup work zero](#setup-work-zero-q61)); `plan.setup.update { zero }`; no `schemaVersion` change            |
| N2  | `src/core/toolpath/wcs.ts:26-47` (`SetupWcs`, `setupWcs`), `:98-104` (`turnToolpath`), `:111-126` (`setupFrame`), `src/core/toolpath/request.ts:55-66`                                                                                                                                                                                                                                                                                                                                                              | The WCS is the (turned) face frame; `setupFrame`'s origin is the face corner                                       | `SetupWcs` gains the shift; `shiftToolpath` after the turn; `setupFrame` origin + zero (so Plan preview and Run scene follow) |
| N3  | `src/core/toolpath/wcs.ts:128-133` (`setupOrientation` doc: "always the front-left corner")                                                                                                                                                                                                                                                                                                                                                                                                                         | Wording and the prompt's model                                                                                     | Carry the zero in the orientation for the prompt                                                                              |
| N4  | `src/core/toolpath/inputs.ts:89-95`, `:354-358`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Drilling order starts at WCS `[0, 0]` mapped from the face frame                                                   | Start from the setup's zero (cosmetic: shortest first rapid)                                                                  |
| N5  | `src/core/run/commands.ts:31-56` (`prepareWorkZero`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Centres the stock assuming it spans `[0, size]` from G54                                                           | Subtract the first setup's zero, so `prepare: true` still centres the stock                                                   |
| N6  | `src/renderer/src/modes/plan/model.ts:157-171` (`setupCorner`), `messages/plan.ts:118-121,132`, `SetupInspector.tsx:99-100`                                                                                                                                                                                                                                                                                                                                                                                         | Names the corner by testing the origin against 0; "the work zero moves to the new front-left corner"               | Name a corner only when the zero is one; else "X … Y … from the front-left corner" or the point's name                        |
| N7  | `src/renderer/src/modes/run/SetupChangeDialog.tsx:3,115,118-132,147,186`, `messages/run.ts:202-203,209`                                                                                                                                                                                                                                                                                                                                                                                                             | The picture draws the stock from the zero and the ring at its corner; the text says "front-left corner of the top" | Draw the stock at `−zero`, the ring at the zero; texts from the zero                                                          |
| N8  | `src/core/agent/primer.ts:11`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | "Each setup's work zero (G54) is its face frame origin"                                                            | WCS = setup frame minus the zero; negative X/Y valid                                                                          |
| N9  | `machine-lane`: `src/core/run/job.ts:67-71,99` (`next.corner`, `setupZeroCorner`), `src/renderer/src/messages/run.ts:378-390` (`zeroText`, `zeroCorner`)                                                                                                                                                                                                                                                                                                                                                            | The zero to set is a part corner                                                                                   | `next.zero` (corner, or offset from it, or the point); "Zero to set" from it                                                  |
| N10 | Docs: [plan-v0.1.md § Setup](plan-v0.1.md#setup-orientation-work-zero-safe-heights), [plan-v0.2.md § Setups](plan-v0.2.md#setups-from-face-directions) ("Work zero", "Orientation"), [§ F6](plan-v0.2.md#implementation-task-f6) ("WCS corner as text"), [§ E2](plan-v0.2.md#implementation-task-e2) (prompt steps, `prepare`), [run-v0.1.md decision 7](run-v0.1.md#decisions), [workholding.md § Frame](workholding.md#frame) ("also the program's work coordinate system"), `run-machine.md` M7 (`machine-lane`) | The zero is the corner; the setup frame is the WCS                                                                 | Folded in with [§ Amendments](#amendments-proposed-alignment-phase-1) on acceptance                                           |

Tests with the change: a top and a bottom setup with the zero at the stock centre and at a point outside the stock (`[−20, −20]` and `[L + 10, W / 2]`): toolpaths equal the corner-zero ones shifted; gCode with negative X/Y streams through the virtual machine without `error:`; the soft-limit check passes or fails exactly by machine coordinates; `prepare: true` centres the stock; the prompt and inspector texts; goldens unchanged without `zero`.

## Amendments (proposed, alignment phase 1)

Proposed with this doc and in force since its acceptance (2026-11-24): the plan-v0.2.md and setup-change prompt changes are summarised in [plan-v0.2.md § Alignment (phase 1)](plan-v0.2.md#alignment-phase-1) with the details kept here; the run.md § Safety rows join its tables when `machine-lane` (where § Safety is drafted) is on `main`. The headings keep their names so links from the proposal stay valid.

### Amendment to plan-v0.2.md (proposed, alignment phase 1)

Task 1.2. Summarised in [plan-v0.2.md § Alignment (phase 1)](plan-v0.2.md#alignment-phase-1).

- **Plan operations without a design operation:** `source?: 'aid'` and `aid: AidParams` on the plan operation record; `designOperationIds` may be empty only then (today `min(1)`, `plan.dto.ts:119-122`). Aids get a tool like a drilling (`toolSource: 'plan'` once assigned) and are never regrouped by direction.
- **Rebuild keeps aids** (an exception to [decision 6](plan-v0.2.md#decisions): aids are not plan-only edits of design operations). A rebuild that removes a setup's last design operation removes the setup with its aids; the confirmation names them ("Rebuild removes Witness mark 1 and 2 with the empty setup Top 2"), and points that referenced them get `missingSource`.
- **Setup record** gains `alignment?: AlignmentPoint[]` and `zero?` ([Setup work zero](#setup-work-zero-q61)); split keeps both on the source setup; merge concatenates the points and keeps the first setup's zero; a rebuild keeps them.
- **Order checks across setups** add: an aid runs before every setup whose points reference it (`plan.alignment`, rule `notYetCut`, on the point; `plan.setup.move` and `plan.operation.move` refuse a move that adds one, as they refuse `plan.order` today). Default order within a setup: registration holes after facing, witness marks last.
- **Work zero** ([§ Setups](plan-v0.2.md#setups-from-face-directions)): "`G54` at the face frame origin" becomes "at the setup's zero, by default the face frame origin".

### Amendment to the setup-change prompt (proposed, alignment phase 1)

Task 1.3. Amends [plan-v0.2.md § Setup change in Run](plan-v0.2.md#setup-change-in-run) and, on `machine-lane`, `run-machine.md` § Run status and the zero to set (M7).

- The prompt's steps become: raise, turn and clamp; set X/Y at the **zero** (the corner, or the point the setup names) and Z on the top; **align** (only with alignment points: [§ The cycle](#the-cycle)); start. "Start setup n" is enabled only after "Confirm alignment" for a setup with points.
- M7's "Zero to set" row names the zero as in [Setup work zero](#setup-work-zero-q61); `run.job.start`'s `next` gains `zero` and `alignment` (the count of points) for agents.
- Whether the step lives in the prompt or in its own Run panel the prompt opens is an [open question](#open-questions) for the UI review.

### Amendment to run.md § Safety (proposed, alignment phase 1)

Task 1.4. `run.md` § Safety is drafted on `machine-lane` (hardening 1.1); on `main` it is still a stub. These rows join its tables when both are accepted.

- **§ 2 Who may command a real connection:** `run.align.goto` and `run.align.tick` join the row "Motion and machine state" (UI yes; agents, CLI, automation **no**, `permission.denied`). Reading the step (`run.status.get`) stays open to every source.
- **§ 3 Confirmations before motion:** a new row, every connection: **Start alignment** – "Move the spindle over the alignment points? It moves at the clearance height each time you press Previous or Next. Keep your hands clear while it moves; the spindle must be off." Confirm "Start alignment". Once per step; later Previous/Next are clicks like jogs (cancellable, refused outside the travel, never from a single key).
- **§ 4 Before a real run streams:** a setup with alignment points needs its step confirmed at the current G54 (`alignmentPending`).
- Stop, jog cancel and Reset stay unconditional; a pointer move is a jog, so all three end it.

## Implementation (slice 1)

Hardening DF78 "Alignment phase 1" (2026-11-24). Built: the setup work zero anywhere (A11, audit N1–N8; N9 with the machine lane, N10 the doc edits), alignment points (A1), their findings (A2 without `markLast`, which needs aids), the export header, `plan.alignment.set` and `plan.setup.update { zero }` (A8, plan side), the setup inspector's zero and point list (A9 without viewport picking) and the points and zero in the plan viewport. Code: `src/core/plan/alignment.ts` (model, positions, findings, texts), `alignment.dto.ts` (records), `src/core/toolpath/wcs.ts` (the shift), `src/core/run/alignment.ts` (the Run step's pure core), `src/core/run/align-commands.ts` (`run.align.goto`, `run.align.tick`). The Run step (A7, A10) was built on `main` after the machine lane (M1–M8) landed: see S8–S11.

Decisions made while building (S1–S7):

- **S1 – Sources in the record.** `{ corner: 'top front left' }` (the eight stock corners by part faces, words in the order top/bottom, front/back, left/right), `{ edge: 'top front', t? }` (the twelve stock edges by their two faces, `t` from the edge's lower end along its part axis, default 0.5), `{ operation, hole }` (the n-th hole centre of a plan operation: drillings, chamfers, circle pockets and inside circle profiles), `{ operation, vertex }` (the n-th outline end point of a pocket or profile, in outline order). Operation edges (`{ operation, edge }`) and `{ aid }` come with aids. `kind` is derived from the source, not stored; `name` is stored only when the user names a point.
- **S2 – Positions.** A corner, edge point or vertex is the source's part-frame point; a hole is its centre at the mouth. Reachable (`notReachable` otherwise): Z 0 in the setup frame (the up face), or on the stock outline in X/Y (every stock corner and edge is), or a hole whose axis is the setup's Z and that goes through the stock (seen from the other side); a hole seen through is placed on the up face.
- **S3 – Moving the zero keeps touch-off spots in place.** `zRef.at` is in the WCS (DF69), so `plan.setup.update { zero }` shifts the setup's stored spots by the change; the spot stays on the same place of the stock.
- **S4 – Zero on a point.** `{ point }` follows the point's expected position. `plan.alignment.set` refuses to drop the point the zero is on (`plan.alignment`, rule `zeroPoint`): move the zero first. A source that went missing leaves the zero at the corner with the point's `missingSource` error, which blocks the export.
- **S5 – Toolpath cache.** A plan operation's input hash covers its setup with the resolved zero and without the points, so adding or renaming a point never makes toolpaths stale and moving the zero always does.
- **S6 – `outsideTravel`.** The X/Y span of the zero and the points (WCS) against the travel, like the stock fit (sizes only); a warning, not an error (the doc's table says error, but the machine's travel at the live zero is checked again in Run, and a stock fit is a warning too).
- **S7 – `none`** is reported only for a setup after the first whose direction or rotation differs from the first setup's (a second setup in the same orientation, e.g. a split, needs no alignment).
- **S8 – Sources for the inspector.** `plan.warning.list` returns `alignmentSources` per setup (the stock corners and edges, and the holes and vertices of operations before the setup that are cut and reachable; at most 64), so the inspector's "Add point" menu needs no new tool; the agent shape drops it (agents name sources directly).
- **S9 – Step state on the machine port.** `MachineService.alignmentStep()` / `setAlignmentStep()` (`MachineClient`); every host status reconciles it (`reconcileStep`: a G54 X/Y change of more than 0.0001 mm clears the ticks, the confirmation and the skips; Alarm, not homed or a closed connection drops it) and `RunStatus.alignment` carries it. A `run.align.goto` for another plan or setup starts a new step.
- **S10 – Moves.** `run.align.goto` sends the pointer's moves as `run.machine.jog`'s jog action (`to` in machine coordinates): Z first to `min(G54.z − zeroLevel + clearance, −0.5)` when lower (the clearance above the surface G54 Z is on, DF69's `zeroLevel`; the clearance the program uses, which follows the workholding, workholding.md), then X/Y; feeds 500 / 2000 mm/min. It refuses with a running job (`run.busy`), when not Idle and homed or with the spindle on (`run.state`, rule `spindleOn`), for a setup without points (`noAlignment`), and the host refuses a move outside the travel (`run.travel`).
- **S11 – Gate.** `run.job.start` checks `alignmentGate` after its checks (not `run.job.check`, so the pre-flight shows the travel findings while the step is open); the prompt disables "Start setup n" with "Confirm the alignment first." until `RunStatus.alignment` is confirmed for that setup.
- **S12 – Workholding (DF59, merged after).** Items, keep-outs and the check stay in the setup frame; the move check adds a moved zero back to the toolpath before comparing (`checkOperations(pairs, zero)`, shared by `plan.warning.list` and the export guard). Every user-facing workholding coordinate is in the WCS, what the operator reads on the machine: `unmachined`'s bounds and the `collision` / `close` / `breakthrough` findings' `x`, `y` (params and the "near X… Y…" message: the check's point less the zero, `moveFindings(…, zero)`; test `user-case.test.ts`, a moved zero gives the same hits 40, 25 mm over). The plan viewport shifts the items and the keep-out halo into the WCS like the toolpaths; the collision markers come in the WCS already. The facing and pocket keep-out undoes only the setup's turn on the footprints (they are in the setup frame), never the zero (fixed with S12's frame pass, 2026-11-24: the zones sat the zero away from the items). The program header carries both the workholding lines and the zero and Align lines; the workholding lines name item positions in the setup frame (from the stock corner, as the items are entered), not the WCS.

Not built in this slice: aids (A3–A6) and `plan.aid.set`, `markLast`, picking points in the viewport (the inspector adds them from a menu of valid sources), the setup picture's point markers in the prompt (the entry list names them with their WCS X/Y).

## Testing

- **Core:** expected positions for every direction and rotation and a moved zero; `notYetCut`, `missingSource`, `notReachable` (a mark on the old top seen from a flipped setup: not reachable on the face, reachable on the outline), `outsideTravel`, `markLast`; aids kept across a rebuild; the aid toolpaths (spot depth from the included angle, line, hole into the spoilboard) and their goldens.
- **Run (in-process host, virtual machine):** the cycle's moves land at each target in machine coordinates, also after a re-zero at a shifted position; ticks cleared by a G54 change from another source; `notAtPoint`, `spindleOn`, `alignmentPending`; permission per source on a loopback serial connection (`machine-lane`).
- **UI:** component tests of the step in the prompt; the hidden e2e of the phase 1 exit ([proposal](../plans/proposal-multi-setup-alignment.md#exit-criteria-per-phase)).

## Decided by the user (2026-11-23, "AL ok")

- **AL1:** "not placed at all" means DFYOM need not suggest a zero; the default stays the up face's front-left corner.
- **AL2:** Z0 stays on the up face; only X/Y are free (Q61). Amended for the **export only** by [z-reference.md](z-reference.md#program-frame-recommendation-per-tool-z0-at-export) (DF69, Q82): a later tool run's program Z0 moves to its reference surface; the setup frame, its work zero, the alignment step and the first tool's Z0 stay on the up face. A touch-off spot (`zRef.at`) is in the WCS like every number in Run, so it follows the X/Y zero ([§ Implementation (slice 1)](#implementation-slice-1), decision S3).
- **AL3:** the `alignmentPending` gate applies on every connection, the virtual machine included.
- **AL4:** pointer moves are sent as `$J=` jogs, so jog cancel and Stop end them and a move outside the travel is refused with a message.

## Open questions

- **Edge points on side setups:** a notch across the edge between the top and the front is reachable from both; is a mark on a face that is vertical in the new setup ever usable other than by its edge (the outline rule says only on the outline)?
- **One dialog or a panel:** does the step belong in the setup-change prompt or in its own Run panel the prompt opens? (UI review.)
- **Flip axis of registration holes:** holes for a flip need the flip axis fixed in the machine frame (dowels in the spoilboard); how is the axis shown and checked when the zero corner moves to the other side after the flip?
