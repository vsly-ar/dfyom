# X3: a fresh agent reruns the black-box test over MCP (installed app 0.4.203)

Status: draft (acceptance report, 2026-11-27) · Task: X3 in [plans/v0.4-llm-first.md § 9](../plans/v0.4-llm-first.md#9-acceptance) · Criteria: [v0.4-llm-first.md § Exit criteria](../plans/v0.4-llm-first.md#exit-criteria), "A real agent", with the [Q44](../plans/v0.4-llm-first.md#questions-for-the-user) numbers · API: [llm-api.md](../architecture/llm-api.md) · Previous runs: [X2 agent variant](2026-11-23-x2-agent-variant.md) (hardening, 0.3.61), the source black-box test `.continuous/research/2026-11-22-llm-first-test.md` (0.3.2)

Tester: a fresh agent, black box. It used only the installed bundle's launcher (`~/Applications/DFYOM.app/Contents/Resources/bin/dfyom`, app 0.4.203), the server primer, `tools/list` and `docs/`. It did not read `src/` or `e2e/`. Transport: headless `dfyom mcp --data-dir <fresh empty dir>` over stdio, through a new small JSON-RPC client, with `DFYOM_HIDE_WINDOWS=1`. No window opened. The user's data, library and projects were not touched.

**Scope.** The X3 row is "the black-box test repeated": the user's `enclosure-wood-base.stl` from a 250 × 200 × 40 mm hardwood block, held by toe clamps on both setups. It is not the hardening lid that X2 used. In this run the X2 phases mean: (1) stock and reference, (2) the design through the LLM-first features (`design_reference_find`, section → shape, offset items, partial-depth profiles, the `holes` suggestion), (3) a plan with workholding and the machine's ER11 holder, so the clamp and stickout checks run, (4) export and the app's own deviation check. A virtual run of both setups was added, as in the source test.

**The STL.** The harness refused to let the tester copy the fixture out of `src/`. So the app read it in place: the absolute path went to `design_reference_import`. That is the one file read the criteria allow ("no file reads but the STL"). The tester never opened it.

## Result

**Pass.** Every X3 criterion holds. The flow took **64 tool calls**, 2 of them refusals.

| Criterion                                                        | Result                                                                                                                                                                                                                                                                                                                                        | Pass |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Finishes the task with the MCP tools only                        | Stock, reference, design, plan, workholding, both exports, deviation check, virtual run of both setups, save. No outside script fed a value into the flow (the tester's G-code check below ran afterwards).                                                                                                                                   | yes  |
| Q44 deviation (plan source, 0.5 mm cells, outside the edge band) | **p95 0 / p99 0 mm** on both faces (≤ 0.05 / ≤ 0.1). **10 regions over 0.5 mm, all with a cause:** 8 `tab` (the outline's tabs, seen from both faces) and 2 `toolRadius` (the cavity's two sharp back corners). `unexplained: 0`, `overcutMax: 0`. Part source: no region over 0.1 mm (603 pieces below it, 263 mm³). These are X1's numbers. | yes  |
| Zero collision findings in the final plan                        | **0** `plan.workholding.collision`, **0 errors** in `plan_warning_list` (13 warnings and 2 infos, listed under F5). The first plan had 4 holder collisions, fixed on the way (F1).                                                                                                                                                            | yes  |
| ≥ 2 mm from every clamp (Q44, independent check)                 | The tester's own oracle (`oracle.py`: true arcs, a radius-3 tool cylinder from the tip up, clamp pads Z 0–25, each tool's own Z0 after a tool change): **Bottom 2.000 mm** (the facing's keep-out runs at the margin, as in X1), **Top 2.000 mm** (the first rapid at the 27 mm clearance height over a clamp top).                           | yes  |
| ≤ 100 tool calls                                                 | **64**: setup 12, design 21, plan 16, export and deviation 4, run and save 11. X1's scripted flow took 66.                                                                                                                                                                                                                                    | yes  |
| No result over 64 KB                                             | Largest **13.9 KB**: `plan_warning_list` with 4 collision groups (6.6 KB of it is text). Next: `plan_get` 8.8 KB, the second `plan_warning_list` 7.2 KB, `plan_workholding_set` 6.9 KB. X2's largest was 46 KB, so the margin grew a lot.                                                                                                     | yes  |
| No stack trace                                                   | 0 of 64 results contain a `stack` key, an `   at` frame or a `.js:<line>` reference. Nothing on stderr.                                                                                                                                                                                                                                       | yes  |
| `tools/list` within the budget                                   | 150 tools, **110,629** chars compact JSON of the tools array (110,423 bytes on the wire). Budget 120,000.                                                                                                                                                                                                                                     | yes  |

Export stats:

| Program          | Lines  | Est. time | Tool changes                          | Export warnings                                                    | Virtual run (sim.) |
| ---------------- | ------ | --------- | ------------------------------------- | ------------------------------------------------------------------ | ------------------ |
| `x3-1-bottom.nc` | 1,295  | 472 s     | 2 (Flat 6 long → Flat 2 → Chamfer 82) | chamfer plunge 2,286 > Z max 1,500 (F5); Z headroom unknown (info) | 508 s, finished    |
| `x3-2-top.nc`    | 37,405 | 6,134 s   | 0 (Flat 6 long, min stickout 57.5)    | Z headroom unknown (info)                                          | 6,343 s, finished  |

**Were the tool descriptions enough?** Yes, with two exceptions. Neither came from the recent trims: the "Args as design.X.add" update listings and the enums without `type`.

- Updates used: `design_shape_update` (its `items` is a sketch, "As design.shape.add items"), `plan_operation_update` (stickout) and `plan_workholding_set` with item ids. The first two worked on the first call. `design_hole_update` and `design_profile_update` were read but not needed: their listings keep every arg name, type and enum, and "Args as design.X.add" made it obvious where the descriptions live. No call failed on an enum.
- Call 25, `design_profile_add { on: "facing1.floor", depth: "4.185" }` → `model.invariant: on: must be a stock face (onSurface)`. The tool's own description says "A stock face", so the agent misread it. But the refusal gives no next step (F4).
- Call 43, `plan_workholding_set { items: [{ id: "wh1", at: "15" }, …] }` → `input.malformed: items.0.kind: Invalid option: expected one of "toeClamp"|"vise"|"screw"|"block"|"base"|"surface" (+ 3 more)` on all four items. The description says "An item with id keeps it (omitted parameters stay)", but the schema still requires `kind`. The retry with `kind: "toeClamp"` worked (F3).

## What was done

### Phase 1: stock, reference, library (12 calls)

1. `project_create`, then `design_part_add` with its own block: 250 × 200 × 40, hard maple, `hardwood`. The quantities were bare strings ("250"); the primer says they are project units.
2. `design_reference_import` with the STL's absolute path: "Read as mm: 249.5 × 177.1 × 39 mm", fitted centre + top. The result gives `facingDepth` (bottom 1 mm).
3. `design_reference_find` five times, all values read from the results:
   - `levels`: cavity floor 34.815 from the top, then 5.185, 4.944 (the hole ends), 2.771 and 1 from the bottom.
   - `section` at 17.408 (the wall band's middle): outline and cavity. The cavity has 2 sharp corners.
   - `holes` from `stock.bottom`: 4 × Ø2.447, flat, 4.944 deep, an 82.8° countersink of Ø4.861, a 2 × 2 grid at pitch 177.062 × 88.531. A ready `suggest` came with `note: belowFace`, and the message said to set `on` to the facing floor.
   - Outer-only sections from the bottom at 1.9 and 4 mm: the base and step outlines, read as bounds for the insets.
4. Library: a 6 mm long flat (LCF 45, OAL 75, stickout 50), a 2 mm flat, an 82° chamfer mill, each with a `recommended` hardwood preset. A GRBL machine with `holder: { preset: "er11" }`, which filled nut Ø19 × 12, body Ø52 and max shank 7.

### Phase 2: the design (21 calls)

| #     | Call                                                                                                                                         | Outcome                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9–10  | `design_shape_import { from: { depth 17.408, loops outer / holes } }`                                                                        | Outline (`shape1`, 72 elements) and Cavity (`shape2`). Each result has `placeAt` (min corner, anchor min/min).                                                                                                                                                                                                                                                                                              |
| 15–19 | `design_shape_add` × 2 with an **offset item**, `design_shape_import` of the outline from `stock.bottom` at 20 mm, `design_shape_update` × 2 | The steps first offset the top-face outline. The bottom face's frame flips v, so the agent re-imported the outline from the bottom (`shape5`) and pointed both offsets at it: inward 0.798 and 4.823 mm. Those are the means of the four side gaps between the outline section's bounds and the bottom sections' bounds. Both offsets land on their sections' bounds within 0.008 mm (`design_shape_list`). |
| 21–23 | `design_pocket_add` (Cavity, `shape2`, depth 34.815), `design_profile_add` (Outline, outside, 4 tabs 8 × 8), `design_operation_tool_set`     | The pocket got **no tool** (`dfm.noFittingTool`: the sharp corners fit no end mill), so the agent locked Flat 6 long. That leaves `dfm.toolUnfit` (F8).                                                                                                                                                                                                                                                     |
| 24–27 | `design_facing_add` (bottom, 1 mm), 2 × **partial-depth outside profiles** on `stock.bottom`                                                 | 1 refusal (`on` must be a stock face, F4), then depths 5.185 and 2.771 from the stock bottom. The placed boxes reach Z −34.815 and −37.229, as the levels give.                                                                                                                                                                                                                                             |
| 28–29 | `design_hole_add` (the `holes` suggestion as sent, `on: facing1.floor`), `design_clones_add` (its grid row)                                  | Countersunk holes bored by Flat 2, countersinks by Chamfer 82. 3 `dfm.holeCustomSize` infos (sizes off the M2 table).                                                                                                                                                                                                                                                                                       |
| 30–33 | `design_part_evaluate` → `job_wait`, `design_reference_compare { part }` → `job_wait`                                                        | 2 `dfm.retainedRemoved`: the steps lower the tabs to 3.81 and 6.23 mm. This is expected, and X1 has the same. Compare: no missing or extra region over 0.1 mm.                                                                                                                                                                                                                                              |

### Phase 3: plan, workholding, holder (16 calls)

1. `plan_create` with the machine: Bottom (facing, 2 steps, drilling ×4, countersink ×4; 3 tools) before Top (cavity, outline; 1 tool).
2. `plan_workholding_set` on Bottom with the criteria's clamps (vMin/vMax at 45 and 205, width 30, grip 10, top 25), then `copyFrom` to Top. The clearance height followed to 27 mm. One `plan.workholding.unmachined` warning appeared: the facing leaves the area under the clamps.
3. `plan_toolpath_generate` → `job_wait`: 7 of 7 generated. Then `plan_warning_list` (13.9 KB) showed **4 `plan.workholding.collision` errors, rule `holder`**: "the collet nut (ER11, Ø19) at Z26.66 hits Toe clamp 1 near X69.56 Y13.26 (tip Z-23.34 …): chuck the tool with at least 69.5 mm out or move the item". There was also a `shortStickout` warning on the cavity (needs 52.9 mm). **The holder check works:** with X1's clamp positions and a Ø19 nut, the outline's deep passes pass the clamps.
4. **Tried `auto: "toeClamps"` on Top.** It placed the clamps at X42/X208, clear of the toolpaths, and the same 4 nut collisions came back (F1).
5. Moved the clamps to the stock corners, at X15 and X235 on both edges (1 refusal first, F3). Copied them to Top. Now the **spindle body** (Ø52) hit all four clamps at tip Z −35.9, and the finding asked for a stickout of at least 57.5 mm.
6. `plan_operation_update { stickout: "58" }` on both Top operations, which leaves 17 mm in the collet on the 75 mm tool. The result was `{}` (F7). `plan_warning_list` confirmed **0 errors, 0 collisions**.

**Not the criteria's clamp positions.** The final clamps sit at X15/X235, not X45/X205. With the holder modelled, X45/X205 needs a 69.5 mm stickout on a 75 mm tool, which is not usable. X1 has no holder on its machine, so it never saw this.

### Phase 4: export and deviation (4 calls)

- `plan_export` per setup regenerated the stale toolpaths itself. The stats are in the table above.
- The program headers list the clamps, the holder ("ER11 nut dia 19 x 12 mm, body dia 52 mm") and "Every move checked: 2 mm clear of the workholding". Top says "min stickout 57.5 mm".
- `design_reference_compare { plan }` → `job_wait` gave the Q44 numbers above (6.9 KB).

### Phase 5: virtual run and save (11 calls, not required by X3)

- `run_connection_open { virtual, prepare: true, timeScale: max }`.
- Bottom: `run_job_start`, then `job_wait`, which stopped at each tool change with `waiting.next` naming `run_job_continue { toolChange: n }`. The agent sent exactly that ×2. The finished result named the next setup and its `run_job_start` args.
- Top ran in one wait. `run_connection_close`, `project_save`.

Server time for all 64 calls was 44 s. The largest parts were Top's export (11.8 s, regenerating) and Top's run start (9.3 s).

## Findings

Severity follows [hardening.md Q54](../plans/hardening.md#questions-for-the-user): **S1** blocks the golden path or risks the machine or data, **S2** gives a wrong result or confuses but has a workaround, **S3** is polish. None blocked the run.

### F1 (S2, workholding): `auto: "toeClamps"` ignores the tool holder

**Fixed in hardening DF138** (2026-11-27): the automatic placement keeps the nut and the body clear at each operation's stickout; when only the holder blocks, the refusal names the stickout per operation that makes room, or that the tool is too short ([workholding.md W6-J](../modes/workholding.md#automatic-arrangement-w6)).

- **Evidence:** on Top, `auto` placed four clamps "clear of the generated toolpaths" (X42, X208, front and back). The same result listed 4 `plan.workholding.collision` errors, rule `holder`: the ER11 nut hits every clamp during the outline's deep passes.
- **Effect:** the automatic placement produces a plan that cannot be exported once the machine has a holder. The agent has to place clamps by trial: here 3 placements and 2 stickout edits. The working placement turned up only because the agent reasoned about the outline's superellipse corners.
- **Fix:** make `auto` keep the clamps clear of the tool's collision envelope at the planned stickout (nut and body, [tool-holder.md § Collision envelope](../modes/tool-holder.md#collision-envelope)), not just of the tool cylinder. Or have it report that no placement fits and say what stickout one would need.

### F2 (S2, AX/safety): the collision's remedy is not checked against the tool

**Fixed in hardening DF138:** stickout remedies stop at OAL − 3 × shank Ø; beyond it the message says the tool is too short and to move the item or use a longer tool ([plan-v0.1.md § Minimum stickout](../modes/plan-v0.1.md#minimum-stickout-hardening-df130)). A suggested clamp move with a distance is not given.

- **Evidence:** "chuck the tool with at least 69.5 mm out or move the item" for a tool with OAL 75 mm and LCF 45 mm. A 69.5 mm stickout leaves 5.5 mm in the collet.
- **Effect:** an agent that takes the first remedy literally makes an unsafe setup.
- **Fix:** compare the needed stickout with OAL minus a minimum grip (for example the collet length, or 3 × shank Ø). When it does not fit, drop that remedy and say "move the item (e.g. N mm further from the cut) or use a longer tool". The `params` already carry `x`, `y` and `itemId`, so a suggested clamp move along its edge is possible.

### F3 (S3, AX/schema): `plan_workholding_set` item with an id still requires `kind`

**Fixed in hardening DF138:** `kind` is optional for an item with an id; a new item without it is refused with rule `required` and the kinds.

- **Evidence:** the description says "An item with id keeps it (omitted parameters stay)". `[{ id: "wh1", at: "15" }]` was refused with `items.0.kind: Invalid option: expected one of "toeClamp"|…` for each item. The same items with `kind` worked.
- **Fix:** either make `kind` optional when `id` names an existing item, or say "an item with id and kind keeps it". The refusal should also say "items with an id still need kind".

### F4 (S3, AX): profile `on` must be a stock face, and the refusal has no next step

**Fixed in hardening DF138:** the refusal lists the stock faces and says "use on stock.bottom and add facing1.floor's depth below it (1 mm) to depth"; design-llm-first.md's wording follows the stock-face rule. A floor as a profile's `on` stays refused.

- **Evidence:** `design_profile_add { on: "facing1.floor", side: outside, depth: "4.185" }` → `on: must be a stock face (onSurface)`. Pockets and holes take an earlier floor. [design-llm-first.md](../modes/design-llm-first.md#partial-depth-profiles) words the steps as "from the bottom, 1.77 and 4.19 mm deep", which reads as from the faced floor.
- **Fix:**
  - Add the next step to the refusal: "start from stock.bottom and add the facing's depth (1 mm) to depth". A7 asks for one.
  - Or allow a facing floor as a profile's `on`, as pockets do.
  - Align the doc's wording with the stock-face rule.

### F5 (S3, feeds): recommended presets trip their own checks

**Partly fixed in hardening DF138:** the chip load range allows 0.1 % for rounding, so `feeds.rubbing` at 0.076194 vs 0.0762 is gone. **Deferred:** power and Z max in recommended presets (library presets resolve without the plan machine; [feeds-speeds.md § Final-value check](../architecture/feeds-speeds.md#final-value-check)).

- **Evidence**, with all presets `recommended: true` for hardwood:
  - **`feeds.rubbing` on 5 operations:** chip load 0.076194 against the data minimum 0.0762. The recommended feed is rounded to a whole 2,743 mm/min, which puts it under the minimum.
  - **`feeds.powerExceeded` on 5 operations:** 0.34–0.71 kW against 0.3 kW available, on a 500 W spindle.
  - **Chamfer plunge 2,286 mm/min against the machine's Z max of 1,500:** `plan.machine` warning in the plan, at export and in the run.
- **Effect:** a plan built only from the app's recommendations is never clean. An agent cannot tell the noise from real warnings.
- **Fix:**
  - Round the recommended feed up, or compare with a rounding tolerance.
  - Let the recommendation honour the plan machine's power and Z max when it resolves in a plan. Library presets are machine-free, but the plan knows the machine.

### F6 (S3, G-code): 70-character line cap cuts names and the M0 prompt

**Fixed in hardening DF138:** header tool lines keep the whole name and move Z0 and the stickout to a second line; the M0 drops the type word before the surface ([grbl.md § Pause messages](../architecture/grbl.md#pause-messages-hardening-df63)).

- **Evidence:** `x3-1-bottom.nc` header lines read `(Tool 2: Flat, dia 2 mm, Z0 on Face bottom floor, min stickout 10 mm)` and `(Tool 3: C, dia 6.35 mm, …)`. The names are "Flat 2" and "Chamfer 82". The tool-change prompt reads `M0 ;Install T3 Chamfer 82, 6.35 mm chamfer, then zero Z`, while T2's prompt says "then zero Z on Face bottom floor". The longest line is exactly 70 characters.
- **Effect:** the name is the part that gets cut, not the optional text after it. The prompt a sender shows at the pause loses the surface to zero on. The comment lines above it still say it.
- **Fix:** shorten the optional parts first ("min stickout", "Z0 on …"). Never cut a tool name. Or put the Z0 surface on its own line before the M0.

### F7 (S3, AX): `plan_operation_update` returns `{}`

**Fixed in hardening DF138:** the result is the operation's stickout, minimum stickout and findings now, with the plan's counts by severity (not a delta).

- **Evidence:** setting `stickout: "58"` returned `{"value":{}}`, so the result did not say whether the 4 holder collisions and the `shortStickout` warning were resolved. A 7.2 KB `plan_warning_list` was needed to find out.
- **Fix:** return the findings delta of the touched setup (added, removed), as design edits return their DFM delta and `plan_workholding_set` returns its findings.

### F8 (S3, design): a section with sharp corners gets no tool

**Fixed in hardening DF138 (the second option):** `dfm.noFittingTool` for sharp corners points to `roundInside` and `design_operation_tool_set`. The auto choice still leaves such an operation without a tool.

- **Evidence:** the cavity from `design_shape_import` (`sharpCount: 2`) got `dfm.noFittingTool` and no tool. The agent locked Flat 6 long and then kept a permanent `dfm.toolUnfit` warning. The plan itself handles the same corners as a `plan.check cornerRadius` warning, and the deviation check gives them the `toolRadius` cause.
- **Fix:** for sharp corners alone, let the auto choice pick the largest tool that fits otherwise and report the corners once, as the plan does. Or have `dfm.noFittingTool` point to `roundInside` on the import or to `design_operation_tool_set`.

### F9 (S3, AX): `dfm.retainedRemoved` always blames the remover

**Fixed in hardening DF138:** "…; or, when profile2 must stay, make profile1's tabs thicker (tabs.thickness)".

- **Evidence:** "Outer step (profile2) lowers tabs 1–4 from 8 mm to 3.81 mm …; change Outer step (profile2): make it shallower or move it off the tabs". The step is reference geometry and cannot change. The real choice is thicker tabs, or accepting the 3.81 mm that remains.
- **Fix:** offer both: "… or make the tabs thicker (Outline profile1 tabs.thickness)".

### F10 (S3, run): stale progress label while waiting at a tool change

**Fixed in hardening DF138:** the progress naming the wait goes out before the phase ([llm-api.md § A2](../architecture/llm-api.md#a2-jobwait-at-operator-waits)).

- **Evidence:** `job_wait` waiting at tool change 3 still reported `progress.done: 789` and the drilling's label ("Base screw - drill x 4 · tool 2"). The `waiting` block was correct.
- **Fix:** update `progress` when the run reaches a wait.

### Observations (no finding)

- **The LLM-first features carried the whole design:**
  - `design_reference_find` gave every number: levels, sections with sharp-corner counts, and holes with a ready `suggest` plus a `belowFace` hint.
  - `placeAt` made section shapes land in place in one call.
  - Offset items followed the re-imported bottom outline.
  - Partial-depth outside profiles replaced the source test's "rectangle − keep-outs − inset" pockets, with no kernel failure (the source test's F3).
- **The holder and stickout checks are visible to an agent:** the program header carries the holder and the minimum stickout, and the findings name the nut or body, the Z and the needed stickout.
- **Compact results held:** delta warnings on edits (0.4–3.4 KB), grouped `plan_warning_list`, and summary `plan_get`. No result came near 64 KB.
- **The bottom frame's flipped v** (primer: "on stock.bottom X stays X, v points to the front") was enough to see that a top-face section must not be placed on the bottom. Re-importing from `stock.bottom` was the clean answer. `design_shape_import` cannot mirror a shape, but none was needed.
- **Avoidable calls:** 6 of the 64 went to clamp trials (F1, F3), and 1 was a `copyFrom` sent after a refused set. Without F1 and F3 the flow would be about 57 calls.

## Artifacts

Kept in the scratchpad, not in the repo: `/private/tmp/claude-501/-Users-dev-Documents-CNC-dfyom/1cf9ecce-77c1-4b19-a385-94d1a0871c31/scratchpad/x3/`. It is session-local, so copy anything that should be kept.

- `nc/x3-1-bottom.nc` (sha256 `6aab928c916679e7…`) and `nc/x3-2-top.nc` (sha256 `11a0cb3586e7ecc5…`): the exported programs.
- `x3-enclosure-base.dfyom`: the saved project (sha256 `0a47d9133585b5e2…`).
- `calls.jsonl`: one line per call with tool, phase, args bytes, result bytes, text bytes, ok, ms and a stack flag.
- `out/NNN-<tool>.json`: every raw result, plus `initialize.json` (the primer) and `tools-list.json`.
- `mcpd.py` and `call.py` (with the `c` wrapper): the client. `schema.py` prints a tool's listed schema.
- `oracle.py`: the tester's G-code clamp-clearance check. It is not part of the agent flow.
- `datadir/`: the fresh data dir the run used. `data/` holds only the library and logs of an aborted first start.

## Intake

- **v0.4-llm-first known issues or the next plan:** F1 and F2 are S2, and they belong together: the holder check is new, and the automatic placement and the remedy text do not use it yet.
- **U9/A-lane batch:** F3–F10 are S3.
- No S1.
