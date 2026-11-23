# Spike S6: clone instances at scale

Status: draft (spike report, 2026-11-22) · Task: S6 in [plans/v0.4.md § Spikes](../plans/v0.4.md#2-spikes) · Specs it informs: [features.md § Clones](../modes/features.md#clones) (draft limits), [design-v0.4.md § Clones in v0.4](../modes/design-v0.4.md#clones-in-v04), [shapes.md § Evaluation perf](../architecture/shapes.md#evaluation-perf-g1-follow-up) and [§ Performance](../architecture/shapes.md#performance) · Code: [`spikes/clones/`](../../spikes/clones/evaluate.ts) · Terms: [glossary.md](../glossary.md)

## Question

Can 100 / 500 / 1000 clone instances stay within the command budget (resolve + checks ≤ 3 ms, [shapes.md § Performance](../architecture/shapes.md#performance)) and the part evaluation budget (≤ 50 ms warm, [geometry.md](../architecture/geometry.md#performance-budgets-v01))? What do toolpath generation and the program size do? Which levers help, and what limit and implementation should F5 take?

## Method

- **Instances as plain operations.** Clones do not exist yet, so an instance is a translated copy of its source operations, in the expansion order of [features.md § Plan and cut order](../modes/features.md#plan-and-cut-order) (source operation A on every position, then B). This is what an expansion writes into the part, so the numbers are what F5 would get with today's pipeline.
- **Workloads** ([`workload.ts`](../../spikes/clones/workload.ts)), each on a 6 mm board:
  - **Counterbored M3 hole** as [design-v0.4.md](../modes/design-v0.4.md) expands it: a Ø6 circular pocket 3.3 deep plus a Ø3.4 through drilling on its floor (2 operations per instance), 40 per row at a 10 mm pitch, stock 420 × 270.
  - **Obround slot** 30 × 5 (the lid's vent): one pocket per instance, through in the geometry runs, 5.5 deep in the command runs (a pocket must end above the stock bottom today), 25 per row at a 36 × 10 pitch, stock 920 × 420.
- **Evaluation** ([`evaluation.test.ts`](../../spikes/clones/evaluation.test.ts)): production `evaluatePart` fresh, unchanged with the worker caches (`OperationCache` + kept solids at `KEPT_TRIANGLES` = 150 000), and with every instance changed by a source edit. Then a cut-down copy of the same pipeline ([`evaluate.ts`](../../spikes/clones/evaluate.ts), no geometry checks) with the levers: subtraction layers of 25 (today), 100 or unbounded (every pairwise-disjoint tool in one layer); instances by `perOp` (today), `translateMesh` (source meshes built once, cache key per source + offset, each instance a translated mesh copy with its own original id) or `transform` (source solid composed once, instances by `SolidPort.transform`, labels recovered per triangle by a grid lookup of the instance boxes). Every way gives the same volume (asserted to 1e-6) and labels every triangle.
- **Unrelated edit** ([`prefix.test.ts`](../../spikes/clones/prefix.test.ts)): a 60 × 200 pocket next to N counterbored holes is edited; today (worker caches) against keeping the part after the clone layers as one kept solid and subtracting only the edited pocket.
- **Commands and plan** ([`commands.test.ts`](../../spikes/clones/commands.test.ts)): `parameterChecks` over the expanded input; N instances added through `design.pocket.add` / `design.drilling.add` (the drilling `on` its pocket's floor), then the time of one more add and of a `design.pocket.update`; `project.apply` (auto tool choice), `plan.create` (with a machine), `exportPlan` with an empty and a warm toolpath cache, the program's lines and bytes. Tools: Flat 6, Flat 3 (stepover 1.2), Drill 3.4; the auto choice took the Flat 6 for the Ø6 counterbores (a plunge per level).
- **Machine:** Apple M1 Pro (10 cores), Node 26.7.0, manifold-3d 3.5.4, **under load average 11–18** from parallel agents (comparable G1 runs swung ≈ 2× under such load, [shapes.md § Performance](../architecture/shapes.md#performance)); medians of 3 runs (evaluation) and 9 (checks), one run for the command table. Absolute values are pessimistic; the scaling and the ratios between levers are the result.

Run: `npx vitest run -c spikes/clones/vitest.config.mts --silent=false` (≈ 15 min; `S6_COUNTS=100` and `S6_RUNS=1` shorten it). Typecheck: `node node_modules/typescript7/bin/tsc --noEmit -p spikes/clones`.

## Results

### Evaluation, today

`evaluatePart`, ms (median):

| Instances               | Operations | Fresh | Unchanged (caches) | Source edited | Triangles |
| ----------------------- | ---------- | ----- | ------------------ | ------------- | --------- |
| 100 counterbored holes  | 200        | 236   | 199                | 231           | 30 064    |
| 500 counterbored holes  | 1 000      | 2 361 | 2 255              | 2 364         | 141 920   |
| 1000 counterbored holes | 2 000      | 7 770 | 7 539              | 7 890         | 281 644   |
| 100 slots               | 100        | 147   | 134                | 145           | 24 318    |
| 500 slots               | 500        | 1 070 | 1 012              | 1 070         | 92 188    |
| 1000 slots              | 1 000      | 3 022 | 2 898              | 3 020         | 176 886   |

- **Already 100 instances are 3–5× over the 50 ms budget**, like the stress grid of 30 pockets + 120 drills (232 ms, [geometry.md](../architecture/geometry.md#performance-budgets-v01)). The output passes the 20 000-triangle budget at about 70 instances.
- **Cost grows quadratically** with today's layers of 25: 10× the instances cost 33× (holes) and 21× (slots). Each layer subtracts from the whole part, which grows with every layer: 80 layers at 1000 holes.
- **The caches do not help**: the subtraction layers always run and make ≈ 90 % of the time; from ≈ 500 instances the kept solids (150 000 triangles) no longer fit either.

### Levers

Cut-down pipeline (no geometry checks), total ms (median); in brackets the slowest single layer, i.e. the longest abortable step:

| Instances               | perOp, 25 (today) | perOp, 100  | perOp, one layer | translateMesh, one layer | transform, 100 | transform, one layer |
| ----------------------- | ----------------- | ----------- | ---------------- | ------------------------ | -------------- | -------------------- |
| 100 counterbored holes  | 213 (36)          | 156 (90)    | 156 (90)         | 152 (90)                 | 137 (91)       | **139** (93)         |
| 500 counterbored holes  | 2 300 (94)        | 1 115 (149) | 795 (468)        | 767 (464)                | 1 017 (150)    | **691** (464)        |
| 1000 counterbored holes | 7 713 (176)       | 2 987 (222) | 1 613 (948)      | 1 615 (961)              | 2 808 (223)    | **1 420** (946)      |
| 100 slots               | 141 (41)          | 92 (74)     | 93 (74)          | 89 (73)                  | 80 (73)        | **81** (74)          |
| 500 slots               | 1 046 (73)        | 548 (114)   | 427 (359)        | 414 (356)                | 495 (114)      | **369** (354)        |
| 1000 slots              | 2 996 (119)       | 1 345 (167) | 865 (724)        | 845 (729)                | 1 231 (168)    | **749** (718)        |

Phases (1000 holes, today → transform with one layer): build 42 → 0.6 ms, compose (`fromMesh` + per-operation booleans) 166 → 5 ms, subtraction 7 496 → 1 397 ms (unions inside it ≈ 100 ms either way), `toMesh` 8 ms, the label lookup 9 ms (0.8 ms at 100).

- **Subtraction layers dominate.** One layer per disjoint set (clone instances of one source operation never overlap) turns the growth linear: ≈ 1.4 ms per counterbored hole and ≈ 0.75 ms per slot on this machine, 1.4–5× faster than today. The price is one long step (0.9 s at 1000 holes), which breaks the "abortable between steps" rule ([workers.md](../architecture/workers.md#abort-and-pause)); layers of 100 keep steps at 90–220 ms and still gain 1.4–2.7×.
- **Instancing the source** (`transform`) removes build and compose almost entirely, but they are only ≈ 10 % of the time. Its label pass is cheap (one grid lookup per clone triangle). `translateMesh` (cache key per source + offset, own original ids, no new label code) gains only the build (≈ 40 ms at 1000).
- **Caches with a source-relative key** make "unchanged" and "source edited" cost the same as fresh minus build/compose (e.g. 1000 slots: 744 / 749 ms, `transform`); again the subtraction remains.
- **Nothing makes 100+ instances fit 50 ms.** The boolean cost per chord is the floor ([S3](../../spikes/prisms/results.md): ≈ 8 µs per chord in booleans when idle); a counterbored hole has ≈ 70 chords, so 100 holes are ≈ 7 000 chords, more than twice the ≈ 3 000-chord budget of an evaluation.

### Unrelated edit next to clones

ms (median); the lever excludes labels and checks:

| Clones                  | Today (worker caches) | Kept clone layers: subtract + `toMesh` | Part triangles |
| ----------------------- | --------------------- | -------------------------------------- | -------------- |
| 100 counterbored holes  | 213                   | **16.8**                               | 30 804         |
| 500 counterbored holes  | 2 318                 | **74**                                 | 143 108        |
| 1000 counterbored holes | 7 969                 | **149**                                | 283 388        |

Subtraction order does not change the solid ([geometry.md § Building the solids](../architecture/geometry.md#building-the-solids)), so the part after the clone layers can be one kept solid keyed by the clone groups' inputs; an edit elsewhere then pays one subtraction against a larger part instead of all clone layers again. This is the lever that keeps a part with clones editable.

### Commands, plan and program

`parameterChecks` itself is negligible: 0.15 / 0.60 / 0.71 ms for 200 / 1000 / 2000 operations. Whole commands are not ("one run each", ms):

| Instances               | Ops   | Add one more | Update one | Apply | `plan.create` | Generate + export | Export, cached | Plan ops | Program lines | Program size |
| ----------------------- | ----- | ------------ | ---------- | ----- | ------------- | ----------------- | -------------- | -------- | ------------- | ------------ |
| 100 counterbored holes  | 200   | 10           | 12         | 18    | 260           | 348               | 222            | 101      | 1 728         | 13 KB        |
| 500 counterbored holes  | 1 000 | 55           | 70         | 76    | 6 157         | 7 877             | 5 429          | 501      | 8 528         | 61 KB        |
| 1000 counterbored holes | 2 000 | 127          | 165        | 155   | 27 887        | 33 280            | 23 716         | 1 001    | 17 028        | 122 KB       |
| 100 slots               | 100   | 8            | 10         | 10    | 159           | 331               | 213            | 100      | 14 572        | 189 KB       |
| 500 slots               | 500   | 45           | 50         | 46    | 3 725         | 6 446             | 4 387          | 500      | 72 972        | 970 KB       |
| 1000 slots              | 1 000 | 100          | 114        | 119   | 18 269        | 26 402            | 17 382         | 1 000    | 145 972       | 1 958 KB     |

- **Every design command is linear in the part's operations** (≈ 50–100 µs per operation): it reloads the part from its DTO (quantity parsing, `Rational` arithmetic), rebuilds the surface graph, maps the geometry input and rewrites the operation list (a CPU profile at 500 instances: `partFromDTO`, `surfaces.build`, `toGeometryInput`, `writeOperationList`, `stableJson` sorting). The 3 ms budget holds to ≈ 30–50 operations on this machine; this is a property of today's commands, not of Clones, but Clones are the first feature that makes hundreds of operations easy.
- **The plan side is quadratic:** `plan.create` and `planOperationInputs` (every export, also with all toolpaths cached) spend their time in `deepEqual` of snapshots and `hashJson` of the chained input hash per plan operation, each over the whole part. 100 instances: 0.2–0.3 s; 1000: 18–28 s.
- **Toolpaths and the program** scale linearly and are no problem for a GRBL stream: ≈ 17 lines (≈ 120 bytes) per counterbored hole (equal drillings share one plan operation; each counterbore pocket is its own), ≈ 146 lines (≈ 2 KB) per slot pocket. 1000 slots give a 2 MB, 146 000-line program.

## Recommendation

1. **Limit for v0.4: 100 instances per Clones feature** (the draft's "100 positions per row" stays; "1000 instances in all" becomes 100 for now), and an info note when a part's evaluation exceeds the chord budget (as `dfm.shapeHeavy`; e.g. `dfm.clonesHeavy` with the instance count). At 100 instances: evaluation 80–140 ms with the levers below (150–240 ms today), commands ≈ 10 ms, plan creation and export ≈ 0.3 s, program ≤ 200 KB. The exit part needs 4 + 6 + 6 instances. 1000 stays a target for after the plan-side and command-side fixes; 500 costs 0.4–0.7 s per evaluation even with every lever, which only a stepped background evaluation with progress can carry.
2. **F5 expands into plain operations** (as features.md specifies): read-only instances, ids by role and Plan untouched. The spike found no reason to keep instances virtual for 100 instances; the costs above are in evaluation and in O(N) / O(N²) document code, not in the expansion itself.
3. **Evaluation (with F5, small):** put the instances of one clone source operation into **one subtraction layer** regardless of `UNION_CHUNK` (they are disjoint by construction, `dfm.cloneOverlap` aside), capped so a step stays near 100 ms (≈ 100 instances); and **keep the part after the clone layers** as one kept solid keyed by the clone groups, so edits elsewhere cost ≈ 17 ms more instead of ≈ 200 ms. Raise `KEPT_TRIANGLES` with it, or key the prefix separately, because a 100-hole prefix is already 30 000 triangles.
4. **Instancing by `transform` is optional.** It saves build and compose (≈ 10 %) for a label pass by position; take it only if F5's measurements on an idle machine show compose mattering. It moves x/y by a float64 offset of float32 vertices (z untouched, so floors stay coplanar exactly); instances that meet other operations' walls would need the sliver test of G1. `translateMesh` is not worth its code.
5. **Before raising the limit** (backlog, independent of Clones; plan side done in [P4](#follow-up-p4), commands in P5): make `plan.create` / `planOperationInputs` linear (hash each operation's own inputs once and chain the hashes; compare snapshot values once per copy, not per operation), and make design commands incremental (load and check only the operations a command touches plus their dependants, cache the parsed part per document revision). Then re-measure with this harness.

## Changes the draft docs should take

For [features.md § Clones](../modes/features.md#clones), [design-v0.4.md § Clones in v0.4](../modes/design-v0.4.md#clones-in-v04) and [shapes.md § Evaluation perf](../architecture/shapes.md#evaluation-perf-g1-follow-up) when they are next edited (not folded in by the spike):

1. Draft limit "1000 instances in all" → 100 per Clones feature in v0.4, with the evaluation note above; [plans/v0.4.md § Risks](../plans/v0.4.md#risks-and-spikes) "the 1000-instance limit stays" no longer holds.
2. Subtraction layers: clone groups in their own layers beyond `UNION_CHUNK`, and the kept clone prefix, as F5 tasks.
3. Known issues for the plan: quadratic `plan.create` / export inputs; linear design commands far past 3 ms at hundreds of operations.

## Follow-up: clone layers

Done after F5 (2026-11-22; the known issue "Clones get no subtraction layers of their own" in [plans/v0.4.md](../plans/v0.4.md#known-issues-found-in-v04)), recommendation 3 as specified, documented in [geometry.md § Clone layers](../architecture/geometry.md#clone-layers):

- `toGeometryInput` writes `cloneGroups` (per repeated source operation: its id and its instances' ids, from the owned roles `<n>_<source id>`); absent without Clones, so other inputs stay byte-identical.
- `evaluatePart` subtracts the groups' tools first, in layers of at most `CLONE_LAYER` = 100 (first fit by bounds, so overlapping instances still separate), then the other operations in layers of `UNION_CHUNK` = 25.
- With the worker caches the part after the clone layers is one kept solid, keyed by the original ids of the stock and the clone operations' solids (equal ids mean equal inputs; a rebuilt operation gets a new id). `KEPT_TRIANGLES` 150 000 → 300 000: 100 counterbored holes keep ≈ 60 000 (operations ≈ 27 000, the part after the clone layers ≈ 31 000; the prefix is lost below ≈ 55 000), so a few such Clones features fit. A separate pool was not needed: the prefix is used by every evaluation, so the LRU keeps it.
- Same part: `clone-layers.test.ts` asserts identical labelled triangles at 16 holes and, at 100, the same volume, triangle count, surfaces, warnings and per-surface vertex sets and areas (another subtraction order triangulates some planar faces – a drill wall, the stock bottom – differently from the same vertices).

Production `evaluatePart` before (no `cloneGroups`) and after, N counterbored holes beside a 60 × 200 pocket ([`layers.test.ts`](../../spikes/clones/layers.test.ts), `S6_RUNS=15`, fresh runs interleaved; same M1 Pro under load 13–24, so absolute values are pessimistic), ms (median):

| Clones                 | Path                  | Fresh | Unchanged (caches) | Source edited (caches) | Pocket edited (caches) | Longest step | Triangles |
| ---------------------- | --------------------- | ----- | ------------------ | ---------------------- | ---------------------- | ------------ | --------- |
| 16 counterbored holes  | layers of 25 (before) | 31.7  | 26.0               | 30.1                   | **26.2**               | 15.2         | 7 284     |
| 16 counterbored holes  | clone layers (after)  | 35.3  | 6.1                | 33.1                   | **6.3**                | 15.0         | 7 284     |
| 100 counterbored holes | layers of 25 (before) | 234   | 211                | 242                    | **216**                | 36.1         | 30 804    |
| 100 counterbored holes | clone layers (after)  | 175   | 21.9               | 179                    | **22.3**               | 87.9         | 30 804    |

- **An edit elsewhere is ≈ 4× (16) to ≈ 10× (100) cheaper**, and 100 holes are back under the 50 ms budget for it; unchanged re-evaluation likewise.
- **Fresh and source edits at 100 holes are ≈ 1.35× faster** (2 clone layers instead of 9 layers of 25), as the cut-down pipeline predicted (perOp, 100: 1.4×). At 16 holes they cost ≈ 3 ms more: the pocket gets a layer of its own instead of sharing the counterbores' (one more subtraction from the whole part).
- **The longest step** grows to ≈ 90 ms (one layer of 100 counterbores; up to ≈ 150–220 ms in noisier runs), the accepted exception to the 50 ms step rule ([workers.md](../architecture/workers.md#abort-and-pause)).
- Not taken: instancing by `transform` (recommendation 4) – compose is still ≈ 10 %.

Run: `npx vitest run -c spikes/clones/vitest.config.mts spikes/clones/layers.test.ts --silent=false` (`S6_COUNTS`, `S6_RUNS`).

## Follow-up: P4

Hardening P4 (2026-11-23, [plans/hardening.md](../plans/hardening.md)), recommendation 5 on the plan side. Measured by [`clones.perf.ts`](../../src/core/design/clones/clones.perf.ts) (`npm run perf`) through the real commands: a counterbored M3 hole as the source of a 10 × 10 Clones grid at a 10 mm pitch on a 6 mm board, once (100 instances, 200 operations) and four times (400 instances in four Clones features – the limit stays 100 per feature – 800 operations), Apply's tool choice, a machine copy. Same M1 Pro under load average 8–25 from parallel agents; lowest of three medians of three runs (generation: one run before, as the S6 table), before → after:

| Measure                                  | 100 instances | 400 instances  |
| ---------------------------------------- | ------------- | -------------- |
| `plan.create`                            | 216 → 42 ms   | 3 321 → 164 ms |
| `planOperationInputs` (every export)     | 225 → 10 ms   | 3 608 → 49 ms  |
| Generate + export (empty toolpath cache) | 316 → 58 ms   | 5 797 → 183 ms |
| Export, all toolpaths cached             | 238 → 20 ms   | 3 752 → 83 ms  |
| Fresh evaluation (unchanged)             | 159 ms        | 800 ms         |
| Longest clone layer step (unchanged)     | 91–95 ms      | 130–134 ms     |

The program (4 028 / 16 028 lines) and every golden are byte-identical; only the toolpath cache key (`inputHash`, in memory, never stored) has other values.

**Plan side: linear.** The time went into whole-part work repeated per plan operation:

- `planOperationInputs` chained `hashJson` over the whole part for every plan operation (the quadratic S6 named); the part now enters the chain by its hash, taken once. The chain still covers position, the part, the plan operation, its copies, setup and units.
- The tool checks (`toolFindings`) and hole depths (`holeDepth`) built the part's surface table per plan operation, and `plan.create` resolves every operation's tool through them, export checks every operation twice: `SurfaceTable.of(ops, stock)` builds it once per (operations array, stock), both immutable models.
- `plan.create`'s tool resolution reloaded the plan (the whole part's parse) per plan operation: it now parses the part once and each copy once (`PlanLoadCache` of `loadPlanDTO`).
- Generation mapped the whole part (`toGeometryInput`) per plan operation; it is mapped once per (part, stock, 2D port) of the plan.
- Scans per operation became lookups by id: the plan's design operations, its stale indicators (`planStale`, which every Apply's pending check runs), the program's labels and clone position comments.

**Evaluation: at the boolean floor.** 85 % of a fresh evaluation at 400 instances is the clone layers' subtraction (compose ≈ 9 %, building operations ≈ 2 %, labels and checks ≈ 1.5 %). 100 → 400 instances costs ≈ 5×: each layer costs a part-size term on top of its tools (counterbore layers 43, 57, 72, 86 ms; drill layers 86, 102, 116, 130 ms, the k-th Clones feature's layers ≈ 15 ms × k slower), because a boolean copies and re-indexes the whole part – ≈ 20 % of the 400-instance time. No order with bounded steps avoids it; measured alternatives on the same part, none taken:

- All clone layers unioned first, then one subtraction from the stock: not faster (union of overlapping counterbore and drill layers costs as much as subtracting them) and one 0.7–0.9 s step.
- Each instance's counterbore and drill unioned first, one layer of 100 holes per feature: 0.90 s against 0.80 s, steps 180–250 ms.
- Instancing by `transform` (recommendation 4): compose is still ≈ 9 %, and transformed instances keep the source's original id (labels by position) and round differently from built ones, so the part would not stay identical.

The guards (`npm run perf`) allow about twice the after medians: at 100 / 400 instances `plan.create` ≤ 100 / 400 ms, `planOperationInputs` ≤ 25 / 100 ms, generate + export ≤ 150 / 450 ms, cached export ≤ 50 / 250 ms, fresh evaluation ≤ 350 / 1 600 ms, the longest subtraction step ≤ 200 / 280 ms. Raising the Clones limit past 100 is now an evaluation question only (≈ 2 ms per counterbored hole at 400, steps up to ≈ 130 ms); design commands remain linear in the part's operations (P5, [shapes.md](../architecture/shapes.md#design-commands-p5)).

## Open questions

- Idle-machine numbers: all timings here ran under load 11–18; the ratios hold, the absolute 100-instance values may halve.
- Should evaluation past the budget show a progress state in the viewport (the clones as ghosts until it lands), so 200–500 instances become acceptable without the plan-side fixes? A UI decision for the user.
