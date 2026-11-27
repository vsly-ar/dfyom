# Tool holder: collet nut and spindle in the collision checks

Status: implemented (2026-11-27; Q174–Q183 take their recommendations, accepted by delegation D82; internal backlog idea 1, hardening [DF132](../plans/hardening.md#intake-user-feedback-goes-here); carries over the backlog row "Holder and collet collision" of [v0.4-llm-first](../plans/v0.4-llm-first.md) and WH-F's "holder model later" ([Q40](../plans/v0.4-llm-first.md#questions-for-the-user)); questions [Q174–Q183](#open-questions-for-the-user) answered; H1–H6 implemented, [§ Implementation (H1)](#implementation-h1), [§ Implementation (H2)](#implementation-h2), [§ Implementation (H3)](#implementation-h3), [§ Implementation (H4)](#implementation-h4), [§ Implementation (H5)](#implementation-h5), [§ Implementation (H6)](#implementation-h6)) · Base: [workholding.md § Collision check](workholding.md#collision-check), [plan-v0.1.md § Minimum stickout](plan-v0.1.md#minimum-stickout-hardening-df130), [safe-links.md § Clamps](safe-links.md#clamps) · Machine fields: [library.md § Machine](../architecture/library.md#machine) · Terms: [glossary.md](../glossary.md)

DFYOM checks the tool as a cylinder of max(cutting Ø, shank Ø) from the tip up ([WH-F](workholding.md#decisions)), and DF130's minimum stickout adds a fixed 5 mm "for the collet nut" above the deepest cut. Neither knows how wide the nut is. A Ø19 ER11 nut, or a Ø65 spindle body above it, can pass over a 25 mm toe clamp while the Ø6 tool cuts the stock 10 mm beside it. Today no check catches that, and the stickout read-out at the tool change does not account for it. This doc adds a **holder model** to the machine: the collet nut and the spindle body, each a diameter and a length. With it the tool becomes a stepped **collision envelope**, and the checks and the minimum stickout use that envelope.

## Goals and not goals

- **Goals:** a holder per machine, chosen from presets or measured; an optional per-tool override; the envelope in the workholding collision check and the low links; a clamp term in the minimum stickout; the reason shown at the tool change; a holder ghost in the plan viewport.
- **Not goals:** gantry, Z carriage or dust shoe collisions; tool holders as library items; automatic tool-length measurement; the nut dipping into wide pockets (later, [Q177](#open-questions-for-the-user)); 3D simulation.

## Model

A machine gains an optional `holder` (the [library.md § Machine](../architecture/library.md#machine) table gets the row in H1). It is an optional field, so there is no `schemaVersion` change ([migrations.md](../conventions/error-handling/migrations.md#pre-alpha-exception-no-data-preservation-yet)).

| Field          | Kind   | Invariants              | Meaning                                                                                           |
| -------------- | ------ | ----------------------- | ------------------------------------------------------------------------------------------------- |
| `preset`       | string | a [preset](#presets) id | The preset the fields came from (display only; editing a size keeps it as "ER11, edited")         |
| `nutDiameter`  | length | > 0                     | Largest diameter of the collet nut (across the hex or the round nut)                              |
| `nutLength`    | length | > 0                     | From the nut face (the [spindle nose](../glossary.md), where stickout is measured) up to the body |
| `bodyDiameter` | length | ≥ `nutDiameter`         | Spindle or router body above the nut; it counts to infinity upward                                |
| `maxShank`     | length | > 0, optional           | Largest shank the collet system takes (ER11: 7 mm); see [Findings](#findings)                     |

- **Per-tool override (H6, [Q175](#open-questions-for-the-user)):** a library tool may carry its own `holder` with the same fields, for a tool that sits in an extension or a reducing holder. It replaces the machine's holder for that tool on every machine.
- **No holder** means today's behaviour: the WH-F cylinder and the fixed 5 mm.
- The nose stays the reference: `noseToTable` ([DF68](../architecture/grbl.md#z-headroom-hardening-df68)) and the stickout are both measured from the nut face, so the Z headroom check does not change.

### Presets

Presets are built-in constants that fill the fields. They are not library items ([Q176](#open-questions-for-the-user)). The machine form says "measure yours with a caliper" and shows a picture of which dimension is which. Checked in H1 against the ISO 15488 / DIN 6499 nut sizes as ER makers (Rego-Fix and others) publish them, from the agent's knowledge of those drawings, not a vendor PDF opened in the session; the last column says how firm each value is.

| Id             | Label                         | Nut Ø × length | Body Ø | Max shank | Checked                                                                                        |
| -------------- | ----------------------------- | -------------- | ------ | --------- | ---------------------------------------------------------------------------------------------- |
| `er11`         | ER11 nut (300–500 W spindle)  | 19 × 12 mm     | 52 mm  | 7 mm      | Nut Ø and capacity: ER11 standard nut drawings; length ≈ (11.3–12 by maker); body: Ø52 spindle |
| `er11Mini`     | ER11 mini nut                 | 16 × 11 mm     | 52 mm  | 7 mm      | Nut Ø: ER11 mini (M/UM) nut; length ≈                                                          |
| `er16`         | ER16 nut                      | 32 × 18 mm     | 65 mm  | 10 mm     | Nut Ø and capacity: ER16 "A" nut; length ≈ (17.5); body: Ø65 spindle ≈                         |
| `er16Mini`     | ER16 mini nut                 | 22 × 17 mm     | 65 mm  | 10 mm     | Nut Ø: ER16 mini nut ≈; length ≈                                                               |
| `er20`         | ER20 nut (1.5–2.2 kW)         | 35 × 20 mm     | 80 mm  | 13 mm     | Nut Ø and capacity: ER20 "A" nut; length ≈ (19.5–20); body: Ø80 2.2 kW spindle                 |
| `er20Mini`     | ER20 mini nut                 | 28 × 19 mm     | 80 mm  | 13 mm     | Nut Ø: ER20 mini nut ≈; length ≈                                                               |
| `trimRouter`   | Trim router, 1/4″ collet      | ≈ 24 × 20 mm   | 65 mm  | 1/4″      | Approximate: no common drawing (nuts differ by brand); Ø65 is the usual trim router clamp      |
| `plungeRouter` | Full-size router, 1/2″ collet | ≈ 30 × 25 mm   | 80 mm  | 1/2″      | Approximate: no common drawing; body differs widely (≈ 75–90 mm)                               |

"≈" marks a typical value that varies by maker; the form shows every preset's sizes, and the user measures theirs. A later check against a vendor PDF may refine the lengths; it changes no stored machine (presets only fill fields).

## Collision envelope

`toolEnvelope(tool, stickout, holder) → Segment[]` is pure, in `src/core/plan/`. Each segment is `{ radius, zFrom, zTo }`, measured from the tip:

| Segment | Radius                             | From the tip             | Up to                    |
| ------- | ---------------------------------- | ------------------------ | ------------------------ |
| Tool    | max(cutting Ø, shank Ø) / 2 (WH-F) | 0                        | `stickout`               |
| Nut     | `nutDiameter` / 2                  | `stickout`               | `stickout` + `nutLength` |
| Body    | `bodyDiameter` / 2                 | `stickout` + `nutLength` | ∞                        |

- Without a holder there is one segment: the tool from 0 to ∞ (today's WH-F).
- With a holder the envelope contains the WH-F cylinder wherever the nut and body are wider than the shank (always true for a real holder). The check therefore only gets stricter: it never clears a move that WH-F refuses.
- A move collides with a prism when, for any segment, the segment's Z band at the move's lowest point overlaps the prism below `zMax` + margin and the distance in XY is under the segment's radius + margin. This is the existing distance test ([workholding.md § Implementation notes](workholding.md#implementation-notes-df59)) run with up to three radii. Arcs keep their lowest Z, as today.

## Checks

### Holder against the stock

- **Material under the nut ([Q177](#open-questions-for-the-user)):** the stock top plane (Z0 over the stock rectangle). The nut never enters a cut. This is DF130's "deepest cut" term, and the `reach` error (depth > stickout) already reports the nut below the stock top.
- **Walls:** with the plane rule the nut stays above every wall, so no wall check is needed. Letting the nut dip into a pocket wider than the nut (a shorter stickout in a large cavity) needs the in-process stock field ([safe-links.md § In-process stock height field](safe-links.md#in-process-stock-height-field)) and is [later](#not-yet).

### Holder against the workholding

- The workholding collision check ([workholding.md § Collision check](workholding.md#collision-check)) walks every move with the envelope instead of the cylinder: feeds, links, hops, rapids, leads, pecks and tool-change moves.
- A hit by the nut or the body is `plan.workholding.collision` with a new kind `holder` and `params.part` (`nut` or `body`). One code keeps the agent API small. The message names the part, the item, the place and the fix: "Collet nut (ER11, Ø19) passes 9 mm into Toe clamp 2 near X42 Y8 (tip Z−6, nut Z14, clamp top Z25): chuck the tool ≥ 37 mm out or move the clamp".
- **Keep-out ([Q179](#open-questions-for-the-user)):** unchanged. Regions keep the tool radius off the clamp. The clamp term in the minimum stickout tells the operator how long to chuck, and the check blocks the export when the set stickout is still too short.
- **Margin ([Q178](#open-questions-for-the-user)):** the check uses the setup's `workholdingMargin` (2 mm), as for the tool.

### Travel links at clearance

- **Clearance height:** at the clearance height the tip is above the highest item + margin, so the nut and body are higher still. Tool changes, start and end need nothing new.
- **Low links ([safe-links.md](safe-links.md#link-profile)) and hops:** the safe-links "cleared footprint" argument only covers the tool's column. The nut is wider, so a low link beside a clamp can carry the nut over it. The link planner gets a **holder floor** ([Q180](#open-questions-for-the-user)): where the corridor grown by a segment's radius meets a prism, the link level is at least prism top + margin − the segment's `zFrom`. The floor only raises links, and the export guard re-checks every link with the envelope.

## Minimum stickout gains the clamp term

DF130 ([plan-v0.1.md § Minimum stickout](plan-v0.1.md#minimum-stickout-hardening-df130)) computes needed = deepest cut + 5 mm. With a holder and workholding items:

```
needed stickout = max(deepest cut, clamp term) + 5 mm (STICKOUT_CLEARANCE)
clamp term      = max over the moves below the clearance height whose nut disc
                  (nutDiameter / 2 + workholdingMargin) meets a prism footprint:
                  prism.zMax − tip Z
                  (the body: prism.zMax − tip Z − nutLength, over bodyDiameter / 2 + margin)
```

- **Source:** the setup's current toolpaths (feeds and the links between them). While a toolpath is missing or stale, the run falls back to DF130's value and the read-out says "(clamps not yet checked)". It is per tool run, as today ([plan-v0.4.md § Tool changes](plan-v0.4.md#tool-changes-per-setup-hardening-df66)).
- **Reason:** `stickoutReason` `{ kind: 'cut' | 'workholding', itemId?, operationId, x, y }`: the move that decides the number, also used by the [ghost](#viewport-holder-ghost).
- **`shortStickout`** (warning, existing) now compares with this value. Its message names the clamp when the clamp term wins: "stickout 25 mm is shorter than the 37 mm Toe clamp 2 needs under the collet nut".
- **Margins ([Q178](#open-questions-for-the-user)):** the read-out adds 5 mm to both terms, and the check errors only inside the 2 mm workholding margin. Between the two the operator gets the `shortStickout` warning, never a silent pass.
- Without a holder or without items the value is exactly DF130's. Goldens and read-outs do not change.

## Findings

| Code                                  | Severity | When                                                                                                                                                            |
| ------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reach` (existing)                    | error    | Depth > stickout: the nut would be in the stock                                                                                                                 |
| `plan.workholding.collision` `holder` | error    | With the stickout as set, the nut or body enters a prism + margin on any move; blocks `plan.export` and `run.job.start`                                         |
| `plan.links.collision` (existing)     | error    | Export guard: a link misses the holder floor (a bug)                                                                                                            |
| `shortStickout` (existing)            | warning  | Stickout under the needed stickout above (deepest cut or clamp term + 5 mm), no collision                                                                       |
| `plan.holder.shankTooLarge`           | warning  | The tool's shank is over the holder's `maxShank` ([Q183](#open-questions-for-the-user))                                                                         |
| `plan.holder.unknown`                 | info     | A setup with workholding items on a machine without a holder: "Enter the collet nut size to check it against the clamps" ([Q181](#open-questions-for-the-user)) |

Errors are only real hits. Everything the operator can fix by chucking differently stays a warning, as [workholding.md](workholding.md#collision-check) does with `close`.

## Run mode

- **Tool-change prompt:** the tool-change dialog and the marker's `M0` message already carry "Needs ≥ N mm stickout" ([grbl.md § Pause messages](../architecture/grbl.md#pause-messages-hardening-df63)). When the clamp term wins, the dialog adds the reason line "Collet nut must clear Toe clamp 2" and the holder's name. The `M0` text keeps only the number, which fits gSender's dialog.
- **Header:** the tool lines keep "stickout ≥ N"; a holder line after the workholding lines: `(Holder: ER11 nut dia 19 x 12 mm, body dia 52 mm)` (H3: "dia" as the tool lines, ASCII).
- Run mode does not run the check itself: Plan already did, and the export guard runs on the final program.

## Viewport: holder ghost

- **Plan viewport ([Q182](#open-questions-for-the-user)):** when an operation or a tool-change row is selected, a translucent ghost of tool, nut and body is drawn at the move that decides its minimum stickout (`stickoutReason`), with the operation's stickout. It is neutral grey, red when that move collides, and has a dimension label ("stickout 25 · needs 37"). The ghost uses the workholding colours ([ui.md § Workholding](../conventions/ui.md#workholding)); the visuals go into ui.md in H5.
- **Collision marker:** a `holder` collision draws the item red with the ghost at the first hit, like the existing marker.
- **Machine form:** a side picture of nut and body with the three dimensions, in the Library window's machine editor.

## Agent API

Budget: `tools/list` ≤ 120,000 characters, now ≈ 117.5 K ([llm-api.md](../architecture/llm-api.md)). Target ≤ 0.8 K, measured in H1 and logged.

- **No new tool.** The `holder` object is added to the machine item schema of `library.machine.*`, and in H6 to the tool item schema of `library.tool.*`. Presets go into the field description as ids (`er11`, …); `preset` alone fills the sizes.
- **Results:** `plan_get`'s `toolRuns[]` gains `stickoutReason` (above), and findings carry `params.part`.
- **No query** for the envelope: the findings and the reason are what an agent acts on.

## Simulation impact

- **No 3D simulation.** The check is a sweep of up to three radii over the moves already walked by `checkWorkholding`, using the 2D port's distance and offset ([geometry.md](../architecture/geometry.md#modules-srccoregeometry)). The cost is O(moves × prisms), as today, times at most three.
- **Holder floor in links:** the same corridor test with a larger radius, run only near prisms.
- **Later:** the nut against the in-process stock (dipping into pockets, walls) and holder collisions in a full simulation ([plan.md § Simulation](plan.md#simulation--prediction)).

## Testing

- `toolEnvelope` per case (no holder, holder, override); the distance test per segment; the property that the envelope contains WH-F's cylinder.
- **User-shaped case:** a 25 mm toe clamp, a facing 10 mm beside it with a 20 mm stickout and an ER11 holder gives `collision` `holder`; a 37 mm stickout clears it; with no holder there is no finding (today).
- **Clamp term:** the needed stickout equals the analytic value, and equals DF130's value without items or without a holder (goldens unchanged).
- **Independent oracle:** `gcode-oracle.testing.ts` gains the stepped envelope, and the replay of [safe-links.md § Verification](safe-links.md#verification-on-the-virtual-machine) asserts every link clears the holder floor (mutation: lowering a link near a clamp by margin + 0.5 mm fails).

## Slices

| Slice | Content                                                                                                                                                                                        | Done when                                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| H0    | This doc → accepted (Q174–Q183)                                                                                                                                                                | User answers recorded; library.md, glossary rows                                                          |
| H1 ✓  | Model: machine `holder`, presets (values checked against vendor drawings), invariants; Library window machine editor "Holder" group with preset select and picture; `library.machine.*` schema | Round-trip and invariant tests; form test; `tools/list` measured and logged ≤ 120 K                       |
| H2 ✓  | Envelope in `checkWorkholding` (kind `holder`), `plan.holder.unknown`, `plan.holder.shankTooLarge`; export guard; oracle with the envelope                                                     | Unit and user-shaped tests above; oracle agrees on the fixtures; programs without a holder byte-identical |
| H3 ✓  | Clamp term in the minimum stickout, `stickoutReason`, `shortStickout` message; inspector rows, header holder line, Run tool-change reason line                                                 | Analytic tests; DF130 values unchanged without holder or items; Run dialog test shows the reason line     |
| H4 ✓  | Holder floor in `planLinks` and in the export guard                                                                                                                                            | Replay and mutation tests pass on the fixtures with clamps; links without a holder unchanged              |
| H5 ✓  | Holder ghost and collision marker in the plan viewport; ui.md amendment                                                                                                                        | Render test of the ghost at the reason move; red on a collision                                           |
| H6 ✓  | Per-tool `holder` override (`library.tool.*`, tool editor Details)                                                                                                                             | Override wins over the machine's in envelope, read-out and ghost; budget re-measured                      |

H1–H3 carry the safety value; H4 matters once low links run near clamps; H5 and H6 can wait.

## Implementation (H1)

Done 2026-11-27. Code: [`holder.dto.ts`](../../src/core/library/holder.dto.ts) (the shape, preset ids), [`holder.ts`](../../src/core/library/holder.ts) (the model, the presets as sources, `checkHolder`, `holderFromDTO`, `holderEdited`), [`machine.ts`](../../src/core/library/machine.ts) (`holder: Option<Holder>`), the Library window's [`HolderGroup.tsx`](../../src/renderer/src/library/HolderGroup.tsx) and [`HolderDrawing.tsx`](../../src/renderer/src/library/HolderDrawing.tsx). Tests: `machine.test.ts` (round trip, preset fill, `required`, `positive`, `atLeastNutDiameter`, every preset valid), the storage contract (memory and filesystem keep and drop the holder), `commands.test.ts` (`{ preset }` alone over the command input, an inch edit keeps the preset's other sizes, issues under `values.holder`), `LibraryWindow.test.tsx` (preset fills, "edited", the core's issue at the field, Save, None removes it, axe), `e2e/library.e2e.ts` (an ER11 holder with an edited length is kept after closing and reopening the Library window; renders `df132-holder-{light,dark}.png` with `DFYOM_RENDERS=1`).

Decisions where the doc left room:

- **Sizes optional in the shape, required in the model.** The DTO's sizes are optional so `{ preset: 'er11' }` alone works for agents ([§ Agent API](#agent-api)); `holderFromDTO` fills missing sizes from the preset, and without a preset a missing nut or body size is `model.invariant` `required` at `holder.<size>`. The model always holds all three sizes and `toDTO` writes them, so a stored holder never depends on the preset table (a later preset correction changes no machine). Given sizes win over the preset; the preset id stays as display ("ER11 nut, edited"), decided by `holderEdited` (exact values against the preset's).
- **Invariants:** nut Ø, nut length and body Ø > 0; `maxShank` > 0 when set; `bodyDiameter` ≥ `nutDiameter` (`atLeastNutDiameter`; equal is allowed, a straight extension); the preset must be one of the ids (a shape error for unknown ids, `input.malformed`). No rule ties `maxShank` to the nut (the presets satisfy shank < nut, tested).
- **Preset values** are stored as entered in mm ("19", default unit mm, as a user types them in a mm library); the router collets as `1/4"` and `1/2"` (exact 6.35 / 12.7 mm).
- **Form:** a "Holder" group at the end of the machine editor's **Spindle** tab (the nut belongs to the spindle; a holder problem marks that tab), Library window only (the quick "New machine…" dialog stays short: no holder is today's behaviour). "Collet nut" is a `Select`: "None (not checked)", the eight presets with their sizes as the option description ("Nut Ø19 × 12 · body Ø52 mm · shank ≤ 7 mm"), and "Measured". Choosing a preset fills all four sizes; "Measured" drops the preset and keeps the sizes (from None it starts from the ER11 sizes, so the form opens valid and the user corrects it). The choice's (i) tip says to measure with a caliper; each size has a note naming the dimension. Beside the sizes the holder drawing (side view: the body broken off at the top, the nut, a tool, the dashed nose line where stickout is measured; short labels ØN, LN, ØB, ØS with a legend), the focused field's dimension amber as in the tool drawing.
- **Agent API:** `tools/list` 117,485 → **117,954** chars (+469, target ≤ 0.8 K), logged in [llm-api.md](../architecture/llm-api.md). `library.machine.update` is sketched and takes the same `holder`; an update without `holder` removes it (updates replace all values).
- **`plan.holder.unknown`** is H2 ([§ Slices](#slices)); H1 adds no finding and changes no program.

## Implementation (H2)

Done 2026-11-27. Code: [`envelope.ts`](../../src/core/plan/workholding/envelope.ts) (`toolEnvelope`, `HolderSizes`), [`check.ts`](../../src/core/plan/workholding/check.ts) (the nut and body in `checkWorkholding`, kind `holder`), [`findings.ts`](../../src/core/plan/workholding/findings.ts) (`checkOperations` passes the machine's holder and the operation's stickout, the `holder` message, `plan.holder.unknown`), [`evaluate.ts`](../../src/core/plan/evaluate.ts) (`plan.holder.shankTooLarge`), the oracle [`gcode-oracle.testing.ts`](../../src/core/plan/workholding/gcode-oracle.testing.ts) (a stepped envelope instead of a radius). Tests: `envelope.test.ts` (envelope per case and containing WH-F; nut beside and over the clamp, beyond the margin, the 2 mm / 5 mm margins, the body where the nut clears, tool hits keep their kind, the worst needed stickout), `holder-case.test.ts` (a 25 mm toe clamp 9 mm from a 6 mm deep pocket: without a holder it exports as today with the info; with ER11 the export is refused with the nut message, and with the 36 mm the finding names it exports and the oracle puts the nut above the clamp + margin on every move, while the same program with 25 mm fails the oracle; `shankTooLarge` with an 8 mm shank), `gcode-oracle.test.ts` (nut and body), the renderer's `messages/plan.test.ts`. Programs without a holder are byte-identical (goldens unchanged).

Decisions where the doc left room:

- **Each part counts from its bottom up.** A segment hits a prism when its bottom (tip Z + `zFrom`) is below the prism's top + margin and its XY gap is under the margin; `zTo` is not used. The band above the nut is covered by the wider body, and the tool keeps WH-F's cylinder to infinity, so the check never clears a move WH-F refuses and the tool's own findings are unchanged.
- **The tool first.** A move whose tool hits an item is the existing `rapid`/`link`/`cut` collision; `holder` is reported only where the tool clears and the nut or body does not (the nut before the body, then the smallest gap). The first `holder` hit per operation and item is reported, as for the other kinds; `close` (warning) stays the tool's.
- **Message and params.** "Pocket 1: the collet nut (ER11, Ø19) at Z23.5 hits Toe clamp 1 near X20 Y66.5 (tip Z−1.5, Toe clamp 1 top Z25, margin 2 mm): chuck the tool with at least 36 mm out or move the item", `field: 'stickout'`, `rule: 'holder'`, params as the other kinds plus `part` (`nut`/`body`), `partZ` (that part's bottom at the hit) and `neededStickout`: the stickout that lifts the hitting part `STICKOUT_CLEARANCE` (5 mm) above the item on **every** colliding move of the operation and item (top − tip Z − the part's height above the nut face + 5, the worst of them; rounded up to 0.1 mm in the message), so the number the message gives clears the error and matches H3's read-out. A measured holder has no name ("the collet nut (Ø19)"); presets have short names (`HOLDER_PRESET_NAMES`: ER11, ER11 mini, …, trim router, router). H3 replaces the number with the clamp term over all moves (including discs that are in reach but not yet colliding).
- **Run gating** needs nothing new: `run.job.start` exports the setup, and the export guard runs `moveFindings` on the final moves with the same `checkOperations`, so a `holder` collision refuses both.
- **`plan.holder.unknown`** (info, `field: 'machine.holder'`, `params.setupId`): per setup with at least one item that has a prism (clamps, vises, screws, blocks; a spoilboard or a surface alone does not), on a plan whose machine has no holder; none without a machine. The app's text names the Holder group of the machine's Spindle tab in the Library.
- **`plan.holder.shankTooLarge`** (warning, per operation, `field: 'tool'`, `params { shank, maxShank }`): the shank is the shank Ø, or the cutting Ø when none is entered (as WH-F does; the message says so); none when the holder has no `maxShank`.
- **Auto-arrange** (`auto: 'toeClamps'`) still places clamps by the tool radius; a placement the nut hits is then a `holder` error to fix by the stickout ([Q179](#open-questions-for-the-user) keeps keep-outs at the tool radius).
- **Agent API:** findings only; `tools/list` measured **117,954** chars, unchanged (the finding code enum is not in the schemas), logged in [llm-api.md](../architecture/llm-api.md).
- **Viewport:** the existing collision marker shows a `holder` collision at the tip's point and paints the item red; the ghost is H5.

## Implementation (H3)

Done 2026-11-27. Code: [`stickout.ts`](../../src/core/plan/workholding/stickout.ts) (`clampTerms`, `stickoutNeed`), [`findings.ts`](../../src/core/plan/workholding/findings.ts) (`setupStickouts`, `planStickouts`, the holder collision's number, the clamp's `shortStickout`, `dropShadowedShortStickout`), `plan.operation.list` in [`commands.ts`](../../src/core/plan/commands.ts) (`stickoutNeeded` with the clamp term, `stickoutReason`), [`plan-export.ts`](../../src/core/post/plan-export.ts) (the run's number over the final moves, its reason, the holder line), [`post.ts`](../../src/core/post/grbl/post.ts) (the reason comment, the `Holder:` line), the sender's [`toolChangeAt`](../../src/core/run/grbl/sender.ts) (`toolChange.stickoutReason`), [`shape.ts`](../../src/core/agent/shape.ts) (`plan_get`'s `toolRuns[].stickoutReason`), the setup inspector's [`ToolChanges.tsx`](../../src/renderer/src/modes/plan/ToolChanges.tsx) and Run's [`RunDialogs.tsx`](../../src/renderer/src/modes/run/RunDialogs.tsx). Tests: `stickout.test.ts` (the analytic nut and body terms, out of reach, no holder or items, a margin over 5 mm, the term clears `checkWorkholding` and 3.5 mm less does not, `stickoutNeed` and its tie, the dedupe), `holder-case.test.ts` (H2's case: DF130's 11 mm with `clamps: "pending"` before the toolpath, then 36 mm with the reason Toe clamp 1 under the nut; the collision names 36; a 34 mm stickout gets the clamp's `shortStickout` and no error; the export's `min stickout 36 mm` and holder line; without a holder 11 mm and no holder line; at 8 mm the collision and only DF130's warning), `post.test.ts` (the reason line, a long item name cut, none for a loaded first tool), `sender.test.ts` (the reason read with the Z reference lines), `shape.test.ts` (the run's reason, pending, omitted without a holder), `ToolChanges.test.tsx` and `RunMode.test.tsx` (read-out and dialog, axe). Hidden e2e `e2e/tool-changes.e2e.ts` (its DF130 read-out test extended by one: an ER11 machine and a toe clamp, "(clamps not yet checked)" before Generate toolpaths, then the Flat 6 run names Toe clamp 1 and the Flat 3 run keeps DF130's text). Programs without a holder are byte-identical (goldens unchanged).

Decisions where the doc left room:

- **A move counts with its lowest Z**, as H2's check does: a segment whose XY distance to the footprint (less an arc chord's sagitta) is under the part's radius + margin adds item top − its lowest Z (the body: − `nutLength`). The term is therefore never below the stickout `checkWorkholding` asks for, so the read-out's number always clears the error (tested). Moves at the clearance height never decide (their term is ≤ 0); only terms above the stock top are kept.
- **A margin over 5 mm** adds its excess to the term (item top + margin − 5 mm − tip Z), so the read-out never sits inside the check's margin; with the default 2 mm nothing changes.
- **Ties** go to the cut (DF130's reason). In a tool run the first operation with the run's number gives the run's reason.
- **Source and "not yet checked".** `plan.operation.list` computes the term over the cached toolpaths of each setup with prism items, on a machine with a holder (the current ones only; the first move from an unknown position counts its end point, as the check). An operation whose toolpath is missing or stale keeps DF130's number with `clamps: "pending"`, and its run's read-out says "(clamps not yet checked)". `plan.export` computes it again over the **final moves** (links included), so the header and marker carry the program's own number.
- **`stickoutReason`** (`plan.operation.list` rows): `{ kind: 'cut' | 'workholding', planOperationId, clamps: 'checked' | 'pending' | 'none', itemId?, itemName?, part?, x?, y? }`, X and Y in the WCS (the deciding move's point nearest the item). `plan_get`'s tool runs carry `{ kind, operationId, itemId?, item?, part?, at?, clamps? }` in the project's units, **omitted** when the cut decides and nothing is checked (no holder or no items: DF130's number needs no reason). The cut has no point (the deepest cut is not one move); H5's ghost uses the reason's point where there is one.
- **`shortStickout` with the clamp** is a finding of the workholding move check (`plan.check`, field `stickout`, params `stickout`, `needed`, `itemId`, `part`, `x`, `y`, `setupId`): only where the clamp decides, the operation has no collision (inside the margin the `holder` error says it) and the stickout is under the number. `plan.warning.list` keeps one per operation: the clamp's replaces DF130's deepest-cut warning of the same operation (`dropShadowedShortStickout`).
- **H2's collision message and `params.neededStickout`** give the operation's H3 number (never below H2's own worst colliding move).
- **Run's reason line** is a program comment before a pausing tool change's marker, after the DF69 touch-off lines: `(Collet nut must clear Toe clamp 1, holder ER11)` (`Spindle body …` when the body decides; no holder name for a measured holder; the item name cut to fit 70 bytes). The sender reads it with the Z reference lines (the look-back grows from 4 to 5 lines) into `toolChange.stickoutReason`, and the dialog shows it as an info note: "Collet nut must clear Toe clamp 1, holder ER11: chuck the tool with at least the stickout above." A first tool the program does not pause for gets none (the header has the number). Other programs simply have no such line.
- **Inspector read-out:** "Needs ≥ 36 mm stickout: the collet nut must clear Toe clamp 1" (title "Toe clamp 1 under the collet nut + 5 mm: chuck the tool with at least this much out."), or "Needs ≥ 11 mm stickout (clamps not yet checked)" (its title asks to generate the toolpaths); without a holder or items DF130's text, unchanged.
- **Agent API:** output only (`plan.operation.list`'s result schema, `plan_get`'s summary); `tools/list` measured **117,954** chars, unchanged, logged in [llm-api.md](../architecture/llm-api.md).

## Implementation (H4)

Done 2026-11-27. Code: [`links.ts`](../../src/core/toolpath/links.ts) (`LinkHolder`, `holderFloor`, the floor in `linkFloor`, which both the link level and the export guard read; `LinkObstacles` gains the workholding `margin`), [`setup-links.ts`](../../src/core/plan/setup-links.ts) (`linkSettings` passes the machine's holder with the items, in the links cache key). Tests: `toolpath/links.test.ts` ("the holder floor": the nut raises a link 8 mm beside a block to its top + 5 − the stickout while the tool alone stays on the stock; the body from the nut top; a far item, no stickout, no items or no holder give today's links exactly; the shorter stickout of the two operations; `checkWorkholding` with the envelope finds no `holder` hit on the linked moves, and finds one when the floor is left out or the link is lowered by 3.5 mm), `post/links.test.ts` (the virtual-machine replay of [safe-links.md § Verification](safe-links.md#verification-on-the-virtual-machine) with a clamp 8–10 mm beside a link: the replay's independent holder check, `HolderReplay` in `links-replay.fixture.ts`, catches the nut on the tool-only link at Z2 and on the ER11 link lowered by the margin + 0.5 mm; the ER11 link at Z8 passes it with properties 1–6), `plan/workholding/holder-case.test.ts` (two pockets of one tool run linked beside H2's toe clamp, 20 mm stickout: without a holder the link crosses at Z2 and the G-code oracle puts the nut inside the clamp's margin; with an ER11 it crosses at Z10, the oracle clears the nut and body, there is no `holder` collision and no clamp `shortStickout`, and the header keeps "min stickout 20 mm"). Programs without a holder or without items are byte-identical (goldens unchanged).

Decisions where the doc left room:

- **The nut and body keep 5 mm, not 2 mm.** The floor is item top + max(`workholdingMargin`, `STICKOUT_CLEARANCE`) − the part's height above the tip (`LinkHolder.above`). With only the 2 mm margin, a link the floor raised would put the nut 2 mm over the clamp, and H3's clamp term over the export's final moves would then ask for 3 mm more stickout than set, on every longer stickout too (the link follows the stickout down). With 5 mm the term over such a link equals the stickout, so the read-out never asks for more because of a link (tested: "min stickout 20 mm"), and the check's 2 mm is kept with 3 mm to spare.
- **Same reach as the check.** A part counts where the link's XY segment comes within its radius + the margin of a prism (`floorAlong` with the part's radius), as H2's check and H3's term do; the nut and body each count from their bottom, the body from the nut top (`nutLength` above the stickout), to infinity.
- **Which stickout.** A link joins two operations of one tool run; it uses the shorter of their stickouts (each operation's own moves are checked with its own). Without a stickout, without a holder on the machine or without items with prisms the floor is −∞: today's links.
- **Only links.** Moves at the clearance height need nothing ([§ Travel links at clearance](#travel-links-at-clearance)), and the generators' own rapids and hops inside an operation stay with H2's check (L4's hops are not built yet). The vertical legs of a link are the columns the full program climbs too.
- **The export guard** is `planLinks`' own guard, which reads the same `linkFloor`: a link below the holder floor is `plan.links.collision` (a bug). The export also runs H2's `checkWorkholding` on the linked moves (independent).
- **Agent API:** none (`LinkSettings` is internal; the holder is the machine's): `tools/list` measured **117,954** chars, unchanged, logged in [llm-api.md](../architecture/llm-api.md).

## Implementation (H5)

Done 2026-11-27. Code: [`holder-ghost.ts`](../../src/renderer/src/modes/plan/holder-ghost.ts) (`holderGhost`: where the ghost stands and its parts, `deepestPoint`, `bodyShown`), [`usePlanScene.ts`](../../src/renderer/src/modes/plan/usePlanScene.ts) (`shownHolderOperation`, `RunScene.holder`), the layer [`HolderGhost.tsx`](../../src/renderer/src/viewport/HolderGhost.tsx) (drawn by `RunLayer`), the reason's tip Z in [`findings.ts`](../../src/core/plan/workholding/findings.ts) (`StickoutReason.z`) and `plan.operation.list`'s `stickoutReason.z` ([`commands.ts`](../../src/core/plan/commands.ts)). Tests: `holder-ghost.test.ts` (at the clamp-deciding move with tool, nut and body by the stickout; at the deepest feed point when the cut decides, rapids never, a drill cycle's bottom; at a `holder` collision's first hit, colliding, a tool collision not; hidden without a holder, tool, stickout or row, and while pending; the rims; which operation a hovered tool-change row shows), `plan-scene-holder.test.tsx` (H2's user case through the fake bridge: with 25 mm the ghost at the collision, colliding, "Stickout 25 mm · needs 36 mm"; none with the setup or nothing selected; with 36 mm at the reason's move at Z−6, neutral; none on a machine without a holder), `holder-case.test.ts` (the reason's `z`), and the hidden e2e `e2e/tool-changes.e2e.ts` (H3's test extended: Pocket 2 selected shows the chip, neutral; a stickout of 8 mm turns it red; renders `df132-holder-ghost{,-collision}-{light,dark}.png` with `DFYOM_RENDERS=1`).

Decisions where the doc left room:

- **Where it stands.** A `holder` collision of the operation (H2's finding, `rule: 'holder'`) wins: the ghost stands at its first hit (`x`, `y`, `lowestZ`) in `--danger`, the [collision marker](#viewport-holder-ghost) (the item is red and the hit ring drawn as before). Otherwise at the `stickoutReason`'s move when a clamp decides (the reason gained `z`, the tip's lowest Z at that move, WCS; output only, `tools/list` unchanged at **117,954**), else at the deepest point of the operation's current toolpath (the first feed move reaching its lowest Z; a drill cycle's bottom; rapids never), since the deepest cut has no single move in H3.
- **With the operation's stickout** (the doc): the tool runs from the tip to the set stickout, the nut above it and the body above the nut, so the picture shows the holder as it would be chucked, not at the needed length; the chip says both: "Stickout 25 mm · needs 36 mm" (the needed rounded up as the read-out, project units).
- **When it shows.** A selected plan operation of the scene's setup, or a hovered or focused tool-change row (the same `zRefPreview` as DF69's spot): the run's operation with a `holder` collision, else the one that decides the run's number. None with the setup or nothing selected, without a holder on the machine (the ghost answers "why this number", and without a holder DF130's number needs no picture), without a tool or stickout, while the reason is `pending` (a toolpath of the setup is missing or outdated), or when the cut decides and the operation has no current toolpath. No toggle: it shows only on selection, like DF122's rest shading.
- **Visuals** ([ui.md § Workholding](../conventions/ui.md#workholding)): three cylinders in `--vp-edge` (not the accent, not the clamps' `--vp-grid-major`), fills 38 % (tool), 26 % (nut), 14 % (body) without depth write, each rim outlined at 75 %; the body is a stub of 0.3 × its diameter (at least 10 mm) with its top rim dashed (broken off: it counts to infinity; a taller stub filled the view over a small part); in `--danger` at a collision. Not pickable. The chip is the Z spot's chip (mono, beside the nut face), with a `--danger` border at a collision.
- **The clamps stay R8 ghosts** while the operation is selected (D75); the red item and ring at a collision carry the relation. A stronger deciding item would change the user's R8 decision and is left out.

## Implementation (H6)

Done 2026-11-27. Code: [`tool.dto.ts`](../../src/core/library/tool.dto.ts) and [`tool.ts`](../../src/core/library/tool.ts) (the optional `holder`, H1's shape and rules below `holder.`), `resolveHolder` in [`holder.ts`](../../src/core/library/holder.ts) (tool override → machine holder → none), its callers: [`findings.ts`](../../src/core/plan/workholding/findings.ts) (`checkOperations`, `operationHolder`, `planHasHolder`, `plan.holder.unknown`, `planStickouts`), [`evaluate.ts`](../../src/core/plan/evaluate.ts) (`plan.holder.shankTooLarge`), `plan.operation.list` in [`commands.ts`](../../src/core/plan/commands.ts), [`links.ts`](../../src/core/toolpath/links.ts) (`LinkOperation.holder`, the floor per operation) and [`setup-links.ts`](../../src/core/plan/setup-links.ts), [`plan-export.ts`](../../src/core/post/plan-export.ts) and [`post.ts`](../../src/core/post/grbl/post.ts) (the reason's holder name, the header lines), the ghost in [`usePlanScene.ts`](../../src/renderer/src/modes/plan/usePlanScene.ts); the tool editor's Details in [`ToolFields.tsx`](../../src/renderer/src/library/ToolFields.tsx) with H1's [`HolderGroup.tsx`](../../src/renderer/src/library/HolderGroup.tsx) (`variant="tool"`). Tests: `tool.test.ts` (round trip, `{ preset }` alone, issues under `holder.`, the resolution order, `with`), the storage contract (memory and filesystem keep and drop a tool's holder), `commands.test.ts` (`library.tool.add` with `{ preset }`, issues under `values.holder`), `toolpath/links.test.ts` (an operation's holder over the setup's; a link between a slim and an ER11 operation takes the ER11's floor), `holder-case.test.ts` (H2's case with the ER11 on the tool of a machine without a holder: the same collision, no `plan.holder.unknown`; a slim extension on the tool under the machine's ER11: no collision, DF130's 11 mm checked, the header's `Holder T1:` line and no machine line, the oracle clears its envelope; H4's link: the tool's ER11 lifts it to Z10 without a machine holder, the slim one keeps it at Z2 under the machine's ER11), `plan-scene-holder.test.tsx` (the ghost with the tool's ER16 on a machine without a holder), `LibraryWindow.test.tsx` (Details: "Machine's holder", a preset fills the sizes, the drawing, axe, Save, the summary, removed), and the hidden e2e `e2e/library.e2e.ts` (the chamfer mill gets an ER16 holder in Details, kept after Save; renders `df132-tool-holder-{light,dark}.png` with `DFYOM_RENDERS=1`). Programs without a tool holder are byte-identical (goldens unchanged).

Decisions where the doc left room:

- **Resolution.** `resolveHolder(tool, machine)`: the tool's `holder` when set, else the machine's, else none. An override cannot say "no holder" (a tool always sits in something; "Machine's holder" removes the override). It holds on every machine and also on a plan without a machine (a fact of the tool, like its default stickout). The plan reads it from the plan's tool copy (snapshot), so a library edit reaches a plan through the existing "used item changed" refresh, and it enters the toolpath input hash with the snapshot (as the machine's holder does).
- **Everywhere the holder is.** H2's check and the oracle's envelope, `plan.holder.shankTooLarge` (the resolved holder's `maxShank`), H3's clamp term and reason (an operation whose tool resolves to none keeps DF130's number, not listed as checked or pending), the Run reason line's holder name (the deciding operation's holder), H4's floor, H5's ghost.
- **`plan.holder.unknown`** stays a machine finding: info on a machine without a holder in a setup with prisms, unless every operation of the setup has a tool with its own holder (then nothing is left unchecked). A setup without operations still gets it.
- **Links between two holders.** A link keeps the nut and body of **both** operations it joins above the items, each with its own stickout: the floor is the higher of the two holder floors (the safe envelope of both). Within one tool run both operations share the tool copy, so today the two holders are the same; the rule keeps the planner and its export guard right if that ever changes. A tool's holder rides on its `LinkOperation` (`holder`, the setup's `LinkSettings.holder` stays the machine's), only with items with prisms.
- **Header.** The machine's line `(Holder: …)` is written only while an operation of the setup runs in it; a tool with its own holder gets `(Holder T2: ER16 nut dia 32 x 18 mm, body dia 65 mm)` after it, once per tool number (a measured one "Nut dia …"), so the operator sees which tool goes in which holder.
- **Form.** At the end of the tool editor's collapsed **Details** (before Notes): a `Select` "Holder" with "Machine's holder" (the default, no override), the eight presets and "Measured", then H1's sizes beside the holder drawing; the (i) tip says it is for a tool in its own holder (an extension or a reducing collet) and replaces the machine's on every machine. The closed Details heading names it ("Details · Carbide · ER16 nut holder"), and an issue under `holder.` opens the group. Library window only; the quick "New tool…" dialog stays short.
- **Agent API:** no new tool; `library.tool.add` / `.update` values gain the same optional `holder` object, described "Overrides the machine's holder for this tool"; an update without it removes it (updates replace all values). `tools/list` 117,954 → **118,418** chars (+464; budget 120,000), logged in [llm-api.md](../architecture/llm-api.md).

## Not yet

| Item                                             | Why / where                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Nut dipping into wide pockets; nut against walls | Needs the in-process stock under the nut disc ([Q177](#open-questions-for-the-user)) |
| Gantry, Z carriage, dust shoe                    | Machine geometry; [plan.md § Simulation](plan.md#simulation--prediction)             |
| Keep-out sized by the nut                        | [Q179](#open-questions-for-the-user) option 2                                        |
| Holders as library items, tool tables            | One holder per machine covers the hobby router                                       |

## Open questions for the user

Numbering continues after [run-recovery.md](run-recovery.md)'s Q173. "Q174 ok" takes the recommendation.

1. **Q174 – Holder shape.** (1) A nut cylinder and a body cylinder (the body to infinity); (2) any stack of N cylinders; (3) one cylinder (nut only). _Recommendation: (1)._ It covers every ER spindle and router with three numbers a caliper can measure. A stack adds UI for extensions nobody here uses, and the nut alone misses the Ø52–80 body over tall clamps.
2. **Q175 – Where the holder lives.** (1) On the machine only; (2) on the machine, with an optional override on the library tool; (3) on the machine, with an override per plan operation. _Recommendation: (2), the override in the last slice (H6)._ The nut belongs to the spindle. A tool in an extension carries its holder wherever it goes, as its default stickout does.
3. **Q176 – Presets.** (1) Built-in constants that fill the fields (ER11/16/20, their mini nuts, trim and full-size router); (2) library items, like workholding devices; (3) no presets, measure only. _Recommendation: (1)._ Few sizes, no sharing, no snapshot work; the fields stay editable.
4. **Q177 – Material under the nut.** (1) The stock top plane: the nut never enters a cut; (2) the in-process stock field: the nut may dip into wide pockets, and walls are checked; (3) the plane for the read-out and the field for the check. _Recommendation: (1) now, (2) later._ It is what operators do, it needs no current toolpaths for the stock term, and the `reach` error already covers it.
5. **Q178 – Margins.** (1) The read-out adds DF130's 5 mm to both terms, and the check errors inside the setup's 2 mm workholding margin (a warning in between); (2) 2 mm everywhere; (3) a new machine field. _Recommendation: (1)._ It keeps DF130's number and the existing check, and the operator sees a warning before an error.
6. **Q179 – Keep-out.** (1) Unchanged (tool radius): the clamp term and the check make the operator chuck longer; (2) regions go around the nut where the operation's stickout is too short. _Recommendation: (1)._ Option 2 makes toolpaths depend on the stickout and leaves material uncut for a problem a longer stickout solves.
7. **Q180 – Low links.** (1) A holder floor in the link planner, which raises a link where the nut passes over a clamp; (2) the check only, which errors; (3) every link near a clamp at the clearance height. _Recommendation: (1)._ Correct and cheap, and it keeps the low links' time savings away from the clamps.
8. **Q181 – No holder entered.** (1) Today's behaviour plus the info `plan.holder.unknown`, only in setups with workholding items; (2) assume ER11; (3) silent. _Recommendation: (1)._ An assumed nut could be smaller than the real one; the info appears only where it matters.
9. **Q182 – Viewport ghost.** (1) At the move that decides the selected operation's minimum stickout; (2) scrubbed along the toolpath; (3) none. _Recommendation: (1)._ One picture answers "why this number"; scrubbing comes with simulation.
10. **Q183 – Collet capacity.** (1) A warning when the tool's shank is over the holder's `maxShank`; (2) an error; (3) no check. _Recommendation: (1)._ An ER11 cannot hold a 1/2″ shank, but a sleeve or a wrong library value is possible, so it warns and does not block.
