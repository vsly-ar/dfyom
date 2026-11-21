# Design mode v0.2: face targets and the operation tool

Status: draft (user decisions D10 and D11 of 2026-11-21; the details below await confirmation) · Vision and v0.1: [design.md](design.md) · Plan side: [plan-v0.2.md](plan-v0.2.md) · Geometry: [geometry.md § Non-top faces](../architecture/geometry.md#non-top-faces-v02-draft) · Library: [library.md](../architecture/library.md#tool) · Terms: [glossary.md](../glossary.md)

This doc extends the [v0.1 operations](design.md#operations-v01) with two decisions. Everything not mentioned here stays as in design.md.

- **D10, faces:** every operation targets a planar face whose outward normal is ±X, ±Y or ±Z. The face gives the operation a local 2D frame. Plan derives the setups from the face directions ([plan-v0.2.md](plan-v0.2.md#setups-from-face-directions)).
- **D11, tools:** every operation has a tool field holding either a generalized tool or a specific library tool. This replaces the v0.1 rule "Design never names a tool" ([design.md § Generalized tools](design.md#generalized-tools)).

Do not implement this doc before the user confirms it ([README.md](../README.md#status-values)).

## Open decisions (placeholders)

These are still open. This doc does not decide them; sections that touch them say so.

| #   | Question                                                                                                                                  | Touches here                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q12 | Shapes model: named line/arc shapes, `inside` / `outside` / centreline                                                                    | `shape` stays the v0.1 rectangle or circle, now placed in the [face frame](#face-frame). Surface ids of general shapes are not specified here.         |
| Q13 | Positioning anchors: 9-point vs centre / front-left                                                                                       | Positions stay **centres** in the face frame until Q13 is decided.                                                                                     |
| Q14 | Split into v0.2 (faces, setups, anchors, tools) and v0.3 (shapes)?                                                                        | None; this doc is written so it works with either split.                                                                                               |
| Q15 | Multi-setup without workholding or in-process stock?                                                                                      | DFM ignores clamping and material removed by earlier setups ([access checks](#dfm-access-checks)); Plan side in plan-v0.2.md.                          |
| Q16 | Free-form fillets                                                                                                                         | None; floor fillets stay as in v0.1.                                                                                                                   |
| Q17 | Project-wide **apply**: Enter (or an "Apply" button with the pending count) runs the deferred follow-up work of all pending edits at once | Decided as D13 (2026-11-21), draft in [apply.md](../architecture/apply.md). The [auto tool choice](#auto-choice) runs on Apply: [§ Apply](#apply-d13). |

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
- **Walls are not face targets in v0.2** (e.g. a hole in a pocket's straight wall). They are planar with axis normals, so the model allows them; whether v0.2 includes them is [question A](#questions-raised-by-this-draft).
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
- `shape.center` and the drilling `center` are `[u, v]` in the frame of `on`. Changing `on` to a face of another direction keeps the numbers (the feature moves to the new face); the [access checks](#dfm-access-checks) warn if it no longer fits. Anchors other than the centre: Q13.
- `depth` runs along `−n` from the `on` face. The removal region is the shape extruded from `on.level − depth` outward through the stock's face of that direction (overshoot, [geometry.md](../architecture/geometry.md#non-top-faces-v02-draft)): a 3-axis tool removes everything between the floor and the outside along `n`. For `+z` this is the v0.1 rule.
- Surface roles keep their v0.1 numbering, read in the face frame: `wall[0]` is the wall at the lowest `v` ("front" seen from outside), then counter-clockwise seen from outside; tabs start at the middle of `wall[0]` (circle: at the lowest `v`). For `+z` this is v0.1.
- The frame orientation, especially the bottom's roll axis, is [question B](#questions-raised-by-this-draft).

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
- Depth arithmetic depends on the sign of `n`: on `+x` a floor is at `x = L − depth`, on `−x` at `x = depth`. A direction-neutral name (`.level`, `.depthFromStock`) is the alternative; [question C](#questions-raised-by-this-draft).

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
- **Specific tool:** a tool from the library, held like the part's stock as a **tool snapshot** in `ProjectDoc.snapshots` ([persistence.md § Library references](../architecture/persistence.md#library-references)): the design never references a library item directly, so the project opens unchanged elsewhere. Library edits never change it; only an explicit, undoable command may ([question J](#questions-raised-by-this-draft)).
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

Whether auto prefers a library tool or always a generalized one is [question D](#questions-raised-by-this-draft) (this draft: library first).

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

`tool.*` stays an unknown reference in design expressions in v0.2 ([design.md § Implementation](design.md#implementation-task-25)): the auto choice depends on the parameters, so a parameter depending on the tool would make a cycle, and the geometry would change with a library edit. See [question F](#questions-raised-by-this-draft).

## Commands and queries (v0.2)

Names follow [commands.md § Naming](../architecture/commands.md#naming); all are `document` commands unless noted, one gesture = one command, results carry the part's DFM `warnings` as in v0.1.

| Command / query                  | Args                                                                                                                             | Result                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `design.<kind>.add`              | as v0.1, plus `on?` for every kind and `tool?` (a given tool is locked)                                                          | `{ operationId, tool, toolLocked, warnings }` |
| `design.<kind>.update`           | as v0.1, plus `on?`                                                                                                              | `{ warnings }` (tool changes: on Apply)       |
| `design.operation.tool.set`      | `{ partId, operationId, tool }` – `tool` is a generalized tool or `{ toolLibraryItemId }` (snapshot taken in the command); locks | `{ warnings }`                                |
| `design.operation.tool.lock`     | `{ partId, operationId }` – pins the current tool                                                                                | `{ warnings }`                                |
| `design.operation.tool.unlock`   | `{ partId, operationId }` – the auto choice runs on Apply                                                                        | `{ warnings }`                                |
| `design.tool.candidates` (query) | `{ partId, operationId }`                                                                                                        | `{ fitting[], generalized, current }`         |

- `toolChange` = `{ partId, operationId, from, to, reason }` whenever the auto choice replaced the tool (reason: the failed fit rule of the old tool). It is in the Apply's result (`ApplyOutcome.toolChanges`); an agent's edit auto-applies, so it sees the swap in the `applied` part of its call's result ([apply.md § Agents](../architecture/apply.md#agents-mcp-and-cli)).
- `design.tool.candidates` lists the fitting library tools in auto-choice order with reasons, the generalized tool auto would pick, and the current tool with its fit result. It is the "makeable with" list of the inspector and the agent's way to pick a tool.
- A specific tool whose library item changed shows as stale and never updates silently. Design has no "update from library" command yet (not for the stock either); [question J](#questions-raised-by-this-draft).
- Errors: a library item that is not a tool or does not exist → `input.malformed`; a generalized tool with invalid values → `model.invariant` (rule per field). A tool that does not fit is **not** an error (a warning).
- **Agents and CLI:** the command layer exposes all of these as MCP tools (`design_operation_tool_set` …, [llm-api.md § Names](../architecture/llm-api.md#names)) and CLI calls (`dfyom design.operation.tool.set '{…}'`) with no extra work. Tool args are typed (a union on `kind`), so the JSON Schema shows agents both forms.

## UI (summary)

UI rules go to [ui.md](../conventions/ui.md) when this doc is accepted. Sketch:

- **`on`:** the pick mode highlights every face target of the operation kind ([ui.md § Selection and picking](../conventions/ui.md#selection-and-picking)), sides and bottom included, with a normal glyph; the dropdown groups targets by direction ("Top", "Right side", …).
- **Tool field** in each operation's inspector, first group after `on`: a combobox with the generalized tool (type + size) and the fitting library tools from `design.tool.candidates`, the lock button of [ui.md § Field](../conventions/ui.md#field), and "Chosen automatically: the 6 mm end mill didn't fit the 2 mm corner" after an auto change.

## Apply (D13)

Q17 is decided as D13 (2026-11-21) and specified, as a draft, in [apply.md](../architecture/apply.md). In short, for this doc:

- Edits commit live (one undo step each; the mesh, parameter checks and live outline follow); the [auto tool choice](#auto-choice) is **deferred** to Apply: Enter in a field, Cmd/Ctrl+Enter, or the "Apply N" button. Blur and Tab commit only.
- Apply runs the auto choice for every unlocked operation with pending changes, then the draft plans follow ([plan-v0.2.md](plan-v0.2.md#tool-resolution-from-the-design-tool-field)), as one undoable entry "Apply N changes"; undoing it restores the old tools and leaves the edits pending.
- Until Apply, `dfm.toolUnfit` and `dfm.toolNotInLibrary` of an unlocked tool with pending changes show as "may change on Apply"; against a locked tool they are final.
- Agents auto-apply per call by default (`apply: false` batches); the swap comes back as `applied.toolChanges`.

## Questions raised by this draft

Each with options and the draft's recommendation; the user answers before `accepted`.

| #   | Question                                              | Options                                                                                                                            | Recommendation                                                                                      |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A   | Are planar pocket/profile walls face targets in v0.2? | (a) no, stock faces + floors + tab tops; (b) also straight walls of rectangles                                                     | (a): walls need the tool to fit inside the pocket beside the feature (a new access rule); add later |
| B   | Face frame orientation                                | (a) as tabled: seen from outside, v up on sides, bottom rolled over X; (b) bottom rolled over Y (u = −X, v = +Y)                   | (a): X stays X on top and bottom, matching a flip toward the operator                               |
| C   | Formula names for face levels                         | (a) part-frame `.x` / `.y` / `.z` per axis; (b) neutral `.level` along the normal; (c) both                                        | (a): readers think in axes, and `.z` stays valid                                                    |
| D   | What the auto choice prefers                          | (a) a fitting library tool, else generalized; (b) always generalized (Plan picks the real tool)                                    | (a): shows real tools and real DFM ("real data", principle 5); (b) for an empty library anyway      |
| E   | Facing and profile `on` beyond stock faces            | (a) stock faces only in v0.2; (b) a profile from a floor (through opening in a pocket floor), a facing of a floor                  | (a): keeps through-cut and tab rules unchanged; (b) later                                           |
| F   | `tool.*` in design expressions                        | (a) unknown in v0.2; (b) allowed for locked tools only                                                                             | (a): (b) still changes geometry on a library edit and breaks the result-first rule                  |
| G   | Changing `on` to another direction                    | (a) keep the `[u, v]` numbers; (b) keep the point in the part frame where possible; (c) reset to the face centre                   | (a): predictable, and the access checks warn                                                        |
| H   | Auto choice during adjust-popover steps               | (a) every committed step, as every command; (b) skip gesture steps and choose on apply                                             | Settled by D13: (b), [apply.md](../architecture/apply.md#adjust-popover)                            |
| I   | Generalized drill and point angle                     | (a) a generalized drill takes the operation's `pointAngle`; (b) it stores its own                                                  | (a): the operation already states the result                                                        |
| J   | Updating a specific tool's snapshot from the library  | (a) a new `design.snapshot.update { snapshotId }` for tool and stock snapshots; (b) re-pick the tool (`design.operation.tool.set`) | (a): one explicit, undoable path for every design snapshot, as plans have `plan.libraryItem.update` |
