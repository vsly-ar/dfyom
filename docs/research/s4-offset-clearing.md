# Spike S4: offset clearing of regions

Status: draft (spike report, 2026-11-22) · Task: S4 in [plans/v0.3.md § Spikes](../plans/v0.3.md#2-spikes) · Spec it informs: [plan-v0.3.md § Pocket](../modes/plan-v0.3.md#pocket-offset-clearing-of-a-region), [shapes.md § 2D port](../architecture/shapes.md#2d-port) · Code and tests: [`spikes/clearing/`](../../spikes/clearing/clearing.test.ts) · Raw output: [`spikes/clearing/results.md`](../../spikes/clearing/results.md) · Offset engine: S1's CavalierContours WASM build ([ADR 0019](../decisions/0019-2d-geometry-library.md)) · Terms: [glossary.md](../glossary.md) (stepover, rest material)

## Question

Does the draft pocket strategy (rings from repeated inward offsets forming a tree, the √2·R step cap, links between rings, helix/ramp entry per branch) clear general regions with islands and necks completely, with few retracts and in reasonable time? What does it leave, and what should T1 build?

## Method

- **Offsets:** S1's `cavalierWasm` candidate (`spikes/2d/candidates.ts`, CavalierContours 0.9.0 as WASM), unchanged. Clipper2 (also from S1) only for the polygon difference of the gap-ring variant.
- **Ring tree** ([`tree.ts`](../../spikes/clearing/tree.ts)): roots are the components of `offset(region, R)` (no finishing allowance in the spike); each node is one component (outer ring + island rings) and its children are the components of its own offset by the step `s`. A neck splits a node into several children; a ring that meets an island merges with it.
- **Step variants:** the requested stepover; **√2·R** (the draft's cap); **corner** cap R·(1 + sin(θ/2)) from the node's smallest convex corner angle θ (the largest step that leaves no cusp between two parallel rings at a corner of angle θ; it equals √2·R at θ ≈ 49° and R(1 + 1/√2) at 90°); **R** cap; and **gap rings**: after the step, the material the rings miss, `offset(node, R) − dilate(children, R)` (a polygon difference), gets a ring along each piece's boundary, cut after the node's own rings.
- **Traversal** ([`traverse.ts`](../../spikes/clearing/traverse.ts)), one level (Z −2, the moves are `src/core/toolpath` `Move`s):
  - **rings:** ring by ring, deepest tree level first; each ring entered from the retract plane (leaf: helix/ramp; others: plunge at the ring start).
  - **linked:** post-order traversal (each branch from its innermost ring outwards, children nearest-first); a **straight feed link** to the nearest ring of the node when every point of it lies inside the node's region (so it crosses only material cleared by the children); otherwise retract, rapid and plunge. Every leaf after the first needs a retract and a fresh entry.
- **Entry** per leaf: helix (Ø min(0.8 D, D), pitch angle 3°, then one flat circle) at the leaf's deepest point (offset bisection until empty) if the helix circle lies inside the root's tool-centre region; else a ramp along the leaf ring at 3°, lapping as needed; else (ring shorter than D) plunge.
- **Coverage oracle** ([`coverage.ts`](../../spikes/clearing/coverage.ts)): `Heightmap.sweep` from [`src/core/toolpath/testing/oracles.ts`](../../src/core/toolpath/testing/oracles.ts) (the v0.1 generators' oracle), cell 0.1 mm, tolerance 0.01 mm. Each cell centre inside the region is **reachable** when it is within R − tol of the tool-centre region (the morphological opening, eroded by the tolerance) and must be at the floor, else it is **leftover**; the rest of the region is **rest material** and must stay; a cut more than tol outside the region (walls, islands) is a **gouge**.
- **Corpus** ([`corpus.ts`](../../spikes/clearing/corpus.ts)): S1's pocket with 2 islands, dumbbells with a 4 mm neck (< D, cannot pass) and a 10 mm neck (splits during clearing), the 200-segment star with 2 islands, the touching-island case normalised by the boolean, the SVG bracket, gear, letter D and heart as pockets; plus a 30° triangle (acute corners) and an 8 × 60 mm slot (helix does not fit). Tool: flat end mill D 6. Stepover 0.4 D (default) and 0.9 D (the largest allowed). Node 26, Apple M1 Pro class.

## Results

Full table: [`results.md`](../../spikes/clearing/results.md). No variant gouged anywhere.

**Coverage at the default stepover (0.4 D):** no leftover on any of the 11 pockets, both traversals. The uncut area equals the expected rest material `region − opening(R)` within 1 % on every pocket: the 4 mm neck (76.9 mm²), the star's acute points (457 mm²), the gear's tooth roots (139 mm²), the triangle's corners (28.8 mm²), the cusp where the island touches the wall (26.8 mm²).

**Coverage at 0.9 D:** leftover above tolerance (mm²):

| Pocket                    | no cap    | √2·R cap | corner cap | R cap | gap rings | √2·R + gap rings |
| ------------------------- | --------- | -------- | ---------- | ----- | --------- | ---------------- |
| pocket, 2 islands         | 234       | 30.1     | 267        | 0     | 0         | 0                |
| star 200 + 2 islands      | 291       | 54.4     | 84         | 0     | 0         | 0                |
| triangle 30°              | 25.3      | 1.8      | 0          | 0     | 0         | 0                |
| island touches outer      | 36.6      | 4.1      | 1.9        | 0     | 0         | 0                |
| bracket                   | 67.7      | 4.7      | 45.4       | 0     | 0         | 0                |
| heart                     | 21.7      | 4.3      | 21.3       | 0     | 0         | 0                |
| gear / letter D           | 639 / 596 | 0 / 0    | 0 / 515    | 0     | 0         | 0                |
| necks, slot               | ≤ 0.26    | 0        | ≤ 0.26     | 0     | 0         | 0                |
| **pockets with leftover** | 9 / 11    | 6 / 11   | 7 / 11     | 0     | 0         | 0                |

Where it is left: rendering the heightmaps shows that sharp corners are the smaller part. The large pieces are **bands**: where a node is between 2R and 2s wide (between an island ring and the wall ring, or along a letter's stroke), its points deeper than R are further than R from both of its rings, and the next offset (by s) does not exist there yet. Smaller pieces are **new corners**: when offset fronts merge or a branch splits, the child ring gets a sharp corner where its parent was smooth (the heart's inner leaf). The corner formula sees neither, so it does worse than √2·R where the step it allows is larger.

**Why R is enough:** a point of a node that is not inside its child `offset(node, s)` lies less than s from the node's ring; with s ≤ R the ring's sweep covers it. A point inside the child is covered by induction, and a leaf (its offset by s is empty) lies within s of its own ring. No corner, band or collapse rule is needed, and the innermost ring needs no "half a step from collapse" placement. The oracle agrees: 0 leftover on all pockets with s ≤ R.

**Gap rings** clear everything at any step ≤ 2R: each missing piece is thinner than 2(s − R) ≤ 2R and lies inside `offset(node, R)`, so a ring along its boundary clears it without gouging. They need a polygon difference per node (the port's composed booleans or Clipper2), make many small loops (71 on the star without a cap) and add retracts where a straight link would cross an island.

**Linked traversal vs ring by ring (0.4 D, all 11 pockets):**

| Traversal    | Retracts | Plunges into material (not entries) | Straight feed links | Estimated time (sum) |
| ------------ | -------- | ----------------------------------- | ------------------- | -------------------- |
| ring by ring | 119      | 108                                 | 0                   | 1519 s               |
| linked tree  | 17       | 6                                   | 79                  | 1472 s (−3 %)        |

The linked traversal's retracts are 1 per extra leaf (11: each new leaf is fresh material and needs an entry) plus 6 links whose straight line would cross an island (pocket with 2 islands: 2, star: 3, bracket: 1). Time gains are small at these rapid rates (retracts are short); the real gain is 102 fewer plunges into material, which a non-centre-cutting end mill cannot do and which load the tool axially.

**Throughput at 0.9 D:** estimated time summed over the corpus: R cap 1206 s (−18 % against 0.4 D), gap rings 1074 s, √2·R + gap rings 1016 s (−31 %); retracts 7 / 27 / 24.

**Entries:** helix in every leaf except the 8 mm slot, which ramps along its ring (one lap at 3°); plunge never needed. Helix at the deepest point of each leaf with the fit test against the root's tool-centre region never gouged.

**Compute time per pocket** (ring tree + traversal, WASM, median of 5): 0.04–3.7 ms for all pockets except the star: 2.5 ms ring by ring, 29 ms linked at 0.4 D (the straight-link test samples points every 0.1 mm against 1 µm polygons; a segment-against-loop intersection test would make it negligible), 25 ms with the R cap at 0.9 D, 60 ms with gap rings without a cap. Within the 500 ms budget of [shapes.md § Performance](../architecture/shapes.md#performance) by an order of magnitude. The rings depend on the region only, so they are computed once per pocket and reused on every level. The heightmap oracle takes 0.06–3.8 s per pocket at 0.1 mm cells (tests only).

## What remains

- **Rest material** in necks narrower than D, in convex corners sharper than the tool reaches and in the cusp of a touching island: exactly `region − opening(R)`, the [DFM rest-material formula](../architecture/shapes.md#parameter-checks-for-shapes). Removing it is rest machining with a smaller tool (later).
- **Leftover** only when the step exceeds R without gap rings (table above).
- **Retracts** at sibling leaves (inherent in inside-out order) and at links blocked by an island (a link routed through the cleared area, e.g. along the ring just cut, would remove these).
- **Engagement:** links between rings cut about a stepover of material at full width for their length (≤ s); gap rings cut thin ridges. Neither is measured here (the heightmap is a coverage oracle, not an engagement model).
- Not covered: finishing allowance and the finishing ring, several levels, bull-nose and ball tools (only flat-bottom coverage was measured).

## Recommendation

For T1:

1. **Step: equal steps ≤ min(stepover, R)**, not √2·R. Simple, provably complete for any region, and the default stepover (0.4 D) is below it, so nothing changes by default. Stepovers above 0.5 D are clamped to 0.5 D for offset clearing (−18 % time vs 0.4 D on this corpus).
2. **Gap rings later**, as an optimisation for large stepovers (another 13–16 % on this corpus), once the port has region booleans; they need the polygon difference per node and routed links to pay off.
3. **Tree and order as drafted**: per-component offsets, post-order (innermost ring of each branch first), children nearest-first.
4. **Links:** straight feed link when it stays inside the node's region (the parent ring's region, all children already cut); else retract, rapid, plunge and feed. Routing blocked links through the cleared area can come later (6 retracts on this corpus).
5. **Entry per leaf** as drafted: helix at the leaf's deepest point if the helix fits in the tool-centre region, else ramp along the leaf ring (lapping), else plunge.
6. **Test oracle** for T1/T3: the heightmap with the three-way cell classification of this spike (reachable / rest / outside) and the assertion "uncut = region − opening(R) within 1 %". The spike's corpus (with the slot and the triangle) becomes the golden and random-region set.

## Changes the draft docs should take

For [plan-v0.3.md § Pocket](../modes/plan-v0.3.md#pocket-offset-clearing-of-a-region) when it is next edited (not folded in by the spike):

1. **Step cap:** replace "capped at √2·R where a ring has sharp corners" with "equal steps ≤ min(stepover, R)", with the reason (bands between 2R and 2s wide and new corners from merging fronts leave material at any larger step; √2·R left up to 54 mm² on the star). Mention gap rings as the later route to larger steps.
2. **Rings:** each node's children are the components of its own offset by the step (as the spike), so steps restart per branch; no rule for the innermost ring's position is needed.
3. **Links:** the test is "the straight link lies inside the parent ring's region", not "the previous ring's region offset by R" (with all children cut, the parent ring's region is cleared to within s of its ring). On failure: retract, rapid, plunge.
4. **Entry:** "the centre of the largest circle inside the innermost ring's region" is per leaf; the helix fits when its circle lies in the tool-centre region (the root ring's region), not only in the leaf's.
5. **Retracts:** document "one per extra leaf plus blocked links" as the expected count (golden-file check).
6. **v0.1 rectangles:** if T1 replaces the v0.1 pocket generator for rectangles too, their step cap drops from √2·R to R for stepovers above 0.5 D; v0.1 goldens use the default stepover and are unaffected. Otherwise keep the v0.1 rule for rectangles and circles only.
7. **Tests:** add the spike's classification and the rest-area assertion to [§ Tests](../modes/plan-v0.3.md#tests); add the 30° triangle and the narrow slot (ramp entry) to the golden set.

## Open questions

- Is a stepover above 0.5 D worth gap rings in v0.3, or is the clamp enough until adaptive clearing?
- Should the UI show the effective (clamped) stepover for pockets of regions?
- Links: route blocked links through the cleared area (along the ring just cut) or accept the retract?
