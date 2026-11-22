# Design mode v0.2: face targets and the operation tool

Status: accepted (user decisions D10, D11, D13, D16; details confirmed with the v0.2 review, D18 of 2026-11-22) · Vision and v0.1: [design.md](design.md) · Plan side: [plan-v0.2.md](plan-v0.2.md) · Geometry: [geometry.md § Non-top faces](../architecture/geometry.md#non-top-faces-v02) · Library: [library.md](../architecture/library.md#tool) · UI rules: [ui.md § Design and plan controls (v0.2)](../conventions/ui.md#design-and-plan-controls-v02) · Tasks: [plans/v0.2.md](../plans/v0.2.md#2-design-faces-anchors-tools) · Terms: [glossary.md](../glossary.md)

This doc extends the [v0.1 operations](design.md#operations-v01) with three decisions. Everything not mentioned here stays as in design.md.

- **D10, faces:** every operation targets a planar face whose outward normal is ±X, ±Y or ±Z. The face gives the operation a local 2D frame. Plan derives the setups from the face directions ([plan-v0.2.md](plan-v0.2.md#setups-from-face-directions)).
- **D11, tools:** every operation has a tool field holding either a generalized tool or a specific library tool. This replaces the v0.1 rule "Design never names a tool" ([design.md § Generalized tools](design.md#generalized-tools)).
- **D16 (Q13), anchors:** a position names one of nine points of the feature's bounding box ([§ Placement anchors](#placement-anchors)).

## Decisions

Settled with the user when this doc was accepted (D18, 2026-11-22: Q12–Q16 as taken by D16, A–J as recommended by D12); the sections below specify them.

1. **Shapes (Q12, Q14):** v0.2 keeps the v0.1 rectangle and circle as `shape`, placed in the [face frame](#face-frame). Named line/arc shapes cut `inside`, `outside` or on the centreline are v0.3 ([roadmap.md](../roadmap.md#v03--shapes)).
2. **Placement anchors (Q13):** 9-point, in v0.2 ([§ Placement anchors](#placement-anchors)).
3. **Several setups without workholding or in-process stock (Q15):** DFM ignores clamping and material removed by earlier setups ([access checks](#dfm-access-checks)); Plan side in [plan-v0.2.md](plan-v0.2.md).
4. **Fillets (Q16):** free-form tabs come with v0.3 shapes; free-form floor fillets are deferred beyond that. In v0.2 floor fillets stay as in v0.1.
5. **Apply (Q17 → D13):** the [auto tool choice](#auto-choice) runs on Apply, not inside the edit command ([§ Apply](#apply-d13), [apply.md](../architecture/apply.md)).
6. **Face targets (A):** stock faces, floors and tab tops. Walls are not face targets in v0.2: a feature in a wall needs the tool to fit inside the pocket beside it, a new access rule (later).
7. **Face frame (B):** as tabled in [§ Face frame](#face-frame): seen from outside, `v` up on the sides, the bottom rolled over the X axis, so X stays X on top and bottom (a flip toward the operator).
8. **Formula names (C):** part-frame `.x` / `.y` / `.z` per axis ([§ Formula names](#formula-names)); no direction-neutral `.level`, so `.z` keeps its v0.1 meaning.
9. **Auto choice (D):** a fitting library tool first, else a generalized tool ([§ Auto choice](#auto-choice)): real tools give real DFM (principle 5).
10. **Facing and profile `on` (E):** stock faces only in v0.2; a profile or facing from a floor is later, so through-cut and tab rules stay unchanged.
11. **`tool.*` in design expressions (F):** unknown in v0.2 ([§ Expressions and the tool](#expressions-and-the-tool)).
12. **Changing `on` to another direction (G):** keeps the `[u, v]` numbers; the [access checks](#dfm-access-checks) warn if the feature no longer fits.
13. **Auto choice during adjust-popover steps (H):** none; the choice waits for Apply (D13, [apply.md § Adjust popover](../architecture/apply.md#adjust-popover)).
14. **Generalized drill (I):** takes the operation's `pointAngle`; it stores none of its own.
15. **Updating a specific tool from the library (J):** a new command `design.snapshot.update { snapshotId }` for tool and stock snapshots, one explicit, undoable path for every design snapshot, as plans have `plan.libraryItem.update` ([§ Commands](#commands-and-queries-v02)).

## Faces and face targets

### Face

A **face** is a planar surface of the stock or of an earlier operation whose outward normal `n` (pointing out of the material, toward where the tool comes from) is one of six **directions**: `+x`, `−x`, `+y`, `−y`, `+z`, `−z` in the [part frame](design.md#part-and-stock-v01). The direction of an operation's face is its **approach direction**: the tool comes in along `−n`.

The model is open for later **user planes** with any orientation (roadmap "Later"): a face frame is a general rigid frame, and v0.2 only restricts `n` to the six axis directions. Nothing below assumes more than "a planar face with a frame".

### Face targets (generalised `on`)

`on` replaces the v0.1 "horizontal planar surface" ([design.md § Positioning](design.md#positioning-v01)) with a **face target**: the surface id of a face. Every operation kind now has `on`:

| Operation | Valid `on` in v0.2                                                                                    | Default     | What changes from v0.1                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| Facing    | A stock face: `stock.top`, `stock.bottom`, `stock.side[0..3]`                                         | `stock.top` | Facing may flatten any stock face; it still faces the whole face (no `shape`).                      |
| Pocket    | A stock face; the `floor` of an earlier facing or pocket; an earlier profile's tab top (`tab[i].top`) | as in v0.1  | Floors and tab tops of any direction, not only +Z.                                                  |
| Drilling  | As pocket                                                                                             | as in v0.1  | As pocket.                                                                                          |
| Profile   | A stock face (a through cut from that face to the opposite one)                                       | `stock.top` | The cut may run along X or Y through the stock; tabs are measured from the **opposite** stock face. |

- A face target's direction comes from the surface table ([below](#surface-table-per-direction)); the operation never stores a direction of its own.
- **Walls are not face targets in v0.2** (e.g. a hole in a pocket's straight wall). They are planar with axis normals, so the model allows them; they come later with their own access rule ([decision 6](#decisions)).
- Floors of operations on other faces are eligible like +Z floors: a drilling on the floor of a pocket in `stock.side[1]` approaches along `−x`.
- A wrong target stays `model.invariant`, rule `onSurface` (params list the allowed ids), as in [design.md § Implementation](design.md#implementation-task-25).
- The DTO field stays a surface id string. Absent `on` on a facing or profile means `stock.top`, so v0.1 projects load unchanged (no `schemaVersion` change, [CLAUDE.md](../../CLAUDE.md) pre-alpha rule).

### Face frame

Each face has a **face frame** `{ origin, u, v, n }` in the part frame: `n` the outward normal, `u` and `v` the 2D axes, right-handed (`u × v = n`). Seen from outside the face (looking along `−n`), `u` points right and `v` points up, and the origin is the lower-left corner of the stock's face of that direction, moved along `n` to the face's level. For the top this is exactly v0.1's part frame, so top-face positions do not change.

| Direction (stock face)        | `n` | `u` | `v` | Origin (part frame, at the stock face) | Seen from                          |
| ----------------------------- | --- | --- | --- | -------------------------------------- | ---------------------------------- |
| `+z` (`stock.top`)            | +Z  | +X  | +Y  | (0, 0, 0)                              | above (as v0.1)                    |
| `−z` (`stock.bottom`)         | −Z  | +X  | −Y  | (0, W, −T)                             | below, part rolled over the X axis |
| `−y` (`stock.side[0]`, front) | −Y  | +X  | +Z  | (0, 0, −T)                             | the front                          |
| `+x` (`stock.side[1]`, right) | +X  | +Y  | +Z  | (L, 0, −T)                             | the right                          |
| `+y` (`stock.side[2]`, back)  | +Y  | −X  | +Z  | (L, W, −T)                             | the back                           |
| `−x` (`stock.side[3]`, left)  | −X  | −Y  | +Z  | (0, W, −T)                             | the left                           |

(L, W, T = stock length, width, thickness; part zero and side numbering as in [design.md](design.md#part-and-stock-v01).)

- All faces of one direction share `u`, `v` and the origin's (u, v); only the level along `n` differs. So a position means the same point on `stock.side[1]` and on the floor of a pocket in it, as v0.1 positions mean the same on `stock.top` and `facing1.floor`.
- `shape.center` and the drilling `center` are `[u, v]` in the frame of `on`. Changing `on` to a face of another direction keeps the numbers (the feature moves to the new face); the [access checks](#dfm-access-checks) warn if it no longer fits. Anchors other than the centre: [§ Placement anchors](#placement-anchors).
- `depth` runs along `−n` from the `on` face. The removal region is the shape extruded from `on.level − depth` outward through the stock's face of that direction (overshoot, [geometry.md](../architecture/geometry.md#non-top-faces-v02)): a 3-axis tool removes everything between the floor and the outside along `n`. For `+z` this is the v0.1 rule.
- Surface roles keep their v0.1 numbering, read in the face frame: `wall[0]` is the wall at the lowest `v` ("front" seen from outside), then counter-clockwise seen from outside; tabs start at the middle of `wall[0]` (circle: at the lowest `v`). For `+z` this is v0.1.
- The bottom is rolled over the X axis, not the Y axis ([decision 7](#decisions)).

### Surface table per direction

`SurfaceTable` ([`surfaces.ts`](design.md#implementation-task-25)) holds, per surface: id, **direction**, **level** and frame. The level is the signed coordinate of the plane along its normal's axis (`n · p` for a point `p` on it), so "deeper" always means a lower level: `floor.level = on.level − depth`, tab top level = opposite stock face level + `tabs.thickness` along the profile's `n`. Tolerances propagate worst-case as in v0.1. The level is internal; expressions use part-frame coordinates ([below](#formula-names)).

Surface ids stay `<operation id>.<role>` ([geometry.md § Surface ids](../architecture/geometry.md#surface-ids-in-meshes)); a face's direction is a property of the surface, not part of its id. The six stock ids are unchanged.

### Formula names

Expression references to face positions are the face's **part-frame coordinate** on the axis of its normal, with the v0.1 limits:

| Face direction | Names                             | Example                                              |
| -------------- | --------------------------------- | ---------------------------------------------------- |
| `±z`           | `<surface>.z`, `.z.min`, `.z.max` | `pocket1.floor.z` (as v0.1)                          |
| `±x`           | `<surface>.x`, `.x.min`, `.x.max` | `stock.side[1].x` = L; `pocket2.floor.x` = L − depth |
| `±y`           | `<surface>.y`, `.y.min`, `.y.max` | `stock.side[0].y` = 0                                |

- A name on the wrong axis (`stock.side[1].z`) is an unknown reference. Bracketed ids become expression names here (`stock.side[1]`), so the [expression grammar](../architecture/quantities.md#expression-grammar) needs bracketed segments in references; tab tops (`profile1.tab[0].top.z`) become reachable the same way.
- Depth arithmetic depends on the sign of `n`: on `+x` a floor is at `x = L − depth`, on `−x` at `x = depth`. A direction-neutral name (`.level`, `.depthFromStock`) was considered and not taken ([decision 8](#decisions)).

### DFM access checks

Parameter checks ([geometry.md § Parameter and tool checks](../architecture/geometry.md#parameter-and-tool-checks)) run in the operation's face frame. Rules that used the stock top or the stock rectangle use the **stock face of the operation's direction** and the **stock extent along `n`** (T for `±z`, L for `±x`, W for `±y`):

| Rule                                        | v0.2 reading                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `dfm.holeOutsideStock`                      | The hole circle reaches outside the stock face rectangle of its direction (a side face of a 12 mm board is L × 12). |
| `dfm.holeDeep`                              | A `through` hole's depth is the material below `on` along `n` (up to the extent along `n`).                         |
| Pocket "floor above `stock.bottom`"         | Floor above the opposite stock face (level > that face's level), so a side pocket never breaks out of the far side. |
| `dfm.slotLeavesStock`, `dfm.slotOpensStock` | Stock margin measured in the face rectangle; `params.sides` names the stock faces it runs out at.                   |
| Facing `depth` < stock thickness            | < stock extent along `n`.                                                                                           |

New checks (codes to register with the implementation):

| Code (proposed) | Operation (parameter)                              | Rule                                                                                                                                                                                                                                                       | Severity |
| --------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `dfm.reach`     | pocket, drilling, profile (`depth`; profile: `on`) | Depth from the stock's outer face of the direction to the deepest point > the reach of the operation's [tool](#operation-tool) (specific: `stickout`, else `fluteLength`; generalized: the longest of the matching library tools; none matching: skipped). | warning  |
| `dfm.setups`    | part                                               | The part uses more than one approach direction: "needs N setups (top, right, bottom)". Information for beginners; Plan derives them.                                                                                                                       | info     |

Out of v0.2 DFM (Q15): workholding and clamping access, material already removed by an earlier setup, and thin walls between features from opposite faces (a geometry check later).

### Implementation (task A1)

The face model is in core: directions, frames and the local stock in [`src/core/geometry/face.ts`](../../src/core/geometry/face.ts) (ids `+z`, `-z`, `-y`, `+x`, `+y`, `-x` in ASCII); the surface table (`direction`, `level`, `faceZ`), resolver and graph in [`surfaces.ts`](../../src/core/design/surfaces.ts); `on` on every kind in [`operation.ts`](../../src/core/design/operation.ts) (a facing's or profile's `on` is written only when it is not `stock.top`, so v0.1 records stay byte-identical); the limits along `n` in [`validate.ts`](../../src/core/design/validate.ts); the access checks in [`dfm.ts`](../../src/core/geometry/dfm.ts). Choices made with the implementation:

- The pocket and drilling default `on` is the last **top** facing's floor, else `stock.top` (a side facing never becomes the default).
- A facing's or profile's `on` is not an operation reference (it is a stock face, always there, and a facing removes it), so it never raises `dfm.surfaceMissing` or `design.referenced`.
- `dfm.reach` runs against the library until the [tool field](#operation-tool) exists (task A4): the longest reach (`stickout`, else `fluteLength`) of the library tools whose type and size fit the operation; a pocket or flat/point hole is measured to its floor (`depth − onZ`), a through hole and a profile by the stock extent along `n`. Since A4 it reads the operation's own tool ([§ Implementation (task A4)](#implementation-task-a4)); an operation without one yet (before its first Apply) keeps this library reading.
- `dfm.setups` is attached to the first operation of the second direction (the one that adds a setup), parameter `on`, `params: { count, directions }` (`top`, `bottom`, `front`, `right`, `back`, `left`, in order of first use).
- Until F1 the Design UI offers only top-facing `on` targets and `.z` formula names (±z), and draws outlines in the face frame's z; geometry evaluates every direction (A1b), toolpaths reject other directions until C3 ([geometry.md](../architecture/geometry.md#non-top-faces-v02)).

## Placement anchors

Q13: 9-point ([decision 2](#decisions)). Every positioned feature (pocket and profile `shape`, drilling `center`) states **which point of its bounding box** its position gives.

- **Anchor:** one of nine points of the shape's bounding rectangle in the [face frame](#face-frame): `{ u: 'min' | 'centre' | 'max', v: 'min' | 'centre' | 'max' }`. Seen from outside the face, `min`/`min` is the lower-left (front-left on the top face). A circle uses its bounding square; a drilling has only the centre (a hole is a point).
- **Data model:** optional `shape.anchor` next to `shape.center`; `center` then means "the anchor point" (kept as `center`, [§ Implementation (task A2)](#implementation-task-a2)). Absent `anchor` = centre, so v0.1 projects load unchanged (no `schemaVersion` change).
- **Changing the anchor keeps the geometry:** `design.<kind>.update { anchor }` recomputes the position so the feature does not move (one undo step). If the position is an expression, the change fails with `model.invariant`, rule `anchorExpression`; the user removes the formula first.
- **Size edits keep the anchor point fixed:** with a `min`/`min` anchor, a longer pocket grows toward `+u`, so a corner stays where it was dimensioned.
- **Default anchor** for new operations is a setting (default: centre); agents pass `anchor` or get the centre.
- **UI:** a 3 × 3 anchor picker beside the position fields, and the viewport marks the anchor point of the selected feature ([ui.md rules](../conventions/ui.md#design-and-plan-controls-v02)).
- References to other features' edges or to a [reference model](reference-model.md) are later (backlog B10, snapping).

### Implementation (task A2)

Code: `ANCHOR_POINTS`, `AnchorDtoSchema` and the optional `anchor` on both shapes in [`part.dto.ts`](../../src/core/design/part.dto.ts); `Shape.anchor` (always set, `CENTRE_ANCHOR` when the record has none; written only when it is not the centre, so v0.1 records stay byte-identical) in [`operation.ts`](../../src/core/design/operation.ts); offsets, the geometric centre and re-anchoring in [`anchor.ts`](../../src/core/design/anchor.ts); the `anchor` arg in [`commands.ts`](../../src/core/design/commands.ts); the setting `defaultAnchor` in [`src/shared/settings.ts`](../../src/shared/settings.ts). Choices made with the implementation:

- **`center` is not renamed** to `position`: the rename would touch the DTO (every saved record), the args, the renderer and the fixtures for no behaviour, so it is not cheap. The arg and DTO descriptions say "center = anchor point".
- **One `anchor` arg per command, not inside `shape`:** `design.pocket.*` and `design.profile.*` take a top-level `anchor?` (kept out of the shape union to stay inside the `tools/list` budget). On **add** it names the point `shape.center` gives (absent: centre). On **update** it re-anchors without moving the feature (one command, one undo step); a `shape` given in the same update first keeps the previous anchor (its `center` is that anchor's point), then the re-anchor runs on the new shape. A `shape` without `anchor` on update keeps the anchor, so the inspector's size edits keep the anchor point fixed with no extra arg.
- **Geometric centre in one place:** `shapeCentre(shape)` (exact `center − offset`, offset ±size/2 per axis for `min`/`max`) feeds `toGeometryInput` (so evaluation, DFM, toolpaths and tab/wall numbering see the same geometry as before), the plan's order checks (`plan/order.ts`) and the renderer's live outline and error marker. Nothing else reads `shape.center` as a centre.
- **Re-anchoring writes literals as typed:** the number in the source is replaced in its written unit, unit, tolerance and written decimals stay (`30.50 ±0.1` → `25.50 ±0.1`, `2"` → `1.5"`); the exact value is shifted exactly, and a non-terminating decimal in the source is cut at 6 digits (the exact value wins, [quantities.md](../architecture/quantities.md#value)).
- **`anchorExpression` per axis:** only a coordinate that has to move fails (`model.invariant`, issue path `anchor`, `params.parameter` = `shape.center.0` / `.1`); changing only `v` keeps a formula in `u`. Every failing axis is reported at once.
- **Default anchor:** `defaultAnchor` in the app settings (default centre; validated by main like every setting), for the window to pass as `anchor` on add (F2). Core never reads it: agents pass `anchor` or get the centre.
- Drillings take no `anchor` (an unknown arg, `input.malformed`).

## Operation tool

Every design operation has a **tool field**. It shows and steers which tool makes the operation, while design still states the result (radii, depths, diameters, slot width) and Plan still owns the concrete assignment ([plan-v0.2.md § Tool resolution](plan-v0.2.md#tool-resolution-from-the-design-tool-field)).

### Data model

```text
operation.tool?:      DesignTool
operation.toolLocked?: true
DesignTool = { kind: 'generalized', type, diameter, cornerRadius? }
           | { kind: 'specific', snapshotId }
```

- **Generalized tool:** a tool [`type`](../architecture/library.md#tool) (`flatEndMill`, `bullNoseEndMill`, `ballEndMill`, `drill`) and a `diameter` quantity; `cornerRadius` only for a bull nose (0 < RE < DC/2). No lengths, no flute count, no presets: "a 1/4″ flat end mill". A generalized drill's point angle is the operation's `pointAngle`. A user without the tool can still design with it.
- **Specific tool:** a tool from the library, held like the part's stock as a **tool snapshot** in `ProjectDoc.snapshots` ([persistence.md § Library references](../architecture/persistence.md#library-references)): the design never references a library item directly, so the project opens unchanged elsewhere. Library edits never change it; only the explicit, undoable `design.snapshot.update` or re-picking the tool may ([decision 15](#decisions)).
- **`toolLocked`:** set by any user choice ([locks](#tool-lock)). Absent = auto.
- Both fields are optional in the DTO: absent `tool` means "auto, nothing chosen yet" (a v0.1 project); the next Apply chooses one (opening marks it pending, [apply.md § Opening](../architecture/apply.md#opening-and-recovery)). No `schemaVersion` change.

### Fit: when a tool can make the operation

`fits(tool, operation)` uses the design's tool requirement, which is the [plan's check table](plan-v0.1.md#tool-assignment-and-checks) without the plan-only parts (stepdown, machine). Sizes compare with `TOOL_MATCH_TOLERANCE` (0.01 mm) as the DFM tool rules do:

| Operation                | Fits when                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Facing                   | `flatEndMill`.                                                                                                                                                                                                                  |
| Pocket                   | `flatEndMill` or `bullNoseEndMill`; DC ≤ narrowest size; radius ≤ `cornerRadius` (rectangle); `floorRadius` > 0 needs a bull nose with RE = `floorRadius`.                                                                      |
| Drilling                 | `drill` with DC = `diameter` (not for `flat`); or `flatEndMill` with `diameter`/2 < DC < `diameter` for `flat` / `through` (helical boring).                                                                                    |
| Profile                  | `flatEndMill` with DC ≤ `slotWidth`; `inside`: radius ≤ `cornerRadius`.                                                                                                                                                         |
| All, specific tools only | Reach: `stickout` (else `fluteLength`) ≥ the depth from the stock's outer face of the direction (profile: the stock extent along `n` + the plan's default breakthrough). A generalized tool has no length, so it always passes. |

### Auto choice

While the field is **not locked**, the tool is chosen automatically:

1. **When:** **on Apply** (Enter, Cmd/Ctrl+Enter or the Apply button), for every unlocked operation with pending changes (from `design.<kind>.add`, `design.<kind>.update`, `design.operation.tool.unlock`). Typing, blur and live gesture steps do not trigger it; agents auto-apply per call. It is the first apply hook, `design.toolAutoChoice`, in Apply's own undo step ([§ Apply](#apply-d13)).
2. **Keep if it fits:** an unlocked tool that still fits is kept (no churn while editing).
3. **Otherwise choose:** the first library tool that fits, ranked by: has a preset for the stock's material class → largest diameter (fewer passes) → library id. Its snapshot is taken in the same command.
4. **No library tool fits:** the largest generalized tool of the [standard size series](#standard-sizes) that fits (bull nose: RE = `floorRadius`; drill: DC = `diameter`).
5. **Nothing fits at all** (e.g. `cornerRadius` 0, or a corner radius below the smallest standard size): the current tool is kept and `dfm.toolUnfit` warns ([DFM](#dfm-with-the-tool)). The command never fails because of the tool.

Library tools come first ([decision 9](#decisions)); with an empty library the choice is always generalized.

#### Standard sizes

Generalized tools are chosen from a per-unit-system series (the project's [unit system](design.md#operations-v01)): metric 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12 mm; inch 1/32, 1/16, 1/8, 3/16, 1/4, 5/16, 3/8, 1/2″. A generalized drill is not taken from the series: its diameter is the hole's. The series is a constant in core for v0.2 (a setting later).

### Tool lock

Modelled on the feeds locks of [plan-v0.1.md § Locks and auto mode](plan-v0.1.md#locks-and-auto-mode):

| State  | Stored                        | Behaviour                                                                                                                                                 | Shown                                     |
| ------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Auto   | `tool` (or nothing yet)       | [Auto choice](#auto-choice) on every Apply.                                                                                                               | "Chosen automatically." Lock not pressed. |
| Locked | `tool` and `toolLocked: true` | Never changed automatically. If it stops fitting, `dfm.toolUnfit` warns at the `tool` field with the fitting alternative; the parameters stay as entered. | "Chosen by you." Lock pressed.            |

- **Any user choice locks:** picking a generalized or specific tool, or pressing the lock of an auto-chosen tool (pins it as it is).
- **Unlocking** keeps the tool and runs the auto choice on apply: it stays if it fits, else it is replaced (step 3–5 above).
- A locked tool is never swapped silently anywhere: not by design edits, not by library edits (the snapshot stays), not by Plan ([plan-v0.2.md](plan-v0.2.md#tool-resolution-from-the-design-tool-field)).
- Changing a parameter so a locked tool no longer fits is allowed (design states the result); the warning tells the user to unlock or pick another tool.

### DFM with the tool

The DFM tool rules ([geometry.md § Parameter and tool checks](../architecture/geometry.md#parameter-and-tool-checks)) gain the operation's own tool:

- **Against the operation's tool** (new): `dfm.toolUnfit` (warning, parameter `tool`): the tool does not fit; `params.rule` names the failed row of the [fit table](#fit-when-a-tool-can-make-the-operation) (`type`, `width`, `cornerRadius`, `floorRadius`, `diameter`, `reach`), `params.locked`; suggestion: the first fitting tool, or "unlock". Corner, slot and floor-radius messages name the tool ("cornerRadius 2 mm < radius of the 1/4″ end mill: use ≥ 3.175 mm").
- **Against the library** (as v0.1): `dfm.pocketNoToolFits`, `dfm.cornerTooSmall`, `dfm.slotNoTool`, `dfm.floorRadiusNoTool`, `dfm.holeNoTool` still say whether any library tool can make the result.
- **Generalized tool not in the library** (new): `dfm.toolNotInLibrary` (info, parameter `tool`): no library tool matches the generalized tool's type and diameter (and RE) within 0.01 mm. "Plan needs a 1/4″ flat end mill; add one to the library." Plan cannot resolve a locked one without it.
- With an empty library: auto choice gives generalized tools, `dfm.toolUnfit` and the geometric rules run, `dfm.toolNotInLibrary` is shown once per distinct tool.

### Expressions and the tool

`tool.*` stays an unknown reference in design expressions in v0.2 ([design.md § Implementation](design.md#implementation-task-25)): the auto choice depends on the parameters, so a parameter depending on the tool would make a cycle, and the geometry would change with a library edit ([decision 11](#decisions)). Allowing it for locked tools only was rejected for the second reason: it breaks the result-first rule.

### Implementation (task A4)

Code: the field in [`part.dto.ts`](../../src/core/design/part.dto.ts) (`DesignToolDtoSchema`, `tool?` / `toolLocked?` on every operation) and [`operation.ts`](../../src/core/design/operation.ts) (`tool: Option<DesignTool>`, `toolLocked`); the model, validation, labels and standard sizes in [`design/tool.ts`](../../src/core/design/tool.ts); the fit table in [`geometry/tool-fit.ts`](../../src/core/geometry/tool-fit.ts) (`toolFit`, pure mm; E4 resolves with the plan checks instead, [plan-v0.2.md § Implementation (task E4)](plan-v0.2.md#implementation-task-e4)); the auto choice and candidates in [`tool-choice.ts`](../../src/core/design/tool-choice.ts); the `tool` arg and tool snapshots in [`tool-args.ts`](../../src/core/design/tool-args.ts); commands, query and the apply hook in [`tool-commands.ts`](../../src/core/design/tool-commands.ts); `dfm.toolUnfit`, `dfm.toolNotInLibrary` and the switched `dfm.reach` in [`dfm.ts`](../../src/core/geometry/dfm.ts) (`ParameterCheckOptions.operationTools`, kept out of `OperationGeometry` so a tool change never touches geometry or its caches). Choices made with the implementation:

- **Apply hook as a seam:** `designToolAutoChoice` (`design.toolAutoChoice`, wrapping `autoChooseTools(draft, pending, ctx)`) is registered in `APPLY_HOOKS` since P2 (before that no Apply chose a tool). An operation without a tool keeps the DFM's library reading until its first Apply; opening a project marks every unlocked operation with an absent or unfit tool pending ([apply.md § Implementation (task P2)](../architecture/apply.md#implementation-task-p2)). Targets: operations with a pending change; a new part (`added`) or a changed `stock` targets all of the part's operations. A part that does not load fails the Apply (corruption, not a derived problem).
- **`toolChange` for a first choice:** an operation without a tool that gets one reports `from: null`, reason `unset`; a replaced one the failed fit rule of the old tool (`unresolved` if its snapshot does not load). `ToolChangeSchema.from/to` are now `DesignToolDTO`.
- **Fit details:** a bull nose fits a pocket only with RE = `floorRadius` (it would leave a fillet on a sharp floor); a drill's point angle is not a fit rule (the plan checks it). Rules are checked in table order, the first failure is reported. Profile reach adds the plan's default `breakthrough` (0.5 mm / 0.02″, a constant here).
- **Tool snapshots:** taken with the next `snapshot-N` id; an existing tool snapshot of the same library item with equal values is reused, and a tool snapshot no operation uses any more is removed in the same command or Apply. A missing tool snapshot makes the part `input.malformed`, as for the stock.
- **Generalized values:** literals only (no formulas); `model.invariant` rules `positive`, `required`, `range`, `notAllowed` under `tool.*`. Chosen sizes are entered as the series reads (`8 mm`, `1/4"`); a generalized drill or bull-nose RE takes the hole's diameter / `floorRadius` as a plain length (no tolerance).
- **`design.tool.candidates`** returns `fitting[] { toolLibraryItemId, name, diameter (mm), reasons }`, `generalized` (DTO or null) and `current { tool, locked, fits, rule?, detail? }` (null: none chosen yet).
- **`design.<kind>.add`** takes `tool?` (locked) and returns `tool?`, `toolLocked`; update keeps the field. `design.operation.tool.lock` without a tool fails with `model.invariant`, rule `noTool`.
- **`design.snapshot.update`** works on tool and stock snapshots (`machine` → `input.malformed`, rule `snapshotKind`; unknown snapshot `unknownSnapshot`; library item gone `unknownItem`); equal values change nothing (no undo step); it returns the warnings of every part that uses the snapshot.
- **`dfm.toolNotInLibrary`** is per operation with a library, once per distinct tool (type, DC, RE) with an empty one. Renderer texts for both new codes are placeholders until F5.

## Commands and queries (v0.2)

Names follow [commands.md § Naming](../architecture/commands.md#naming); all are `document` commands unless noted, one gesture = one command, results carry the part's DFM `warnings` as in v0.1.

| Command / query                  | Args                                                                                                                             | Result                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `design.<kind>.add`              | as v0.1, plus `on?` for every kind, `tool?` (a given tool is locked), `anchor?` for pocket and profile                           | `{ operationId, tool, toolLocked, warnings }` |
| `design.<kind>.update`           | as v0.1, plus `on?`, `anchor?` for pocket and profile (re-anchors, the feature stays)                                            | `{ warnings }` (tool changes: on Apply)       |
| `design.operation.tool.set`      | `{ partId, operationId, tool }` – `tool` is a generalized tool or `{ toolLibraryItemId }` (snapshot taken in the command); locks | `{ warnings }`                                |
| `design.operation.tool.lock`     | `{ partId, operationId }` – pins the current tool                                                                                | `{ warnings }`                                |
| `design.operation.tool.unlock`   | `{ partId, operationId }` – the auto choice runs on Apply                                                                        | `{ warnings }`                                |
| `design.snapshot.update`         | `{ snapshotId }` – a design tool or stock snapshot takes the library item's current values ([decision 15](#decisions))           | `{ warnings }`                                |
| `design.tool.candidates` (query) | `{ partId, operationId }`                                                                                                        | `{ fitting[], generalized, current }`         |

- `toolChange` = `{ partId, operationId, from, to, reason }` whenever the auto choice replaced the tool (reason: the failed fit rule of the old tool). It is in the Apply's result (`ApplyOutcome.toolChanges`); an agent's edit auto-applies, so it sees the swap in the `applied` part of its call's result ([apply.md § Agents](../architecture/apply.md#agents-mcp-and-cli)).
- `design.tool.candidates` lists the fitting library tools in auto-choice order with reasons, the generalized tool auto would pick, and the current tool with its fit result. It is the "makeable with" list of the inspector and the agent's way to pick a tool.
- A specific tool (or the stock) whose library item changed shows as stale and never updates silently; `design.snapshot.update` updates it explicitly (one undo step). A library item that no longer exists fails it with `input.malformed`. An updated tool snapshot keeps `toolLocked`; if it stops fitting, `dfm.toolUnfit` warns as for any locked tool. Updating the stock snapshot is pending for Apply like any part field ([apply.md § What is pending](../architecture/apply.md#what-is-pending)).
- Errors: a library item that is not a tool or does not exist → `input.malformed`; a generalized tool with invalid values → `model.invariant` (rule per field). A tool that does not fit is **not** an error (a warning).
- **Agents and CLI:** the command layer exposes all of these as MCP tools (`design_operation_tool_set` …, [llm-api.md § Names](../architecture/llm-api.md#names)) and CLI calls (`dfyom design.operation.tool.set '{…}'`) with no extra work. Tool args are typed (a union on `kind`), so the JSON Schema shows agents both forms.

## UI (summary)

Rules for the controls: [ui.md § Design and plan controls (v0.2)](../conventions/ui.md#design-and-plan-controls-v02). What they show:

- **`on`:** the pick mode highlights every face target of the operation kind ([ui.md § Selection and picking](../conventions/ui.md#selection-and-picking)), sides and bottom included, with a normal glyph; the dropdown groups targets by direction ("Top", "Right side", …).
- **Tool field** in each operation's inspector, first group after `on`: a combobox with the generalized tool (type + size) and the fitting library tools from `design.tool.candidates`, the lock button of [ui.md § Field](../conventions/ui.md#field), and "Chosen automatically: the 6 mm end mill didn't fit the 2 mm corner" after an auto change.

## Apply (D13)

Q17 is decided as D13 (2026-11-21) and specified in [apply.md](../architecture/apply.md). In short, for this doc:

- Edits commit live (one undo step each; the mesh, parameter checks and live outline follow); the [auto tool choice](#auto-choice) is **deferred** to Apply: Enter in a field, Cmd/Ctrl+Enter, or the "Apply N" button. Blur and Tab commit only.
- Apply runs the auto choice for every unlocked operation with pending changes, then the draft plans follow ([plan-v0.2.md](plan-v0.2.md#tool-resolution-from-the-design-tool-field)), as one undoable entry "Apply N changes"; undoing it restores the old tools and leaves the edits pending.
- Until Apply, `dfm.toolUnfit` and `dfm.toolNotInLibrary` of an unlocked tool with pending changes show as "may change on Apply"; against a locked tool they are final.
- Agents auto-apply per call by default (`apply: false` batches); the swap comes back as `applied.toolChanges`.
