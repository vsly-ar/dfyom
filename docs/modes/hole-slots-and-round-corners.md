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

**R1 done** ([§ Implementation (R1)](#implementation-r1)), **R2 done** ([§ Implementation (R2)](#implementation-r2)), **H1 done** ([§ Implementation (H1)](#implementation-h1)), **H2 done** ([§ Implementation (H2)](#implementation-h2)), **H3 done** except the viewport's slot dimension ([§ Implementation (H3)](#implementation-h3)).

Order: R1 → (R2 ∥ H1) → H2 → H3. H1 does not need R1, and V1 of DF118 is independent; H1's equal-width case is tested once V1 is in.

## Implementation (R1)

Code: [`round.ts`](../../src/core/design/round.ts) (`settleRound`, the apply rule; `roundRadius`, `AdjustedSchema`), `Fields.roundCorner` in [`commands.ts`](../../src/core/design/commands.ts) (pocket and profile shapes, pattern cells), `takeRound` / `settleItemRounds` in [`shape-commands.ts`](../../src/core/design/shape-commands.ts) (shape items), `followRound` in [`surfaces.ts`](../../src/core/design/surfaces.ts) (after `recalculate`), the `roundRadius` checks in `validate.ts` (operation shapes), `shape-items.ts` (items) and `pattern.ts` (cells). Tests: [`round.test.ts`](../../src/core/design/round.test.ts).

- **Stored:** `round: true` beside `cornerRadius` on an operation's rectangle shape, a rectangle shape item and a rectangle pattern cell; left out when off, so existing records and the goldens are byte-identical. The radius is a derived length (exact half of the narrowest side, no tolerance, shown in the project units like a hole's derived sizes).
- **Args:** `cornerRadius: "round"` or `round: true` turns Round on; `round: false` turns it off and keeps the refusal of a too-large radius. `"round"` wins over `round: false` in the same arg. A Round rectangle stays Round when an edit gives no radius, or **the same radius as stored** (an inspector sends the whole shape back with the resolved radius); another radius turns it off (rule 4). A shape arg without a radius on a rectangle that is not Round still takes the default (unchanged). `design.shape.update` compares each item with the stored item at the same index.
- **Chord tolerance:** a radius above half by at most `CHORD_TOLERANCE` (0.01 mm) becomes Round without an `adjusted` entry.
- **Results:** `design.{pocket,profile}.{add,update}` return `round` (the rectangle is Round after the edit) and `adjusted`; `design.shape.{add,update,item.update}` and the feature results (`design.pattern.{add,update}`) return `adjusted`. Each entry: `{ path, from, to: 'round', rule: 'cornerRadiusRound', message }`, the message naming a radius edit ("3 mm is more than half the width (2.75 mm): set to Round.") or a size edit ("R 4 mm does not fit the new width (half is 3 mm): set to Round."). Output schemas only.
- **Recalculation:** `followRound` re-derives a Round radius after a formula size changed (a facing edit moving `facing1.floor.z`). A recalculated size that makes a non-Round radius too large is still refused at the dependant (`cornerRadiusRange`): rule 3 is about the edited rectangle. Pattern cells and shape items have no surface formulas that recalculate (shapes reference stock faces only), so they settle Round in their own commands.
- **Inspector (until R2):** no switch yet. A radius above half applies as Round and the field shows the resolved radius; a negative radius is refused at the field as before. The DF117 "Not applied" tests (`DepthPickNotApplied.test.tsx`) used a Length below 2 × the corner radius as their refused value; they now use a Depth below the floor fillet radius (the error still lands at another field).
- **`tools/list`:** 111,990 → **112,204** chars (+214, 145 tools): `round` (boolean) beside `cornerRadius` on the pocket and profile shape, the shape item and the pattern cell, and `or "round"` in their descriptions. The rule itself is one clause on the primer's operation-args line (not in `tools/list`). Above the ≈ 0.05 K estimate (the `round` arg is listed four times), within the 0.5 K budget of these slices.

## Implementation (R2)

Code: [`RoundField.tsx`](../../src/renderer/src/modes/design/RoundField.tsx) (the switch field, `adjustedNote`), used by `CornerRadiusFields` in [`OperationFields.tsx`](../../src/renderer/src/modes/design/OperationFields.tsx) (pocket Corners, profile Shape), `ItemFields` in [`ShapeInspector.tsx`](../../src/renderer/src/modes/design/ShapeInspector.tsx) and the Cell group of [`PatternInspector.tsx`](../../src/renderer/src/modes/design/PatternInspector.tsx); `undoEdit` in [`shell/hooks.ts`](../../src/renderer/src/shell/hooks.ts). Tests: [`RoundCorners.test.tsx`](../../src/renderer/src/modes/design/RoundCorners.test.tsx), the DF120 case in `Shape.test.tsx`, [`e2e/round-corners.e2e.ts`](../../e2e/round-corners.e2e.ts).

- **Switch:** a `Switch` field "Round" on its own row under Corner radius, with the (i) tip "Radius = half the narrowest side, follows size edits. Off: keeps the current radius." The Shape Editor's item fields are a field list, not a table, so it gets the same switch field there (not the checkbox in a radius cell the table above planned). On sends `round: true`; off sends `round: false` with the stored (derived) radius, so the radius stays.
- **Radius while on:** the field is read-only (the dashed read-only style of `QuantityInput`) and shows the derived value; no separate "Round" tag (the switch beside it says it). The closed Corners accordion's summary reads "r 2.75 mm (Round)".
- **Notice:** the `adjusted` message from the core ("3 mm is more than half the width (2.75 mm): set to Round.", "R 3 mm does not fit the new length (half is 2.75 mm): set to Round.") is shown as the mode's undo toast (as the open-path "Side set to On line" toast), not as a field note: it is neutral, transient and has Undo. Since Enter commits **and** applies, and the Apply is its own undo entry when it changed something ([apply.md § Baseline and undo](../architecture/apply.md#baseline-and-undo)), this toast's Undo (`undoEdit`) undoes an Apply on top first and then the edit, so the radius and size come back in one click.
- **DF117:** refusals other than a too-large radius (a negative radius, a Depth below the floor fillet) still keep the typed text as "Not applied" at the field.

## Implementation (H1)

Done 2026-11-26. Code: the `recessedCountersink` head in [`hole.ts`](../../src/core/design/hole.ts) (record, invariants, expansion, `recessDiameter`), its build in [`hole-commands.ts`](../../src/core/design/hole-commands.ts), `DEFAULTS.recessLedge` / `recessDepth` in [`operation.ts`](../../src/core/design/operation.ts). Tests: [`recessed-countersink.test.ts`](../../src/core/design/recessed-countersink.test.ts); headless exit [`exit-criteria.recessed-countersink.test.ts`](../../src/main/cli/exit-criteria.recessed-countersink.test.ts) with its golden `exit-criteria-recessed-countersink-m5.nc`; hidden e2e [`recessed-countersink.e2e.ts`](../../e2e/recessed-countersink.e2e.ts).

- **Record:** `type: 'recessedCountersink'` stores `cbDiameter`, `cbDepth`, `csDiameter`, `csAngle` (all required); `csMethod` / `csStepdown` are refused (`notForType`): the cone is cut by a chamfer mill only, stepped stays type `countersink`. Records of the other types are byte-identical; no `schemaVersion` change.
- **Expansion:** `counterbore` (circle pocket `cbDiameter` × `cbDepth` on the face, flat floor) → `drill` on `<id>_counterbore.floor` (depth `depth − cbDepth`, the B5 tolerance rule, or through) → `countersink` (chamfer `edgeOf` `<id>_drill`, `on` `<id>_counterbore.floor`, width (`csDiameter` − `diameter`) / 2). Role ids stay those of [A3](features.md#expansion-and-owned-operations), so the owned recess is named "Bolt hole 1 · counterbore"; the inspector's Tools row calls it "Recess". Its tool follows the drill role's end mill as any counterbore's ([`followsHole`](design-v0.4.md#counterbore-tool)).
- **Defaults and refill:** `csDiameter` and `csAngle` from the table as for `countersink` (ISO 10642 dk + 2 × `headSink`, 90°). `cbDiameter` = `csDiameter` + the ledge (1 mm / 0.04″): refilled with the cone (a new fastener, purpose, fit or head sink), and following a hand-edited `csDiameter` while it still has the default width; an entered recess Ø is kept. `cbDepth` = 2 mm / 0.08″ and **never refilled** (it is the user's recess). Without a fastener `csDiameter` is required (`csAngle` 90°, the recess as above).
- **Rules:** `cbDiameter` ≥ `csDiameter` (`atLeastCsDiameter`; equal allowed), `cbDepth` > 0 (`positive`), `csDiameter` > `diameter`, and for a blind hole `cbDepth` + cone < `depth` (`countersinkTooDeep`, params gain `cbDepth`; `max` is the widest cone that fits below the recess). The angle range is the owned chamfer's (as countersink).
- **`dfm.holeCustomSize`:** `diameter`, `csDiameter` and `csAngle` against the table; the recess never (no standard sizes it).
- **Construction surface (DF118):** with `cbDiameter` = `csDiameter` the recess floor has no triangles left; the drill and the countersink are its only consumers and both are its dependants, so `construction` lists `hole1_counterbore.floor` and there is no `dfm.surfaceCutAway`. The default ledge keeps the floor.
- **Inspector** (H3 adds the slot): Type option "Recessed countersink" (a fourth segment labelled "Recessed", full name as its accessible name and tip via `SegmentedOption.fullLabel`; icon `hole-recessed-countersink`), Sizes Diameter, Bottom, **Recess Ø** (step `small`), **Recess depth** (`depth`), Countersink Ø, Countersink angle; the Tools row "Recess"; the section draws the recess step and the cone on its floor with the countersunk head in it ("Section: Ø 5.5 mm through; recess Ø 12.6 mm, 2 mm deep; countersink Ø 11.6 mm, 90°; M5 head 2.2 mm below the face."). The navigator read-out is "M5 · recessed countersink" (the slot part of the read-out comes with H2/H3).
- **Agent API:** `recessedCountersink` in the `type` enum and "recess" in the `cb*` descriptions: `tools/list` 112,204 → **112,308** chars (+104, 145 tools; [llm-api.md](../architecture/llm-api.md#implementation-task-310)).
- **Plan and program** (M5 through a 10 mm board, Flat 3 and a 90° chamfer mill): the recess and the bore by helical boring with Flat 3, one tool change, the cone by the chamfer mill plunged to 2 + 5.8 mm below the face; streamed on the virtual machine to Idle.

## Implementation (H2)

Done 2026-11-26. Code: `Hole.slot` (`HoleSlot`: `length`, `rotation`), the `notForSlot` / `positive` rules in `holeInvariants`, `slotShape` / the slotted `drill` and `counterbore` in `expandHole`, `slotTooLong` and `materialBelow` in [`hole.ts`](../../src/core/design/hole.ts); the args and `notForRound` in [`hole-commands.ts`](../../src/core/design/hole-commands.ts); `toolSuitsKind` in `materialize` ([`feature.ts`](../../src/core/design/feature.ts)), fed a specific tool's type from its snapshot by `placeFeature` ([`feature-commands.ts`](../../src/core/design/feature-commands.ts)). Tests: [`slotted-hole.test.ts`](../../src/core/design/slotted-hole.test.ts); headless exit [`exit-criteria.slotted-hole.test.ts`](../../src/main/cli/exit-criteria.slotted-hole.test.ts) with its golden `exit-criteria-slotted-recessed-countersink-m5.nc`.

- **Record:** `slotLength` and `rotation` are stored together, only for a slotted hole; a round hole's record is byte-identical (no `schemaVersion` change). `slotLength: 0` in an add or update makes the hole round (the add is then identical to one without it); a `rotation` without a slot is refused (`notForRound`). The rotation defaults to 0° and is kept when only the length changes.
- **Expansion:** as [§ Expansion of a slotted hole](#expansion-of-a-slotted-hole) for every type, including `recessedCountersink` (Round recess pocket, the slot pocket and the chamfer on its floor). The pockets are rectangles with `round: true`, `cornerRadius` half the width, `rotation` about the hole centre (centre anchor). A through slot is a [through pocket](patterns.md#implementation-p4) whose `depth` is the material below its face when expanded (below a recess: less `cbDepth`); a blind slot has a flat floor at `depth` (`depth − cbDepth` below a recess, the B5 tolerance rule). The countersink chamfer is a general-edge chamfer on the slot pocket's outline, width (`csDiameter` − `diameter`) / 2.
- **Rules:** `slotLength` > 0 (`positive`); `notForSlot` at `bottom` (`drillPoint`), `purpose` (`tapDrill`) and `csMethod` (`stepped`). **`slotTooLong`** (expansion, `model.invariant` at `slotLength`): the slot's widest outline (the recess or counterbore, else the bore), turned by `rotation`, is longer than its face in either face direction, so it can never be cut there; params `overall` and `max` (the longest travel that fits at that rotation). A slot that only reaches past the stock edge stays allowed (as an open-sided pocket).
- **Issue paths:** the owned pockets' `shape.length` maps to `slotLength`, `shape.width` / `shape.cornerRadius` to `diameter` or `cbDiameter`, `shape.rotation` to `rotation`.
- **Round ↔ slotted:** the `drill` role changes kind (drilling ↔ pocket) and surface (`hole1_drill.bottom` ↔ `.floor`; a reference to the old one fails with `design.referenced` as a disappearing role does). Its tool and lock are kept when the tool's type can cut the new kind (a pocket: flat or bull-nose end mill; a drilling: a drill or a flat end mill); otherwise the role goes back to auto (a drill bit never cuts a pocket). A specific tool's type comes from its snapshot.
- **Plan and program** (the user's case, M5 recessed countersink with `slotLength` 19.5 in a 10 mm board, Flat 3 and a 90° chamfer mill): the Round recess and the 25 × 5.5 slot by Flat 3 (the recess follows the slot's end mill, `followsHole`), one tool change, then the chamfer mill along the slot outline 2 + 3.05 mm below the face; streamed on the virtual machine to Idle. The core test builds the same hole from the user's operations (Round recess, Round slot on its floor, edge chamfer) and gets the same volume.
- **Agent API:** `slotLength` ("Travel; 0 = round") and `rotation` (an angle string, no description: the primer's operation-args line says rotation is CCW) on `design.hole.add` / `.update`: `tools/list` 112,308 → **112,496** chars (+188, 145 tools). These slices now total 506 of their 0.5 K budget (R1 214, H1 104, H2 188): 6 chars over, recorded in [llm-api.md](../architecture/llm-api.md#implementation-task-310); 7.5 K headroom under the 120 K cap.

## Implementation (H3)

Done 2026-11-26. Code: [`HoleInspector.tsx`](../../src/renderer/src/modes/design/HoleInspector.tsx) (Slotted switch, slot fields, Overall, the Slot tool row), `holeRecord`'s `slot`, `slotOverall`, `defaultSlotLength` in [`hole-view.ts`](../../src/renderer/src/modes/design/hole-view.ts), the slot section in [`hole-section.ts`](../../src/renderer/src/viewport/hole-section.ts), the read-out in [`feature-view.ts`](../../src/renderer/src/modes/design/feature-view.ts), the field icon `slotTravel`. Tests: the slotted cases in `HoleInspector.test.tsx`, `hole-view.test.ts`, `hole-section.test.ts`, `feature-view.test.ts`; hidden e2e [`slotted-hole.e2e.ts`](../../e2e/slotted-hole.e2e.ts) (dark captures reviewed).

- **Layout** ([§ Inspector layout](#inspector-layout)): the `Switch` field **Slotted** closes the Type group; Sizes shows, when Slotted, **Slot length** (step `xy`, (i) "Travel between the slot's end centres."), **Rotation** (step `rotation`, as the pocket's and profile's Rotation: the `angle` kind is for chamfer, countersink and point angles; the layout above said `angle`) and the read-only **Overall** ("25 mm", (i) "Slot length + diameter: the slot end to end.") right after Diameter. Rotation is in Sizes, as this doc lays out, not behind a More row. The Recess labels came with H1.
- **Switch:** on sends `slotLength` = 2 × the diameter (M5: 11 mm), off sends `slotLength: 0`; one undo step each. A refusal (a slot too long for the face) shows at Slot length (or at the switch).
- **Section:** drawn along the slot: the walls half the travel out, the screw at mid-travel, the diameters measured across the right end, the travel as the measured part `slotLength` between the end centres; label "Section along the slot: Ø 5.5 mm through, slotted: 19.5 mm travel, 25 mm overall; …".
- **Tools** names the slotted hole's `drill` role "Slot"; the navigator read-out reads "M5 · recessed countersink, slot 19.5".
- **Not built:** the viewport's slot centre line and travel dimension while the hole is selected (the selection outline shows the slot); a known issue in [hardening.md](../plans/hardening.md) DF119.

## Flagged for the user

Nothing is irreversible (optional fields, no migration). Two behaviour choices are accepted by delegation but are worth your veto:

1. **RC-B applies to agents too.** An agent that sends a too-large radius gets Round and an `adjusted` report, not an error. The alternative is to switch only in the UI and keep the refusal for agents.
2. **RC-B on size edits.** Narrowing a pocket so its existing radius no longer fits turns Round on, rather than refusing the size. You asked for it on the radius field; extending it to size edits keeps one rule.
