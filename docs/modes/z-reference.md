# Z reference surface per tool change

Status: accepted (proposed 2026-11-24 for hardening [DF69](../plans/hardening.md); the user answered [Q81–Q92](#open-questions-for-the-user) on 2026-11-24 ("Q81-92 ok") and took every recommendation). **Implemented:** the references, spots and findings (`src/core/plan/z-reference.ts`, `src/core/geometry/flat-patch.ts`), `plan.operation.update { zRef }`, the export (header, rapid to the spot, the two lines, per-run Z shift, `src/core/post/grbl/post.ts`), `plan_get` `toolRuns[].zRef`, the machine field, Run's tool-change dialog text, the setup inspector's "Z from" column with its picker, the plan viewport's highlight of the reference surface with its draggable touch-off spot, and the operation inspector's "Z from" field with the spot's X and Y; with the machine lane merged (M4 Probe Z), Run's "Move to touch-off spot", Probe Z on the surface, the run scene's `s` correction with the surface and spot shown at the wait, and the virtual plate on the surface (Z3, [notes](#implementation-notes-df69)). **Not yet:** choosing a surface by picking it in the viewport. [§ Implementation notes](#implementation-notes-df69) lists where the code differs from the text below · Source: the user's real cut, TG #246 · Base: [grbl.md § Output dialect](../architecture/grbl.md#output-dialect) (tool change, first tool, after the `M0`), [grbl.md § Setup header (DF58)](../architecture/grbl.md#setup-header-hardening-df58), [run-v0.1.md § Work zero](run-v0.1.md#work-zero-and-the-soft-limit-check), [plan-v0.2.md § Setups](plan-v0.2.md#setups-from-face-directions), [plan-v0.2.md § Material left for later cuts (DF61)](plan-v0.2.md#material-left-for-later-cuts-df61), [run-machine.md § Probing and re-zero (M4)](run-machine.md#probing-and-re-zero-m4) · Related drafts: [alignment.md](alignment.md) (AL2), [proposal-multi-setup-alignment.md](../plans/proposal-multi-setup-alignment.md) (Q61), [workholding.md](workholding.md) · Terms: [glossary.md](../glossary.md)

## Problem

The user's words (2026-11-24, after a real cut): "it should be possible in the plan mode to set a new Z0 at any surface that was already "cut" (previously in the plan). Why: if using a vacuum table or other type of workholding that doesn't use any top surface and the top surface was faced (or otherwise cut), it makes it almost impossible to precisely re-zero Z after a tool change in the setup."

What happens today:

- A setup's program has **one Z0: the up face** (the stock top in the setup frame; [grbl.md § Setup header](../architecture/grbl.md#setup-header-hardening-df58), AL2).
- At every tool change the operator **re-zeroes Z** for the new tool's length: DFYOM's sender guides "zero Z with `G10 L20 P1 Z0`" ([grbl.md](../architecture/grbl.md#output-dialect), tool change in DFYOM), the tool-change dialog offers "Set Z zero here" and "Probe Z" with the touch plate (contact = Z plate thickness, M4). Other senders pause at the `M0` and leave it to the operator.
- All of these assume the **stock top is still there** under the tool. After a facing (the first operation of most setups on rough stock) it is not, and with a vacuum table or tape, which hold the bottom face, no uncut piece of the top is left anywhere (with clamps an operator can at least keep a corner under a clamp uncut): the faced floor is 0.5 mm lower, a pocket floor 7.19 mm lower. Zeroing on them as "Z0" cuts that much too deep; doing it right means working out the offset by hand and typing it into the sender (after a probe, from the probe's retract height). That is the "almost impossible" of the report.

## Proposal in brief

1. Every **tool run** of a setup (the setup's first tool and every tool change) has a **Z reference surface**: a flat, upward-facing surface that exists when that tool starts, chosen in Plan mode, by default by a [rule](#default-rule).
2. Each Z reference has a **touch-off spot** (X, Y) on that surface where the plan guarantees a flat, reachable patch big enough for the tool or the touch plate.
3. **Plan, toolpaths, simulation and the UI stay in the setup frame** (Z0 on the up face, AL2). The **exported program** writes each tool run's Z relative to its reference surface, so the operator always does the same thing in any sender: **put Z0 on the named surface at the named spot** ("Zero Z" or the sender's touch-plate probe). Recommendation, [§ Program frame](#program-frame-recommendation-per-tool-z0-at-export).
4. The gCode tells the operator where (comment lines before the tool-change marker, the move to the spot at the clearance height before the `M0`); DFYOM Run moves there, probes, and draws the surface and the spot.
5. Findings check that the surface exists, is flat at the spot and is not cut away before the tool that uses it.

## Terms

| Term                | Meaning                                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool run            | The consecutive operations of a setup cut with one tool; a setup's first tool run starts with the setup, every later one with a tool change ([grbl.md](../architecture/grbl.md#output-dialect), tools numbered by first use). |
| Z reference surface | The surface the operator touches off Z on for a tool run; a [surface id](../glossary.md) (`stock.top`, `facing1.floor`, `pocket2.floor`, `profile3.floor` for a step).                                                        |
| Touch-off spot      | The X, Y (setup frame) on the Z reference surface where the operator touches off.                                                                                                                                             |
| Reference level `s` | The surface's Z in the setup frame (0 for the up face, −0.5 for a 0.5 mm facing); always ≤ 0.                                                                                                                                 |
| Flat patch          | The part of the surface that is still at its level when the tool run starts: its region minus everything cut lower over it before then.                                                                                       |

## Z reference per tool run

### Eligible surfaces

A surface may be a tool run's Z reference when, **at the start of that tool run** (machining order: earlier setups, then earlier tool runs of this setup):

- it faces **up in this setup** (normal = the setup's up direction): the setup's up face, or the floor of a facing, pocket or blind profile (step, groove) of the setup's direction;
- it **exists**: the up face always (until cut over the spot); a floor only once its operation has run (in an earlier tool run of this setup, or in an earlier setup of the same direction, [plan-v0.2.md § Merge, split, reorder](plan-v0.2.md#merge-split-reorder));
- it is **flat**: cut by a tool with a flat bottom (flat end mill, facing / surfacing bit; not ball, V, chamfer or drill), and not a fillet or tab top;
- it has a **flat patch** large enough for a [touch-off spot](#touch-off-spot).

Not eligible: side faces, chamfers, hole bottoms, surfaces of later tool runs, the spoilboard / table top (Q88), and in-air levels.

The **reference level** `s` is the surface's level in the setup frame from the surface table ([design-v0.2.md § Surface table per direction](design-v0.2.md#surface-table-per-direction)): the floor depth below its `on` level, chained. Floors are cut exactly to their depth (the generators' rule "the deepest cut exactly at the target depth", [plan-v0.1.md § Toolpath generators](plan-v0.1.md#toolpath-generators-task-210); allowances are on walls only), so the plan level is the cut level. Nominal values; tolerances do not move it.

The flat patch reuses the 2D coverage model of the material bands ([plan-v0.2.md § Material left for later cuts](plan-v0.2.md#material-left-for-later-cuts-df61)): the surface's region (the whole face for a facing or the up face, the pocket region, the step's slot clipped to the stock) minus the regions of every operation **before this tool run** that cut below the surface's level over it (pockets, steps and grooves on it, holes and through profiles through it, openings of earlier setups), clipped to the stock face. No in-process stock model is needed.

### Default rule

Absent a choice, each tool run's Z reference is, in order:

1. **The up face (`stock.top` of the setup)** while it has a flat patch for a spot: it is Z0 already, so nothing changes for the operator and every plan without a facing exports as today (byte-identical gCode, [§ Exported gCode](#exported-gcode)).
2. Else **the floor of the most recent facing** of the setup's direction before this tool run (the faced top), when it has a flat patch. A region facing's floor ([DF145](design.md#facing-region-hardening-df145)) does not count here; it can still win rule 3 or be chosen.
3. Else **the largest flat patch** among the eligible floors, as a **warning** (`zRef.chosen`: "Tool 3 touches off on Pocket 1 floor; check it"), so the operator's attention goes to a choice DFYOM made on an unusual surface.
4. No eligible surface (everything cut away or not flat): **error** `zRef.none`, the setup's export and `run.job.start` are blocked until the user chooses (Q84).

The setup's **first** tool run gets the up face by rule 1 in every normal plan (nothing has cut it yet in this setup; a through opening of an earlier setup leaves the rest of the face). The default is derived on every read, never stored, so a design edit or a reorder updates it; a **chosen** reference is stored and checked (Q83).

## Touch-off spot

- **Where:** inside the flat patch, at least the **clearance radius** from its boundary: max(tool radius, plate half-size) + 1 mm, where the plate size is a new optional machine field `probe.plateSize` (the largest extent of the plate; Q87). Without a plate size the tool radius + 1 mm is used and the hint says "the plate must lie flat on the surface".
- **Default spot:** the centre of the **largest inscribed circle** of the flat patch eroded by the clearance radius (the point farthest from any wall), rounded to 1 mm (0.05 in) and kept inside; ties → the one nearest the setup's work zero. For a faced top this is the middle of the part's largest uncut area, away from pockets and holes.
- **Chosen spot:** `at: [x, y]` in the setup frame; must lie in the eroded patch (`zRef.spotNotFlat` otherwise). Stored with the chosen reference, or alone to move the default surface's spot.
- **Reachable:** within the machine's travel like every move (sizes in Plan; Run checks it at the live work zero), and with workholding modelled ([workholding.md](workholding.md)), outside every item's keep-out.

## Program frame (recommendation: per-tool Z0 at export)

The plan keeps one frame per setup. The question is what the **exported program** asks the operator to do at a tool change whose reference level `s` is not 0.

|                                                    | **A. Setup frame in the program**                                                                                                            | **B. Per-tool Z0 at export (recommended)**                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Program Z                                          | Z0 = up face throughout                                                                                                                      | Each tool run's Z shifted by −`s`: Z0 = its reference surface                                        |
| Operator, any sender                               | Set Z = −0.50 at the spot: type `G10 L20 P1 Z-0.50` in the console, or after a touch-plate probe work out the offset from the retract height | "Zero Z" at the spot, or the sender's own touch-plate probe: the same action as at every tool change |
| Habit error (operator zeroes on the surface as Z0) | Cuts `s` too deep: 7.19 mm into a pocket floor, possibly a crash                                                                             | Correct                                                                                              |
| Forgotten re-zero                                  | Wrong by the tool length difference (both)                                                                                                   | Same, plus `s`: shallower (air), never deeper                                                        |
| DFYOM Run                                          | Set Z / Probe Z write `s` (+ plate thickness)                                                                                                | Unchanged: Set Z zero / Probe Z at the surface (contact = plate thickness, as M4)                    |
| Reading the gCode                                  | Z values match the design                                                                                                                    | Z values of later tools differ from the design by `s`; each run's comment states it                  |
| Goldens                                            | Unchanged                                                                                                                                    | Unchanged while every reference is the up face (`s` = 0)                                             |

**Recommendation: B.** Most hobby senders (gSender, Candle, UGS) offer "Zero Z" and a touch-plate probe that both set Z0, and few make "set Z to a value" easy, so A turns the safe habit into the dangerous mistake. B keeps every operator action identical across tool changes; the shift is a pure Z translation of the tool run at export (like the alignment draft's `shiftToolpath` in X/Y, after AL-D), applied to every Z word of the run, including `clearanceZ` and the retract after the `M0` (clearance = stock top + `clearanceHeight` − `s`, the same physical height). Nothing upstream of the post changes: toolpaths, the input hash, the simulation, DF61 bands, DF64 links and DF68 headroom stay in the setup frame. Only the export and Run's drawing of the live position (the run scene adds `s` of the current tool run) know the shift.

Under B, AL2 still holds for the setup: the setup's frame, its work zero, the alignment step and the first tool's Z0 are on the up face. A later tool run's program Z0 moves to its reference surface; this amends AL2's wording for the export only (Q82).

## Exported gCode

**Header** (amends [grbl.md § Setup header](../architecture/grbl.md#setup-header-hardening-df58)): the Z0 line stays when every tool run uses the up face. Otherwise it reads `(Z0 on the top face for tool 1; later tools: see each tool change)`, and each tool line of the header gains its reference when it is not the up face: `(Tool 2: 6 mm flat end mill, Z0 on Facing 1 floor)`.

**Tool change** (amends the tool-change block of [grbl.md § Output dialect](../architecture/grbl.md#output-dialect)): after the retract and before the marker, a rapid to the spot at the clearance height (Q85) and two comment lines; then the marker and `M0` as today, and the restated modes and retract in the new tool run's frame. Example (the user's case: faced 0.5 mm, clearance height 10 mm):

```text
M5
G0 Z10
G0 X120 Y45
(Z0 for tool 2: Facing 1 floor, 0.50 below the stock top)
(Touch off Z here, X120 Y45: set Z0 on that surface)
(DFYOM TOOL CHANGE 2: 6 mm flat end mill)
M0
G90 G94 G17 G21
G54
G0 Z10.5
```

- **DF63 coordination:** DF63 (in progress) puts the tool (number, name, Ø, type) in the `M0` line's comment and the line before it, because gSender shows that comment at the pause. The Z instruction follows DF63's form: if the `M0` line's comment has room within 70 bytes, it ends with `, Z0 on Facing 1 floor`; the two lines above always carry the full text. The [marker rule](../architecture/grbl.md#output-dialect) is DF63's to amend; this doc adds lines only before the marker.
- **Text:** surfaces by their labels as the Plan list shows them ("Facing 1 floor", "Pocket 2 floor", "Step 1 floor"; the up face "the top face"), levels as a positive distance below the stock top in program units, coordinates as the program writes them (in the WCS, so with the alignment draft's free zero they follow it). Each line through `commentLine` (printable ASCII, ≤ 70 bytes).
- **First tool:** with `firstToolLoaded` (no `M0`) and the up face as reference, nothing changes. If the first tool's reference is not the up face (Q84), the first tool change pauses like any other, with the same lines.
- **Plans whose references are all the up face:** no new lines, no move to a spot: every existing golden is unchanged (Q85 for the spot move on those).

## DFYOM Run

- **Tool-change dialog** (and the setup-change prompt for the first tool run): "Tool change 2: 6 mm flat end mill · Z0 on Facing 1 floor (0.50 below the stock top) at X 120 Y 45". A **"Move to touch-off spot"** button (rapid at the clearance height, then X Y; confirmed like every motion, [run.md § Safety](run.md#safety), rule 3) when the machine is not already there (the program's rapid put it there); then "Probe Z" and "Set Z zero here" as today.
- **Probe Z** (M4, `run.machine.probeZ`) is unchanged under B: the contact is Z = plate thickness on the surface. Under A it would take `surfaceZ` and write `G10 L2 P1 Z<prb.z − plateThickness − s>`.
- **Run scene:** the reference surface highlighted (its flat patch tinted) and the spot marked with a crosshair; the tool marker at WPos + `s` of the current tool run.
- **Virtual machine:** the host lays the virtual plate on the reference surface (plate top = the setup-frame stock top + `s` + plate thickness), so the e2e flows probe on a faced floor.
- **Resume** (M5): a resumed run starts at a tool change, so its tool run's reference and lines come with it.

## Checks

Findings in `plan.warning.list` (`plan.zRef`, `params.setupId`, `params.planOperationId` of the tool run's first operation), derived per call; errors block the setup's export and `run.job.start` like every error finding:

| Rule          | Severity | When                                                                                                                                             |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notYetCut`   | error    | The chosen surface is cut in this tool run, a later one, or a later setup: it does not exist when the tool starts                                |
| `cutAway`     | error    | An operation between the surface's cut and this tool run cuts lower over the spot (a pocket in the faced top, a hole) or removes the whole patch |
| `notFlat`     | error    | The surface is not eligible: side face, cut by a non-flat tool, fillet, tab top, wrong direction                                                 |
| `spotNotFlat` | error    | The chosen spot lies outside the flat patch eroded by the clearance radius                                                                       |
| `missing`     | error    | The chosen surface is gone (its operation removed by a rebuild)                                                                                  |
| `none`        | error    | No eligible surface for the default rule (rule 4)                                                                                                |
| `chosen`      | warning  | The default rule fell to rule 3 (an unusual floor)                                                                                               |
| `small`       | info     | The flat patch fits the tool but not `probe.plateSize`: touch off by hand (paper or feeler), or choose another surface                           |
| `inert`       | info     | A stored reference sits on an operation that no longer starts a tool run (after a reorder or tool change); it is ignored, `fix` removes it       |

"Cut away before the tool that uses it" is `cutAway`; a surface cut away **after** its tool run is fine (the tool has touched off already).

## Agent API (compact)

No new tool (the `tools/list` size budget, [llm-api.md](../architecture/llm-api.md#exposure-commands-and-queries-as-mcp-tools)); one argument on an existing command and one summary field:

- **Store:** the reference belongs to the tool run's first operation: `plan.operation.update { zRef?: { surface?: string, at?: [x, y] } | null }` (`surface` absent = the default surface with a chosen spot; `null` = back to the default). Allowed where `plan.operation.update` is; validated as `model.invariant` for an unknown surface id. The plan operation record gains `zRef?` (optional: no `schemaVersion` change). A reorder carries it with the operation; if the operation no longer starts a tool run the finding `inert` says so (Q83).
- **Read:** `plan.get`'s summary gains per setup `toolRuns: [{ tool, operations, zRef: { surface, label, level, at, chosen } }]` (`tool` = its number and name; `level` = `s` in project units; `chosen` false for a default). The same list feeds DF66's inspector; `detail: "full"` adds each run's flat patch area.
- **Fix suggestions:** the `zRef.*` findings carry a `fix` with the default surface and spot, and `params.candidates` (up to five eligible surfaces with their spots) so an agent can choose without another query.
- **Run:** nothing new for agents: `run.job.continue` at the tool change as today; on the virtual machine `run.machine.probeZ` or `run.workZero.set { axes: ['z'] }` at the spot.

## UI

- **Plan, setup inspector:** DF66's tool-change list (tool, operations, in order) gains a **"Z from"** column: the surface label and level ("Facing 1 floor · −0.50"); a default reads in the secondary text colour, a chosen one in the primary. Clicking it opens a picker of the eligible surfaces (label, level, patch size) with "Default" on top; a findings icon on the row as in the operation list.
- **Viewport:** selecting a row (or hovering the picker's entries) highlights the surface's flat patch and the spot crosshair on the part; the spot can be dragged within the patch (snaps to 1 mm), which stores `at`. A surface not eligible is never offered; picking a surface in the viewport while the picker is open chooses it when eligible.
- **Operation inspector:** an operation that starts a tool run shows the same "Z from" field in its tool group.

## Implementation notes (DF69)

Where the implementation settles or differs from the proposal above:

- **Machine field:** `probe.plateSize` is the flat optional length `probePlateSize` on the machine (Library, Z height group, "Touch plate size"), like the other machine fields.
- **Flat surfaces:** the up face and the floors of facings, pockets and blind profiles of the setup's direction, cut with a **flat end mill** (facing and surfacing bits are flat end mills in the library). Through profiles have no floor. Cuts from the opposite direction lower a patch only where they reach through to this face (holes, openings, deep pockets); cuts from side directions are ignored.
- **Spot:** the best point of a grid in the WCS (1 mm, 1.27 mm = 0.05 in on inch machines) by its distance to the patch boundary; ties go to the one nearest the middle of the patch, then nearest the work zero. The clearance radius is max(tool radius, plate size / 2) + 1 mm; a patch that fits only tool radius + 1 mm gives the spot with `small`.
- **Findings:** `plan.zRef` findings are listed by `plan.warning.list` and block the setup's export (`plan.check`, so `run.job.start` too). They do not block toolpath generation, and a stored `zRef` never makes a toolpath stale (it is out of the input hash). Their `params` carry `setupId`, `surface`, `fixSurface`, `fixAt` ("x,y") and `candidates` ("id x,y; …", up to five), as strings because finding params are flat.
- **Data source:** `plan.warning.list` returns `zRefs`: per tool run its first operation, tool number, reference (surface, label, level, spot, patch area, `small`, `top`, `chosen`, rule) and the eligible candidates. `plan_get`'s summary and the inspector read it from there; `toolRuns[].zRef` has `{ surface, label, level, at, chosen }` in project units, `null` when the run has no reference.
- **Header:** `(Z0 on the top face for tool 1, later tools: see each tool change)` (a comma: `commentLine` drops `;`); when tool 1 itself uses another surface, `(Z0 for tool 1 on <label>: see the first tool change)`. The tool lines: `(Tool 2: Flat 6, dia 6 mm, Z0 on Facing 1 floor)`.
- **Tool change, after DF63:** the rapid to the spot comes after `M5` and the clearance retract and **also when every reference is the up face** (Q85: the goldens gain this one line per tool change, nothing else). The two comment lines come only for a surface other than the up face. DF63's pause line ends `, then zero Z on <label>` when that fits in 70 bytes, else `, then zero Z` as before; the comment lines above carry the full text.
- **DFYOM Run:** the sender reads the two comment lines before the marker; the tool-change dialog shows the surface, level and spot. The tool change (`run.status.get` `job.toolChange`) carries them as text (`surface`, `spot`) and as numbers: `level` (mm, setup frame, < 0) and `at` (the spot in work coordinates, mm), read from the same lines (program units from the last `G20`/`G21`).
- **Zero level (Z3):** the machine host keeps `zeroLevel`, the level of the surface G54 Z was last set on: a tool change's `level` becomes the run's level, and a Z zero or Probe Z during a run records it; outside a run (and at connect or `prepare`) it is the stock top (0). `run.status.get` reports it when not 0. A run that ends leaves it as it was: G54 Z is still on that surface (a next run started without re-zeroing shows the tool that much lower in the scene, which is where it is). GRBL keeps G54 across a reconnect, the host does not know its level then (0 assumed).
- **Run scene:** the tool marker, the playback and the travel box are drawn at WPos + `zeroLevel` (the setup frame). At a tool-change wait onto a surface other than the top, the scene shows that run's flat patch and spot (from `plan.warning.list` `zRefs`, the setup's run with that tool number, not draggable). During streaming no surface is shown.
- **Move to touch-off spot:** in the tool-change dialog when the run's spot is known and the machine is more than 0.01 mm off it in X or Y (the program's rapid put it there; the operator jogged away to change the tool). Confirmed ("Move to the touch-off spot?", rule 3), then two `run.machine.jog { to }` in machine coordinates: Z up to the setup's clearance height above the stock top of the current zero (G54 Z − `zeroLevel` + clearance, capped at the machine top), only if lower, at the Z jog feed; then X Y at that height at the XY jog feed. Z never moves down. A longer new tool sits lower than the old one at the same height: the confirmation says so. No new command or tool (jogs; the `tools/list` budget is unchanged).
- **Probe Z on the surface:** unchanged in the host (contact = plate thickness, B); the confirmation names the surface ("Put the touch plate on Facing 1 floor under the bit…").
- **Virtual plate:** before a probe on the virtual machine the plate top is G54 Z − `zeroLevel` + the run's level + plate thickness (the stock top of the current zero, down to the run's surface), else 10 mm below the tool as before.
- **Resume (M5) inside a tool run:** the resumed program's tool change carries the run's reference even when the resume starts at a later operation of the run (`toMachiningProgram` keeps the run's `zRef` from its first operation).
- **Viewport outline:** `plan.warning.list` `zRefs[].outline` carries, for the run's reference, the flat patch and the area the spot may lie in (the patch eroded by the clearance radius) as polygons in the setup WCS (arcs as chords within 0.05 mm, mm to 0.001), the clearance radius and the spot grid; `null` without a reference. It is for the viewport only: agents' results leave it out (`plan_warning_list` `detail: "full"` and `plan_get` keep the compact shape above).
- **Which run the viewport shows:** the run whose tool-change row is hovered or focused, or whose "Z from" is hovered; else the selected plan operation's run; else, with a setup selected, the setup's first run; nothing with no selection. One run at a time, so the spot to drag is never ambiguous.
- **Spot drag:** the spot moves on the surface's plane under the pointer, snapped to the spot grid (1 mm, 1.27 mm on inch machines) and kept in the eroded patch (the nearest allowed grid point when the pointer leaves it); releasing commits one `plan.operation.update { zRef: { surface?, at } }` (the chosen surface kept, the default surface's spot alone otherwise), one undo step; `Escape` cancels; read-only plans do not drag. The keyboard way is the operation inspector's X and Y.
- **Operation inspector:** the first operation of a tool run shows "Z from" (the same menu as the tool-change row) and the touch-off spot's X and Y in its Tool group; entering one commits `{ zRef: { surface?, at } }` with the other kept, and a moved spot offers "Use default spot". Choosing a surface in the menu resets its spot to that surface's default. Other operations of the run show nothing (their run's reference is set on its first operation).

## Relations

- **AL2 / Q61 ([alignment.md](alignment.md), accepted 2026-11-24):** the setup's Z0 stays on the up face, and the alignment cycle's zero (X/Y free, AL-D) is untouched. This doc only changes what the operator touches off for each later tool. The X/Y of a spot are in the WCS like every number in Run, so they follow the setup's zero: moving the zero (`plan.setup.update { zero }`) shifts stored spots (`zRef.at`) by the same amount, so each stays on the same place of the stock.
- **Vacuum table, tape, glue (surface hold, [workholding.md](workholding.md)):** the motivating case. Nothing holds the top, so after a full facing no original top is left; rule 2 picks the faced floor. With clamps the operator might keep an uncut corner under a clamp, but that corner is no flatter than the raw top.
- **Raw top vs faced floor:** the faced floor is a better reference than the raw top (flat, cut by this machine), so rule 2 does not wait for the top to vanish completely: a top with only small uncut scraps fails the patch size and falls to the facing.
- **DF63** (tool on the `M0` comment): the text format is shared, [above](#exported-gcode). **DF65** (no change at a setup boundary): a carried-over tool still needs the new setup's Z0 (the stock was moved), so the setup's first tool run keeps its reference and its pause. **DF66:** the list this doc's column lives in. **DF68** (Z headroom): computed in the setup frame, unaffected by the shift. **DF64** (lower safe links): the move to the spot uses the clearance height.
- **M4 / M5 (machine lane):** the probe and the resume carry over unchanged under B.

## Not covered (later)

- **Tool length sensor** (a fixed tool setter: measure each tool's length offset against the sensor and carry Z over without touching the part). It needs no surface at all and is the industry answer for vacuum tables; it is listed out of scope in `run-machine.md` (Q89).
- **Table / spoilboard reference** (Z = −stock thickness): only as good as the measured thickness (Q88).
- **Z pads:** leaving a small uncut pad on purpose for zeroing (like the tiling idea "islands for marks" in [proposal-multi-setup-alignment.md](../plans/proposal-multi-setup-alignment.md#ideas-from-the-user-after-the-answers)): not needed while cut floors qualify.
- **Probing the spot automatically** at the start of a tool run (a `G38.2` in the program): GRBL programs can probe, but a missing plate alarms mid-program; DFYOM's guided probe at the wait covers it.

## Phases (sketch)

| Phase | Content                                                                                                                     | Depends on          |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Z0    | This doc accepted; amendments to grbl.md (header, tool change), run-machine.md (dialog), plan-v0.2.md (record)              | Q81–Q92             |
| Z1    | Core: eligible surfaces, flat patch, default rule, spot, findings; `zRef` on `plan.operation.update`; `plan.get` `toolRuns` | DF61 coverage model |
| Z2    | Export: per-run shift, header and tool-change lines, spot move; goldens for a faced plan                                    | Z1, DF63            |
| Z3    | Run: dialog text, move to spot, run scene, virtual plate on the surface; e2e on the emulator (done)                         | Z2, machine lane    |
| Z4    | Plan UI: "Z from" column and picker, viewport highlight and spot drag                                                       | Z1, DF66            |

**Testing:** the default rule on plans with no facing (unchanged gCode), a full facing (rule 2), a pocket on the faced top under the default spot (spot moves), a facing cut away by an opening; each finding; the export shift checked on the emulator (a two-tool program, the second touching off on a faced floor with the plate: every motion end point in setup-frame Z equals the unshifted program's); the e2e probe at a tool change on the faced floor.

## Open questions for the user

1. **Q81 – Scope.** A Z reference surface and touch-off spot per tool run (first tool and every tool change), chosen in Plan mode from flat, upward surfaces that exist when the tool starts. _Recommendation:_ yes, as above.
2. **Q82 – Program frame.** B: the plan stays in the setup frame (Z0 on the up face, AL2), the export shifts each tool run's Z so its reference surface is Z0 and the operator always "zeroes Z" there; A would keep Z0 on the up face in the program and ask the operator to set Z = −0.50. _Recommendation:_ B (safe with every sender's Zero Z and touch-plate probe; AL2's wording amended for the export only).
3. **Q83 – Default rule and storage.** Up face while it has a patch; else the most recent facing floor; else the largest flat patch with a warning; else an error. Default derived on every read; a choice stored on the tool run's first operation, reported `inert` when a reorder moves it off a tool-run start. _Recommendation:_ yes.
4. **Q84 – No surface / first tool off the up face.** When no eligible surface exists, block export until the user chooses; allow the first tool run's reference to be another surface (then the first tool pauses like a tool change). _Recommendation:_ yes to both.
5. **Q85 – Move to the spot before the `M0`.** The exported program rapids to the spot at the clearance height before the tool-change pause, so the operator changes the tool and touches off right there; only for tool runs whose reference or spot is not the default up face? _Recommendation:_ move to the spot at **every** tool change once this ships (one habit, and the up face's default spot is flat by construction), accepting that the goldens change once; if you prefer the tool change at a fixed front position, keep the move off and rely on the comment.
6. **Q86 – Spot rule.** Centre of the largest inscribed circle of the flat patch eroded by max(tool radius, plate half-size) + 1 mm, rounded to 1 mm; draggable in the viewport. _Recommendation:_ yes.
7. **Q87 – Plate size.** A new optional machine field `probe.plateSize` (beside "Plate thickness") so the spot leaves room for the plate. _Recommendation:_ yes, optional; without it only the tool radius counts and the hint says the plate must lie flat.
8. **Q88 – Table as a reference.** Offer the spoilboard / vacuum table top (Z = −stock thickness) as a reference? _Recommendation:_ no for now: it is only as accurate as the measured thickness, and a cut floor is always available after a facing.
9. **Q89 – Tool length sensor.** A fixed tool setter removes the need for any surface; keep it out of this doc and the machine lane for now (a separate draft when you have one on the machine)? _Recommendation:_ yes, later.
10. **Q90 – Exported text.** Two comment lines before the marker ("Z0 for tool 2: Facing 1 floor, 0.50 below the stock top" / "Touch off Z here, X120 Y45: set Z0 on that surface"), a short suffix on DF63's `M0` comment when it fits, and the header's tool lines naming non-default references. _Recommendation:_ yes.
11. **Q91 – Agent API.** `zRef` on `plan.operation.update`, `toolRuns` in `plan.get`'s summary, candidates in the findings; no new tool. _Recommendation:_ yes.
12. **Q92 – UI.** "Z from" column with a picker in DF66's tool-change list, the surface and spot highlighted in the viewport, spot drag. _Recommendation:_ yes, built with DF66 (phase Z4 after Z1–Z3 if DF66 slips).
