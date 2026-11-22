# Shapes: 2D layer, geometry and import

Status: draft (v0.3; follows [ADR 0019](../decisions/0019-2d-geometry-library.md), proposed) · Design side: [design-v0.3.md](../modes/design-v0.3.md) · Toolpaths: [plan-v0.3.md](../modes/plan-v0.3.md) · Geometry base: [geometry.md](geometry.md) · Spike: [plans/v0.2.md § 7](../plans/v0.2.md#7-spike-for-v03), harness [`spikes/2d/`](../../spikes/2d/harness.ts) · Tasks: [plans/v0.3.md](../plans/v0.3.md) · Terms: [glossary.md](../glossary.md)

What `src/core` needs so shapes of lines and arcs flow through geometry, DFM and toolpaths. It extends the [layers](geometry.md#layers) of geometry.md: the "2D" row becomes CavalierContours behind a port; the analytic model stays the source of truth ([ADR 0007](../decisions/0007-layered-geometry-without-brep-kernel.md) holds: still 2.5D per direction).

## 2D model

- **Element:** `line { a, b }` or `arc { a, b, centre, ccw }` in float64 mm (the analytic form); CavalierContours' **bulge** form (`tan(sweep / 4)` per vertex) is the port's wire format only.
- **Loop:** a closed chain of elements; **Path:** an open chain. **Region:** loops that never cross, outer loops counter-clockwise, holes clockwise (the spike's convention: a positive offset shrinks).
- `src/core/geometry/contour.ts` keeps its analytic rounded rectangles and circles; they convert to loops (exact arcs) for everything general, so v0.1/v0.2 outputs stay byte-identical where nothing changed (golden files).

## 2D port

`Region2dPort` in `src/core/geometry/2d/` (like `SolidPort`), implemented over the CavalierContours WASM with our thin C ABI ([ADR 0019 decision 2](../decisions/0019-2d-geometry-library.md#decision-proposed)):

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

The module has no imports (ADR 0019), so one loader serves all hosts. How the `.wasm` is built (CI toolchain or vendored with a checksum) is decided when ADR 0019 is accepted ([plans/v0.3.md](../plans/v0.3.md#decisions-to-settle-first)).

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

- **Labelled prisms:** walls are bands per flattened element, labelled `wall[i]` / `corner[i]` by element (lines / arcs, [Surfaces](../modes/design-v0.3.md#surfaces)); caps are triangulated with holes (Manifold's `triangulate` on the flattened loops, so no new dependency) and labelled `floor` / `air`. The v0.1 offset-loft stays for rectangles and circles with floor fillets.
- **Flattening** as today: removals inscribed, the kept-side prism circumscribed, per element, at the 0.01 mm chord tolerance.
- **Tabs:** the offset band of [Offset-loft](geometry.md#offset-loft) is defined by "points whose nearest shape point lies on the tab's stretch"; for general loops it is built from the stretch's elements offset to `outer` and `inner` with end faces along the loop normal, bent on the medial axis by the same rule. The tab stretch comes from `pointAt` with the design's positions.
- **Slivers:** general shapes make wall positions non-dyadic everywhere, so the v0.2 backlog issue "walls of two directions differ by float32 rounding" ([plans/v0.2.md](../plans/v0.2.md#known-issues-and-risks)) matters more; task G2 measures it and, if needed, moves wall placement into float64 like the key levels.

## Parameter checks for shapes

`parameterChecks` gains the region per shape operation ([design-v0.3.md § DFM checks for shapes](../modes/design-v0.3.md#dfm-checks-for-shapes)):

- **Inside corners of the cut:** walk the loops of the material side: a vertex with a turn into the material and no arc, or an arc of that sense with radius < the tool radius (+ `TOOL_MATCH_TOLERANCE`).
- **Width:** `offset(region, R)` empty → no tool of radius R fits.
- **Rest material:** `region − offset(offset(region, R), −R)` (a morphological opening) minus the corner zones; pieces above 0.5 × R² area are reported.
- Cost per check is a few offsets (sub-ms at the spike's sizes); the auto tool choice runs them per candidate tool on Apply only.

## Arc fitting

SVG Béziers and elliptical arcs become **biarcs** (two tangent arcs per piece, tangent-continuous with their neighbours), subdivided until every point is within 0.01 mm (the chord tolerance). The spike's 3-point arcs are not tangent-continuous and are not used. Lines stay lines; circular arcs stay exact; arcs whose radius exceeds 10 m become lines. Fitting runs in the dispatcher's prepared input (import), never on render.

## SVG import

`src/core/import/svg.ts`, pure: an XML tokenizer of the SVG subset (no DOM; `src/core` stays headless), transforms flattened into the element coordinates, units from `width`/`height`/`viewBox`, `fill-rule` to booleans, the [import report](../modes/design-v0.3.md#svg-import) as data. Limits (refused with `input.malformed`, rule `svgLimit`): 10 MB file, 20 000 elements after fitting. The spike corpus (`spikes/2d/corpus/`) seeds the tests.

## Performance

Budgets on the Apple M1 Pro class reference, measured by `npm run perf`:

| Measure                                                           | Budget   | Spike evidence (ADR 0019)                |
| ----------------------------------------------------------------- | -------- | ---------------------------------------- |
| Resolve + parameter checks of a 200-element shape, in the command | ≤ 3 ms   | one offset 0.14 ms, union 0.26 ms (WASM) |
| Part evaluation with three shape operations (500 elements total)  | ≤ 50 ms  | –                                        |
| Pocket toolpath of the spike's star (200 + 2 islands)             | ≤ 500 ms | 20 rings 1.1 ms                          |

## Open questions

- Does Manifold's `triangulate` keep up with 2000-element caps within the evaluation budget, or do caps need their own fan of the region's rings? (spike S3, [plans/v0.3.md](../plans/v0.3.md#risks-and-spikes))
- Report the touching-island defect upstream with the spike fixture (ADR 0019 open question).
