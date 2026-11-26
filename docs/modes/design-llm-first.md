# Design additions for the v0.4 follow-up: shape offset, placement scale, partial-depth profiles

Status: draft (proposed 2026-11-22 from the [LLM-first black-box test](../plans/v0.4-llm-first.md#source), findings F6, F7, F10; milestone: the v0.4 follow-up, after v0.4 and before v0.5; decisions below are proposals until the user answers [Q45–Q46](../plans/v0.4-llm-first.md#questions-for-the-user)) · Plan of record: [plans/v0.4-llm-first.md](../plans/v0.4-llm-first.md) · Base: [design-v0.3.md](design-v0.3.md) (shapes, placement, profiles), [shapes.md](../architecture/shapes.md) (2D port, resolution) · Toolpaths: [plan-v0.3.md](plan-v0.3.md) · Terms: [glossary.md](../glossary.md)

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

## Placement scale

`shape: { kind: 'named', shapeId, center, rotation?, mirror?, scale? }` on pockets and profiles: `scale` is a positive scalar quantity (default 1), applied about the shape's anchor point before rotation and mirror ([shapes.md § Resolving a shape](../architecture/shapes.md#resolving-a-shape), step 4). Lines and arcs scale exactly (centres and radii times the factor). Tab positions given as distances along the loop scale with it. Rule `positive` (`model.invariant`). This covers "the same outline 2 % larger" and reference models in the wrong unit without a new shape; non-uniform scale stays out (it turns arcs into ellipses).

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
- **Messages:** a design warning's `message` starts with its operation's name and id ("Pocket 1 (pocket1): a sharp inside corner …", `namedMessages` in `src/core/design/warnings.ts`, parameter and geometry warnings); the UI already names operations from `params` (DF43). Plan messages, `dfm.retainedRemoved`'s "what remains" text and `dfm.shapeOutsideFace` in waste are not built yet (D4 stays open for them).
- **Not changed:** the plan's own corner check (`plan/shape-checks.ts`) and the design's tool choice (`tool-choice.ts`) still count corners in waste, so they may pick or ask for a smaller tool than needed there; harmless, revisit with the plan message fixes.
- Acknowledging single warnings (`design.warning.ack`) is not in this milestone ([Q45](../plans/v0.4-llm-first.md#questions-for-the-user)): noise is fixed at the source first.

## Testing

- Offset items: the offset oracle ("every output point lies exactly |d| from the input", the port's existing oracle) on the enclosure outline at 0.81, 4.80, 4.83, 4.85 and 5.00 mm inward and 3 mm outward; follow-edit (edit the source, the offset shape's region changes, operations go stale); cycle, open path and empty refusals; remove refused while referenced.
- Scale: exact arcs after scale; anchor stays fixed; tab distances scale.
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
