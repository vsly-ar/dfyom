# Spike S7: edge chamfers along general loops

Status: draft (spike report, 2026-11-25; Apple M1 Pro, Node v26.7.0, manifold-3d 3.5.4, load average 6–10) · Task: [plans/v0.4.md § Spikes](../plans/v0.4.md#2-spikes) (S7, moved after v0.4 with the edge chamfer), hardening [DF77](../plans/hardening.md#intake-user-feedback-goes-here) · Feature draft: [modes/edge-chamfers.md](../modes/edge-chamfers.md) · Base: [design-v0.4.md § Chamfer operation](../modes/design-v0.4.md#chamfer-operation-v04-circular-edges), [plan-v0.4.md § Chamfer toolpath](../modes/plan-v0.4.md#chamfer-toolpath), [geometry.md § 2.5D evaluation](../architecture/geometry.md#25d-evaluation-v01), [shapes.md](../architecture/shapes.md), [S3 results](../../spikes/prisms/results.md)

Question: can DFYOM build the removal solid and the toolpath of a chamfer along any closed loop of lines and arcs (outside and inside edges, convex and concave corners, small features where the offset changes topology) for a V-bit of included angle α, tip diameter dt and chamfer width w – correct against analytic volumes, fast enough for the evaluation, and with known failure modes?

**Verdict: yes.** One idea gives both the toolpath and the solid, and the solid has a fast path and a robust fallback. Every case below matches its oracle within the chord-tolerance band. The fast path costs 1–30 ms per chamfer for 4–1000 edge elements. The fallback costs ≈ 0.6 ms per element and is needed only where the offset changes topology.

## The idea

A V-bit of half-angle α/2 with its tip at depth h below the face covers, at height z, a disc of radius ρ(z) = dt/2 + (z − z<sub>tip</sub>)·tan(α/2) around its axis. Let the axis follow the **toolpath P**: the edge loop offset into the air by dt/2. At every height the tool has then swept **P ⊕ ρ(z)**, the toolpath region offset by ρ(z). Consequences:

- **Toolpath.** P is one call to the existing 2D port (`Region2dPort.offset`, CavalierContours), and the tip Z is face − h with h = w / tan(α/2), as in the circular case (r = (d − dt)/2 there). The tool's cone then reaches exactly w into the material at the face.
- **Corners come out right by themselves.** Offsetting into the air turns a convex material corner into an arc of radius dt/2 in P (a pointed bit pivots in place), which leaves a **sharp mitre**. At a concave material corner (a pocket's corner) P keeps the edge's corner radius minus dt/2. A radiused corner gets the exact constant-width cone. A sharp corner is left as a **cone of uncut material**, because the V-bit cannot reach into it (quantified below).
- **Topology changes need no special case** in the toolpath: the 2D port's offset already splits and drops loops. The solid is the swept volume of that same path, so geometry and toolpath cannot disagree ([geometry.md § Principle](../architecture/geometry.md#principle-geometry-comes-from-material-removal)).
- For the solid: on the material side, the removal at height z is the material within ρ(z) − dt/2 of the edge. This is the 2D oracle the tests check against: (A ⊖ e) ⊕ ρ(z) for a pocket A, and M minus ((M ⊕ e) ⊖ ρ(z)) for an outside edge of M. Simpson's rule over z gives the volume; the integrand is exactly quadratic between topology events.

## What was built

Throwaway code in [`spikes/chamfers/`](../../spikes/chamfers/), against `src/core` (no app code changed):

- [`sweep.ts`](../../spikes/chamfers/sweep.ts) – **construction A, sweep union:** per toolpath element, a line becomes `hull(tool at a, tool at b)` (two convex frustums, so the hull is the exact sweep; the frustum polygons are turned so a vertex points along the line's normal, which loses no width to chords). An arc becomes `revolve` of the tool's half profile at radius R over the arc's sweep, plus the tool at its ends where the neighbour is a non-tangent arc. Then a batch union. It also holds the toolpath (`chamferPath`) and the 2D oracle (`removedArea`, `removedVolume`).
- [`loft.ts`](../../spikes/chamfers/loft.ts) – **construction B, offset-loft:** P ⊕ ρ(z) at a few levels from the **analytic** offset of P's elements: parallels, joint arcs where neighbours part, trims where they cross, and arcs whose radius reaches 0 collapsed into their neighbours' trim point. The levels are joined by ruled bands and closed with triangulated caps, and run vertically from the face to the overshoot as the circular solid does. An inside edge takes one loft (P grown). An outside edge takes the grown loft minus the shrunk one: the V-groove only, so the offcut beyond the slot is left alone. Every level is checked against the 2D port's offset (loop count, and area within the chord band). A level that fails means a topology change: B returns `undefined` and A is used.
- [`chamfers.test.ts`](../../spikes/chamfers/chamfers.test.ts) – **reassembly with the real evaluation:** `evaluatePart` builds the edge operation (the app's pocket or profile solids, tiled stock, layers, labels, checks). A `SolidPort` wrapper subtracts the chamfer from the stock before the first layer, and the removed volume is the volume difference. `S7_MODE=union|layers|loft` selects the construction.
- [`tools-size.test.ts`](../../spikes/chamfers/tools-size.test.ts) – measures `tools/list` for the draft's Agent API budget.

Run: `npx vitest run -c spikes/chamfers/vitest.config.mts --silent=false` (with `S7_MODE=loft` for the fast path). Typecheck: `npx tsc -p spikes/chamfers`.

## Correctness

Removed volume against the analytic value (rectangles, circles) or the 2D oracle (everything else). The **band** is edge length × h × 0.01 mm chord tolerance: the volume a 0.01 mm shift of the bevel moves. Every case is within half a band.

| Case (90° unless noted, tip 0 unless noted)                                    | Removed mm³ | Oracle / analytic mm³          | Δ / band    | Pieces |
| ------------------------------------------------------------------------------ | ----------- | ------------------------------ | ----------- | ------ |
| Rectangle 100 × 60, outside, w 1.5 – h((a+b)w − 4w²/3)                         | 355.500     | 355.500                        | 0.00        | 2 → 2  |
| Rectangle outside, w 1, 60°, tip 0.2                                           | 274.819     | 274.819                        | 0.00        | 2 → 2  |
| Pocket 80 × 50 R3 (inside), w 1 – h(P·w/2 + πw²/3)                             | 128.494     | 128.472                        | 0.01        | 1 → 1  |
| Circle pocket R10 (hole mouth), w 1 – h(πRw + πw²/3)                           | 32.487      | 32.463                         | 0.04        | 1 → 1  |
| Circle R30, outside, w 1 – h(πRw − πw²/3)                                      | 94.969      | 93.201                         | 0.94        | 2 → 2  |
| Pocket 80 × 50 **sharp** corners, w 2                                          | 528.201     | 528.378 (mitred ideal 530.667) | −0.03       | 1 → 1  |
| Same, tip 0.5                                                                  | 527.198     | 527.414 (mitred ideal 530.667) | −0.04       | 1 → 1  |
| Star pocket (lines + concave arcs) + 2 islands, 52 / 204 / 504 / 1004 elements | –           | 2D oracle                      | 0.42 … 0.11 | 1 → 1  |
| Faceted circle pocket, 250 / 1000 lines                                        | –           | 2D oracle                      | 0.00        | 1 → 1  |
| Islands pocket (S3 generator), 104 / 504 elements, w 0.5                       | –           | 2D oracle                      | 0.13 … 0.15 | 1 → 1  |
| Comb pocket, material teeth 6 / 2 / 1 mm, w 1.5                                | –           | 2D oracle                      | −0.04       | 1 → 1  |
| Dumbbell pocket, 0.4 mm neck, tip 0.6, w 1 (the path splits)                   | 96.023      | 95.959                         | 0.03        | 1 → 1  |
| Enclosure outline (84 fitted arcs), outside, w 1.5                             | 793.4       | 786.2                          | 0.69 – 0.71 | 2 → 2  |
| Enclosure cavity (75 elements), pocket, w 1                                    | 331.0       | 330.9                          | −0.01       | 1 → 1  |

- Constructions A and B agree with each other and with the oracle in every case where B applies (the loft column of the test output).
- **Circles and fitted arcs sit near the edge of the band** (0.7–0.96): the edge operation's prism is flattened circumscribed and the chamfer inscribed, and both errors are the chord tolerance. Straight edges are exact (Δ = 0.000 %).
- **No air triangles**, no `status` errors, no loose pieces. One exception was found and fixed: see the float32 round trip under [Failure modes](#failure-modes-found).

## Cost

Warm, ms. "Chamfer → solid": the chamfer's meshes into the app kernel and composed there (loft: `fromMesh` + grown − shrunk; union: `fromMesh` per piece + batch union). "Eval": the whole `evaluatePart` without, and with, the chamfer.

| Case                      | Edge elements | Loft: build | Loft: chamfer → solid | Loft: tris | Eval without | Eval with (loft) | Union: chamfer → solid | Eval with (union) |
| ------------------------- | ------------- | ----------- | --------------------- | ---------- | ------------ | ---------------- | ---------------------- | ----------------- |
| Rectangle outside         | 4             | 1.3–3.4     | 1.1–1.8               | 632–760    | 5–14         | 8–11             | 9–11                   | 18–19             |
| Pocket R3 / circle pocket | 8 / 2         | 0.8–1.1     | 0.4–0.5               | 516–736    | 2.5          | 5–6              | 1–6                    | 7–12              |
| Star + islands            | 52            | 6.1         | 3.8                   | 5 564      | 8.0          | 29               | 29                     | 57                |
| Star + islands            | 204           | 16.1        | 8.6                   | 12 244     | 15.9         | 60               | 185                    | 247               |
| Faceted circle            | 250           | 4.6         | 3.2                   | 4 996      | 4.6          | 22               | 367                    | 396               |
| Faceted circle            | 1 000         | 17.7        | 13.9                  | 19 996     | 15.3         | 88               | 3 386                  | 3 517             |
| Islands                   | 504           | 27.7        | 16.0                  | 20 564     | 42.9         | 131              | 328                    | 500               |
| Comb, 6 mm teeth          | 36            | 2.7         | 2.2                   | 3 452      | 2.4          | 10.5             | 47                     | 58                |
| **Enclosure outline**     | 84            | 5.9         | 23.6                  | 6 652      | 19.8         | **62**           | 60                     | 97                |
| **Enclosure cavity**      | 75            | 3.2         | 1.8                   | 2 736      | 6.6          | **20**           | 58                     | 79                |
| Star (topology change)    | 504 / 1 004   | fallback    | –                     | –          | 24 / 52      | –                | 800 / 2 646            | 905 / 2 865       |
| Comb, 2 / 1 mm teeth      | 36            | fallback    | –                     | –          | 2.4          | –                | 60 / 62                | 70 / 71           |

- **The loft is cheap.** Building it costs about as much as one S3 prism per chord, and an inside edge needs no boolean of its own. With it, a chamfer adds 3–45 ms to an evaluation at ≤ 250 elements, which is the size of real parts (the enclosure: 84 and 75 elements).
- **Most of an outside edge's cost is the boolean `grown − shrunk`** (≈ 20 ms on the enclosure outline). Building the V-groove as one annular mesh (both rings per level, annular caps) would drop it: the two lofts never touch.
- **The sweep union does not scale.** About 0.5–0.6 ms per piece up to ≈ 100 pieces, then superlinear (204 → 185 ms, 1 000 → 3.4 s). Every piece crosses the tiled stock face, the quadratic case S3 found. Subtracting the pieces in pairwise-disjoint layers instead of one union (`S7_MODE=layers`, `subtractionLayers`) helps only at large counts (1 004 pieces: 2.6 → 1.6 s).
- The toolpath itself (one 2D offset) costs 0.1–6 ms in every case.

## Topology changes at small offsets

Where the analytic offset changes structure between dt/2 and dt/2 + w, the loft's validity check fails and the fallback takes over. The cases met:

| Case                                                                        | What changes                                                            | Result                                                                                                                                         |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Small arcs of P (radius dt/2 + run at convex corners) on the shrinking side | Radius reaches 0                                                        | Handled in the loft: the arc collapses into the trim point of its neighbours (rectangle, comb with 6 mm teeth, enclosure cavity)               |
| Material teeth narrower than 2w (comb 2 / 1 mm, w 1.5)                      | The tooth's top vanishes: the two bevels meet in a ridge below the face | Fallback; volume right. A real design finding: the wall loses its top face (`dfm.chamferMeets` in the draft)                                   |
| Notches shorter than ≈ w (star, 504 / 1 004 elements)                       | Concave arcs and their joint arcs vanish                                | Fallback (0.8 / 2.6 s): a heavy-shape case, like S3's 2 000 elements                                                                           |
| Air narrower than the tip (dumbbell neck 0.4 mm, tip 0.6 mm)                | P splits into two loops; the neck's walls are never reached             | Correct machined result: 95.96 mm³ against 114.63 mm³ for a pointed bit, 16 % left in and near the neck (`dfm.chamferIncomplete` in the draft) |

A loft split at the event offsets (one loft per interval between events, matched again after each) would replace most fallbacks. It is not needed for the first slices: real outlines rarely have features narrower than 2w, and the fallback is correct.

## Inside corners

A sharp concave material corner (a pocket corner of radius 0) keeps a cone that the V-bit cannot reach. Against the mitred ideal it is **(4 − π)/12 · h · w² per 90° corner** with a pointed bit. Measured: 2.289 mm³ for 4 corners at w = h = 2, matching the formula to 0.001 mm³ (oracle) and within the chord band (solid). A 0.5 mm tip leaves 3.25 mm³. A milled pocket corner always has at least the end mill's radius. With a corner radius ≥ dt/2 the result is the exact constant-width cone, with nothing left. Sharp corners only exist in the nominal model, where `dfm.cornerSharp` already warns. Getting a crisp inside mitre needs the V-carving corner move (the tip rises along the bisector to the face, [glossary: V-carving](../glossary.md)). That is an option for later.

## Failure modes found

1. **A float32 round trip of a unioned sweep is not a valid solid.** `getMesh` of the union, then `fromMesh` (float32 positions, as every app mesh is passed) left 4–6 loose tetrahedra of 0.07–0.7 mm³ on the enclosure. The cause is near-coincident faces of nested pieces flipping under rounding. Fix, as built: pass each piece as its own mesh and **union inside the kernel**, so a production fallback needs `SolidPort.union` over the pieces (it exists). The loft has no such issue: one mesh, built in float64 and placed once.
2. **manifold-3d 3.5.4 `revolve`** takes `circularSegments` as the slice count for any sweep (not per 360°): a 2° arc of R 1 000 at 4 000 segments made 32 000 triangles. Fewer than 3 slices gave an **empty** solid for short arcs of large radius, which silently lost 7–10 % of the enclosure's volume. Fix: slices = max(3, ⌈n<sub>360</sub> · sweep / 360°⌉). A production sweep should build its own labelled meshes (as `loft.ts` does) instead of `revolve` / `hull`, which the `SolidPort` does not offer.
3. **Chord loss across the bevel:** hulls of inscribed polygons lose up to the chord tolerance of width at every height unless a polygon vertex points along the line's normal (fixed in the spike; the loft has none).
4. **Topology changes:** see above. Detected reliably by comparing the analytic offset with the port's offset (loop count, area within the chord band).
5. **Air too narrow for the V:** a pocket narrower than 2·(w + dt) has the V's air side reach the opposite wall. That is correct (the tool does cut it) and shows in the solid, but it is a finding for the user (`dfm.chamferMeets` covers walls; a narrow slot chamfered from both sides is the same case).

## Recommendation (for the draft)

- **Solid:** the offset-loft of the toolpath region (construction B) as the normal path, labelled `chamfer1.bevel`, built in the geometry module next to `shape-solids.ts`. An outside edge is built as one annular V-groove mesh, or for a start as grown − shrunk. **Fallback:** per-element swept pieces built as labelled meshes, unioned in the kernel. Both run on the same toolpath region from the 2D port, so the solid is what the tool cuts.
- **Toolpath:** P = the edge loops offset into the air by dt/2 (the port), the tip at face − w / tan(α/2), one pass, entry by plunging in the air at the loop's start point. Circles keep the v0.4 generator (plunge at the centre, grouping P-B).
- **Checks** from the same 2D offsets: `dfm.chamferMeets` (the material offset by w loses an element or a piece) and `dfm.chamferIncomplete` (the path loses length against the edge: air narrower than the tip). `dfm.chamferTooDeep` is reused for an edge shallower than h.
- **Budgets:** inside edges fit the 50 ms evaluation budget at the sizes measured. An outside edge of ≈ 100 elements adds ≈ 40 ms (≈ 20 ms with the annular mesh). The operation cache keeps an unchanged chamfer's solid, as for other operations.
