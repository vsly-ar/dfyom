# Split parts: one part cut from several stocks

Status: accepted (proposal task 1.8, written 2026-11-24 after the user asked again, TG #311; the user took every recommendation of [Q109–Q116](#questions-for-the-user), TG #317 "go") · Proposal: [plans/proposal-multi-setup-alignment.md § 5](../plans/proposal-multi-setup-alignment.md#5-phase-4--split-parts-design) (S1–S4, [Q68](../plans/proposal-multi-setup-alignment.md#questions-for-the-user)) · Research: [research § D](../research/2026-11-23-multi-setup-alignment.md#d-splitting-one-part-across-several-stocks) · Base: [design.md](design.md), [features.md § Expansion and owned operations](features.md#expansion-and-owned-operations), [design-v0.3.md](design-v0.3.md) (shapes), [geometry.md § 2.5D evaluation](../architecture/geometry.md#25d-evaluation-v01), [alignment.md § Alignment aids](alignment.md#alignment-aids) (registration holes) · Terms: [glossary.md](../glossary.md)

The user (2026-11-24, TG #311): "any progress on splitting a large part into separate parts? I was trying to do it for temp/enclosure_1x.dfyom but haven't found an option." There is none yet: phase 4 of the proposal was not scheduled. This doc specifies it so it can be accepted and built in slices, smallest first ([§ Slices](#slices)).

**In one paragraph.** The user designs the part whole. A **split** on that part names straight **split lines** across its top (vertical cuts) and **split levels** (horizontal cuts at a Z). The cells between them are **pieces**. Each piece becomes a **derived part**: its own blank (piece bounds plus a margin per side), the source's operations mapped into it, and generated operations that cut it free along its outline and make the joint. Pieces stay in sync with the source; they are planned, exported and run like any part. Joints, DFM near the cuts and nesting onto library stock come in later slices.

## Decisions (proposed)

| Id   | Decision                                                                                                                                                           | Q    | Section                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------- |
| SP-A | Pieces are **derived parts**, regenerated from the source in the same command as any source edit; read-only in Design                                              | Q109 | [Source and pieces](#source-and-pieces)                                |
| SP-B | Phase 4a = straight split lines **and split levels**, butt joints, margins, one own blank per piece; no nesting, no keyed joints                                   | Q110 | [Slices](#slices)                                                      |
| SP-C | Several parts per project in the app (today one, rule `onePart`) is a prerequisite: a part list in Design, plans picking their part                                | Q111 | [Prerequisite: several parts](#prerequisite-several-parts-per-project) |
| SP-D | One split per part (`part.split`), not a feature in the design order: it makes parts, not operations                                                               | –    | [Model](#model)                                                        |
| SP-E | Dowel holes are **design** operations owned by the split (they are in the finished part), reusing the registration hole's dowel sizes and toolpaths; not plan aids | Q112 | [Joints](#joints)                                                      |
| SP-F | A piece cut by a level sits at the **top** of its blank; the surplus thickness is faced off in the top setup                                                       | Q113 | [Blanks and margins](#blanks-and-margins)                              |

## User story: the enclosure

From the user's project (`temp/enclosure_1x.dfyom`, read 2026-11-24; not copied into the repo). Part "enclosure 1": an open box at full scale (the reference STL at scale 1), faced 9.738 mm on both sides of an 80 mm Eucalyptus block, a cavity pocket 56.29 mm deep, four Ø4.06 and two Ø3.25 rim holes.

| Quantity                        | Enclosure                                     | Limit                                                                                     | Fits?                       |
| ------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------- |
| Footprint                       | ≈ 249.5 × 177.0 mm (walls ≈ 7 mm, back 11 mm) | Largest library hardwood: Block 200 × 100.1 × 40 (Eucalipto)                              | No: longer and wider        |
| Height                          | 60.5 mm (floor ≈ 4.2 mm)                      | Library thickness 40 mm                                                                   | No                          |
| Cavity depth from the block top | 66 mm (9.7 facing + 56.3)                     | Longest end mill "extralong 1/4″": 50 mm flute, 62 mm stickout; the others ≤ 22 mm flutes | No: deeper than any flute   |
| Design stock                    | Own block 250 × 200 × 80 (not in the library) | 3020 Nova travel 300 × 200 × 80                                                           | Y equals the travel exactly |

So the part is "large" three ways: no stock the user keeps holds it, its cavity is deeper than any tool reaches, and its own block fills the Y travel. Two ways to split it:

1. **One split level** at Z ≈ 30 mm (half the height): a tray (floor + 26 mm of wall) and a ring (30 mm, the cavity goes through). Each layer is ≤ 31 mm deep: within the extralong's flute, and the 1/4″ 1F (31 mm stickout) only just. Needs blanks ≥ 260 × 187 × 31 mm (bounds + 5 mm margins): a wider board or a glued-up panel. **2 pieces.**
2. **The level plus two lines** (X ≈ 125, Y ≈ 88.5) for the library's 200 × 100.1 × 40: pieces of 125 × 88.5 × 30 + margins = 135 × 98.5 (1.6 mm to spare in Y). **8 pieces**, and every line runs through 7 mm walls and the 4.2 mm floor: small end-grain glue faces, no room for a key (DFM [`thinJoint`](#dfm-near-a-split)).

Recommended: (1); (2) gets `thinJoint` on every line. DFYOM supports both. Flow in 4a: add the outline profile first (the part has none yet, so the pieces would be cut along the 250 × 200 stock edges, [`noOutline`](#dfm-near-a-split)) → Split part… → add a level at 30.25 → preview shows two pieces with their blanks and "Fits no library stock; own blank 259.5 × 187 × 30.3" → Done → two pieces under the part → Plan each piece → export or run each.

Until 4a ships, the workaround is one project per piece ([research § D](../research/2026-11-23-multi-setup-alignment.md#d-splitting-one-part-across-several-stocks)): the app allows one part per project.

## Prerequisite: several parts per project

The data model keeps a list of parts ([design.md § Part and stock](design.md#part-and-stock-v01)) and `plan.create` takes a `partId`, but `design.part.add` refuses a second part (`onePart`) and Design and Plan show the first part only (`Object.values(doc.parts)[0]`). The user's file holds two parts ("enclosure 1" and the earlier 0.54-scale "Enclosure"), so one of them is invisible in the app today. Task S0 (part of 4a):

- Lift `onePart`; the part row in the Design navigator becomes a part menu (source parts, their pieces indented under them); the selected part is window state, not document state.
- Plan: the plan's part shown in the plan row; "New plan" asks for the part when there are several. Run shows the plan's part name in the setup picture.
- Agents already address parts by id; no new tool. (Implemented with one: removing a part, below.)

### Implementation (S0)

Done 2026-11-24 (branch of task S0, 4a started). What was built, and where this section left room:

- **Core:** `design.part.add` adds parts beside the first (rule `onePart` removed). New `design.part.remove { partId, confirm? }` – the task asked for remove and rename; rename is the existing `design.part.update { name }`. It removes the part, its references, its plans (`confirm: true` required when there are any, `input.malformed` rule `partHasPlans` otherwise; `model.invariant` rule `planInUse` while one is `inUse`, as `plan.remove` refuses an `inUse` plan), its stock snapshot when no other part uses it and its tool snapshots no other part uses, in one undo step (`removedPlans` in the result). No document format change, no `schemaVersion` bump. Every other design, plan, shape, feature, reference and Clones tool already took `partId` (checked: none read "the first part"); `design.part.list` lists all. `tools/list` +0.34 K ([llm-api.md](../architecture/llm-api.md#implementation-task-310)). Tests: `src/core/design/several-parts.test.ts` (two parts, rename, plans per part with Apply following only the edited part's plan, remove with plans and snapshots and its undo, `planInUse`, last part, tools by id) and a reference case in `reference-commands.test.ts`.
- **Design UI:** the part menu ([ui.md § Part menu](../conventions/ui.md#part-menu-split-parts-s0)): switch (window state `designPart`), New part… (the Stock dialog), Remove with an undo toast or a confirmation when plans go too. `designPart(doc, partId)` (renderer `modes/design/model.ts`) resolves the shown part, falling back to the first; every Design hook reads it through `useDesignPart`. The menu item gained `checked` (`menuitemradio`) and `id` (key) in `ui/Menu`. No `kind`/`derivedFrom` fields yet: pieces (4a) add `derivedFrom` and the indented menu rows.
- **Plan and Run:** the Plan start card's Part field (several parts), "New plan for" per part in the plan menu, plan names with their part in the Plan and Run pickers (`planLabel`), the setup-change picture captioned with the part. Export and Run are unchanged: a plan carries its own part copy.
- **Tests:** component `modes/design/Parts.test.tsx` (part menu, New part, remove with toast and with confirmation, Plan start Part field, New plan per part; axe on each state), e2e `e2e/several-parts.e2e.ts` (New part…, switch, plan the second part, export holds only its operations).
- **The user's file:** `temp/enclosure_1x.dfyom` as read on 2026-11-24 at implementation holds **one** part ("enclosure 1", 9 operations, one plan), not two as read earlier for this doc; the 0.54-scale "Enclosure" part is no longer in it. Loaded headless with a second part added: both list and load in Design's model, the plan is named "Plan 1 · enclosure 1", removing the added part restores one part.

## Model

### Split

`part.split?: { id, lines: SplitLine[], levels: Length[], margin: Length, joint: JointSpec }` on the **source** part, in the part frame ([design.md § Part and stock](design.md#part-and-stock-v01)).

| Element     | 4a                                                                                    | Later                                                                                   |
| ----------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Split line  | Straight, along X or Y (`{ axis: 'x' \| 'y', at }`), through the whole part, vertical | Any angle; an open [named shape](design-v0.3.md#what-a-shape-is) from edge to edge (4d) |
| Split level | `z` (part frame, between the bottom and the top), horizontal through the whole part   | –                                                                                       |
| `margin`    | Per side of the blank, default 5 mm (Q68)                                             | Per piece override                                                                      |
| `joint`     | `butt` (glue faces, no geometry)                                                      | Dowels on levels, puzzle key, dovetail key, finger, half-lap ([§ Joints](#joints))      |

Lines and levels cut the part's **footprint** into cells: the inside of the part's through outline profile when it has exactly one, else the stock rectangle (finding `noOutline`). Empty cells make no piece.

### Source and pieces

Each non-empty cell is a **piece**: a part record with `derivedFrom: { partId, splitId, index }`, named "<source name> · <n>", numbered by position (X, then Y, then Z, from the front-left bottom). Options for how pieces relate to the source:

| Option                      | Edit after splitting                                         | Cost                                                                                                               |
| --------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Derived, kept in sync**   | Edit the source; every piece follows in the same command     | Mapping rules below; pieces read-only (like [owned operations, A4–A5](features.md#expansion-and-owned-operations)) |
| One-time copy               | Edit each piece by hand; a source edit means splitting again | Least code; the user's iterations (two scales already) repeat by hand                                              |
| Derived with "Detach" later | As derived; Detach turns a piece into a plain part           | Derived plus one command                                                                                           |

**Recommended: derived, kept in sync** (SP-A, Q109), with Detach as a later option. It follows the feature rule (A1–A2): the expansion is **materialized** (pieces are stored parts, so Plan, export, geometry and DFM work on them unchanged) and **regenerated in the same command** as the source edit (an instant reaction, [apply.md § Rules for new reactions](../architecture/apply.md#rules-for-new-reactions)); piece plans follow by Apply like any design change. A piece keeps, by its index: its name, its blank choice ([§ Nesting](#nesting)) and its operations' tool fields. When a line change removes a piece that has plans, the UI confirms first ("Piece 4 has 1 plan; removing the line removes both"); the command removes them in one undo step.

### Mapping the source into a piece

The piece frame is its blank's front-left top corner; the piece holds `offset` (source part frame → piece frame). Piece operations hold **resolved values** (no expressions; the source keeps them) and keep the source operation ids, so plans read "Pocket 1", not a new name.

| Source operation                               | In the piece                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Removal region outside the piece               | Dropped                                                                                                                             |
| Inside the piece                               | Copied, shifted by `offset`                                                                                                         |
| Crosses a split line (pocket, profile, facing) | Its shape gets an `intersect` item with the piece region plus the tool's clearance ([shape items](design-v0.3.md#shape-definition)) |
| Drilling or hole crossed by a line             | Goes to the piece holding its centre; warning `cutsFeature` (the other piece misses its part)                                       |
| Crosses a level, from the top                  | Upper piece: depth capped at the piece bottom (a through cut). Lower piece: `on` its new top, depth reduced by what is above        |
| Crosses a level, from the bottom               | Mirrored rule                                                                                                                       |
| The through outline profile                    | Replaced by the generated piece outline                                                                                             |
| Side-face operations (±X/±Y)                   | Clipped like a pocket; their face must be an outer face of the piece, else dropped with `cutsFeature`                               |

Generated operations (owned by the split, ids `<splitId>_<role>`): `outline` (a through profile around the piece region, with the plan's tabs) and `glueFace` (a facing to the level on the side a level cut, [§ Blanks and margins](#blanks-and-margins)). Removal regions are 2.5D prisms ([geometry.md](../architecture/geometry.md#25d-evaluation-v01)), so a prism cut by a vertical plane or a Z slab is again a prism: no new geometry kind. Chamfers and floor fillets crossing a level are the exception: warning `cutsFeature`, kept in the piece that holds their face.

**Invariant (tested):** the pieces' evaluated solids, moved back by their offsets, equal the source part's (within the general tolerance), minus nothing and with no overlap.

### Blanks and margins

- A piece's stock is its **blank**: the piece bounds plus `margin` on each side in X and Y; in Z the piece height (4a: own block, no library link, like DF13's [own stock](../architecture/library.md#snapshots)).
- With a thicker blank (nesting onto a library stock, 4c) the piece sits at the **top** of the blank and the surplus is removed in the top setup: by the source's top facing when the piece has the top face, else by its `glueFace` facing (SP-F, Q113). The glue face of an upper piece is then the blank's own bottom (a planed face). This keeps a piece to the setups the source needs; the alternative (surplus at the bottom) adds a flip for every upper piece.

## Joints

| Kind         | Where            | Geometry                                                                                                                           | Clearance                                        | Slice |
| ------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----- |
| Butt         | Lines and levels | None: flat glue faces                                                                                                              | –                                                | 4a    |
| Dowels       | Levels           | Vertical holes in both glue faces at the same X/Y: lower piece from its top, upper piece from its bottom (a flip setup) or through | Hole Ø = dowel Ø + fit (registration hole sizes) | 4b    |
| Puzzle key   | Lines            | Round knob and socket along the line (jigsaw)                                                                                      | Socket offset by the clearance (default 0.15 mm) | 4b    |
| Dovetail key | Lines            | Trapezoid key; inside corners need relief                                                                                          | As puzzle                                        | 4b    |
| Finger       | Lines            | Square wave along the line; inside corners need dogbones                                                                           | As puzzle                                        | 4d    |
| Half-lap     | Lines            | Each piece keeps half the thickness over an overlap; one side cut from the bottom (a flip, [alignment](alignment.md))              | Lap length + clearance                           | 4d    |

- **Clearance** goes on the socket (female) side only, so the male key keeps its nominal size; per joint, default 0.15 mm (S2), and a "Test fit" helper (4b) adds a small two-piece coupon of the joint as its own part so the user tunes the clearance on scrap first.
- **Dogbones:** a router leaves the tool radius in every inside corner seen from the top. The joint generator rounds the male side's outside corners to the tool radius plus the clearance where the shape allows (puzzle, dovetail), else cuts a dogbone (along the bisector) or a T-bone (along one wall, default for finger joints where a bisector would show) sized from the joint's [tool field](design-v0.2.md#operation-tool). DFM warns when no library tool is small enough for the joint's corners.
- **Dowels reuse phase 1** (SP-E, Q112): the dowel size list, the fit (dowel + 0.2 mm) and the drilling or helical-bore toolpaths of the [registration hole](alignment.md#alignment-aids), but as design operations owned by the split, because they are part of the finished part. Horizontal dowels in a vertical glue face (a line) need a side setup, which a hobby machine rarely can hold, so lines get keys, levels get dowels. A dowel hole is also a valid [alignment point](alignment.md#alignment-points) for the piece's own flip setup.

## DFM near a split

Warnings `design.split` with rules (never blocking, as all DFM):

| Rule            | When                                                                                                            | Slice |
| --------------- | --------------------------------------------------------------------------------------------------------------- | ----- |
| `noOutline`     | The source has no through outline profile: pieces are cut along the stock edges                                 | 4a    |
| `cutsFeature`   | A line or level crosses a hole, a chamfer, a floor fillet or a side-face operation (mapping table)              | 4a    |
| `featureNear`   | A feature edge lies within 2 × the nearest operation's tool Ø of a line or level (S3): a thin wall at the joint | 4a    |
| `thinJoint`     | A glue face (or a key's neck) narrower than 10 mm or 3 × the joint tool Ø                                       | 4a    |
| `sliver`        | A piece narrower than 2 × margin, or less than 5 % of the part's volume                                         | 4a    |
| `noStock`       | Info: the blank fits no library stock; names the nearest and by how much it is short                            | 4a    |
| `outsideTravel` | The blank is larger than the machine travel of the project's machines                                           | 4a    |
| `fitsWhole`     | Info: the unsplit part fits a library stock and the travel: the split may be unnecessary                        | 4a    |

## Nesting

S4, slice 4c: each piece onto one blank, chosen from the library stocks that hold the piece plus margins (smallest volume first; rotation 0° or 90° about Z), or its own block as in 4a. The choice is per piece and kept across regeneration; a source edit that makes the chosen stock too small turns into `noStock` and falls back to the own block. Several pieces on one sheet needs a plan holding several parts, which plans cannot today; it is a later milestone, not this doc. "Split to fit" (4c): given a library stock and the machine travel, suggest the fewest levels, then lines, that make every piece fit; the user accepts or edits them.

## UI (summary, Design)

- **Where:** "Split part…" in the part inspector and the part row's context menu ([ui.md decision 27](../conventions/ui.md#decisions)); not in the Add menu, since a split makes parts, not operations. On a piece the inspector shows "Piece 3 of Enclosure 1 · Edit the split" instead.
- **Split editing:** the viewport switches to Top for lines (drag a line; snap to the footprint's midpoints, feature edges and the "fits" positions) and Front for levels (drag a plane); the inspector lists lines and levels with their positions as fields, the margin and the joint. Edits commit live like any field ([apply.md](../architecture/apply.md)).
- **Preview:** pieces pulled apart by a few mm (`--motion-slow`, none under reduced motion), each with its blank outline and a chip "3 · 135 × 98.5 × 30 · Block 200 × 100.1 × 40" or "own blank"; findings on the line or level they concern.
- **Piece list:** under the source in the part menu ([prerequisite](#prerequisite-several-parts-per-project)); a piece's operation list is read-only, mapped operations marked "from Enclosure 1", generated ones grouped under "Split". Plan: "Plan all pieces" makes one plan per piece with the source plan's machine.

## Agent API

`tools/list` measured at **103.8 K** (103,803 chars, 135 tools) on 2026-11-24; phase 4 stays within ≈ 3 K so the listing stays near 107 K of 120 K.

| Tool                                                                          | Estimate | Slice | Shape                                                                                                               |
| ----------------------------------------------------------------------------- | -------- | ----- | ------------------------------------------------------------------------------------------------------------------- |
| `design.split.set { partId, lines, levels, margin, joint }`                   | ≈ 1.0 K  | 4a    | One folded tool (set the whole split; `null` removes it), like `plan.alignment.set`; returns piece ids and findings |
| `joint` kinds and dowel args on the same tool                                 | ≈ 0.6 K  | 4b    | Args, not tools                                                                                                     |
| `design.part.update { blank }` on a piece                                     | ≈ 0.3 K  | 4c    | Blank choice (library stock id, rotation) as an arg on an existing tool                                             |
| `design.split.suggest { partId, stockLibraryItemId?, machineLibraryItemId? }` | ≈ 0.6 K  | 4c    | Query; returns lines and levels to pass to `set`                                                                    |
| **Total**                                                                     | ≈ 2.5 K  |       |                                                                                                                     |

Pieces need no tool of their own: `derivedFrom` and the offset are in the part's output schema (which `tools/list` does not carry), `plan.create { partId }` plans a piece, export and Run are unchanged. Edits to a piece's operations fail with `model.invariant`, rule `derivedPart` ("Pocket 1 belongs to Enclosure 1 · 3; edit Enclosure 1").

## Plan, export and Run per piece

A piece is a part, so its plan, setups, workholding, export header and Run are today's. Additions: the export header and the Run setup picture name the piece ("Enclosure 1 · 3 of 8"); the plan summary lists the piece's blank; Run has no alignment step for splits (Q68: the joint aligns the pieces at glue-up), but a piece's own flip setup uses phase 1 as any part does. The split shares one need with [tiling (T3)](../plans/proposal-multi-setup-alignment.md#4-phase-3--tiling): clipping an operation to a region. Build it once, here or there, whichever comes first.

## Persistence

`split` on the part and `derivedFrom`/`offset` on a piece are new optional fields: older files load unchanged, so no `schemaVersion` bump ([persistence.md § Schema version](../architecture/persistence.md#schema-version-pre-alpha)). Piece parts are ordinary `parts/<id>.json` records.

## Implementation (4a)

Built 2026-11-24 (task DF91, after S0). Where this doc left room, the decisions taken:

- **Model** (`src/core/design/part.dto.ts`): `part.split = { id: 'split1', lines: [{ axis, at }], levels: [z], margin, joint: { kind: 'butt' } }` (one split per part; `axis: 'x'` is the plane x = at; levels are part-frame z in (−thickness, 0)); a piece has `derivedFrom: { partId, splitId, index }` and `offset: [x, y, z]` (source part frame → piece frame, lengths). Optional fields: no `schemaVersion` bump.
- **Cells** (`split/layout.ts`): the footprint (the one through outside profile on `stock.top` with a closed shape, else the stock rectangle) cut by the lines into rectangles, intersected with the footprint by the 2D port; levels make Z bands from the bottom to the top of the stock, and bands wholly in the top or bottom facing are skipped. Numbering: X, then Y, then Z (bottom first), non-empty cells only.
- **Blank:** cell bounds plus `margin` per side in X and Y, exactly the band height in Z. So **no `glueFace` in 4a**: the blank is the piece height, its glue face is the board face. `glueFace` comes with thicker blanks (4c). The blank is an own block snapshot named "Blank L × W × T" with the source stock's material.
- **Mapping** (`split/pieces.ts`): as the table, plus: resolved literal values; `on` becomes the piece's `stock.top`/`stock.bottom` when the operation starts beyond the piece, else keeps its source surface when that surface's operation is mapped with its floor; otherwise it is dropped with `cutsFeature` (`reason: 'on'`). A pocket capped by a level (through the piece) becomes a **through inside profile** (slot = its tool Ø, 4 tabs): a pocket must end above the stock bottom, and the core is waste held by tabs; likewise a capped profile starts on the piece's stock face. A crossing pocket or profile gets a new named shape `shape<n>`: the source definition plus an `intersect` rectangle of the cell grown by the tool Ø. Drillings go by centre (half-open cells); a drilling capped by a level becomes `through`. A chamfer follows its edge operation. **Side-face operations are not mapped in 4a** (`cutsFeature`, `reason: 'sideFace'`). `featureId`/`featureRole` are stripped: pieces hold plain operations. The generated `split1_outline` is a through outside profile (the source outline's shape, slot width, tab count/size and tool, else the cell rectangle, 6 mm slot, 4 tabs).
- **Regeneration** (`split/commands.ts`): `design.split.set` regenerates itself; the `design.splitFollow` document hook regenerates every split source whose record or stock snapshot changed in the command (unchanged records are frozen, `frozen-memo.ts`); the apply hook of the same name runs after the tool choice, so mapped operations carry their source's chosen tool; pieces are left out of the library-change re-choice (`design.toolRechoice`), whose own choice for a smaller piece would never settle against the copied tool (Apply then left keys pending forever). A piece keeps by its number its id, blank snapshot id, a non-default name and its generated operations' tool fields; records are written only when they change. Piece removal with plans: `design.split.set` needs `confirm: true` (`input.malformed`, rule `pieceHasPlans`); a source edit that would drop a piece with plans fails the same way. `design.part.remove` on a source takes its pieces (and their plans, counted for `confirm`); on a piece it fails with `derivedPart`, as every design command on a piece except `design.part.update { name }`.
- **Findings** (`split/findings.ts`): code `design.split` (added to `DFM_WARNING_CODES`) with `params.rule` and `operation` = the split id; returned by `design.split.set` and listed by `design.warning.list` (not by every edit's result, for cost). Since the 4a polish they follow source edits: the renderer re-reads `design.warning.list` after every revision, and its costly geometric pass (pieces, `noOutline`, `cutsFeature`, `featureNear`, `thinJoint`, `sliver`; ≈ 100 ms for the 8-piece enclosure) is cached per frozen source record and snapshot map (`frozen-memo.ts`), so the evaluation-status re-reads and edits of other parts cost ≈ 1 ms; the library rules (`noStock`, `outsideTravel`, `fitsWhole`) run each time (the library is a service, not a record). `featureNear` uses the operation's chosen tool Ø (else its slot or drill Ø). `thinJoint`: 10 mm (butt joints have no joint tool); glue faces sampled on a grid from the 2.5D removal prisms, the narrowest of the two run lengths at any sample; for a level this is the ring's wall width. `sliver` uses gross volumes (footprint area × height). `outsideTravel` and `fitsWhole` use the machines of the project's plans, else the library's. Part height for these = stock between the top and bottom facings.
- **Exit test, headless:** `src/main/cli/exit-criteria.split.fixture.ts` (in `exit-criteria.mcp.test.ts`): the enclosure split by the level (2 pieces), then by the level and two lines (8 pieces); each piece is planned on the library machine with no plan errors, every setup exported (the program's stock line is the piece's blank) and run on the virtual machine at `max` (tools zeroed on a floor touched off at their tool change).
- **Exit test, hidden e2e:** `e2e/split-parts.e2e.ts`: the enclosure from the bridge; in the UI, "Split part…" (the mid-height level), the part menu's pieces, a read-only piece and "Edit the split", "Add line at X" and "Add line at Y" (8 pieces), the Plan start card on a piece and its toolpaths; then every piece of the 8-piece and the 2-piece split planned, exported and run on the virtual machine through the bridge.
- **UI** ([ui.md § Split part](../conventions/ui.md#split-part-split-parts-4a)): the "Split" section of the part inspector, a 2D schematic preview there (not the 3D exploded viewport of [§ UI summary](#ui-summary-design); viewport drag of lines and levels is open), pieces inset under their source in the part menu, read-only pieces with "Edit the split". `design.part.list` returns each piece's `derivedFrom`.
- **Polish (4a, same task):** see [§ Implementation (4a polish)](#implementation-4a-polish).
- **Tests:** `split/split.test.ts` (both exit splits, regeneration and undo, read-only pieces, confirm, validation, `noOutline`, part removal, warning list), `split/reassembly.test.ts` (the invariant: ray-parity membership of the source and of each piece moved back, at random points of every cell; the core of a through inside profile is waste and not compared). Each exit-split piece is also checked valid on its blank (`checkPartFits`, what a plan checks).

## Implementation (4a polish)

Built 2026-11-25 (task DF91), the open items of 4a:

- **Read-only rows:** a piece's operation list has no grip, row menu, Delete, Alt+↑/↓ or Skip ([ui.md § Split part](../conventions/ui.md#split-part-split-parts-4a)).
- **Where:** "Split part…" / "Edit the split" also in the part menu and the part row's context menu.
- **Export header:** `(Piece 3 of 8 of Enclosure 1)` after the program line, the piece's name after a colon when renamed ([grbl.md § Setup header](../architecture/grbl.md#setup-header-hardening-df58)). Plain parts unchanged (no golden changed); a header golden from the split exit test.
- **Findings follow source edits** (cached geometric pass, [§ Implementation (4a)](#implementation-4a), Findings).
- **Side-face operations** stay unmapped (`cutsFeature`, `reason: 'sideFace'`): later, with the side setups of pieces.

## Slices

| Slice | Content                                                                                                                                                                            | Exit                                                                                                                                                                            | Size           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 4a    | S0 several parts; `part.split` with straight lines and levels, butt joint, margins, own blanks; derived pieces and the mapping; DFM rules marked 4a; Design UI; `design.split.set` | The enclosure split by one level (and, second test, by the level and two lines): the invariant holds; each piece plans and runs on the virtual machine; headless and hidden e2e | L: ≈ 8–11 days |
| 4b    | Joints: dowels on levels, puzzle and dovetail keys with clearance and corner relief; Test fit coupon                                                                               | Proposal exit: a 600 × 400 mm part in two pieces with a puzzle joint that fits by hand (user)                                                                                   | M: ≈ 5–7 days  |
| 4c    | Nesting one piece per library blank (rotation 0/90°), surplus faced off, Split to fit                                                                                              | The enclosure split to fit 200 × 100.1 × 40 by the suggestion, each piece on a library blank                                                                                    | M: ≈ 3–5 days  |
| 4d    | Split lines as shapes, finger and half-lap joints, Detach                                                                                                                          | –                                                                                                                                                                               | later          |

Sizes are agent working days including docs, tests and review, comparable to alignment phase 1 (two slices). S0 alone is ≈ 2 days of 4a.

## Questions for the user

Answered 2026-11-24 (TG #317 "go"): every recommendation below was taken.

1. **Q109 – Pieces follow the source.** (1) Derived and kept in sync, read-only; (2) one-time copy; (3) derived, with Detach later. _Recommendation: (1), Detach later (3)._ You iterate on the enclosure (two scales already); a copy would make every change a re-split by hand.
2. **Q110 – What 4a ships.** (1) Straight lines **and levels**, butt joints, margins, own blanks; (2) lines only, as the proposal first said; (3) (1) plus dowels on levels. _Recommendation: (1)._ Your enclosure needs a level (60.5 mm tall, cavity deeper than your longest flute); lines alone would not help it.
3. **Q111 – Several parts in the app.** (1) Lift `onePart`, a part menu in Design with pieces under their source, plans pick their part; (2) keep one part per project and write each piece to its own project. _Recommendation: (1);_ your file already holds two parts and the app shows only one.
4. **Q112 – Dowel holes.** (1) Design operations owned by the split, reusing the registration hole's sizes and toolpaths; (2) plan aids in each piece's plan, as the proposal said. _Recommendation: (1);_ they are part of the finished part and must match in both pieces, so they belong to the design.
5. **Q113 – Thicker blank.** (1) Piece at the blank's top, surplus faced off in the top setup; (2) piece at the bottom, surplus faced from below (a flip). _Recommendation: (1);_ fewer setups, and the glue face is the board's planed bottom.
6. **Q114 – First keyed joint (4b).** (1) Puzzle key; (2) dovetail key; (3) both. _Recommendation: (3);_ same generator, the dovetail is the puzzle with straight flanks.
7. **Q115 – Nesting scope.** (1) One piece per blank from the library (4c), several pieces per sheet as a later milestone; (2) several per sheet now. _Recommendation: (1);_ several per sheet needs plans of several parts, a larger change than this phase.
8. **Q116 – Default margin.** (1) 5 mm per side (Q68); (2) tool Ø + 2 mm, from the outline's tool. _Recommendation: (1)_ for 4a; (2) as the default once nesting picks stock, since it saves material on small tools.

## Open questions (for the docs, not the user)

- Grain direction: should a piece carry the source's grain axis so the blank (4c) is not turned across the grain? Needs a grain field on stock first.
- Assembly view: the source drawn with its pieces exploded and the joints highlighted, or the preview only?
- Clones crossing a line: each instance maps on its own (the table holds per operation); check the 100-instance budget with 8 pieces ([S6](../research/s6-clone-budgets.md)).
