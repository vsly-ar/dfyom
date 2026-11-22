# Design mode v0.4: hole features, chamfers and Clones

Status: accepted (D34, 2026-11-22: the user took every recommendation of [Q28–Q35](../plans/v0.4.md#questions-for-the-user), ISO metric from M1.6; proposed 2026-11-22 with [plans/v0.4.md](../plans/v0.4.md)) · Scope: [roadmap v0.4](../roadmap.md#v04--features) · Concept: [features.md](features.md) (feature model A1–A6, [Clones](features.md#clones)) · Base: [design.md](design.md), [design-v0.2.md](design-v0.2.md), [design-v0.3.md](design-v0.3.md) · Toolpaths: [plan-v0.4.md](plan-v0.4.md) · Tasks: [plans/v0.4.md](../plans/v0.4.md) · Terms: [glossary.md](../glossary.md)

v0.4 builds the **feature model** of [features.md](features.md) and its first two kinds: the **hole** feature (simple, counterbore, countersink, sizes from fastener tables) and the **Clones** feature (one face, no rotation). Countersinks need a cut DFYOM does not have yet, so v0.4 adds the **chamfer operation** on circular edges and the **chamfer mill** tool type first ([features.md rule](features.md#feature-vs-operation): a feature never cuts on its own). This doc owns what v0.4 adds or bounds; the feature model itself (owned operations, ids by role, order, Apply, undo, persistence) stays in [features.md](features.md) and is linked, not repeated.

## Decisions

Accepted with [Q28–Q35](../plans/v0.4.md#questions-for-the-user) (D34, every recommendation taken).

| Id  | Decision                                                                                                                                                                                                                                                     | Section                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| H-A | The feature model is built as [features.md A1–A6](features.md#expansion-and-owned-operations) says (stored owned operations, regenerated in the same command, ids by role, read-only geometry, no Explode, one nesting level).                               | [features.md](features.md#expansion-and-owned-operations)                        |
| H-B | One `hole` feature kind with a `type`: `simple`, `counterbore`, `countersink`. It expands only to existing operations (drilling, circular pocket) and the new chamfer operation.                                                                             | [Hole feature](#hole-feature)                                                    |
| H-C | Sizes come from a small **built-in fastener table**, ISO metric first ([Q29](../plans/v0.4.md#questions-for-the-user)); chosen values are copied into the feature and stay editable. No fastener library in v0.4.                                            | [Fastener table](#fastener-table)                                                |
| H-D | Threads are never cut: a "threaded" hole is a **tap drill** hole for tapping by hand (or a custom pilot for a threaded insert). Thread milling stays later ([candidate 12](features.md#candidate-features)).                                                 | [Hole feature](#hole-feature)                                                    |
| H-E | The **chamfer operation** in v0.4 chamfers the **circular mouth** of a drilling or a circular pocket only. Chamfers along general loops (edge chamfers, the enclosure's bevel) wait for spike S7 and a later milestone.                                      | [Chamfer operation](#chamfer-operation-v04-circular-edges)                       |
| H-F | One new tool type, **`chamferMill`**, covers chamfer mills and V-bits (included angle, tip diameter); generalized form "90° chamfer mill Ø12".                                                                                                               | [Chamfer mill tool type](#chamfer-mill-tool-type)                                |
| H-G | **Clones v0.4** = the [Clones draft](features.md#clones) with its first-version bounds (one face, source orientation kept, stable numbering) and C3/C4/C6 as recommended; the `along` row kind is proposed ([Q30](../plans/v0.4.md#questions-for-the-user)). | [Clones in v0.4](#clones-in-v04)                                                 |
| H-H | Linear, grid and circular repetition (bolt circles) is done with Clones rows. "Pattern" stays reserved for the user's sense (D30: decorative surface patterns like cnc-code's pattern helper), which is later.                                               | [Clones in v0.4](#clones-in-v04), [features.md § Patterns](features.md#patterns) |

## Hole feature

A hole feature is one round hole with an optional counterbore or countersink at its mouth, placed by `[u, v]` and an anchor on a [face target](design-v0.2.md#face-targets-generalised-on), like a drilling.

### Parameters

| Parameter         | Kind   | Default                                | Rule                                                                                        |
| ----------------- | ------ | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `type`            | –      | `simple`                               | `simple`, `counterbore`, `countersink`                                                      |
| `fastener`        | –      | none                                   | Optional table key (`M3`); sets the defaults below when chosen, never afterwards on its own |
| `purpose`         | –      | `clearance`                            | `clearance` or `tapDrill`; `tapDrill` only with `type: simple`                              |
| `fit`             | –      | `normal`                               | `close`, `normal`, `loose` (ISO 273); `clearance` only                                      |
| `diameter`        | length | from the table, else 6 mm / 1/4″       | > 0                                                                                         |
| `bottom`, `depth` | –      | `through`                              | As [drilling](design.md#drilling): `through`, `flat`, `drillPoint`; `depth` from the face   |
| `cbDiameter`      | length | table head Ø + clearance (counterbore) | `counterbore` only; > `diameter`                                                            |
| `cbDepth`         | length | head height + `headSink`               | `counterbore` only; 0 < `cbDepth` < `depth` (through: < the stock extent along −n)          |
| `csDiameter`      | length | table head Ø + 2 × `headSink`          | `countersink` only; > `diameter`                                                            |
| `csAngle`         | angle  | head angle from the table (90° ISO)    | `countersink` only; 60°–120°                                                                |
| `headSink`        | length | 0.2 mm / 0.008″                        | ≥ 0; how far the head sits below the face; only used when the defaults are filled           |
| `center`, anchor  | –      | required                               | `[u, v]` in the face frame, [anchor](design-v0.2.md#placement-anchors) `center`             |

Choosing a `fastener`, `purpose` or `fit` refills `diameter`, `cbDiameter`, `cbDepth`, `csDiameter` and `csAngle` in the same command (one undo step); editing a size by hand clears `fastener` to "custom" only for that size's read-out ("M3 · counterbore Ø 7 (custom)"). Every size is a quantity and may be an expression, as operation parameters are.

### Expansion

The [expansion](features.md#expansion-and-owned-operations) per type (role → operation, in design order):

| `type`        | Owned operations                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `simple`      | `drill`: drilling (`diameter`, `bottom`, `depth`) on the feature's face                                                                                                               |
| `counterbore` | `counterbore`: circular pocket (`cbDiameter`, depth `cbDepth`) on the face; `drill`: drilling `on` `<id>_counterbore.floor`, depth `depth − cbDepth` (or `through`)                   |
| `countersink` | `drill`: drilling on the face; `countersink`: [chamfer operation](#chamfer-operation-v04-circular-edges) on the mouth of `<id>_drill` with `diameter = csDiameter`, `angle = csAngle` |

Ids follow [A3](features.md#expansion-and-owned-operations) (`hole1_drill`, `hole1_counterbore`, `hole1_countersink`). Changing `type` keeps the `drill` role and its tool lock; a disappearing role removes its operation (or fails with `design.referenced`).

### Checks and DFM

- Feature invariants (`model.invariant`, path at the feature field): the rules of the [parameter table](#parameters); `cbDiameter`/`csDiameter` > `diameter`; a countersink whose cone would reach below the hole's bottom (blind holes) is invalid (`countersinkTooDeep`).
- Owned operations keep their own checks and codes; the navigator rolls them up on the feature row ([features.md § Validation and DFM](features.md#validation-and-dfm)).
- New info note `dfm.holeCustomSize` when a size differs from the table row the feature names (so a hand-edited M3 counterbore that no longer fits an ISO 4762 head is visible): params `{ field, table, value }`.

### Fastener table

Status: implemented (F2). A built-in, read-only table in core ([`src/core/design/fastener/data.ts`](../../src/core/design/fastener/data.ts), every row citing its sources as [feeds-speeds.md](../architecture/feeds-speeds.md) requires; values ported from cnc-code's hole helper and re-checked, D30 Q7, relicensed by the author). Plain numbers in mm. Columns per size:

| Column                       | Source                                                                      |
| ---------------------------- | --------------------------------------------------------------------------- |
| Clearance close/normal/loose | ISO 273:1979 fine / medium / coarse series                                  |
| Tap drill (coarse thread)    | ISO 2306:1972 (6H; = DIN 336) / ISO 261:1998 pitch (e.g. M3 × 0.5 → 2.5 mm) |
| Socket head Ø and height     | ISO 4762:2004 dk max, k max (= d)                                           |
| Counterbore Ø                | DIN 974-1:2008 series 1 for ISO 4762                                        |
| Countersunk head Ø and angle | ISO 10642:2004 dk theoretical max, 90° (M3 up); ISO 7046-1:2011 below M3    |

The values live in `data.ts` only (not repeated here). The ISO and DIN texts are paywalled: values are those of the standards' dimension tables as reproduced in catalogues and handbooks, cross-checked against the cnc-code port; DIN 974-1 was checked against secondary charts only, and each of its values exceeds the ISO 4762 dk max (by 0.5 mm at M1.6 and M2, at least 1 mm from M2.5). A test lint requires a source for every column, sizes growing with the screw size in every column, and holes that fit their screw (tap drill ≈ d − P, d < close < normal < loose, counterbore > head Ø). The hole defaults use the table so: `cbDiameter` = the counterbore Ø, `cbDepth` = k + `headSink`, `csDiameter` = countersunk dk + 2 × `headSink`, `csAngle` = 90°.

v0.4 sizes: ISO metric M1.6, M2, M2.5, M3, M4, M5, M6, M8, M10, M12 ([Q29](../plans/v0.4.md#questions-for-the-user), M1.6 added by D34; ISO 10642 starts at M3, so the countersunk head values below M3 come from ISO 7046-1, with that source on the row); inch (#4–1/2″, ASME B18.3, 82°) after v0.4. The table version is not stored ([features.md § Persistence](features.md#persistence-high-level)). Query (app scope, no project needed): `design.fastener.list { standard?, size? }` returns `{ rows, sources }` (each row with its source keys, `sources` the cited standards); `size` is the folded `get` and an unknown size is `input.malformed` (rule `unknownSize`). Agents choose sizes the same way the inspector does.

## Chamfer operation (v0.4: circular edges)

A chamfer operation cuts a conical bevel at the **mouth** of an earlier round operation. In v0.4 it is used by countersink holes and may be added on its own to any drilling or circular pocket (an edge break on a dowel hole).

| Parameter  | Kind   | Default       | Rule                                                                                                      |
| ---------- | ------ | ------------- | --------------------------------------------------------------------------------------------------------- |
| `edgeOf`   | –      | required      | Id of an earlier drilling or pocket with a `circle` shape; the edge is its mouth on that operation's `on` |
| `diameter` | length | edge Ø + 1 mm | > the edge's diameter; the chamfer's diameter in the face plane                                           |
| `angle`    | angle  | 90°           | Included angle, 60°–120°                                                                                  |

- **Removal region:** the cone frustum from the face plane (`diameter`) down to where it meets the edge's diameter, axis along −n; its depth `(diameter − edge Ø) / 2 / tan(angle / 2)` is derived and shown. Surfaces: `chamfer1.cone` (display only, not a face target and not an expression name: it is not planar).
- **Order:** after its `edgeOf` operation (a reference, [design order](design.md#ordering-and-composition)).
- **Fit** (adds a row to [the fit table](design-v0.2.md#fit-when-a-tool-can-make-the-operation)): `chamferMill` with `angle` equal within 0.5°, `tipDiameter` < the edge's diameter, and either `diameter` ≥ the chamfer's (plunged at the centre) or a cutting edge long enough for the chamfer's slant height (contoured, [plan-v0.4.md](plan-v0.4.md#chamfer-toolpath)).
- **DFM:** `dfm.chamferTooDeep` (cone below the edge operation's bottom or through a thin floor), `dfm.chamferNoTool` (no library tool of that angle; as `dfm.holeNoTool`).
- **Commands:** `design.chamfer.add { partId, edgeOf, diameter?, angle?, name? }`, `design.chamfer.update`. General loops (`edgeOf` a pocket or profile of any shape, outside edges) are later ([H-E](#decisions)).

## Chamfer mill tool type

An amendment to [library.md § Tool](../architecture/library.md#tool) made when this doc is accepted (that doc stays the owner of the field table):

| Field              | Kind   | Rule                    | Why                                                                |
| ------------------ | ------ | ----------------------- | ------------------------------------------------------------------ |
| `type`             | –      | `chamferMill`           | Chamfer operations; later engraving and V-carving                  |
| `diameter` (DC)    | length | > 0                     | Largest cutting diameter                                           |
| `angle` (included) | angle  | 30°–150°                | Must match the chamfer angle; a V-bit of 90° is a 90° chamfer mill |
| `tipDiameter`      | length | ≥ 0, < DC (0 = pointed) | Smallest cutting diameter; the tool cannot cut below its tip       |

Lengths, flutes, material and presets as for other types. Generalized: `{ kind: 'generalized', type: 'chamferMill', diameter, angle }`, standard sizes 90° × 6/12 mm, 1/4″/1/2″. Feeds use the **effective diameter** at the cut depth ([feeds-speeds.md](../architecture/feeds-speeds.md), amendment in [plan-v0.4.md](plan-v0.4.md#feeds-for-chamfer-mills)). The Library window gets the type's form and drawing (B22 V-bit icon, drawn but not wired yet).

## Clones in v0.4

[features.md § Clones](features.md#clones) owns the concept, properties, checks and commands. v0.4 builds it with these bounds:

- **First version (user, D30):** one face (sources on one face or on each other's surfaces), every instance keeps the source's orientation, stable numbering after skips.
- **Sources allowed:** hole features, pockets, drillings, chamfers, and profiles with side `inside` or `on`. Facing and `outside` profiles are refused (`clonesSourceKind`): repeating the part outline is "part copies", which the user ruled out (D30 Q3).
- **C3, C4, C6 as recommended** ([Q31](../plans/v0.4.md#questions-for-the-user)): clone instances follow the source operation's tool; removing Clones keeps the source; Clones are created from existing operations or a feature only ("Make Clones…" on a selection).
- **Rows:** `grid`, `offset`, `polar`, `arc`, `point` as drafted, plus the proposed **`along`** row (positions at a spacing along a named shape's path, [features.md § Properties](features.md#properties)) as the first item to cut.
- **Positions of instances** are values: the evaluated source position plus the row offset, rewritten on every regeneration; expressions stay on the source only.
- **Plan:** nothing Clones-specific ([features.md § Plan and cut order](features.md#plan-and-cut-order)).

## Commands and queries (v0.4)

New tools (each one MCP tool, [llm-api.md](../architecture/llm-api.md)): `design.hole.add`, `design.hole.update`, `design.chamfer.add`, `design.chamfer.update`, `design.clones.add`, `design.clones.update`, `design.clones.preview`, `design.feature.remove`, `design.feature.move`, `design.feature.list`, `design.fastener.list`; `design.feature.get` is folded into `list` (filter by id) to save room. `library.tool.add`/`update` and the tool unions grow by the `chamferMill` fields. Rough size: 11–14 K characters of `tools/list`; the budget is **120 K** ([Q32](../plans/v0.4.md#questions-for-the-user) option A, task M1; measurements in [llm-api.md](../architecture/llm-api.md#implementation-task-310)).

Results carry `{ featureId, operationIds, warnings }` as [features.md § Commands](features.md#commands-sketch) says; `design.operation.update` / `.remove` / `.move` on an owned operation fail with `design.featureOwned` naming the feature (A4, A5).

## UI (summary)

The [ui.md](../conventions/ui.md) amendment (plan task 1.4) specifies: feature rows in the navigator with nested owned operations ([features.md § UI](features.md#ui-sketch)); "Add" with Operations and Features groups; the **hole inspector** with a fastener picker (size, purpose, fit) and a dynamic **section illustration** drawn from the entered sizes (principle 5; built so it can become the first `sketch` view of the later Field info views spec, D30 Q11); the chamfer inspector; the [Clones UI](features.md#ui-summary) (rows list, read-out, clone path, click-to-skip); new icons for hole types, chamfer, chamfer mill and Clones, reviewed with the B22 follow-ups.

## Persistence

As [features.md § Persistence](features.md#persistence-high-level): optional `part.features`, optional `featureId`/`featureRole` on operations, a `chamfer` operation kind and a `chamferMill` tool type added to the unions. All additive: existing projects load unchanged, **no `schemaVersion` change** (pre-alpha rule).

## Out of scope (v0.4)

Edge chamfers along general loops and outside edges (the enclosure bevel); rotation of clone instances; Clones on several faces; part copies; decorative patterns; thread milling, hex-nut recesses, spot drilling as a separate role; inch fastener tables; the Field info views framework; a fastener library.
