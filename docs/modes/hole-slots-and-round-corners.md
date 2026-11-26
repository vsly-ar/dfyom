# Slotted bolt holes, recessed countersinks and Round corners

Status: accepted (by delegation, 2026-11-26: the user delegated draft confirmation, D70, so the recommended options below are **accepted by delegation (D70, 2026-11-26)** and the user may veto; flagged items are listed under [Flagged](#flagged-for-the-user)) · Hardening [DF119, DF120](../plans/hardening.md#intake-user-feedback-goes-here), user TG #369 · Builds on: [design-v0.4.md § Hole feature](design-v0.4.md#hole-feature) (parameters, expansion, fastener table), [features.md](features.md) (A1–A6), [edge-chamfers.md](edge-chamfers.md) (chamfers on pocket outlines), [construction-surfaces.md](construction-surfaces.md) (DF118), [inspector-layout.md](../conventions/inspector-layout.md#per-inspector-target-layout) (S1–S6) · Terms: [glossary.md](../glossary.md)

The user asked (TG #369), on the clamps_40 project:

- **DF119:** "I was trying to make a long, recessed, countersunk hole for an M5 screw. Please plan to extend the 'bolt hole' feature to allow this." They built it from operations: a rounded-rectangle recess pocket, a rounded-rectangle slot pocket on its floor, and an edge chamfer on the slot ([research § Reproduction](../research/2026-11-26-construction-surfaces.md#reproduction)).
- **DF120:** "When Corner radius is > allowed, instead of showing the error 'Must be between 0 and half the narrowest size', plan to add a checkbox/toggle 'Round' to corner radiuses and activate it when entered radius goes beyond (on apply)." In clamps_40 the slot is 5.5 mm wide with R 2.5, not the 2.75 a fully round end needs.

## Decisions

| Id   | Decision (accepted by delegation, D70)                                                                                                                                                                                                                                                                                                                                   | Section                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| RC-A | **Round** is a flag on a rectangle's corner radius: the radius is half the narrowest side and **follows size edits**. It is stored as `round: true` beside a `cornerRadius` that the commands keep equal to the resolved value, so every existing reader of `cornerRadius` is unchanged                                                                                  | [Round corners](#round-corners-df120)              |
| RC-B | **On apply, a radius above half the narrowest side turns Round on** instead of refusing, unless the same edit sets Round off explicitly. The result reports the adjustment. A negative radius is still refused                                                                                                                                                           | [Apply rule](#apply-rule)                          |
| RC-C | Round applies to every **rectangle**: pocket and profile shapes, Shape Editor rectangle items and pattern cells. Polygons keep their own corner rule (a regular polygon is never round)                                                                                                                                                                                  | [Where](#where-round-applies)                      |
| SH-A | **Slotted holes** are a hole option, not a new feature: `slotLength` (the centre-to-centre travel, 0 = round) and `rotation`. A slotted hole expands to **pockets** with Round corners, and its countersink to an **edge chamfer** on the slot outline                                                                                                                   | [Slotted holes](#slotted-holes-df119)              |
| SH-B | **New hole type `recessedCountersink`:** a counterbore-like recess, then the hole on the recess floor, and a countersink at the hole's mouth on that floor. It reuses the `cb*` and `cs*` fields. The recess may be exactly as wide as the countersink, so the cone cuts the recess floor away; that relies on [construction surfaces](construction-surfaces.md) (DF118) | [Recessed countersink](#recessed-countersink-type) |
| SH-C | **Agent API:** `slotLength`, `rotation` and one enum value on `design.hole.add/update` (≈ +0.3 K), plus `"round"` accepted as a `cornerRadius` (≈ +0.05 K). No new tools                                                                                                                                                                                                 | [Agent API](#agent-api)                            |

## Round corners (DF120)

### Model

- A rectangle shape (operation `shape`, shape item, pattern cell) gains an optional `round?: true`. Absent means off, so old records stay byte-identical and there is no `schemaVersion` change (pre-alpha rule).
- With `round`, `cornerRadius` is **derived**: half of min(`length`, `width`), nominal and untoleranced. The commands rewrite it whenever `length` or `width` change, by direct edit or by [recalculation](design.md#ordering-and-composition) of a formula. A pure `followRound(ops)` runs after `recalculate`, in the same place as `followEdges` ([`surfaces.ts`](../../src/core/design/surfaces.ts)). It is applied to shape items and pattern cells in their own commands.
- **Why a flag plus a stored value** (option 1), not a `'round'` sentinel in `cornerRadius` (option 2) or a formula (option 3)? The checks, geometry, tool fit, corner warnings and the plan read `cornerRadius` as a `Quantity` in dozens of places, and option 1 leaves all of them unchanged. Option 2 would make each of those readers resolve the sentinel. Option 3 is impossible: formulas reference surfaces, not the shape's own sizes ([quantities.md](../architecture/quantities.md#expressions-and-references)).
- **Invariant** `roundRadius`: with `round`, `cornerRadius` equals half the narrowest side. It is restored by the commands and never shown to a user; it guards hand-edited files (`model.invariant` at load, as other rules).
- A Round rectangle 5.5 × 25 is the slot shape (an [obround](design-v0.3.md#shape-definition)). The `obround` shape item stays; it is a different item kind with its own `width` = end diameter.

### Apply rule

When a design command applies a rectangle with `cornerRadius` > half the narrowest side (more than the chord tolerance above it):

1. If the same edit does not set `round: false`, it sets `round: true`, the radius becomes half the narrowest side, and the command succeeds. It reports `adjusted: [{ path: 'shape.cornerRadius', from: '3 mm', to: 'round', rule: 'cornerRadiusRound' }]` in its result (output schema only).
2. If the edit sets `round: false` explicitly, it fails as today (`model.invariant`, `cornerRadiusRange`).
3. This holds for a radius edit, and also for a **size edit** that makes the current radius too large (narrowing a 10 mm-wide R 4 pocket to 6 mm turns Round on). The message names which.
4. Entering a radius on a Round rectangle turns Round off and uses that radius (subject to rule 1 again if it is too large).

In the UI the field shows a transient info note after the apply: "3 mm is more than half the width (2.75 mm): set to Round." It has an Undo link (the same undo step as the edit), as the open-path toast ([ui.md](../conventions/ui.md)) does.

### Where Round applies

| Place                                     | Control                                                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pocket inspector, accordion Corners       | Corner radius field, then a `Switch` field "Round" on its own row (switch fields, [ui.md § Switch fields](../conventions/ui.md)). When on, the radius field is read-only, shows the resolved value and the tag "Round" |
| Profile inspector, group Shape            | as the pocket                                                                                                                                                                                                          |
| Shape Editor, rectangle item row          | a "Round" checkbox in the row's radius cell                                                                                                                                                                            |
| Pattern inspector, group Cell (rectangle) | as the pocket                                                                                                                                                                                                          |
| Hole feature (slotted)                    | none: owned slot pockets are always Round                                                                                                                                                                              |

Corner summaries read "R 2.75 (Round)". DFM corner checks are unchanged: a Round corner's radius is half the width, so `dfm.toolUnfit` needs a tool no wider than the width.

## Slotted holes (DF119)

### Parameters added to the hole

Added to [design-v0.4.md § Parameters](design-v0.4.md#parameters):

| Parameter    | Kind   | Default | Rule                                                                                                                                                                         |
| ------------ | ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slotLength` | length | 0       | ≥ 0; the distance between the slot's end centres (the screw's adjustment travel). 0 = a round hole. Overall length = `slotLength` + `diameter`, shown read-only              |
| `rotation`   | angle  | 0°      | The slot's direction in the face frame, counter-clockwise from +u (as shapes, [design-v0.3.md](design-v0.3.md#shape-definition)); only with `slotLength` > 0 (`notForRound`) |

- `center` is the slot's midpoint, and the anchor works as before on the slot's bounding box.
- The **width** is the hole `diameter` (a clearance from ISO 273 with `fastener`, as for round holes). No fastener standard sizes slots, so `slotLength` is never filled from the table and is not "custom" in `dfm.holeCustomSize`.
- **Refused with a slot** (`notForSlot`): `bottom: drillPoint` (a pocket has a flat floor), `purpose: tapDrill`, and `csMethod: stepped` (stepped chamfers stay circular-only, [edge-chamfers.md](edge-chamfers.md)). `bottom: flat` and `through` work.

### Expansion of a slotted hole

The roles and ids follow [A3](features.md#expansion-and-owned-operations); the kinds change with the slot. For every type, a slot means:

| Role          | Round hole (unchanged) | Slotted hole                                                                                                                                                                    |
| ------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drill`       | drilling               | **pocket**: rectangle (`slotLength` + `diameter`) × `diameter`, `round`, `rotation`; `through` (a [through pocket](patterns.md#implementation-p4)) or `depth` with a flat floor |
| `counterbore` | circle pocket          | pocket: rectangle (`slotLength` + `cbDiameter`) × `cbDiameter`, `round`, same centre and `rotation`, depth `cbDepth`                                                            |
| `countersink` | chamfer on the mouth   | [edge chamfer](edge-chamfers.md) on the `drill` pocket's outline, width (`csDiameter` − `diameter`) / 2, angle `csAngle`                                                        |

- **Switching** a hole between round and slotted changes the `drill` role's kind (drilling ↔ pocket) and its surface (`hole1_drill.bottom` ↔ `hole1_drill.floor`). The role's tool lock is kept if the tool fits the new kind (a drill bit never fits a pocket). A later operation that references the old surface makes the switch fail with `design.referenced`, as a disappearing role does today.
- **Tools:** the slot pocket needs an end mill no wider than `diameter`; the counterbore's [`followsHole`](design-v0.4.md#counterbore-tool) rule applies unchanged (both are pockets). A chamfer mill cuts the countersink along the outline.
- **Clones, plan order, labels** are unchanged; the owned operations are ordinary pockets and chamfers.

## Recessed countersink type

`type: 'recessedCountersink'` ("Recessed countersink"; round or slotted). A countersunk head sits in a recess below the face, as in clamps_40.

| Field        | Meaning here                                        | Default                                      | Rule                                                                     |
| ------------ | --------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| `cbDiameter` | recess width (diameter, or the slot recess's width) | `csDiameter` + 1 mm (0.5 mm ledge each side) | ≥ `csDiameter` (equal allowed: the cone then cuts the recess floor away) |
| `cbDepth`    | recess depth below the face                         | 2 mm / 0.08″                                 | > 0; `cbDepth` + cone depth < hole depth (`countersinkTooDeep`)          |
| `csDiameter` | countersink Ø at the recess floor                   | table head Ø + 2 × `headSink`                | > `diameter`                                                             |
| `csAngle`    | as countersink                                      | table                                        | 60°–120°                                                                 |

**Expansion:** `counterbore` (recess pocket on the face) → `drill` (drilling or slot pocket `on` `<id>_counterbore.floor`, depth `depth − cbDepth` with the B5 tolerance rule, or through) → `countersink` (chamfer on `<id>_drill`, `on` `<id>_counterbore.floor`). With `cbDiameter` = `csDiameter` the recess floor is fully consumed by the hole and its countersink, both its dependants. [Construction surfaces](construction-surfaces.md#check-dfmsurfacecutaway) make that warning-free. Until V1 is built, the default 1 mm ledge avoids it.

`headSink` keeps its meaning (the head below the recess floor); `cbDepth` is the recess the user wants. The read-out is "M5 · recessed countersink Ø 10.4 in Ø 11.4 × 2, slot 20".

## Inspector layout

Bolt hole target layout ([inspector-layout.md § Per-inspector target layout](../conventions/inspector-layout.md#per-inspector-target-layout); the row there is updated in H3):

- **Group Position:** X, Y, On; More: Anchor.
- **Group Type:** Type (Simple, Counterbore, Countersink, Recessed countersink), Fastener, Fit, then the `Switch` field **Slotted**.
- **Group Sizes:** Diameter, then, when Slotted: Slot length and Rotation (angle step kind), with the read-only "Overall 25 mm" after them (field order rule 3). Then Recess Ø / Recess depth (labels for `cbDiameter` / `cbDepth` in this type; "Counterbore Ø/depth" in counterbore), Countersink Ø / angle, Bottom, Depth.
- **Group Tools**, **Accordion Defaults closed** and **Findings**, as now.
- Step kinds ([inspector-layout.md § Field step model](../conventions/inspector-layout.md#field-step-model-df104)): Slot length `xy`, Rotation `angle`, Recess Ø `small`, Recess depth `depth`.
- The viewport draws the slot's centre line and its travel as a dimension while the hole is selected (the existing selection outline otherwise).

## Agent API

`tools/list` is ≈ 111.6 K of 120 K.

- `design.hole.add` gains `slotLength?` (length string; "centre-to-centre travel, 0 = round"), `rotation?` (angle string) and `recessedCountersink` in the `type` enum. `design.hole.update` lists them as sketches of add's args (the P2 pattern). Estimate ≈ +0.3 K.
- `cornerRadius` on `design.{pocket,profile}.{add,update}`, `design.shape.item.{add,update}` and `design.pattern.{add,update}` accepts `"round"` (the description gains one shared sentence via `$ref`, ≈ +0.05 K). Results return `round` and `adjusted` (output schemas only).
- Measured in each slice and logged in [llm-api.md](../architecture/llm-api.md#implementation-task-310). Budget for these slices: ≤ 0.5 K.

## Slices

| Slice | Scope (one agent each)                                                                                                                                                                                                                                    | Done when                                                                                                                                                                                                                                                                |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1    | **Round, core.** `round` on rectangles (operation shapes, shape items, pattern cells), `followRound` after edits and recalculation, the apply rule with `adjusted`, `"round"` in args, the `roundRadius` invariant, docs (design.md, design-v0.3.md rows) | Core tests: 3 mm on a 5.5 mm-wide pocket applies as Round 2.75; a width edit to 8 mm moves it to 4; `round: false` with 3 mm is refused; a formula width follows after a facing edit; byte-identical records without Round; `tools/list` measured                        |
| R2    | **Round, UI.** The Round switch in Pocket, Profile and Pattern Cell, the checkbox in the Shape Editor, the read-only resolved radius, the apply note with Undo; ui.md                                                                                     | UI tests per inspector: typing 3 mm on a 5.5 mm-wide pocket and applying shows Round on and the note; Undo restores it; axe passes                                                                                                                                       |
| H1    | **Recessed countersink, core (round holes).** Type, defaults, expansion, rules, fastener defaults, `dfm.holeCustomSize` fields, design-v0.4.md amendment                                                                                                  | Core test: an M5 recessed countersink expands to recess, drill on its floor and countersink on its floor. With `cbDiameter` = `csDiameter` and V1 built: no warning. Plan and gCode golden for it                                                                        |
| H2    | **Slotted holes, core** (needs R1). `slotLength`, `rotation`, the slot expansion to Round pockets and an edge chamfer, `notForSlot` / `notForRound`, role kind switch, `tools/list` measured                                                              | Core test: the clamps_40 hole as one feature (M5, slot 19.5 for a 25 mm slot, recess, countersink) gives the user's geometry within the chord bound and plans with an end mill ≤ 5.5 mm and a chamfer mill. Switching round ↔ slotted keeps the drill lock where it fits |
| H3    | **Bolt hole inspector.** Type option, Slotted switch, Slot length, Rotation, Overall read-out, recess labels, slot dimension in the viewport, inspector-layout.md row                                                                                     | UI test: make the clamps hole from the inspector (M5, Recessed countersink, Slotted 19.5); a hidden e2e capture reviewed                                                                                                                                                 |

Order: R1 → (R2 ∥ H1) → H2 → H3. H1 does not need R1, and V1 of DF118 is independent; H1's equal-width case is tested once V1 is in.

## Flagged for the user

Nothing is irreversible (optional fields, no migration). Two behaviour choices are accepted by delegation but are worth your veto:

1. **RC-B applies to agents too.** An agent that sends a too-large radius gets Round and an `adjusted` report, not an error. The alternative is to switch only in the UI and keep the refusal for agents.
2. **RC-B on size edits.** Narrowing a pocket so its existing radius no longer fits turns Round on, rather than refusing the size. You asked for it on the radius field; extending it to size edits keeps one rule.
