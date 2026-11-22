# Plan mode v0.4: chamfer toolpaths and feature operations

Status: accepted (D34, 2026-11-22: the user took every recommendation of [Q28–Q35](../plans/v0.4.md#questions-for-the-user); proposed 2026-11-22 with [plans/v0.4.md](../plans/v0.4.md)) · Design: [design-v0.4.md](design-v0.4.md) · Concept: [features.md § Plan](features.md#plan) · v0.1 strategies and generators: [plan-v0.1.md](plan-v0.1.md#pass-strategies-v01) · v0.3 generators: [plan-v0.3.md](plan-v0.3.md) · Feeds: [feeds-speeds.md](../architecture/feeds-speeds.md) · Post: [grbl.md](../architecture/grbl.md) · Tasks: [plans/v0.4.md](../plans/v0.4.md) · Terms: [glossary.md](../glossary.md)

Plan sees **operations only**: hole and Clones features expand to drillings, circular pockets and chamfers, so v0.4 adds exactly one generator (the chamfer) and one tool type to the checks. Counterbores are v0.1 circular pockets and holes are v0.1 drillings (drill or [helical boring](plan-v0.1.md#toolpath-generators-task-210)); nothing new is needed for them.

## Decisions

| Id  | Decision                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-A | **No feature logic in Plan** ([features.md Q9](features.md#questions-for-the-user)): plan operations are built from operations; the plan navigator labels them with their feature name ("Hole 1 · counterbore").      |
| P-B | Equal chamfers (same angle, diameter, edge diameter, face direction) group into one plan operation, as equal holes do; clone instances therefore cut **one source operation on every position** with one tool change. |
| P-C | A chamfer is **plunged** at the centre when the tool's diameter covers it, else **contoured** on one circle (several rings when the slant height exceeds the cutting edge).                                           |
| P-D | Chamfer mill feeds use the **effective diameter** at the deepest point of the cut.                                                                                                                                    |
| P-E | Program comments name the feature and instance of each position (`(Hole 1 · 3/6)`), so a user reading the gCode can find a clone.                                                                                     |

## Chamfer toolpath

Input: the chamfer's axis point (the edge centre in the face frame), the edge diameter d, the chamfer diameter D, the included angle α, the face Z; the tool's DC, tip diameter dt and angle. A V-bit's cutting cone of half-angle α/2 touches the chamfer cone along its whole slant only when the angles match (the fit rule, [design-v0.4.md § Chamfer operation](design-v0.4.md#chamfer-operation-v04-circular-edges)).

- **Plunge** (DC ≥ D and dt ≤ d): rapid to the centre at the clearance height, feed down at `plungeRate` to the Z where the tool's cone has diameter D at the face (tip Z = face − (D − dt) / 2 / tan(α / 2)), short dwell optional (strategy `dwell`, default 0), rapid out. The hole below lets the tip pass through the edge diameter without cutting.
- **Contour** (DC < D): the tool axis runs one circle of radius r so the cutting cone meets the chamfer from d to D. With slant height s = (D − d) / 2 / sin(α / 2) and usable cutting length l of the tool's cone, one ring when s ≤ l, else ⌈s / l⌉ rings from the inside out at equal Z steps. Entry: a ramp along the first circle from the hole side (inside the edge diameter, which is already cut), climb direction, arcs as `G2`/`G3` ([plan-v0.3.md T-B](plan-v0.3.md#decisions)); exit: lift on a tangent arc into the hole.
- **Order checks:** a chamfer must cut after its `edgeOf` operation in the same setup ([order checks](plan-v0.1.md#plan-operations-and-order)); `plan.order` blocks the reverse.
- **Strategy parameters:** `entry` (`plunge`, `contour`, `auto` = P-C), `dwell`, `rampAngle` (contour); nothing else. A finishing pass is not offered (one ring cuts to size).

## Tool checks for chamfer mills

Added to the [plan check table](plan-v0.1.md#tool-assignment-and-checks):

| Check                      | Code (proposed)      | Rule                                                                              |
| -------------------------- | -------------------- | --------------------------------------------------------------------------------- |
| Angle                      | `plan.check` `angle` | Tool angle = chamfer angle within 0.5°                                            |
| Tip                        | `plan.check` `tip`   | `tipDiameter` < edge diameter (else the tip would cut the edge itself)            |
| Reach                      | as today             | `stickout` (else `fluteLength`) ≥ the chamfer's depth from the setup's outer face |
| Wrong type for other kinds | as today             | A `chamferMill` never fits a pocket, profile, facing or drilling                  |

## Feeds for chamfer mills

Amendment to [feeds-speeds.md](../architecture/feeds-speeds.md) when this doc is accepted: the cutting speed uses the effective diameter `De = dt + 2 · depth · tan(α / 2)` at the deepest point (≤ DC), with the same chip-load data as a flat end mill of that diameter for the material class; spindle speed from De, feed from the tool's flutes. Sources are added with the amendment (V-bit speed-by-depth rule from cnc-code, D30 Q12, re-sourced).

## Plan side

- **Grouping:** P-B plus the existing hole grouping; Clones need nothing else ([features.md § Plan and cut order](features.md#plan-and-cut-order)).
- **Plan-only edits** work per owned operation, as [features.md § Plan](features.md#plan) says; a rebuild discards them as today.
- **Labels:** plan operations whose operations share one feature show its name; grouped clone instances show "Hole 1 · drill × 6".
- **Program comments:** P-E; the post already writes operation comments ([grbl.md](../architecture/grbl.md)).

## Tests

- Chamfer generator: plunge and contour on circles of the [heightmap oracle](plan-v0.3.md#tests) with a V tip profile (the oracle gains a cone tip); mm and inch goldens; one ring vs several rings.
- Exit-part programs golden through both transports ([plans/v0.4.md § X1](../plans/v0.4.md#7-acceptance)); the number of tool changes per setup is asserted (one per distinct tool).
- The virtual machine streams the countersink and Clones programs.

## Later

Chamfers along general loops and outside edges (offset at the tool's contact Z, after spike S7); spot drilling as a separate role; deburring passes; helical thread milling; travel-order optimisation across clone positions.
