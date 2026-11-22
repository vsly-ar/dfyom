# Plan mode v0.3: toolpaths for general loops

Status: draft (assumptions T-A to T-F await the user's confirmation with [design-v0.3.md](design-v0.3.md#questions-for-the-user)) · Design: [design-v0.3.md](design-v0.3.md) · 2D layer: [architecture/shapes.md](../architecture/shapes.md) · v0.1 strategies and generators: [plan-v0.1.md](plan-v0.1.md#pass-strategies-v01) · Setups: [plan-v0.2.md](plan-v0.2.md) · Post: [grbl.md](../architecture/grbl.md) · Tasks: [plans/v0.3.md](../plans/v0.3.md) · Terms: [glossary.md](../glossary.md)

The v0.1 generators compute offsets of rectangles and circles analytically ([plan-v0.1.md § Toolpath generators](plan-v0.1.md#toolpath-generators-task-210)). v0.3 feeds them **regions and paths of lines and arcs** and takes every offset from the 2D port ([shapes.md § 2D port](../architecture/shapes.md#2d-port)). The [toolpath data model](plan-v0.1.md#toolpath-data-model), the job, the cache, setups and the export stay; the common rules (clearance, retract plane, levels, plunge rate, arcs ≤ 180°) apply unchanged.

## Decisions (assumed)

| Id  | Assumption                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-A | Pockets of any region keep **offset clearing** (rings from the inside out, a finishing ring per loop); adaptive clearing stays later.                             |
| T-B | Toolpaths keep **arcs exact**: every arc of an offset is an `arc` move, exported as G2/G3. Lines are never fitted to arcs or the reverse, except degenerate arcs. |
| T-C | Profiles roll round convex corners of the tool-centre path (arc joins, the CAM "round corners" default); sharp (extended) corners are later.                      |
| T-D | Finishing passes enter and leave on **tangent arcs** (lead-in / lead-out arcs) where there is room, else straight as v0.1.                                        |
| T-E | An `on` groove of an open path is cut **zigzag by level** (along, then back one level lower); climb or conventional does not apply to a full-width slot.          |
| T-F | Plan-only edits may change a shape operation's placement, shape reference and parameters, not shape definitions.                                                  |

## Pocket: offset clearing of a region

Strategy parameters as [v0.1 pocket](plan-v0.1.md#pocket-offset-clearing); no new ones.

Spike S4 measured this strategy on S1's corpus and this section takes its recommendations: [research/s4-offset-clearing.md](../research/s4-offset-clearing.md).

- **Rings:** the roots are the components of `offset(region, R + finishAllowance)`; each node (one component: an outer ring and its island rings) has as children the components of **its own** offset by the step, until empty. Offsets split at necks and merge with islands, so the rings form a **tree** and steps restart per branch; no rule places the innermost ring.
- **Step:** equal steps ≤ **min(`stepover`, R)**; a larger stepover is clamped to R (0.5 D) for offset clearing. Why: a point of a node outside its child lies less than the step from the node's ring, so with steps ≤ R every ring's sweep covers it and clearing is complete for any region. Any larger step leaves material in **bands** (where a node is between 2R and 2·step wide, e.g. between an island ring and the wall ring) and at **new corners** where merging fronts or splits sharpen a child ring; v0.1's √2·R cap left up to 54 mm² on S4's star. The default stepover (0.4 D) is below R, so nothing changes by default. **Gap rings** (a ring round each piece the larger step misses) are the later route to larger steps. The heightmap simulation is the test oracle for coverage ([Tests](#tests)).
- **v0.1 rectangles and circles:** if T1 replaces the v0.1 pocket generator for them too, their cap drops from √2·R to R for stepovers above 0.5 D; v0.1 goldens use the default stepover and are unaffected. Otherwise they keep the v0.1 rule.
- **Order:** per branch of the tree, from the innermost ring outwards (post-order, v0.1 order), climb direction (outer loops counter-clockwise, island loops clockwise, seen from the spindle). Children are visited nearest-first.
- **Links:** a straight feed move to the next ring only when every point of it lies inside the **parent ring's region** (all its children are cut, so that region is cleared to within a step of its ring); otherwise retract, rapid on the retract plane and plunge (re-enter).
- **Entry** per leaf, with v0.1's fallback order: `helix` at the leaf's deepest point (the centre of the largest circle inside the leaf ring's region, found by offsetting until empty) if the helix + 2a fits inside the **root's tool-centre region** (not only the leaf's); `ramp` **along the leaf ring** (lapping as needed) at `rampAngle`; else `plunge`.
- **Retracts:** expected count per level is **one per leaf after the first plus one per blocked link** (golden-file check).
- **Finishing:** one ring per loop (outer and every island) at offset R, levels of `finishStepdown`, lead-in and lead-out arcs from the cleared side (T-D).
- **Rest material** in necks narrower than the tool is not cut; design warns `dfm.restMaterial` ([design-v0.3.md § DFM](design-v0.3.md#dfm-checks-for-shapes)), Plan repeats it as `plan.restMaterial` (warning) for the plan's own tool. Rest machining with a smaller tool is later.

## Profile on general loops

Strategy parameters as [v0.1 profile](plan-v0.1.md#profile-with-tabs), plus `leadRadius` (length, default 0.5 D, ≥ 0; 0 = straight lead) for the finishing pass.

- **Passes:** distances from the shape as v0.1 (part side at R + allowance, then toward the offcut in steps ≤ `stepover`); each pass is `offset(loop, ±distance)` (outside: grows; inside: shrinks; an inside pass that vanishes in a neck splits, and each piece is cut).
- **`on`:** passes symmetric about the centreline; a slot equal to D is one pass on the loop or path. Closed loops keep the profile's climb direction for the outer passes; open paths zigzag by level (T-E) with ramps along the path.
- **Entry:** ramp along the first pass as v0.1; on an open path the ramp zigzags along the first stretch.
- **Tabs:** as v0.1 (lift where the tool disk overlaps a nominal tab band), with the general bands of [shapes.md](../architecture/shapes.md#geometry-for-shape-operations) at the design's positions; boundaries by sampling and bisection along arcs as along lines.
- **Finishing:** the part-side pass at full depth, lead-in and lead-out arcs of `leadRadius` on the offcut side, starting and ending at the start point unless a tab is there (then mid-way to the next tab).

## Arcs in, G2/G3 out

- Every offset element is a `line` or `arc` move; arcs over 180° are split (v0.1 rule). Helices (ramp and helix entries along arcs) are `arc` moves with a Z change.
- **Degenerate arcs:** sweep < 1e-4 rad → `line`; radius < 0.005 mm → `line` (the offset of a corner arc just above zero). There is no radius rule in the toolpath: a huge radius is not a deviation bound (a 225 m arc over 300 mm bows 0.05 mm, [shapes.md § Arc fitting](../architecture/shapes.md#arc-fitting)).
- **Huge-radius arcs:** whether a G2/G3 of huge radius goes out as `G1` (GRBL computes in float32, so km radii lose precision in `I`/`J`) is the **post's** decision, by the arc's sagitta against the post's own tolerance, beside its short-chord rule ([grbl.md § Output dialect](../architecture/grbl.md#output-dialect)); added to the post with these goldens.
- **GRBL arcs:** the post already writes arcs as GRBL reads them (`I`/`J` from the written start, short chords as `G1`, the `error:33` end-on-circle guard, [grbl.md § Output dialect](../architecture/grbl.md#output-dialect)). v0.3 changes nothing there; it feeds the post many more arcs, so the post's property tests gain the shape goldens (tiny corner arcs, near-180° splits, helices along arcs) in mm and inch.

## Plan side

- **Design snapshot:** carries the part's shapes; plan operations of shape operations group as today (equal holes only). Plan-only edits per T-F through `plan.design.operation.update`.
- **Tool checks** ([plan-v0.1.md § Tool assignment](plan-v0.1.md#tool-assignment-and-checks)): "wider than the pocket / slot / opening" uses the region's width (`offset(region, R)` non-empty); a corner radius below the tool radius is a warning (the corner keeps the tool radius), not an error, as today.
- **Order checks** (`plan/order.ts`) use the placed region's bounding box where they used the shape's.
- No change to setups, export per setup, Run.

## Tests

Extend the v0.1 suite ([plan-v0.1.md § Toolpath generators](plan-v0.1.md#toolpath-generators-task-210)): the generic rules on every generator; golden files for a pocket with two islands, a neck that splits, S4's 30° triangle (acute corners), S4's 8 × 60 mm slot (the helix does not fit, ramp entry), an outside profile of the spike's bracket with free tabs, an inside profile, an `on` groove (open and closed); the **heightmap simulation** compared with the analytic removal, with S4's three-way cell classification: **reachable** (within R − tol of the tool-centre region: must be at the floor), **rest** (the rest of the region: must stay) and **outside** (any cut more than tol outside the region is a gouge); the assertion **uncut area = region − opening(R)** within 1 % (rest material only where `dfm.restMaterial` says); 30 seeded random regions from S4's corpus (with the triangle and the slot); every golden program streamed through the [virtual machine](../architecture/grbl.md#virtual-machine-task-38) without an error.

## Open questions

- **Gap rings in v0.3?** Is a stepover above 0.5 D worth gap rings now (another 13–16 % time on S4's corpus at 0.9 D), or is the clamp to R enough until adaptive clearing? Recommendation: later; they need region booleans per node and routed links to pay off.
- **Show the clamped stepover?** Should the UI show the effective stepover for pockets of regions when it is clamped? Recommendation: yes, as an info note on the operation.
- **Blocked links:** route them through the cleared area (e.g. along the ring just cut) or accept the retract (6 on S4's corpus)? Recommendation: later; accept the retract in v0.3.
