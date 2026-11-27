# Tool holder: collet nut and spindle in the collision checks

Status: accepted (2026-11-27; Q174–Q183 take their recommendations, accepted by delegation D82; internal backlog idea 1, hardening [DF132](../plans/hardening.md#intake-user-feedback-goes-here); carries over the backlog row "Holder and collet collision" of [v0.4-llm-first](../plans/v0.4-llm-first.md) and WH-F's "holder model later" ([Q40](../plans/v0.4-llm-first.md#questions-for-the-user)); questions [Q174–Q183](#open-questions-for-the-user) answered; H1 implemented, [§ Implementation (H1)](#implementation-h1)) · Base: [workholding.md § Collision check](workholding.md#collision-check), [plan-v0.1.md § Minimum stickout](plan-v0.1.md#minimum-stickout-hardening-df130), [safe-links.md § Clamps](safe-links.md#clamps) · Machine fields: [library.md § Machine](../architecture/library.md#machine) · Terms: [glossary.md](../glossary.md)

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
- **Header:** the tool lines keep "stickout ≥ N"; a holder line after the workholding lines: `(Holder: ER11 nut Ø19 x 12, body Ø52)`.
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
| H2    | Envelope in `checkWorkholding` (kind `holder`), `plan.holder.unknown`, `plan.holder.shankTooLarge`; export guard; oracle with the envelope                                                     | Unit and user-shaped tests above; oracle agrees on the fixtures; programs without a holder byte-identical |
| H3    | Clamp term in the minimum stickout, `stickoutReason`, `shortStickout` message; inspector rows, header holder line, Run tool-change reason line                                                 | Analytic tests; DF130 values unchanged without holder or items; Run dialog test shows the reason line     |
| H4    | Holder floor in `planLinks` and in the export guard                                                                                                                                            | Replay and mutation tests pass on the fixtures with clamps; links without a holder unchanged              |
| H5    | Holder ghost and collision marker in the plan viewport; ui.md amendment                                                                                                                        | Render test of the ghost at the reason move; red on a collision                                           |
| H6    | Per-tool `holder` override (`library.tool.*`, tool editor Details)                                                                                                                             | Override wins over the machine's in envelope, read-out and ghost; budget re-measured                      |

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
