# Shapes: 2D layer, geometry and import

Status: accepted (v0.3; user decision D29 of 2026-11-22, [Decisions](#decisions-d29); follows [ADR 0019](../decisions/0019-2d-geometry-library.md), accepted) · Design side: [design-v0.3.md](../modes/design-v0.3.md) · Toolpaths: [plan-v0.3.md](../modes/plan-v0.3.md) · Geometry base: [geometry.md](geometry.md) · Spike: [plans/v0.2.md § 7](../plans/v0.2.md#7-spike-for-v03), harness [`spikes/2d/`](../../spikes/2d/harness.ts) · Tasks: [plans/v0.3.md](../plans/v0.3.md) · Terms: [glossary.md](../glossary.md)

What `src/core` needs so shapes of lines and arcs flow through geometry, DFM and toolpaths. It extends the [layers](geometry.md#layers) of geometry.md: the "2D" row becomes CavalierContours behind a port; the analytic model stays the source of truth ([ADR 0007](../decisions/0007-layered-geometry-without-brep-kernel.md) holds: still 2.5D per direction).

## 2D model

- **Element:** `line { a, b }` or `arc { a, b, centre, ccw }` in float64 mm (the analytic form); CavalierContours' **bulge** form (`tan(sweep / 4)` per vertex) is the port's wire format only.
- **Loop:** a closed chain of elements; **Path:** an open chain. **Region:** loops that never cross, outer loops counter-clockwise, holes clockwise (the spike's convention: a positive offset shrinks).
- `src/core/geometry/contour.ts` keeps its analytic rounded rectangles and circles; they convert to loops (exact arcs) for everything general, so v0.1/v0.2 outputs stay byte-identical where nothing changed (golden files).

## 2D port

`Region2dPort` in `src/core/geometry/2d/` (like `SolidPort`), implemented over the CavalierContours WASM with our thin C ABI ([ADR 0019 decision 2](../decisions/0019-2d-geometry-library.md#decision)):

| Function                                     | Use                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `normalise(loops) → Region`                  | Unite overlapping outer loops, subtract holes, split self-touching loops (avoids the touching-island defect, ADR decision 3) |
| `union`, `difference`, `intersect` (regions) | Shape items, islands; multi-loop booleans folded from the crate's loop-to-loop booleans                                      |
| `offset(region, d) → Region`                 | Tool radius compensation, pocket rings, slot bands, rest-material and width checks                                           |
| `offsetPath(path, d)`                        | Both sides of an open path for `on` grooves (stroke outline with round ends)                                                 |
| `pointAt(loop, s)`, `length`                 | Distances along a loop: tab positions, start points                                                                          |
| `contains`, `distance`                       | Snapping, link checks in toolpaths, markers                                                                                  |

- **Rules:** the port takes and returns plain data (no WASM handles leak, as for Manifold's [arena](geometry.md#wasm-lifetime-and-ownership)); its errors are `geometry.evaluation` with a rule; a result that fails validation (crossing loops) is a bug, never silently used.
- **Epsilons:** CavalierContours' position ε 1e-5 mm and offset ε 1e-4 mm sit below the 0.01 mm [chord tolerance](geometry.md#evaluation-rules); documented beside it when built. Elements shorter than 1e-4 mm are merged before the library sees them (`segmentTooShort` for user input).
- **Regression tests:** the spike's correctness fixtures (necks, tangent and near-tangent arcs, touching islands, 2000-segment star, SVG corpus) become port tests with the offset oracle ("every output point lies exactly |d| from the input").

## Where the 2D layer runs

| Host                         | Why                                                                                                                                                               | Loading                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Dispatcher (commands)        | Resolving shapes, invariants and parameter DFM checks are synchronous in the command step ([design-v0.3.md § DFM](../modes/design-v0.3.md#dfm-checks-for-shapes)) | instantiated once at host start from bytes the host supplies (Node allows synchronous compile)                                      |
| `geometry`, `toolpath` lanes | Solids and toolpaths                                                                                                                                              | per worker, lazily, like `manifold.wasm`                                                                                            |
| Renderer                     | Live outline, Shape Editor handles, snapping                                                                                                                      | **asynchronously** at window start (`WebAssembly.instantiate`): Chromium refuses synchronous compiles over 4 KiB on the main thread |
| CLI and tests                | Same as the dispatcher                                                                                                                                            | `testing/node-wasm.ts` pattern                                                                                                      |

The module has no imports (ADR 0019), so one loader serves all hosts. The `.wasm` is vendored with its SHA-256, the pinned crate source and a rebuild script; CI checks the checksum and needs no Rust toolchain ([ADR 0019 decision 6](../decisions/0019-2d-geometry-library.md#decision), Q26, D29).

## Resolving a shape

`resolveShape(definition) → AppResult<Region | Path>` (pure, in `src/core/design/shape.ts`):

1. Each item to loops in the shape frame: primitives analytically (exact arcs), paths by walking segments (`arc` from `to`, `radius`, `cw`, `large`; `tangentArc` from the previous element's end tangent), fillets as tangent arcs between neighbours.
2. Fold the items with their `op` through the port, `normalise` the result.
3. Validate: no crossings, area > ε, every loop ≥ 3 elements or a circle.
4. Place: shape frame → face frame by the operation's anchor, rotation and mirror; anchors use the placed bounding box of the exact elements (arc extremes included).

Results are cached per (definition hash, placement): commands, the geometry mapper and the toolpath mapper call it many times per edit.

### Validity

- A closed `path` that crosses itself is refused (`shapeSelfIntersects`), not repaired: which side is "inside" is the user's intent. SVG import repairs instead and says so in the report (`fill-rule` decides).
- A boolean result with several disjoint outer loops is valid for a pocket (several pockets in one) and refused for a profile (`profileOneLoop`).

## Geometry for shape operations

Builders in [Building the solids](geometry.md#building-the-solids) get general-loop variants; placement by the face frame, overshoot, labels and checks stay as in [Non-top faces](geometry.md#non-top-faces-v02).

| Operation       | Removal                                                                                    | Retained                   |
| --------------- | ------------------------------------------------------------------------------------------ | -------------------------- |
| Pocket (region) | **Prism** of the region (holes = islands) from `zf` up through `ov`; no floor fillet (Q16) | –                          |
| Profile outside | `offset(loop, −slotWidth) − loop` prism, through (the kept side circumscribed, as today)   | Tabs: general offset bands |
| Profile inside  | `loop − offset(loop, slotWidth)` prism                                                     | Tabs                       |
| Profile `on`    | `offsetPath` / `offset(loop, ±slotWidth/2)` band, through or to the blind `depth`          | Tabs (closed through only) |

- **Labelled prisms:** walls are bands per flattened element, labelled `wall[i]` / `corner[i]` by element (lines / arcs, numbering in [Surfaces](../modes/design-v0.3.md#surfaces)); caps are triangulated with holes by Manifold's `triangulate` on the flattened loops (no new dependency, no fan caps: S3 measured caps at 10–25 % of the cost) and labelled `floor` / `air`. `triangulate` is exposed through the manifold adapter (`src/core/geometry/manifold/`, plain data in and out, outside the arena, same module instance). The v0.1 offset-loft stays for rectangles and circles with floor fillets.
- **Flattening** as today: removals inscribed, the kept-side prism circumscribed, per element, at the 0.01 mm chord tolerance.
- **Tabs:** the offset band of [Offset-loft](geometry.md#offset-loft) is defined by "points whose nearest shape point lies on the tab's stretch"; for general loops it is built from the stretch's elements offset to `outer` and `inner` with end faces along the loop normal, bent on the medial axis by the same rule. The tab stretch comes from `pointAt` with the design's positions.
- **Part-frame placement:** every mesh, the stock included, has its vertices placed into the part frame in float64 **before** the float32 mesh I/O; the same part-frame value then rounds to the same float32 in every mesh, so walls of two directions meet as exactly as levels do. This supersedes the A1b "key level in the placement" rule ([geometry.md § Non-top faces](geometry.md#non-top-faces-v02)) once G1 lands, closes the v0.2 wall-sliver issue ([plans/v0.2.md](../plans/v0.2.md#known-issues-and-risks); S3: 0 of 60 cases, against 33 of 60) and folds G2 into G1. It changes v0.1/v0.2 meshes by float32 rounding, so mesh golden files change. Precision: half a float32 ulp is 3.8 nm at 100 mm, 30 nm at 1 m.
- **Tiles:** Manifold re-triangulates every face a prism crosses as one polygon, in time quadratic in the chords of the crossing loop. Planar faces that later operations cross – the stock faces and facing floors – are therefore built as tiles of ≈ 15 mm, each with its own face id, all mapped to one surface role (`stock.top`, `facing1.floor`). S3: the 2000-element star 169 → 60 ms, ≈ 600 extra triangles on a 200 × 120 × 30 stock.
- **Spike S3:** [results](../../spikes/prisms/results.md); numbers in [Performance](#performance).

## Parameter checks for shapes

`parameterChecks` gains the region per shape operation ([design-v0.3.md § DFM checks for shapes](../modes/design-v0.3.md#dfm-checks-for-shapes)):

- **Inside corners of the cut:** walk the loops of the material side: a vertex with a turn into the material and no arc, or an arc of that sense with radius < the tool radius (+ `TOOL_MATCH_TOLERANCE`).
- **Width:** `offset(region, R)` empty → no tool of radius R fits.
- **Rest material:** `region − offset(offset(region, R), −R)` (a morphological opening) minus the corner zones; pieces above 0.5 × R² area are reported.
- Cost per check is a few offsets (sub-ms at the spike's sizes); the auto tool choice runs them per candidate tool on Apply only.

## Arc fitting

SVG Béziers and elliptical arcs become **biarcs** (two tangent arcs per piece, tangent-continuous with their neighbours), subdivided until every point is within 0.01 mm (the chord tolerance). The spike's 3-point arcs are not tangent-continuous and are not used. Lines stay lines; circular arcs stay exact. Fitting runs in the dispatcher's prepared input (import), never on render. Method (spike S5, approach B, [research/s5-biarc-fitting.md](../research/s5-biarc-fitting.md)):

1. **Split** each curve at cusps (B′ = 0: **true corners**, the source has no tangent there), then at inflections and ellipse vertices (G1 joins), so every piece is C-shaped.
2. **Fit** each piece with a biarc joined at the incenter of its tangent triangle; subdivide at the parameter midpoint while the error estimate exceeds the tolerance. Estimate: 24 curve samples per piece against the elements, plus a guard rejecting element chains more than 10 % longer than the sampled curve.
3. **Lines** only for degenerate arcs: sagitta ≤ 0.1 µm **and** half sweep (the kink left) ≤ 0.1 mrad; the fit runs at 0.01 mm − 0.1 µm to pay for it. There is no radius rule: a 225 m arc over 300 mm is 0.05 mm off its chord. Collinear lines merge.
4. **Clean up:** micro corners (lines shorter than 1·10⁻⁴ mm left at near-cusps) are merged into their neighbours before the shape reaches the [2D port](#2d-port), so `segmentTooShort` never fires for imports; arcs over 180° are split in two (bulge ≤ 1), so a circular SVG arc or full circle gives 1–2 elements. Merging consecutive arcs with a common centre (within tolerance) is optional.

Each fitted curve gives ≥ 2 elements (B: ≈ 7–8 per cubic, 27–33 µs per cubic). Corners kept at cusps and micro corners merged are counted in the [import report](../modes/design-v0.3.md#svg-import). The spike's independent oracle (two-sided sampled deviation, kink angles) and corpus become I1's tests; production code relies on the in-fit estimate and keeps no two-sided check ([Decisions](#decisions-d29)).

## SVG import

`src/core/import/svg.ts`, pure: an XML tokenizer of the SVG subset (no DOM; `src/core` stays headless), transforms flattened into the element coordinates, units from `width`/`height`/`viewBox`, `fill-rule` to booleans, the [import report](../modes/design-v0.3.md#svg-import) as data. Limits (refused with `input.malformed`, rule `svgLimit`): 10 MB file, 20 000 elements after fitting. The spike corpus (`spikes/2d/corpus/`) seeds the tests.

## Performance

Budgets on the Apple M1 Pro class reference, measured by `npm run perf`:

| Measure                                                           | Budget   | Spike evidence (ADR 0019)                |
| ----------------------------------------------------------------- | -------- | ---------------------------------------- |
| Resolve + parameter checks of a 200-element shape, in the command | ≤ 3 ms   | one offset 0.14 ms, union 0.26 ms (WASM) |
| Part evaluation with three shape operations (500 elements total)  | ≤ 50 ms  | S3: 40 ms                                |
| Pocket toolpath of the spike's star (200 + 2 islands)             | ≤ 500 ms | 20 rings 1.1 ms                          |

Evaluation cost follows **chords** (flattened segments at the chord tolerance), not elements: with [tiles](#geometry-for-shape-operations), ≈ 16 µs per chord (triangulate ≈ 3.6, `fromMesh` ≈ 3.2, booleans ≈ 8), so the 50 ms budget holds ≈ 3 000 chords per evaluation ([S3](../../spikes/prisms/results.md#cost-median-of-15-part-placement)). Single 500-element pockets take 15–39 ms; 2000-element shapes (5 000–7 000 chords) take 47–115 ms tiled (82–169 ms untiled) and do not fit: they run under a documented limit ([Decisions](#decisions-d29)).

## Decisions (D29)

Settled with the user when this doc was accepted (D29, 2026-11-22, the recommendations taken):

- **Shapes over the chord budget** (2000 elements: 47–115 ms, [Performance](#performance)): a documented limit, no hard refusal – each subtraction stays one evaluation step (≤ ≈ 60 ms, abortable between steps) – plus the DFM info note `dfm.shapeHeavy` when a shape operation's chords exceed the budget ([design-v0.3.md § DFM checks](../modes/design-v0.3.md#dfm-checks-for-shapes)). A coarser chord tolerance for such shapes is not used.
- **Two-sided deviation check:** tests only (I1's oracle); production code keeps the in-fit estimate, which stayed ≤ 9.9 µm on every S5 case ([Arc fitting](#arc-fitting)).
- **WASM build** (Q26): vendored with its SHA-256, pinned crate source and a rebuild script; CI checks the checksum, no Rust toolchain ([Where the 2D layer runs](#where-the-2d-layer-runs)).

## Open questions

- Report the touching-island defect upstream with the spike fixture (ADR 0019 open question).
