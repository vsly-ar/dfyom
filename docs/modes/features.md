# Design features: parametric groups of operations

Status: draft (backlog B23; assumptions below await the user's confirmation, [Questions for the user](#questions-for-the-user)) · Design: [design.md](design.md), [design-v0.2.md](design-v0.2.md) · Apply: [apply.md](../architecture/apply.md) · Plan: [plan-v0.1.md](plan-v0.1.md#plans-are-snapshots) · Shapes: [roadmap v0.3](../roadmap.md#v03--shapes), [ADR 0019](../decisions/0019-2d-geometry-library.md) · Terms: [glossary.md](../glossary.md)

The user's request (B23): "Features create and combine operations (bolt hole with counterbore, no thread; pattern with optional chamfers; engraving; text…) + a backlog of features." [design.md § Workflow](design.md#workflow) already names features as "groups of operations" and [§ Ordering and composition](design.md#ordering-and-composition) reserves a "repeat" feature; this doc drafts the concept. Nothing here is implemented, and every decision is an **assumption** until the user confirms it.

## Feature vs operation

|                  | Operation (today)                                                                                                  | Feature (new)                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| What it is       | One cutting action: one removal region, its surfaces, one [tool field](design-v0.2.md#operation-tool)              | A named design element the user thinks in ("M5 counterbored hole", "bolt circle of 6"), stated by its result      |
| Parameters       | Geometry of one cut (`shape`, `depth`, `diameter`, …)                                                              | Intent: hole type and size, fastener, pattern count and pitch, chamfer size, text and font                        |
| Makes geometry   | Directly (`part = stock − ∪ removal(op)`, [geometry.md](../architecture/geometry.md))                              | Never directly: it **generates** operations, and only they make geometry                                          |
| Downstream       | Geometry, DFM, auto tool choice, Plan, surface ids, references                                                     | Unchanged: all of them see the generated operations only                                                          |
| Examples (kinds) | `facing`, `pocket`, `drilling`, `profile`; later chamfer, engraving, V-carving ([candidates](#candidate-features)) | `hole` (simple, counterbore, countersink), `pattern` (linear, grid, circular), `edgeChamfer`, `text`, … (backlog) |

**Rule:** a feature is a pure function of its parameters, its face target and the part's earlier state to an ordered list of operations (its **expansion**). It adds no geometry, tool or toolpath logic of its own; a feature that needs a new kind of cut first gets that **operation** (e.g. a chamfer operation and a chamfer-mill tool type before countersinks and edge chamfers).

## Expansion and owned operations

Assumptions A1–A6:

1. **A1 – Materialized, owned operations.** The expansion is stored: generated operations sit in the part's operation list like any other, each with `featureId` and `featureRole` (e.g. `hole1` / `counterbore`). They are the feature's **owned operations**. Geometry input, DFM, the auto tool choice, Apply, Plan and surface references therefore work on operations exactly as today. (Rejected: deriving the operations on every read, which would touch every consumer and give owned operations no place for their tool lock.)
2. **A2 – Regenerated in the same command.** `design.<featureKind>.add` / `.update` run the expansion inside the command (one undo step) and replace the owned operations by role. Expansion is cheap, deterministic and decides nothing on the user's behalf, so it is an **instant** reaction ([apply.md § Rules for new reactions](../architecture/apply.md#rules-for-new-reactions)); the auto tool choice of the owned operations still waits for Apply.
3. **A3 – Stable ids by role.** An owned operation's id is `<featureId>_<role>` (`hole1_drill`, `hole1_counterbore`); pattern instances add the instance number (`pattern1_3_drill`, instance 1 = the seed). Underscores are valid in [expression names](../architecture/quantities.md#expressions-and-references), so surface ids stay `<operation id>.<role>` (`hole1_counterbore.floor`). A role that survives a parameter change keeps its id, so references, plan operations and tool locks survive; a role that disappears removes its operation and fails with `design.referenced` if a later operation references it, as [`design.operation.remove`](design.md#commands-and-queries-v01) does.
4. **A4 – Owned geometry is read-only.** The owned operations' geometric parameters are edited only through the feature. Each owned operation keeps the fields that are not part of the feature's definition: its **tool field** (pick, lock, unlock per operation), its `generalTolerance` and its display `name`; they survive regeneration by role. No per-field geometric overrides in the first version ([Q1](#questions-for-the-user)).
5. **A5 – Explode.** `design.feature.explode` turns the owned operations into plain operations (drops `featureId`/`featureRole`, keeps ids and values) and removes the feature: one undo step. This is the way out when a user needs an edit the feature does not offer (industry: "explode" / "dissolve").
6. **A6 – One nesting level.** A pattern's seed is either an operation or a non-pattern feature (a bolt circle of counterbored holes); a pattern of patterns is not allowed. Other features do not nest.

### Order and references

- A feature occupies one position in the [design order](design.md#ordering-and-composition); its owned operations are contiguous there, in the order its kind defines (counterbore: the counterbore pocket, then the hole `on` its floor). `design.operation.move` on an owned operation is refused; `design.feature.move` moves the block.
- The feature's `on` is a [face target](design-v0.2.md#face-targets-generalised-on) and its position is `[u, v]` in that [face frame](design-v0.2.md#face-frame) with a [placement anchor](design-v0.2.md#placement-anchors), like a pocket. Owned operations reference the feature's face and each other only; later operations may reference owned surfaces (`hole1_counterbore.floor.z`).
- Feature parameters are quantities and may be expressions over earlier surfaces, as operation parameters are.

### Validation and DFM

- Feature invariants are `model.invariant` on the feature's fields (counterbore diameter > hole diameter, counterbore depth < hole depth, pattern count ≥ 1, instances inside the face). Check order: feature fields → expansion → the existing operation checks of [design.md § Implementation](design.md#implementation-task-25), with issue paths mapped back to the feature field where the expansion knows it.
- DFM warnings stay per owned operation (codes unchanged); the navigator rolls them up on the feature row, and the feature inspector shows them at the feature field that drives the parameter.

## Patterns

The "repeat" of [design.md](design.md#ordering-and-composition) becomes the **pattern** feature (industry term), still "never list parameters on an operation":

- **Kinds:** linear (count, pitch or extent, direction `u`/`v`), rectangular grid (two directions), circular / bolt circle (count, pitch circle diameter, start angle, full circle or angle), later mirror and along a path (v0.3 shapes).
- **Seed:** an existing operation or feature (A6). Making a pattern from an existing one moves it into the pattern as instance 1 (one undo step).
- **Skip instances:** `skip: number[]`; a skipped instance generates nothing and keeps its number, so the other instances keep their ids.
- **Rotation:** circular patterns rotate each instance. Circles and holes need nothing new; rotated rectangles need [v0.3 shape rotation](../roadmap.md#v03--shapes), so until then a circular pattern only accepts rotation-invariant seeds (drilling, circular pocket, round holes).
- "Pattern with optional chamfers" is read as: the seed's own options (a hole's chamfer) are repeated with it ([Q6](#questions-for-the-user)).

## Plan

- Plan sees **operations only**: the [design snapshot](plan-v0.1.md#plans-are-snapshots) copies the part, features included, but plan operations are built from operations as today. Equal holes from a pattern group into one plan operation by the existing grouping key.
- [Plan-only edits](plan-v0.2.md#plan-only-edits-and-the-snapshot-scene) work per owned operation (they edit the snapshot's operations); the feature in the snapshot is informational. A rebuild discards them as today.
- The plan navigator may label plan operations with their feature name ("Counterbore 1 · hole"); no feature logic in Plan ([Q9](#questions-for-the-user)).

## Apply and pending changes

- **Pending keys** ([apply.md § What is pending](../architecture/apply.md#what-is-pending)) for a feature are `(part, feature, field)` for its own fields and `(part, feature)` for add, remove and move; changes of its owned operations caused by the expansion fold into these keys, so changing a pattern from 4 to 6 instances counts **1**, not 12. Owned-operation fields the user edits directly (tool unlock) keep their per-operation keys.
- The [auto tool choice](design-v0.2.md#auto-choice) on Apply targets every unlocked owned operation of a feature with pending changes, plus new owned operations.
- The tooltip lists features by name ("Counterbore 1: diameter · Pattern 1 added").

## Undo

One feature command is one undo step, the expansion included: add, update, remove (removes its owned operations), move, explode. An adjust-popover session on a feature field is one [gesture](../architecture/commands.md#gestures-live-edits) as for operations. Undoing a feature update restores the owned operations by their inverse patches; the expansion is never re-run on undo or redo (handlers are not re-run, [commands.md](../architecture/commands.md#undo--redo)).

## Persistence (high level)

- The part record gains an optional `features: FeatureDTO[]`; every operation gains optional `featureId?` and `featureRole?`. A `FeatureDTO` is a union on `kind` with `{ id, kind, name, on, anchor?, generalTolerance?, …parameters }` (quantity DTOs as for operations). Absent fields mean "no features", so existing projects load unchanged; **no `schemaVersion` change** ([CLAUDE.md](../../CLAUDE.md) pre-alpha rule).
- Ids follow [design.md § Implementation](design.md#implementation-task-25): kind prefix + number (`hole1`, `pattern1`, `chamfer1`, `text1`), default names "Hole 1", "Pattern 1". Owned operation names default to "<feature name> · <role>" ("Hole 1 · counterbore").
- Consistency: an operation whose `featureId` names no feature, or a feature whose owned set differs from its expansion, makes the part `input.malformed` (corruption, never repaired silently). A fastener table version is not stored: chosen sizes are stored as values.

## Commands (sketch)

Per-kind, like operations, so each has a typed schema for agents ([commands.md § Naming](../architecture/commands.md#naming)): `design.hole.add` / `.update`, `design.pattern.add` / `.update` (`{ seed: operationId | featureId, … }`), later `design.edgeChamfer.*`, `design.text.*`. Shared: `design.feature.remove`, `.move`, `.explode`; queries `design.feature.list`, `design.feature.get`. Results carry `{ featureId, operationIds, warnings }`. MCP and CLI get them from the command layer ([llm-api.md](../architecture/llm-api.md)).

## UI (sketch)

- **Navigator:** a feature row (feature icon, name, rolled-up warning badge) with its owned operations nested below, collapsed by default, as plan operations nest under setups ([ui.md § Design and plan controls (v0.2)](../conventions/ui.md#design-and-plan-controls-v02)). "Add operation" becomes "Add" with two groups: Operations and Features.
- **Feature inspector:** its parameters with dynamic illustrations ([principle 5](../principles.md#5-user-friendly-beginner-friendly-highly-graphical): a counterbore section drawn with the entered sizes, a bolt circle preview). Selecting an owned operation shows its fields read-only with "Edited through Hole 1" (a link) and "Explode feature…", except its tool field.
- **Viewport:** selecting a feature highlights all owned operations; clicking a surface selects the owned operation, a second click (or the breadcrumb) its feature.

## Relation to ADR 0019 and v0.3 shapes

- **Hole, counterbore and patterns of circles** need nothing from [ADR 0019](../decisions/0019-2d-geometry-library.md): they expand to v0.2 circles and drillings.
- **Edge chamfers along pockets and profiles of any shape, dogbone corner reliefs, text and engraving** need v0.3 shapes: offset loops of lines and arcs (CavalierContours) and, for text, glyph outlines turned into arcs like SVG Béziers (biarcs, ADR 0019 consequences). They follow v0.3.
- **New operations first:** countersink and edge chamfer need a chamfer operation and a chamfer mill / V-bit tool type ([library.md](../architecture/library.md#tool) lists them as later); text and engraving need the engraving / V-carving operations of [design.md § Carving and engraving](design.md#carving-and-engraving-later).

## Candidate features

Prioritised by value for the [target users](../vision.md) and by what they need first.

| #   | Feature                                                   | One line                                                                                                                        | Needs first                                            |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | **Hole: counterbore** (the user's "bolt hole, no thread") | Through or blind hole plus a coaxial flat-bottom counterbore for a socket head cap screw; sizes custom or from a fastener table | Nothing (drilling + circular pocket)                   |
| 2   | **Pattern: linear, grid, circular (bolt circle)**         | Repeats an operation or a feature by count and pitch or on a pitch circle; skip instances                                       | Nothing for round seeds; v0.3 rotation for others      |
| 3   | Hole: simple, from a fastener table                       | Clearance hole by screw size and fit (ISO 273 close / normal / loose, inch equivalents); threaded-insert pilot sizes            | A small built-in table ([Q5](#questions-for-the-user)) |
| 4   | Hole: countersink                                         | Hole plus a conical countersink (82° / 90°) for flat head screws                                                                | Chamfer operation, chamfer-mill / V-bit tool type      |
| 5   | Edge chamfer / edge break                                 | 45° (or any angle) chamfer along the top edge of a hole, pocket or profile; the "optional chamfer" of other features            | As 4; any shape after v0.3                             |
| 6   | Mirror                                                    | Mirrors an operation or feature about a face-frame axis line (a pattern kind)                                                   | Nothing for symmetric seeds; v0.3 for others           |
| 7   | Dogbone / T-bone corner relief                            | Corner reliefs so square parts fit routed pockets and slots (joinery, inlays)                                                   | v0.3 shapes                                            |
| 8   | Text                                                      | Text in a font, engraved on its centreline (single-line font) or V-carved / pocketed (outline font), on any face target         | v0.3 shapes, engraving and V-carving operations        |
| 9   | Engraving from vectors                                    | SVG paths engraved or V-carved as one feature                                                                                   | As 8, plus v0.3 SVG import                             |
| 10  | Dowel / reamed hole                                       | Tight-tolerance hole: undersize drill plus helical bore or ream                                                                 | Tolerance-driven tool choice                           |
| 11  | Keyhole / hanging slot                                    | Slot with an undercut for a screw head                                                                                          | Keyhole cutter tool type, side-cut operation           |
| 12  | Threaded hole (thread milling)                            | Tap drill plus thread milling; explicitly out of scope now ("no thread")                                                        | Thread mill tool type, helical thread toolpath         |
| 13  | Finger / box joint                                        | Edge joinery of two parts                                                                                                       | Several parts per project, v0.3 shapes                 |

## Questions for the user

Each with the recommendation this draft assumes.

1. **Owned operations: read-only, or editable with per-field overrides?** Recommendation: read-only geometry, own tool field, tolerance and name per owned operation, plus Explode (A4, A5). Overrides that survive regeneration are hard to show and to reason about; add them later only for a concrete case.
2. **Store owned operations or derive them on read?** Recommendation: store them with `featureId` (A1), so every consumer stays unchanged.
3. **Pattern of features?** Recommendation: yes, one level (A6): a bolt circle of counterbored holes is the common case.
4. **Pending count per feature field?** Recommendation: yes (4 → 6 instances is "1 change").
5. **Fastener tables in the hole feature?** Recommendation: yes, a small built-in table (ISO metric M2–M12 socket head and flat head, inch #4–1/2″; clearance close / normal / loose; counterbore and countersink sizes), values copied into the feature and always editable; a fastener library later.
6. **"Pattern with optional chamfers":** a repeat pattern whose seed may carry a chamfer (assumed), or a decorative surface pattern (texture)? Recommendation: the former; decorative patterns would be a carving feature later.
7. **Converting existing operations:** pattern from an existing operation, yes; a general "group these operations into a custom feature" (user templates)? Recommendation: not now; user-defined features later.
8. **Milestone:** hole (counterbore) and patterns need nothing from v0.3. Recommendation: a small lane after v0.2 (or in v0.3 beside shapes); chamfers, text and engraving after v0.3 shapes and their operations.
9. **Feature names in Plan:** recommendation: label only, no plan logic per feature.
