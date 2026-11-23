# Library: stock, tools and machines

Status: implemented · Storage rule: [persistence.md](persistence.md#library-references) · Values: [quantities.md](quantities.md) · Models: [error-handling/models.md](../conventions/error-handling/models.md) · Terms: [glossary.md](../glossary.md) · UI: [ui-library-window.md](../conventions/ui-library-window.md) · Task: [v0.1 plan](../plans/v0.1.md) 1.7 (models: 2.4)

The library holds the user's **stock**, **tools** and **machines**. It is global app data shared by all projects; a project uses an item only through a **snapshot** ([persistence.md](persistence.md#library-references)). Workholding joins the library later. Every dimensional field is a [quantity](quantities.md) of the kind given below; "v0.1 = yes" means required (an optional field is `Option`).

## Common fields

| Field       | Type                             | v0.1 | Invariants        | Why                                                           |
| ----------- | -------------------------------- | ---- | ----------------- | ------------------------------------------------------------- |
| `id`        | string (UUID)                    | yes  | non-empty         | Target of `libraryItemId` in snapshots.                       |
| `kind`      | `'stock' \| 'tool' \| 'machine'` | yes  | –                 | Discriminates the record and the snapshot `kind`.             |
| `name`      | string                           | yes  | 1–120 chars       | Shown in pickers, plan sheets and gCode comments.             |
| `notes`     | string                           | no   | ≤ 4000 chars      | Vendor, product number, where it is stored.                   |
| `revision`  | integer                          | yes  | ≥ 1, +1 per write | Stale-write check across app instances ([Storage](#storage)). |
| `updatedAt` | ISO 8601 string                  | yes  | –                 | Sorting; "library changed since snapshot" hint.               |
| `parentId`  | item id                          | no   | a root stock      | Stock only: the parent of a [variant](#stock-variants-df13).  |

## Stock

v0.1 has one shape, the rectangular **block**; `shape` is a discriminant so round bar, tube and sheet can be added later.

| Field            | Kind / type          | v0.1 | Invariants  | Why                                                                                                                        |
| ---------------- | -------------------- | ---- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `shape`          | `'block'`            | yes  | –           | Selects the stock solid in `part = stock − …` ([geometry.md](geometry.md#principle-geometry-comes-from-material-removal)). |
| `length` (X)     | length               | yes  | > 0         | Stock solid; facing region; profile and drilling must lie inside.                                                          |
| `width` (Y)      | length               | yes  | > 0         | As above.                                                                                                                  |
| `thickness` (Z)  | length               | yes  | > 0         | Facing amount, through-cut depth for profile and drilling. Its tolerance is the real stock variation.                      |
| `material.name`  | string               | yes  | 1–120 chars | Shown to the user ("6061-T6", "birch plywood").                                                                            |
| `material.class` | `MaterialClass` enum | yes  | –           | Key for feeds-and-speeds presets and DFM hints. Users cannot add classes.                                                  |

`MaterialClass` (fixed enum): `softwood`, `hardwood`, `sheetGood` (MDF, plywood), `plastic`, `aluminum`, `brass`, `steel`, `other`.

### Stock variants (DF13)

The user's request ([hardening.md](../plans/hardening.md) intake DF13): a stock in the library may have **variants**, e.g. "Aluminium plate 10" with its cut sizes "Aluminium plate 10 · 200 × 150 × 10" and "· 300 × 200 × 10". A variant is an ordinary stock item (all fields of its own, written and snapshotted like any other) with `parentId`, the id of its parent stock.

- **One level:** the parent is a stock without `parentId`; a variant of a variant is refused (`library.stock.add` fails with `input.malformed`, issue `parentId` rule `nestedVariant`; an unknown parent is rule `unknownItem`). `parentId` is set when the item is added and kept by every update; it is library bookkeeping like `revision`, so it is not part of the values a snapshot copies.
- **Remove:** a stock that still has variants cannot be removed (`library.stock.remove` fails with `input.malformed`, rule `hasVariants`: remove the variants first). A variant whose parent file is gone or does not load is listed as a stock of its own.
- **Only stock** has variants; `parentId` on another kind is refused (`notStock`). Stored as an optional field of the item file, so older files load unchanged (no reset, [pre-alpha rule](../conventions/error-handling/migrations.md#pre-alpha-exception-no-data-preservation-yet)).
- UI: the Library window lists variants under their parent ([ui-library-window.md § Stock variants](../conventions/ui-library-window.md#stock-variants-df13)); the design Stock dialog saves a changed library stock as an update or a new variant ([ui.md § Stock dialog](../conventions/ui.md#stock-dialog-df11df13)).

## Tool

Types and field names follow ISO 13399 symbols as used by the Fusion tool library (`DC`, `LCF`, `OAL`, `NOF`, `RE`, `SIG` – [Autodesk forum example](https://forums.autodesk.com/t5/fusion-api-and-scripts/creating-a-cam-tool-with-api/td-p/12683292)) and the FreeCAD CAM tool-bit shapes (`Diameter`, `CuttingEdgeHeight`, `Length`, `ShankDiameter`, `CornerRadius`, `TipAngle` – [FreeCAD tool bits](https://github.com/FreeCAD/FreeCAD/tree/main/src/Mod/CAM/Tools/Bit)).

| `type`            | v0.1 use                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flatEndMill`     | Facing (incl. surfacing bits), pocket, profile, inside corner radius ≥ tool radius.                                                                                  |
| `bullNoseEndMill` | Floor fillet in one pass when `cornerRadius` matches ([geometry.md](geometry.md#fillets-as-retained-regions)).                                                       |
| `ballEndMill`     | Floor fillet by 3D passes; later carving.                                                                                                                            |
| `drill`           | Drilling.                                                                                                                                                            |
| `chamferMill`     | v0.4: chamfer operations (countersinks); chamfer mills and V-bits ([design-v0.4.md](../modes/design-v0.4.md#chamfer-mill-tool-type)); later engraving and V-carving. |

| Field                 | Kind / type                     | v0.1                         | Invariants                                                      | Why                                                                                |
| --------------------- | ------------------------------- | ---------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `type`                | enum above                      | yes                          | –                                                               | Which operations may use the tool; toolpath tip shape.                             |
| `diameter` (DC)       | length                          | yes                          | > 0                                                             | Toolpath offset, stepover, minimum inside corner radius, drill hole size.          |
| `cornerRadius` (RE)   | length                          | bull nose only               | 0 < RE < DC/2; flat = 0 and ball = DC/2 are derived, not stored | Floor-fillet matching; tip shape for depth and scallop height.                     |
| `fluteLength` (LCF)   | length                          | yes                          | > 0                                                             | Maximum cutting depth per pass and per operation (plan check, not invariant).      |
| `overallLength` (OAL) | length                          | yes                          | > `fluteLength`                                                 | Plausibility of `stickout`; later collision checks.                                |
| `stickout`            | length                          | no                           | > 0, < `overallLength`                                          | Default length below the collet: deepest reachable floor; plan may override (1.9). |
| `shankDiameter`       | length                          | no                           | > 0                                                             | Collet size; later collision checks.                                               |
| `fluteCount` (NOF)    | scalar, integer                 | yes                          | ≥ 1                                                             | Chip load = feed rate / (spindle speed × flutes), shown next to feed presets.      |
| `pointAngle` (SIG)    | angle                           | drill only                   | 0° < SIG < 180° (118°/135° typical)                             | Tip length, so a through hole is drilled deep enough.                              |
| `angle` (included)    | angle                           | chamfer mill only (required) | 30°–150°                                                        | Must match the chamfer angle (within 0.5°); a 90° V-bit is a 90° chamfer mill.     |
| `tipDiameter`         | length                          | chamfer mill only, optional  | ≥ 0, < `diameter`; absent = pointed (0)                         | Smallest cutting diameter: the tool cannot cut below its tip; feeds use De (F10).  |
| `toolMaterial`        | `'carbide' \| 'hss' \| 'other'` | no                           | –                                                               | Feeds-and-speeds hint.                                                             |
| `coating`             | string                          | no                           | ≤ 60 chars                                                      | Display only.                                                                      |
| `presets`             | `CuttingPreset[]`               | no                           | unique `name`; see below                                        | Feeds and speeds ([below](#feeds-and-speeds-presets)).                             |

v0.1 has the first four types above; v0.4 adds `chamferMill` (task C1, amendment from [design-v0.4.md](../modes/design-v0.4.md#chamfer-mill-tool-type); the field set is additive, no `schemaVersion` change). For a chamfer mill `diameter` is DC (the largest cutting diameter) and `fluteLength` (LCF) the height of its cutting edge. A chamfer mill fits no facing, pocket, drilling or profile ([fit](../modes/design-v0.2.md#fit-when-a-tool-can-make-the-operation)). Later: holder (gauge length, collision shape), tool number (machine tool table), taper, fly cutter, face mill, tap.

### Feeds-and-speeds presets

Feeds and speeds are stored as optional presets on the tool, per material class, like the Fusion tool library's presets ([Autodesk blog](https://www.autodesk.com/products/fusion-360/blog/new-manufacturing-tool-library/)). How plan mode picks or fills a preset (manual entry, calculator) is task 1.9 ([plan](../plans/v0.1.md)):

| `CuttingPreset` field | Kind / type     | Invariants                                                     |
| --------------------- | --------------- | -------------------------------------------------------------- |
| `name`                | string          | 1–60 chars                                                     |
| `materialClass`       | `MaterialClass` | optional; none = any                                           |
| `spindleSpeed`        | spindleSpeed    | > 0                                                            |
| `feedRate`            | feedRate        | > 0                                                            |
| `plungeRate`          | feedRate        | > 0                                                            |
| `stepdown`            | length          | optional; > 0                                                  |
| `stepover`            | length          | optional; > 0, ≤ `diameter`                                    |
| `recommended`         | boolean         | optional; needs `materialClass`; [below](#recommended-presets) |

Chip load is derived and displayed, not stored (it is not a v0.1 quantity kind – [quantities.md](quantities.md#kinds-and-units)). Machine limits are checked by plan mode, not as tool invariants ([models.md](../conventions/error-handling/models.md#a-simple-model)).

### Recommended presets

A preset with `recommended: true` **follows the calculator** until its values are edited (the user's D30 item 14, after the "Recommended" checkbox of the earlier cnc-code tool library). Its `spindleSpeed`, `feedRate`, `plungeRate` and `stepdown` are the [calculator's](feeds-speeds.md) recommendation for the tool and the preset's material class:

- **Engagement:** a full-width slot for end mills (as pockets and profiles use), drilling for drills, the full cone (De = DC, [F10](feeds-speeds.md#chamfer-mills-v04)) for chamfer mills. **No particular machine:** the lowest [rigidity](feeds-speeds.md#machine-rigidity-presets) (`extrusion`) and no spindle or feed clamp, because a library tool serves every machine. Plan mode's machine checks still apply to the stored values; for values that follow the plan's machine, use [auto mode](../modes/plan-v0.1.md#locks-and-auto-mode).
- **Written on save:** `library.tool.add` and `.update` replace those four values of every recommended preset with the recommendation (a field the calculator does not suggest keeps its value; `stepover` always keeps its value), so the preset follows changes to the tool's diameter, flutes, type, lengths, stickout or tool material. Values are rounded (whole rpm; mm: whole mm/min and 0.01 mm; inch: 0.1 in/min and 0.001 in) and written in the command's `units`. A calculator update reaches a preset when its tool is next saved; plans use the stored values like any preset (their tool copies are [snapshots](#snapshots)).
- **Editing ends it:** to enter its own values, an agent sends the preset with `recommended` false or omitted; in the [Library window](../conventions/ui-library-window.md#recommended-presets) editing one of the four values unticks the flag (the values stay).
- **Rules:** `recommended` without `materialClass` is a `CuttingPreset` invariant issue (`recommendedNeedsClass`, path `presets.<i>.recommended`); a tool and class the calculator has no data for (`feeds.noData`) fails the command with `model.invariant`, rule `noRecommendation` at `values.presets.<i>.recommended`, the calculator's reason as the message.
- **Offered:** the plan inspector's "Cutting preset" list shows "Follows the calculator" under a recommended preset; the tool's preset order is kept.
- **Stored** only when true; the field is optional, so existing presets load unchanged (not recommended). The rules are `followRecommended` in `src/core/feeds-speeds/preset.ts`.
- **Built-in presets:** none; the library starts empty, so nothing is seeded.

## Machine

v0.1: a 3-axis router or mill on a GRBL-family controller ([ADR 0013](../decisions/0013-grbl-first-controller.md)). Limit fields mirror GRBL `$` settings ([GRBL v1.1 configuration](https://github.com/gnea/grbl/wiki/Grbl-v1.1-Configuration)), so they can be imported from `$$` output ([GRBL `$$` import](#grbl--import)) and configure the virtual machine.

| Field                | Kind / type                                                                           | v0.1 | Invariants        | Why                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------- | ---- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `controller`         | `'grbl'`                                                                              | yes  | –                 | Selects post-processor and streaming protocol; grblHAL/FluidNC use the same value.                                                                                                                           |
| `travel.x/y/z`       | length ×3 (`$130–$132`)                                                               | yes  | > 0               | **Work envelope** = travel box; plan checks that stock and toolpaths fit; `machine.travel.z` in expressions.                                                                                                 |
| `maxFeedRate.x/y/z`  | feedRate ×3 (`$110–$112`)                                                             | yes  | > 0               | Feed rates above it are flagged; GRBL also rapids (G0) at it, so it drives run-time estimates.                                                                                                               |
| `acceleration.x/y/z` | scalar ×3, mm/s² (`$120–$122`)                                                        | no   | > 0               | Better time estimates; virtual machine timing.                                                                                                                                                               |
| `junctionDeviation`  | length (`$11`)                                                                        | no   | > 0               | GRBL's cornering speed model; the virtual machine and time estimates use it (none = DFYOM default 0.010 mm).                                                                                                 |
| `arcTolerance`       | length (`$12`)                                                                        | no   | > 0               | Chord tolerance GRBL splits `G2`/`G3` into; virtual machine and time estimates (none = DFYOM default 0.002 mm).                                                                                              |
| `stepsPerMm.x/y/z`   | scalar ×3, steps/mm (`$100–$102`)                                                     | no   | > 0               | Recorded so a changed drive or controller reset is noticed (`$$` import); reported by the virtual machine, not used.                                                                                         |
| `spindle.control`    | `'gcode' \| 'manual'`                                                                 | yes  | –                 | `manual` (trim router dial): export pauses (M0) and asks the user to set the speed; S words informative.                                                                                                     |
| `spindle.maxSpeed`   | spindleSpeed (`$30`)                                                                  | yes  | > 0               | GRBL clamps S above `$30` silently, so plan flags it.                                                                                                                                                        |
| `spindle.minSpeed`   | spindleSpeed (`$31`)                                                                  | no   | ≥ 0, < `maxSpeed` | Flags presets below the spindle's range.                                                                                                                                                                     |
| `spindle.power`      | power                                                                                 | no   | > 0               | Rated output power, for the [feeds-and-speeds power check](feeds-speeds.md#hobby-machine-realism); none = check skipped.                                                                                     |
| `rigidity`           | `'extrusion' \| 'hobby' \| 'prosumer' \| 'fixedGantry' \| 'benchMill' \| 'rigidMill'` | no   | –                 | [Rigidity preset](feeds-speeds.md#machine-rigidity-presets) for suggested depth and feeds; none = `extrusion` (lowest).                                                                                      |
| `homingCorner`       | `'backRight' \| 'backLeft' \| 'frontRight' \| 'frontLeft'` (`$23` bits 0–1)           | no   | –                 | Where XY homes (Z always homes up); configures the virtual machine and places the home marker ([run.md](../modes/run.md#machine-coordinates-and-the-homing-corner-df33)). None = `backRight` (GRBL `$23=0`). |
| `pullOff`            | length (`$27`)                                                                        | no   | > 0               | Homing pull-off; MPos after homing is −pull-off (or −travel + pull-off on an axis homing to −). None = 1 mm (GRBL default).                                                                                  |
| `softLimits`         | boolean (`$20`)                                                                       | no   | –                 | Soft limits on the virtual machine; jogs and moves outside `[−travel, 0]` are refused. None = on (DFYOM default).                                                                                            |
| `programUnits`       | `'mm' \| 'in'`                                                                        | yes  | –                 | G21/G20 in exported gCode. GRBL settings are always mm; `$13` changes only reports.                                                                                                                          |
| `toolChanger`        | `'none'`                                                                              | yes  | –                 | Manual tool change: export stops (M0), the user changes the tool and re-zeros Z.                                                                                                                             |

`acceleration` and `stepsPerMm` are set for all three axes or for none. Axes are fixed X/Y/Z in v0.1; 4th/5th axis, Z homing down, tool length sensor and tool table come later. Machine coordinates follow GRBL: the travel is `[−travel, 0]` on every axis whatever the homing corner ([grbl.md](grbl.md#homing-and-machine-coordinates)).

## GRBL `$$` import

Status: implemented (paste import, D30; diff on a real-machine connect, hardening M1, draft) · Origin: ported from the user's cnc-code `grblSettings.ts` (relicensed GPL-3.0-or-later)

The user pastes GRBL's `$$` answer (from any sender or terminal); DFYOM shows what it would change in a library machine and applies only the changes the user accepts. **DFYOM never writes settings to GRBL** (writing `$x=` would be a separate, explicit command).

**Parsing** (`src/core/run/grbl/settings.ts`, shared with the sender's [handshake](../modes/run-v0.1.md#sender), which classifies each received line with the same `parseSettingLine`):

- A setting is `$<n>=<number>` anywhere in a line, after the line start or a space, ending at the line end, a space, `(` or `;`. Senders' prefixes (`>>> `, `[rx] `), GRBL builds' descriptions (`$110=5000.000 (x max rate, mm/min)`), `ok`, the banner, `[MSG:…]` and blank lines are ignored. A later duplicate wins.
- Unknown ids (`$999=1`, grblHAL extras) are read and returned as `ignored`; text with no setting at all is `input.malformed` (rule `noSettings`, path `text`).
- `$$` values are always mm, mm/min, mm/s² and rpm (`$13` changes only reports).

**Mapping** to machine fields (`src/core/library/grbl-import.ts`, rules ported from cnc-code; `$20` and `$23` mapped since hardening M1):

| Setting      | Field                               | Rule                                                                                                                                                                                                      |
| ------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$11`, `$12` | `junctionDeviation`, `arcTolerance` | –                                                                                                                                                                                                         |
| `$100–$102`  | `stepsPerMm.x/y/z`                  | All three together when the machine has none (rule `allAxes`).                                                                                                                                            |
| `$110–$112`  | `maxFeedRate.x/y/z`                 | –                                                                                                                                                                                                         |
| `$120–$122`  | `acceleration.x/y/z`                | All three together when the machine has none (rule `allAxes`).                                                                                                                                            |
| `$130–$132`  | `travel.x/y/z`                      | Only with soft limits on (`$20=1`); else skipped (`softLimitsOff`): GRBL never uses them and they may be its defaults.                                                                                    |
| `$30`, `$31` | `spindle.maxSpeed`, `.minSpeed`     | Only for a `gcode` spindle; a manual dial ignores `S`, skipped (`manualSpindle`). `$31=0` means "no minimum" and is skipped.                                                                              |
| `$27`        | `pullOff`                           | –                                                                                                                                                                                                         |
| `$20`        | `softLimits`                        | `1` → on, `0` → off. Unchanged when it equals the stored value or, with none stored, the default (on).                                                                                                    |
| `$23`        | `homingCorner`                      | Bits 0–1 → `backRight` (0), `backLeft` (1), `frontRight` (2), `frontLeft` (3); bit 2 set (Z homes down) is skipped (`zHomesDown`). Unchanged when it equals the stored corner or, with none, `backRight`. |

- A value ≤ 0 of a mapped quantity setting is skipped (`notPositive`); a value equal to the stored one within GRBL's printed precision (0.0005) is `unchanged`.
- A new value is written in the machine's own unit system ([`itemUnitSystem`](#command-input)): a bare number in an mm machine, the GRBL unit written out in an inch machine (`5000 mm/min`), never converted.
- **Diff entry:** `{ setting: '$110', field: 'maxFeedRate.x', value: 5000, from: '3000 mm/min' | null, to: '5000 mm/min', together: ['$120','$121','$122']? }`; `from`/`to` are display texts with their unit (`on`/`off` for `$20`, the corner name such as `backRight` for `$23`). Skipped entries carry `{ setting, field, value, rule }`; the UI words the rule.
- `machineSettingsDiff(machineValues, settings)` takes a parsed `Map<number, number>`, so the connect path can call it with `ControllerInfo.settings` (planned below).

**Commands** (app scope, like the other library commands):

- Query `library.machine.settings.preview { id, text }` → `{ read, changes, unchanged, skipped, ignored }`.
- Command `library.machine.settings.import { id, revision, text, accept }` (`effect`, not undoable): re-parses `text`, applies the accepted changes (`accept`: setting names from `changes`, at least one) and stores the machine; result `{ item, applied }`. An `accept` entry that is not a change is `input.malformed` (`notAChange`, path `accept.<i>`); accepting part of a `together` group is `input.malformed` (`allAxes`); the new machine is checked by the model like any update; a stale `revision` is `command.conflict`.
- **UI:** "Import $$…" in the Library window's machine editor ([ui-library-window.md](../conventions/ui-library-window.md#implementation-task-l1)).

**Diff on connect** (hardening M1, [run-machine.md § Settings check](../modes/run-machine.md#settings-check)): `run.connection.open` against a real controller compares the handshake's `$$` (`ControllerInfo.settings`) with the connection's machine copy (the plan's, or the library machine) through `machineSettingsDiff`; a difference does not refuse the connection but refuses real runs until the copy matches. The plan's machine snapshot is never changed silently, and nothing is written to GRBL.

## Snapshots

The snapshot record and rule are owned by [persistence.md](persistence.md#library-references). This doc fixes:

- `kind` is the item's `kind`; `values` is the item's DTO without `id`, `revision`, `updatedAt` and `parentId`, parsed with the same Zod schema and built with the same `Model.create()`. A snapshot never reads the library.
- "Library changed" is shown when the item's current values differ from `values` (deep compare); no extra field.
- **Own stock (DF13):** a part's stock snapshot may have no `libraryItemId`: the project's own block, entered in the Stock dialog without saving it to the library, or a library stock whose sizes were changed there (a piece cut from it). `design.part.add { stock }` takes it from the values; it is never stale, has no "Update from library", and the plans' copies of it neither.
- Commands that take a snapshot (e.g. choosing stock in design mode, assigning a tool or machine in plan mode) and `project.snapshot.update` ("update from library") are project document commands, one undo step each.
- When a library item used by the open project changes, the app notifies the user and suggests re-importing it. Each plan holds its own copies; they are updated per item and per plan (`plan.libraryItem.update`, [plan-v0.1.md](../modes/plan-v0.1.md#plans-are-snapshots)); `draft` plans follow library changes automatically, all other plans only on request. The notice is the query `plan.stale.list` (`libraryCopies`); draft plans re-import on the project's next Apply ([apply.md](apply.md#implementation-task-p2); v0.1 dispatched `followLibraryChanges` per change).

## Storage

The app host opens the library once per instance (`Library.open` over `<appData>/library`) and passes it as `services.library` to the app-scope dispatcher, which runs the `library.*` commands without an open project, and to every project dispatcher (snapshots) ([llm-api.md](llm-api.md#app-scope-and-project-scope), task 3.10).

| Item     | Path                                                 | Content                                                  |
| -------- | ---------------------------------------------------- | -------------------------------------------------------- |
| Manifest | `<appData>/library/library.json`                     | `{ format: 'dfyom-library', schemaVersion: 1 }`          |
| Items    | `<appData>/library/{stock,tools,machines}/<id>.json` | One item DTO per file, pretty-printed, stable key order. |

- Writes are atomic per file (temp + fsync + rename), like the [working folder](persistence.md#working-folder-writes). Every instance shares the folder; a write whose `revision` differs from the file on disk fails with `command.conflict`.
- An item that does not load is listed with its error and never deleted or overwritten automatically ([pre-alpha rule](../conventions/error-handling/migrations.md#pre-alpha-exception-no-data-preservation-yet)).
- Commands: `library.{stock,tool,machine}.{add,update,remove}`; queries `.get` and `.list` ([naming](commands.md#naming)); the `$$` import adds `library.machine.settings.{preview,import}` ([GRBL `$$` import](#grbl--import)). The commands are `effect` commands ([kinds](commands.md#command-definition)): written to disk at once, **not undoable**, no history entry, still logged in the action log.
- **UI (v0.1):** the stock setup adds a block ([design.md](../modes/design.md#workflow); since DF13 only on "Save to library", [ui.md § Stock dialog](../conventions/ui.md#stock-dialog-df11df13)); plan mode's "New tool…" and "New machine…" forms add a tool or machine with the fields v0.1 needs ([ui.md](../conventions/ui.md#plan-mode-task-37)). Editing and removing items needs the library editor (later milestone; drafted as the [Library window](../conventions/ui-library-window.md), B24).
- `add`/`update` take [quantity strings](#command-input), not stored quantity objects; results are the stored item DTO.
- `remove` asks for confirmation: its args schema requires `confirm: true` (`z.literal(true)`), so a call without it fails with `input.malformed`. The UI sets it after a confirmation dialog; agents and CLI pass it explicitly. Projects keep their snapshots of a removed item.

## Command input

`library.<kind>.add` and `.update` take `values` with every quantity as a **string as entered** (`"6 mm"`, `"1/4\""`, `"10 ±0.1"`, `"18000"`), like every other command (decision D20, v0.2: the stored quantity objects cost 8.6 K of the agent [`tools/list` budget](llm-api.md#implementation-task-310)). Stored files, `.get`/`.list` results and snapshots keep the quantity [DTO](quantities.md#persistence-dto) unchanged.

- **Bare numbers:** the optional `units` arg (`mm` | `inch`, default `mm`, the project unit systems) gives each field's bare-number default: length `mm` / `in`, feed rate `mm/min` / `in/min`; spindle speed `rpm`, power `W`, angle `deg`, scalar `1` in both. It is stored as the quantity's `defaultUnit`. The UI forms pass the project's unit system; an agent writes the unit or passes `units`. To keep a stored value on `update`, pass its `source` with the same `units` (or write the unit).
- **Literals only:** strings follow the [literal grammar](quantities.md#literal-grammar-task-21); library items have no parameters to reference.
- **Errors** are those of every quantity field: `quantity.syntax` / `quantity.unit` with the field's path below `values` (`values.diameter`, `values.presets.0.feedRate`), returned for the first bad field (as `collect()`); model rules then report all fields as `model.invariant` issues with the same paths. A quantity object where a string is expected is `input.malformed`.
- **Implementation:** [`values-input.ts`](../../src/core/library/values-input.ts) derives the input schema from the DTO schema (each `quantityDto(kind)` node becomes a string, descriptions kept), so the two cannot drift, and parses the strings into DTOs before the model is built; `libraryUnit(kind, units)` is shared with the UI forms.

## Implementation decisions (task 2.4)

Where this doc was silent, the implementation chose conservatively:

- **Ids** are file names, so they match `[a-z0-9_-]{1,120}` – lowercase, so case-insensitive file systems (APFS, NTFS) cannot alias two ids (generated as `<kind>-<uuid>`); anything else is `input.malformed` before a path is built.
- **Per-type fields:** `cornerRadius` on a non-bull-nose tool and `pointAngle` on a non-drill are invariant issues (`notAllowed`), not silently dropped; `Tool.effectiveCornerRadius` derives 0 / DC/2. `fluteCount` is a `scalar` quantity that must be a whole number ≥ 1; `acceleration` is a `scalar` in mm/s² (all three axes or none). `presets` is always written (`[]` when empty).
- **Preset rules:** each `CuttingPreset` checks its own fields; `stepover ≤ diameter` and unique names are checked by the tool, only once all presets are valid ([composite models](../conventions/error-handling/models.md#composite-models)).
- **Revisions:** `update` requires the `revision` the caller read; `add` fails with `command.conflict` if the id exists; `remove` checks `revision` when given and may omit it only to delete an item whose revision cannot be read (otherwise `command.conflict`). An unknown id is `input.malformed` (rule `unknownItem`); updating an unloadable item is refused (`unreadableItem`). Command args carry `values` without `kind`, quantities as strings ([Command input](#command-input)); results are the stored item DTO.
- **Snapshot status** has a fourth value, `libraryUnreadable` (the item file exists but does not load, so nothing can be compared). "Update from library" (`refreshSnapshot`) keeps the snapshot id and sets `takenAt` to now.
- **"Used item changed" notice** is data only: `Library.subscribe` emits each change, `usedItemNotices(snapshots, library.lookup)` lists the affected snapshots. A query joins once `ProjectDoc` holds snapshots (tasks 2.5/2.13).
- **Library service:** `Library` loads all items once and keeps them in memory, so `.get`/`.list` queries and the snapshot check are synchronous; writes go through the port, are serialized, and a conflict reloads the item. It reaches handlers as `ctx.services.library` (queries get `ctx.services` too – [commands.md](commands.md#command-definition)). Library queries set `readsDocument: false`, so they do not count as a project read for the [stale-write baseline](commands.md#stale-writes).
- **Cross-instance writes:** read → revision check → rename (or unlink) runs under a per-item lock file `<id>.json.lock` created with `wx`; a held lock is retried (~2 s) and then reported as `command.conflict`, a lock older than 30 s is treated as left by a crashed instance and broken. After the rename the directory is fsynced (skipped on Windows). Opening the library sweeps stale `*.tmp-<uuid>` files (older than 10 min) and stale locks.
- **Files:** stable key order is the model's order (meta first), not alphabetical. A manifest with another `schemaVersion` fails with `persist.migration`, a foreign or broken one with `input.malformed`; neither is reset ([pre-alpha rule](../conventions/error-handling/migrations.md#pre-alpha-exception-no-data-preservation-yet)).

## Files

| File                                            | Contents                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/core/library/item.ts`                      | Common fields, `LibraryItemKind`, `MaterialClass`, model helpers               |
| `src/core/library/stock.ts`, `stock.dto.ts`     | `Stock` model and Zod DTO schema                                               |
| `src/core/library/tool.ts`, `tool.dto.ts`       | `Tool` model (per-type invariants), `CuttingPreset`                            |
| `src/core/feeds-speeds/preset.ts`               | Recommended presets: `presetRecommendation`, `followRecommended`               |
| `src/core/library/machine.ts`, `machine.dto.ts` | `Machine` model and DTO, `RIGIDITY_PRESETS`                                    |
| `src/core/library/library-item.ts`              | `LibraryItem` (meta + values), item/values schemas, `parseLibraryItem`         |
| `src/core/library/snapshot.ts`                  | `Snapshot` model and DTO, `takeSnapshot`, `refreshSnapshot`, status, notices   |
| `src/core/library/storage.ts`                   | `LibraryStorage` port (`list`, `get`, `put`, `remove`) and its revision checks |
| `src/core/library/memory-storage.ts`            | In-memory port for tests and headless use                                      |
| `src/core/library/storage.contract.ts`          | Contract tests every port implementation runs                                  |
| `src/core/library/library.ts`                   | `Library` service: cache, serialized writes, change events                     |
| `src/core/library/commands.ts`                  | Library commands and queries                                                   |
| `src/core/library/values-input.ts`              | Command input of values: string schema, parsing into DTOs, `libraryUnit`       |
| `src/core/library/grbl-import.ts`               | `$$` settings → machine diff and apply ([GRBL `$$` import](#grbl--import))     |
| `src/core/library/used.ts`                      | `usedLibraryItemIds`: the items a project uses (Library window chips)          |
| `src/main/library/fs-storage.ts`                | Filesystem implementation of the port                                          |
