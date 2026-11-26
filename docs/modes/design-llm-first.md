# Design additions for the v0.4 follow-up: shape offset, placement scale, partial-depth profiles

Status: accepted by delegation (D70, 2026-11-26; the user can veto: [readiness review](../plans/v0.4-llm-first.md#readiness-review-2026-11-26); proposed 2026-11-22 from the [LLM-first black-box test](../plans/v0.4-llm-first.md#source), findings F6, F7, F10; milestone: the v0.4 follow-up, after v0.4 and before v0.5; [Q45–Q46](../plans/v0.4-llm-first.md#questions-for-the-user) take their recommendations). Built: DL-A ([Implementation (LF1)](#implementation-lf1)), DL-B ([Implementation (D2)](#implementation-d2)), their UI ([Implementation (U3)](#implementation-u3)), DL-C (hardening DF53) · Plan of record: [plans/v0.4-llm-first.md](../plans/v0.4-llm-first.md) · Base: [design-v0.3.md](design-v0.3.md) (shapes, placement, profiles), [shapes.md](../architecture/shapes.md) (2D port, resolution) · Toolpaths: [plan-v0.3.md](plan-v0.3.md) · Terms: [glossary.md](../glossary.md)

Small design gaps the black-box test hit while recreating the enclosure base. The two-step bottom edge relief needs the outline inset by 0.81 and 4.83 mm: no shape item did that, so the agent read the resolved arcs and computed concentric arcs itself (a 5.5 KB path). The step itself is a partial-depth outside cut, which profiles cannot do, so it became pockets of "rectangle minus inset outline", which then hit F3 and 16 noisy DFM warnings in the waste.

## Decisions

| Id   | Decision                                                                                                                                                                                  | Section                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| DL-A | **Offset is a shape item** that references another shape by id and follows its edits; no separate command or tool. Regions only, round corners on outward offsets (the 2D port's offset). | [Offset item](#offset-item)                       |
| DL-B | A **uniform `scale`** on the `named` shape placement of pockets and profiles; arcs stay exact.                                                                                            | [Placement scale](#placement-scale)               |
| DL-C | **Inside and outside profiles take a `depth`** like `on` grooves (null = through). A partial-depth outside profile is a rabbet or step along the outline; tabs only on through profiles.  | [Partial-depth profiles](#partial-depth-profiles) |
| DL-D | DFM corner and tool checks run only where the cut touches the **part's final solid**; corners in waste (offcut, frame) are not reported.                                                  | [DFM in waste](#dfm-in-waste)                     |

## Offset item

A new item kind in the [shape definition](design-v0.3.md#shape-definition) (the "Later: offset items" of v0.3):

| Item     | Parameters                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| `offset` | `shapeId` (another shape of the part), `distance` (length ≥ 0), `direction` (`outward` or `inward`), and `op` |

- **Resolution:** the referenced shape is resolved first (its region in its own shape frame), then offset through the 2D port's `offset(region, d)` ([shapes.md § 2D port](../architecture/shapes.md#2d-port); positive shrinks, so `inward` = +d, `outward` = −d), then folded with the other items by `op` as any item. The result lives in the referencing shape's frame at the same coordinates as the source (no move), so "outline inset 0.81" placed like the outline lands concentric with it.
- **Follows edits:** the item stores the reference, not the result; editing the source shape changes every shape that offsets it, and their operations go stale as usual (pending changes per [apply.md](../architecture/apply.md)). Resolution caches key on the source's definition hash too.
- **Rules** (`model.invariant`, path `shapes.<id>.items.<n>.<param>`): `unknownShape` (no such shape), `shapeCycle` (a shape that offsets itself through any chain), `offsetOpenPath` (the source resolves to an open path: path offsets are later), `shapeEmpty` (an inward offset that leaves nothing, the existing rule). A shape referenced by an offset item cannot be removed (`design.referenced`, as for operations).
- **Corners:** convex corners of an outward offset become arcs (the true offset curve, [glossary: Offset curve](../glossary.md)); inward offsets keep the source's arcs concentric and may split a loop into several (fine for a pocket; a profile refuses it with the existing `profileOneLoop`). Sharp (extended) offset corners are later.
- **Robustness:** the black-box test's region offsets failed at 4.83 and 5.00 mm and worked at 4.80 and 4.85 (`the 2D library returned an open loop`, `an offset hole lies in no outer loop`). Offset items lean on the same port call, so the port fix (plan task K-R: merge near-coincident arc ends before offsetting, retry with a nudged ε, never return a raw stack) lands first, with the test's shape as a regression fixture.
- **Commands:** none new. `design.shape.add` / `update` / `item.add` take the new item kind in their existing union (≈ 0.3 K of `tools/list`). UI: "Offset…" on a shape row's menu creates a new shape with one offset item (distance field, inward / outward), and the item shows in the Shape Editor list like any other ([ui.md](../conventions/ui.md) amendment).

### Implementation (LF1)

Built 2026-11-26 (slice LF1, plan task [D1](../plans/v0.4-llm-first.md#5-design)); core and agent API, the inspector's minimum (below).

- **Item:** `{ kind: 'offset', op, shapeId, distance, direction }` in the shape item union (`shape.dto.ts`); stored as given (no `schemaVersion` change: a new kind in an existing union). `shapeId` takes named shapes only (`shapeN`), never a feature's owned shape.
- **Resolution** (`shape.ts`): the resolver's definition carries each offset item's source **inlined** (`withOffsetSources`, recursively; a shape met again on the chain is `shapeCycle`, a missing one `unknownShape`). `definitionOf(items, shapes, self)` does it from a part's loaded shapes, so `resolveShape`'s cache key and the operations' geometry input hash include the source: editing the source re-resolves and restales without a separate dependency table. The part loader brings the sources of placed shapes along (`operation.ts`, beside pattern cells), as do pattern facts and engravings.
- **Rules** as above, at `items.<n>.shapeId` / `items.<n>.distance`, plus `nonNegative` for a negative distance; a cycle anywhere down the chain is reported on the item that starts it. A source that does not resolve keeps its issues under `items.<n>.shapeId`.
- **Source edits are checked against their dependants:** `design.shape.update` / `item.update` of a shape resolve every shape offsetting it (through any chain) with the new items; one that would no longer resolve (e.g. an inward offset left empty) refuses the edit with its issues at `shapes.<id>.items.<n>.<param>`.
- **`design.shape.item.update`** changes `distance`, `direction` and `op` of an offset item; its `shapeId` arg names the edited shape, so the source is changed by `design.shape.update` (replace the item list).
- **Pending changes:** a shape key targets the operations placing the shape or any shape offsetting it (`operationsUsingShape`, `shape-users.ts`). `design.shape.remove` of a source is `design.referenced` with an issue per offsetting shape (`shapes.<id>.items`).
- **UI (minimum until [U3](../plans/v0.4-llm-first.md#8-ui)):** the item shows in the Shape Editor's item list ("Offset 2 inward · shape1", the Path icon until [L1](../plans/v0.4-llm-first.md#8-ui)) with Source (read-only, the source's name, an (i) tip), Distance and Direction (Outward / Inward) in the inspector; no handles; the outline previews resolve the sources from the part's shapes. "Offset…" on a shape row and adding the kind from the Add menus are U3.
- **`tools/list`:** 111,202 → 111,599 chars (+397).
- **Tests:** `shape-offset.test.ts`: the offset oracle on the enclosure outline (0.81, 4.80, 4.83, 4.85, 5.00 mm inward, 3 mm outward, < 2.5 µm), outward corners as arcs, an offset subtracted as a ring; inward/outward through the commands; follow-edit (placed outline, input hash, pending targets); `unknownShape`, `shapeCycle` (direct and self), `offsetOpenPath`, `shapeEmpty`, `nonNegative`; a source edit refused for its dependant; remove refused while referenced.

### Implementation (U3)

Built 2026-11-26 (plan task [U3](../plans/v0.4-llm-first.md#8-ui)); renderer only, no command or `tools/list` change. Decisions taken by delegation (D70):

- **"Offset…" on a shape row** (Shapes dialog and the Shape Editor window's list, `ShapeList`): the row's context menu ([ui.md decision 27](../conventions/ui.md#decisions)) lists "Offset…" above Remove. It opens the **"Offset…" dialog** (`OffsetDialog.tsx`, title "Offset Shape 1"): Distance (length, starts at 2 mm / 0.1 in, step kind `small`, illustration `offsetDistance`) and Direction (Outward / Inward, starts Outward: an outward offset never leaves nothing). "Create offset" sends one `design.shape.add` named "<source> offset" with one offset item (`op` add) and opens the new shape in the Shape Editor window. The entry is `aria-disabled` with its reason for an open path ("An open path cannot be offset yet.", `offsetOpenPath`) and for a shape that does not resolve.
- **"Add item" → "Offset…"** in the Shape Editor (after a separator below the drawn kinds): the same dialog with a Source select (closed, resolving named shapes other than the edited one; the first preselected; none: "No other closed shape to offset." and the action disabled). "Add item" sends one `design.shape.update` with the item appended and selects it. The other Add menus (operation shape picker, "Add shape") do not offer it: the row menu is where a source is chosen.
- **Refusals stay in the dialog** (`ErrorMessage` "The offset was not made" with the core's issues, e.g. `shapeEmpty` for an inward offset that leaves nothing, `shapeCycle`); nothing is written and the user corrects the values.
- **Item row:** names the source by its shape name ("Offset 3 inward · Shape 1"), not its id. The Source field stays read-only: a different source is a new item (remove, then "Add item" → "Offset…"), which keeps `design.shape.item.update` without a `shapeId` change.
- **Scale field** (D2's field under Mirror) keeps its place in the Shape group (a non-default scale must never hide behind More) and gets its own illustration `scale` (shape and dashed scaled copy from one corner; [ui.md § Field](../conventions/ui.md#field): one illustration per meaning) and an (i) tip; step kind `scale` ([inspector-layout.md § Step assignment](../conventions/inspector-layout.md#step-assignment-per-field)).
- **Profile depth for all sides** was DF53 (hardening); nothing new here.
- **Tests:** `Shape.test.tsx` (row "Offset…" → new shape and its item row, open path disabled with the reason, "Add item" → "Offset…" with a refused inward offset kept in the dialog, axe on the dialog), `OperationShape.test.tsx` (Scale field: illustration, a factor stored); e2e `shape-editor.e2e.ts` (shape row → Offset… → the item in the Shape Editor list → used by a pocket, scaled; with `DFYOM_RENDERS=1` dark renders `u3-*-dark.png`).

## Placement scale

`shape: { kind: 'named', shapeId, center, rotation?, mirror?, scale? }` on pockets and profiles: `scale` is a positive scalar quantity (default 1), applied about the shape's anchor point before rotation and mirror ([shapes.md § Resolving a shape](../architecture/shapes.md#resolving-a-shape), step 4). Lines and arcs scale exactly (centres and radii times the factor). Tab positions given as distances along the loop scale with it. Rule `positive` (`model.invariant`). This covers "the same outline 2 % larger" and reference models in the wrong unit without a new shape; non-uniform scale stays out (it turns arcs into ellipses).

### Implementation (D2)

Built 2026-11-26 (plan task [D2](../plans/v0.4-llm-first.md#5-design)); core, agent API and a plain inspector field.

- **Model:** `scale` (a plain number, 0 < scale ≤ 1000, absent = 1) moved from the Line path into the `named` placement itself (`part.dto.ts`, `operation.ts`), so a Line path, a pocket and a profile share it; a number rather than a scalar quantity, as the Line path's (DF113 E2) already was. Written only when set and not 1: unscaled records stay byte-identical; no `schemaVersion` change.
- **Placement:** the scale is part of the orientation (`Orientation.scale` in `geometry/2d/place.ts`, `shapeOrientation` in `placement.ts`): the resolved shape is scaled about the shape frame's origin with the mirror and rotation, centres and radii times k (exact arcs), then anchored by its placed box as before, so the anchor point stays at `center`. Every reader of the placed shape (solids, surfaces, DFM and tool fit, toolpaths, `placed` bounds, re-anchoring, the Shape Editor's placement) gets it from there; the Line's separate post-placement scaling is gone (the same geometry; Line tests and goldens unchanged). Oriented shapes are cached per scale too.
- **Commands:** `design.pocket.*` / `design.profile.*` `shape: { kind: 'named', …, scale? }`. Refusals are `model.invariant` at `shape.scale`: `positive` (≤ 0) and `max` (> 1000). An update whose shape arg leaves `scale` out drops it, as for `mirror`. A shape that no longer fits the tool after scaling gets the usual DFM warnings (nothing scale-specific).
- **Tabs:** stored `tabs.positions` stay distances along the placed loop; a profile update that changes the scale (and gives no positions) multiplies them by new / old scale, so the tabs stay at the same places on the shape.
- **Split:** a scaled pocket or profile crossing a split line keeps its scale in the piece; the clip rectangle and key items are written in the shape frame (÷ k).
- **UI (minimum until [U3](../plans/v0.4-llm-first.md#8-ui)):** a Scale field under Mirror in the Shape group of a pocket or profile placing a named shape (empty or 1 = unscaled); the Shape Editor's handles follow the scale (`ShapePlacement.scale`).
- **`tools/list`:** 112,496 → 112,636 chars (+140): `scale` ("About the anchor; default 1") on the add tools' named shape; the update tools sketch `shape`.
- **Tests:** `placement-scale.test.ts`: exact arcs and the fixed anchor (centre; corner with rotation and mirror), scale 1 not stored, the refusals, tab distances scaling, a tool-fit warning on a shape scaled down, a split of a scaled pocket equal to the same shape drawn larger.

## Partial-depth profiles

- `depth` (length, `null` = through) is allowed for every profile side, not only `on` ([design-v0.3.md § Cut side](design-v0.3.md#cut-side-and-open-shapes)). The removal solid is the existing slot band (loop to its offset by the slot width, outward for `outside`, inward for `inside`) from `on` down to `depth`; a blind profile adds a `profile.floor` surface at its depth, like a blind groove.
- **Rabbet / step:** an outside profile with a depth where the band reaches the stock edge or another removed region is a rabbet. The DFM check `dfm.profileBandLeft` (info) says when a thin wall of stock stays outside the band ("a 0.5 mm skin stays outside Profile 2; widen the slot or use a pocket"), so the user knows the profile does not clear the whole step.
- **Tabs** only on through profiles: `tabs` with a `depth` is refused (`tabsOnBlind`).
- **Toolpaths:** the profile generator already cuts in levels down to the operation's depth ([plan-v0.3.md § Profile on general loops](plan-v0.3.md#profile-on-general-loops)); a blind profile stops at `depth` with the finishing pass there and no breakthrough.
- In the black-box test this replaces two "rectangle − keep-outs − inset outline" pockets by two outside profiles of the offset items, from the bottom, 1.77 and 4.19 mm deep.

## DFM in waste

- `dfm.cornerSharp`, the tool-fit checks and `dfm.reach` are evaluated only on boundary pieces of the removal that lie on the part's final solid (the evaluated part minus [offcut](../glossary.md) and [loose pieces](../glossary.md)); a corner whose both edges lie in waste is skipped. The check classifies by the 2D removal region against the part's final outline on that face, so it stays within the resolve budget.
- `dfm.shapeOutsideFace` becomes `info` when the overhang lies wholly in waste (an intended overrun).
- Message fixes: every DFM and plan message names its operation by name and id; `dfm.retainedRemoved` reports what remains (e.g. "Pocket 3 lowers tabs 1–4 of Profile 1 from 8 mm to 2.8 mm") and says which one to change.

### Rule as built (D4, slice LF3)

Code: `src/core/geometry/waste.ts` (`faceWaste`), used by `dfm.ts`, `tool-fit.ts` (`toolFit`'s `waste`) and `shape-measure.ts` (`wallCorners`).

- **[Waste](../glossary.md) of a face:** the through profiles (no `depth`; `inside` or `outside`, closed loop) of the operation's direction or the opposite one cut the whole extent along that axis, so their loops are the part's outline on that face (mapped into the operation's face frame). Waste is what lies outside every outside profile's loop (the frame; several outside profiles are several parts) or inside an inside profile's loop (the slug), except a part cut out inside that opening. No such profile: nothing is waste and every check runs as before. Blind profiles (steps, rabbets), `on` grooves, profiles of other axes and through pockets do not bound the part; loose pieces are not waste here (they need the evaluation, and `dfm.loosePiece` already reports them).
- **Corners** (`dfm.cornerSharp`, `dfm.cornerTooSmall`, and `dfm.toolUnfit` rule `cornerRadius`): a corner does not count when the leftover a tool of radius r leaves there lies wholly in waste: its point lies off the part by at least r · spread (DF53's open-corner measure; r the smallest end mill for the library checks, the own tool for the fit rule; with no end mill, strictly off the outline). A corner on the outline or on the part warns as before. v0.1 rectangles test their four corner points the same way.
- **Rest material:** `dfm.restMaterial` leaves out pieces whose marker lies at least the tool radius into waste.
- **Wholly in waste:** a pocket or drilling whose removal region has no area on the part (2D port; without the port this is never assumed) gets none of `dfm.cornerSharp`, `dfm.cornerTooSmall`, `dfm.pocketNoToolFits`, `dfm.pocketDeepNarrow`, `dfm.restMaterial`, `dfm.reach`, nor `dfm.toolUnfit` for the rules `cornerRadius`, `width`, `reach` and `flutes` (a hold-down screw hole or a clamp pocket in the frame). Still reported: a wrong tool type, `floorRadius`, `dfm.holeNoTool`, `dfm.holeDeep`, `dfm.floorRadiusNoTool`, and everything of a cut that touches the part (reach is the whole operation's, so a pocket across the outline still gets it).
- **Messages:** a design warning's `message` starts with its operation's name and id ("Pocket 1 (pocket1): a sharp inside corner …", `namedMessages` in `src/core/design/warnings.ts`, parameter and geometry warnings), and the other operation in `params.by` (`dfm.retainedRemoved`'s remover) reads "Pocket 2 (pocket2)" too; the UI already names operations from `params` (DF43).
- **Plan messages** (`namedPlanMessages`, `src/core/plan/labels.ts`): every finding of `plan.warning.list` with a `planOperationId`, and the `plan.check` / `plan.order` failure of toolpath generation and export, starts with the plan operation's label and id ("Drilling 1 (planOp-3): spindle speed has no entered, preset or calculator value"); a message that already starts with the label gets the id after it ("Witness mark 1 (planOp-7) cuts the part"). The app shows each finding at its operation, so `findingText` drops that head again (`withoutOperationName`).
- **`dfm.retainedRemoved` says what remains:** for tabs, the height the cut leaves where it reaches in from the tab's top or bottom (the intersection's extent along the face normal, from its mesh), as "profile1: pocket2 lowers tabs 1–4 from 3 mm to 0.5 mm (120.0 mm³); change pocket2: make it shallower or move it off the tabs" (named: "Profile 1 (profile1): Pocket 2 (pocket2) lowers …"); over the whole height "cuts through tabs 1–4"; a cut that touches neither end, or a floor fillet, "cuts into the floor fillet … change pocket2: move it off the fillet". `params` add `height` and `remains` (mm) when a tab is lowered or cut through. The one to change is always the remover: a tab or fillet is placed on purpose. The UI words it from those params.
- **`dfm.shapeOutsideFace` in waste:** the overhang beyond the stock is never on the part, so DF53's rule already is the waste rule: `info` ("an open-sided pocket") while any of the shape lies on the face, with no corner, tool-fit or reach findings when the rest lies in the frame (above); a `warning` only when the shape lies wholly off the face (it cuts nothing). Tested in `dfm-waste.test.ts`; no code change.
- **Not changed:** the plan's own corner check (`plan/shape-checks.ts`) and the design's tool choice (`tool-choice.ts`) still count corners in waste, so they may pick or ask for a smaller tool than needed there; harmless (a smaller tool still cuts), left as a follow-up ([Not yet](#not-yet)).
- Acknowledging single warnings (`design.warning.ack`) is not in this milestone ([Q45](../plans/v0.4-llm-first.md#questions-for-the-user)): noise is fixed at the source first.

## Testing

- Offset items: the offset oracle ("every output point lies exactly |d| from the input", the port's existing oracle) on the enclosure outline at 0.81, 4.80, 4.83, 4.85 and 5.00 mm inward and 3 mm outward; follow-edit (edit the source, the offset shape's region changes, operations go stale); cycle, open path and empty refusals; remove refused while referenced.
- Scale: exact arcs after scale; anchor stays fixed; tab distances scale (`src/core/design/placement-scale.test.ts`, [Implementation (D2)](#implementation-d2)).
- Partial-depth profiles: removal solid volume, floor surface, toolpath levels stop at depth (golden), `tabsOnBlind`.
- DFM in waste: the black-box test's bottom pockets with keep-outs produce no `cornerSharp` in waste; corners on the part still warn. Unit tests per finding (in waste silent, on the part warns) in `src/core/geometry/dfm-waste.test.ts`; the enclosure flow itself follows with X1 (it needs D1's offset items).

## Not yet

| Item                                                | Why / where                                      |
| --------------------------------------------------- | ------------------------------------------------ |
| Offsets of open paths (one-sided parallel path)     | After region offsets prove out                   |
| Sharp (extended) offset corners                     | Needs miter rules; round corners cover the cases |
| Non-uniform scale, mirror by an axis other than `u` | Arcs become ellipses                             |
| A step / rabbet operation of its own                | Partial-depth profiles first                     |
| `design.warning.ack`                                | Q45                                              |
| Waste in the plan corner check and the tool choice  | A smaller tool than needed is harmless (D4)      |
