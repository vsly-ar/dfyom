# X2: an agent makes a lid variant over MCP (installed app 0.3.61)

Status: draft (acceptance report, 2026-11-23) · Task: X2 in [plans/hardening.md § 7](../plans/hardening.md#7-acceptance) · Criterion: [hardening.md § Exit criteria](../plans/hardening.md#exit-criteria), "One variant through an agent over MCP" · API: [llm-api.md](../architecture/llm-api.md) and its hardening amendments (A1–A7) · Previous black-box test: `.continuous/research/2026-11-22-llm-first-test.md` (v0.3.2)

Tester: an agent, black box. It used only the installed bundle's launcher (`~/Applications/DFYOM.app/Contents/Resources/bin/dfyom`), the server primer, `tools/list` and the docs. It did not read `src/`. App: `DFYOM.app` 0.3.61. Transport: headless `dfyom mcp --data-dir <fresh temp dir>` over stdio, through a small JSON-RPC client. No window opened, and the user's app data and running app were not touched.

## Result

**Pass.** All three constraints hold. The variant (M4 bolt circle, eight vents, a second connector cutout with its own M4 bolt circle) was designed, planned and exported in **21 tool calls**. 2 of them were deliberate probes that came back as clean refusals.

| Constraint                      | Result                                                                                                                                                                                                                                                                 | Pass |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| ≤ 60 tool calls for the variant | **21** (23 for an agent that did not build the lid first: it would also need `library_machine_list` and `library_tool_get` for two ids this session already knew). The lid itself took 27 more calls. 49 calls in all, with 1 probe after the export.                  | yes  |
| No single result over 64 KB     | Largest is **45.97 KB**: JSON-RPC bytes of `plan_warning_list`, of which 21.7 KB is the text block. The next largest are `design_operation_list` (19.4 KB) and `plan_get` (16.8 KB). The largest result while building the lid was 6.0 KB. **Margin is thin:** see F1. | yes  |
| No stack trace in any result    | 0 of 49 results contain a `stack` key, an `   at` frame or a `.js:<line>` reference. The server wrote nothing on stderr.                                                                                                                                               | yes  |
| Plan and export                 | One setup (Top). `plan_export` regenerated all 26 plan operations itself: 3,102 lines, est. 739 s, **2 tool changes for 3 tools** (Flat 3 → chamfer mill → Flat 6, outline last), `warnings: []`.                                                                      | yes  |

Artifacts are kept in the scratchpad, not in the repo:

- `x2/lid-variant.nc`: the exported program, sha256 `de661cb93514d49b…`.
- `x2/calls.jsonl`: one line per call with tool, args bytes, result bytes, text bytes, ok, ms, a stack flag and the phase.
- `x2/out/NNN-<tool>.json`: every raw result.
- `x2/lid.dfyom` and `x2/lid-variant.dfyom`: the base lid and the variant.
- `x2/mcpd.py` and `x2/call.py`: the client.

The scratchpad is `/private/tmp/claude-501/-Users-dev-Documents-CNC-dfyom/54220b1c-…/scratchpad/x2/`. It is session-local, so copy anything that should be kept.

## What was done

### Phase 1: the lid (27 calls, not counted)

The lid was rebuilt from [v0.4 exit criteria](../plans/v0.4.md#exit-criteria) using tools only, in a fresh data dir with an empty library:

1. `project_create`, then `design_part_add` with its own block: 255 × 200 × 6, birch plywood, `sheetGood`.
2. The outline. The fixture `enclosure-sections.svg` lives under `src/` and was off limits, so the agent wrote a 4-cubic SVG by hand from [v0.3's measured sizes](../plans/v0.3.md#exit-criteria): a superellipse with exponent 2.5, 249.5 × 177. `design_shape_import` fitted it to 64 arcs (max deviation 0.006 mm). See F9.
3. The outline profile: `outside`, 6 tabs. The result said "2 of 6 tabs moved", which matches D42.
4. The countersunk M3 hole at (39, 55.7), then a Clones `grid` of 2 × 2 at 177 × 88.6.
5. The cutout: an inside profile, Ø22 at (187.5, 100).
6. A counterbored M3 hole at (205.5, 100), then a Clones `arc` with r 18, angle 180, arc 360, step 60. The preview came first and showed 6 holes.
7. The vent: an obround shape 30 × 5, placed as an inside profile at (67.5, 70). Then a Clones `offset` with count 6, step (0, 10) and `skip: [2]`, which leaves out instance 4 (see F7).
8. Library: Flat 6, Flat 3, a 90° × Ø12 chamfer mill, and a GRBL machine with a manual spindle.
9. `design_operation_tool_set` put Flat 3 on the corner hole's drill (see F6).
10. Evaluate, save, close.

### Phase 2: the variant (21 calls, counted)

The variant was made on a copy of the saved lid:

| #     | Call                                                                               | Purpose / outcome                                                                                                                         |
| ----- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1–4   | `project_open`, `design_part_list`, `design_feature_list`, `design_operation_list` | Find out what the lid holds. Features do not list plain operations, so the operation list is needed to find the cutout profile (19.4 KB). |
| 5     | `design_hole_update { featureId: hole2, fastener: M4 }`                            | **M4 bolt circle: 1 call.** The source and all 5 instances followed (the program shows Ø8 counterbores 4.2 deep, Ø4.5 holes).             |
| 6     | `design_profile_update { profile3, tabs.count: 0 }`                                | Removes 6 `dfm.tabsUnused` infos. The Clones instances followed.                                                                          |
| 7     | `design_clones_update { clones3, offset count 8, skip [2] }`                       | **Eight vents** (n 1–3, 5–9).                                                                                                             |
| 8–9   | `design_clones_preview` (probes)                                                   | Try to clone "cutout + its bolt circle" as one group: refused, first `clonesSourceOwned` and then `clonesNested`. See F3 and F4.          |
| 10–12 | `design_profile_add`, `design_hole_add` (M4), `design_clones_add` (arc)            | **Second cutout**: Ø22 at (127.5, 100) with its own M4 bolt circle of 6.                                                                  |
| 13–15 | `design_warning_list`, `design_part_evaluate`, `job_wait`                          | Check the variant: 2 info warnings on the outline, as for the base lid.                                                                   |
| 16    | `plan_create` with the machine                                                     | One setup.                                                                                                                                |
| 17    | `plan_warning_list`                                                                | **66 errors, 88 entries in all, from 22 plan operations** (every Flat 3 operation): no feeds for a 3 mm tool. See F2. 45.97 KB.           |
| 18    | `library_tool_update` (Flat 3 + a `sheetGood` preset)                              | The draft plan followed the change by itself (`plans: [{ status: followed }]`).                                                           |
| 19    | `plan_get`                                                                         | Check that the feeds now resolve (16.8 KB).                                                                                               |
| 20    | `plan_export`                                                                      | Regenerates and writes `lid-variant.nc`. 2 tool changes.                                                                                  |
| 21    | `project_save`                                                                     |                                                                                                                                           |

The program was checked by eye. It has 8 vent comments (`Vents #1–3, 5–9`), 12 `Bolt circle 2 #k` comments (6 counterbores and 6 holes), and the countersinks are plunged with the chamfer mill only once. Both Ø22 cutouts come after the tool change to Flat 6, and the outline is last. Clone positions appear in comments as [features.md](../modes/features.md) asks.

Calls in the variant: 19 ok and 2 refusals (both probes). Server time was 1.7 s, 0.72 s of it in `plan_get` and 0.22 s in `plan_export`.

## Findings

Severity follows [hardening.md Q54](../plans/hardening.md#questions-for-the-user): **S1** blocks the golden path or risks the machine or data, **S2** wrong result or confusing with a workaround, **S3** polish. Class follows the plan's issue classes. None of these blocked the variant.

### F1 (S2, AX/perf): `plan_warning_list` grows per operation × field and is the 64 KB risk

- **Evidence:** 22 plan operations with unresolved feeds produced 88 entries: 3 `plan.check` errors (`spindleSpeed`/`feedRate`/`plungeRate`) plus 1 `feeds.noData`, each repeating the same message. The result was 45.97 KB as JSON-RPC (21.7 KB of text plus the same data in `structuredContent`).
- **Effect:** about 2.1 KB per failing operation. With ~31 failing operations the result passes 64 KB. With the 100-instance Clones limit (D36) and one shared tool with no data, it reaches ~200 KB. That is exactly the case X2 hit: one tool with no feeds, and every Clones instance as its own plan operation.
- **Fix:**
  - Group by identity across operations: `{ code, field?, message, severity, planOperationIds: [...] }`, the same way rule 3 shapes DFM warnings.
  - Or add a `detail: "summary"` default (counts by code and severity, first N groups) to `plan_warning_list`, as on `plan_get`.
- **Related:** `design_operation_list` is 19.4 KB for 43 operations, about 0.45 KB each, so 100-instance Clones features reach about 64 KB too. Collapse Clones instances (source + `{ n, center }` per instance) or add `detail: "summary"`.

### F2 (S2, UX/AX): no calculator data for a Ø3 end mill in sheet goods; 66 blocking errors and no next step

- **Evidence:** `feedsSpeeds_suggest { Flat 3, sheetGood, slot }` returned all `null` and `feeds.noData: no fz data for a 3 mm tool`. Flat 6 and the chamfer mill resolved.
- **Effect:**
  - Every Flat 3 operation is blocked: the clearance holes, counterbores and vents.
  - The messages ("spindleSpeed: no entered, preset or calculator value") do not say what to do. A7 says unresolved feeds name the plan operation and how to resolve them. That is true for the `plan.check` refusal text, not for the `plan_warning_list` entries.
  - The cheapest fix, a library preset that the draft plan follows, is not suggested. The agent had to guess between `plan_operation_update` × 22 and a library preset.
- **Fix:**
  - Add chip-load data for 3 mm (and 2, 1.5 mm) tools in wood and sheet goods, since the X0 lid itself uses Flat 3.
  - Give `feeds.noData` / `unresolved` entries a `next`: "add a preset for <materialClass> to the library tool (`library_tool_update`; draft plans follow) or enter values with `plan_operation_update`".

### F3 (S2, missing capability): cannot clone a group of features (cutout + its bolt circle)

- **Evidence:** a Clones `source` is plain operations or one feature. `profile2` with `hole2_*` was refused with `clonesSourceOwned`, which correctly says "use it as featureId". A clone of the Clones feature `clones2` was refused with `clonesNested`.
- **Effect:** "a second cutout like the first" took 3 calls (profile, hole, arc Clones) and re-entered every value, so the two connectors can drift apart. In the UI it is the same.
- **Fix (follow-up, a model change):** allow `source: { featureIds: [...], operationIds: [...] }`, or a Clones source that is a Clones feature together with its own source. Until then, document the 3-call recipe in the primer or in `design_clones_add`'s description.
- An alternative that was not tried: a chained row on `clones2` (arc 360, then offset −60, then arc 360) plus a Clones of `profile2`. It works only if the agent sees that rows chain from the last position.

### F4 (S3, AX): `clonesNested` refusal has no next step

- **Evidence:** `source.featureId: Clones of Clones are not allowed (clonesNested)`. It names the field and the rule but not what to do instead. A7 asks for all three.
- **Fix:** append "clone the source feature (`hole2`) with another row on `clones2`, or add a new feature".

### F5 (S3, AX): results name tools by snapshot id

- **Evidence:** the `applied.toolChanges[].to` of design edits and the `tool` of `design_operation_list` are `{ kind: "specific", snapshotId: "snapshot-…" }`. Only the plan results (`plan_get`) name tools ("Flat 3").
- **Effect:** an agent cannot tell from a design result which tool an operation got without another call.
- **Fix:** add `name` (and `diameter`) beside `snapshotId` in the agent-shaped result. This is cheap, adds no tool and does not change `tools/list`.

### F6 (S3, UX/AX): tool choice made against an empty library is not revisited when tools arrive

- **Evidence:** the corner hole was added before the library had tools. Its drill got a generalized "3.4 mm drill" (`dfm.toolNotInLibrary`). After Flat 3 was added, `design_tool_candidates` listed Flat 3 as fitting, but the operation kept the generalized drill (`current.fits: true`) until `design_operation_tool_set`. The outline profile also stayed generalized Flat 6 in the design. Later operations got the library tools directly.
- **Effect:** the design and the plan disagree on tool kind unless the agent locks tools. The plan picks library tools on its own, so this may only matter for the design view. Not verified, because the black box cannot see what `plan_create` would have chosen for the generalized drill.
- **Fix:** when a library tool is added, re-run the auto choice for unlocked generalized tools that a library tool can now replace. Or have the `dfm.toolNotInLibrary` removal say which library tool now matches.

### F7 (S3, AX): `skip` indices are ambiguous

- **Evidence:** the schema says "skip: 0-based point indices left out, numbers kept". The exit criteria say "instance 4 skipped". `skip: [3]` left out n 5. The indices count the row's clone points, not the source, so instance 4 is `skip: [2]`. The preview showed this, so it cost one extra preview.
- **Fix:** say "indices of the row's clones (0 = the first clone, instance n = index n − 2 for the first row)", or accept `skipN: [4]` (instance numbers) as the UI shows them.

### F8 (S3, AX): `design_part_evaluate` says it waits, but returns a job; `job_wait`'s outcome lists all warnings in full

- **Evidence:**
  - The description says "Evaluate a part's geometry now and wait for its DFM warnings", but the result was `{ jobId }` with "wait with job_wait". That is two calls.
  - The finished job's `outcome.value.warnings` is the full list (6.0 KB in the lid session, with 8 near-identical `tabsUnused` lines), not the delta of rule 3.
- **Fix:** reword the description ("starts an evaluation job; job_wait returns its warnings"), or return the warnings inline when the evaluation finishes within a short budget. Shape job outcomes that carry the part's warnings with the same delta, or use a count plus `design_warning_list`.

### F9 (S3, AX/docs): the exit part's outline is not reachable by a tools-only agent

- **Evidence:** the v0.4 exit criteria say "outline = the enclosure's outline shape from `enclosure-sections.svg` (the v0.3 fixture)". The fixture lives under `src/`, and no tool or resource gives it. A black-box agent must rebuild it from the v0.3 sizes; here it was a hand-written superellipse SVG with 4 cubics.
- **Effect:** the variant cannot be compared byte for byte with X1's `exit-criteria-lid.nc`. The outline differs, and so does every comment and offset that depends on it.
- **Fix:** for acceptance runs, give the SVG next to the note, for example as a `docs/` asset or in the dogfood guide. Or accept that X2 checks constraints, not bytes, which is what this note does.

### F10 (S3, AX): truncated program comment for merged drillings

- **Evidence:** in `lid-variant.nc` line 1752, `(Bolt circle screw - drill, Bolt circle screw - drill - 2, Bolt circl)`. The plan operation that merges 12 drillings lists their names until a length cap and cuts mid-word.
- **Fix:** name the feature once with a count, "(Bolt circle screw - drill x 6, Bolt circle 2 screw - drill x 6)", as the countersinks already do ("Corner screw - countersink x 4").

### F11 (S3, AX): Clones preview carries the full row path

- **Evidence:** the `arc` preview returns `rows[].path` with 73 points of the arc polyline (about 2.3 KB of the 4.8 KB result), on top of `instances` and `points`.
- **Fix:** leave `path` out of the agent-shaped result. Keep `start`, `end`, `centre` and `points`, and give the path with `detail: "full"`.

### Observations (no finding)

- **`tools/list`:** 123 tools, 117,228 chars compact (125,394 with default JSON spacing), within the 120 K budget with about 2.8 K left. The variant needed none of the 23 run, machine and library-machine tools.
- **Things that worked well:**
  - The primer (frames, reserved args, compact results).
  - `placed` bounds on profile results, which made a quick clearance check possible.
  - Clean, field-named refusals.
  - Draft plans following a library edit by themselves.
  - `plan_export` regenerating stale toolpaths, so no separate `plan_toolpath_generate` and `job_wait` were needed.
  - Warnings delta on edits: 0.4–2.8 KB per edit.
- **The project key changes on a copied file:** opening a copy of a saved project gave key `…~2`, because both files share the project id. It is harmless, but an agent that keeps keys across sessions may be surprised.
- **Possible U6 input:** the calculator's Flat 6 plywood plunge suggestion was 2,286–2,500 mm/min, which the machine's Z max clamped to 1,500 (`feeds.feedClamped`). The value is plausible for a ramp but high for a straight plunge.

## Intake rows to add

F1, F2 and F3 are S2. F3 is a model change and belongs in the [v0.4 follow-up](../plans/v0.4-llm-first.md). F4–F11 are S3, for the U9/A-lane batch. No S1.
