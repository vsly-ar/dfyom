# Shapes: 2D layer, geometry and import

Status: accepted (v0.3; user decision D29 of 2026-11-22, [Decisions](#decisions-d29); follows [ADR 0019](../decisions/0019-2d-geometry-library.md), accepted); the [2D model, port and hosts](#implementation-k1) are implemented (task K1), the [shape model and `resolveShape`](#implementation-k2) (task K2) and [operations taking shapes](#implementation-k3) with placement and the geometry input mapping (task K3; solids G1, toolpaths T1/T2) and the [SVG import core](#implementation-i1-core) (task I1, without `design.shape.import`) · Design side: [design-v0.3.md](../modes/design-v0.3.md) · Toolpaths: [plan-v0.3.md](../modes/plan-v0.3.md) · Geometry base: [geometry.md](geometry.md) · Spike: [plans/v0.2.md § 7](../plans/v0.2.md#7-spike-for-v03), harness [`spikes/2d/`](../../spikes/2d/harness.ts) · Tasks: [plans/v0.3.md](../plans/v0.3.md) · Terms: [glossary.md](../glossary.md)

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
- **Epsilons:** CavalierContours' position ε 1e-5 mm and offset ε 1e-4 mm sit below the 0.01 mm [chord tolerance](geometry.md#evaluation-rules) (documented beside it). Elements shorter than 1e-4 mm are merged before the library sees them (`segmentTooShort` for user input).
- **Regression tests:** the spike's correctness fixtures (necks, tangent and near-tangent arcs, touching islands, 2000-segment star, SVG corpus) become port tests with the offset oracle ("every output point lies exactly |d| from the input").

### Implementation (K1)

Code in `src/core/geometry/2d/` (headless; the contract comments point here):

| File                                       | Holds                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model.ts`                                 | `Element` (`line`, `arc`; an arc with `a === b` exactly is a full circle), `Loop`, `Path`, `Region { pieces: { outer, holes }[] }`, the epsilons, areas, exact bounds                                                                                                                               |
| `port.ts`                                  | `Region2dPort`                                                                                                                                                                                                                                                                                      |
| `wire.ts`                                  | Input checks and the bulge wire format; errors `geometry.evaluation` with rule `notFinite`, `empty`, `notChained`, `arcInvalid` (centre not equidistant within 1e-5·max(1, r)), `degenerate`, `offsetInvalid` (non-finite offset, `offsetPath` with d ≤ 0), `resultInvalid`, `outOfRange`, `kernel` |
| `regions.ts`                               | Multi-loop booleans folded from loop booleans, `normalise`                                                                                                                                                                                                                                          |
| `measure.ts`                               | `length`, `pointAt`, `contains`, `distance` in pure TS on the analytic elements (exact winding numbers for arcs; no WASM call)                                                                                                                                                                      |
| `cavalier/binding.ts`, `cavalier/index.ts` | The C ABI binding and loaders; the port over it                                                                                                                                                                                                                                                     |
| `testing/`                                 | `node-wasm.ts` (module bytes for Node tests), the spike fixtures and SVG corpus, the offset and crossings oracles                                                                                                                                                                                   |

- **Region:** pieces of one counter-clockwise outer loop and its clockwise holes; an island inside a hole is a piece of its own. Outputs never cross and are re-validated (orientation, nesting); a violation is `resultInvalid`, never used.
- **`normalise(loops)`:** applies the loops by decreasing |area|: a counter-clockwise loop is united, a clockwise one subtracted (so a hole drawn inside an outer loop cuts it, and a loop drawn inside a hole is an island). Self-touching loops (the touching-island case) are split into lobes when each lobe keeps the loop's orientation and has ≥ 2 elements and an area > (1e-4 mm)².
- **Booleans of regions:** `A − S` = (A − outer) ∪ (A ∩ each hole of S); `A ∩ S` = (A ∩ outer) − holes; union folds the outer loops (holes subtracted afterwards; holes enclosed by the merged outer become islands); fast paths for disjoint bounding boxes and identical loops.
- **`offset(region, d)`:** positive shrinks; one call of the crate's shape offset with all loops, holes re-nested into the smallest containing outer. `d = 0` returns the input.
  - **Arcs offset past zero radius:** the crate (0.9.0) drops such an arc and relies on its neighbours' offsets crossing; where they cross beyond their ends, the loop is lost. It happens growing an eroded region by more than the radius of the concave arcs the erosion left round reflex corners (an opening's `offset(offset(r, R), −R − ε)`; T1). So a growth whose result does not contain a point of every input piece is redone in steps: by the smallest radius of an arc it would collapse (that arc becomes a corner; offsets compose exactly), repeated, then the rest. A last step under `OFFSET_EPSILON` is dropped (the crate fails on such small offsets of the cusps steps leave; the error stays below its epsilon). If the stepped result still loses a piece, the offset fails with `resultInvalid`. Shrinking is not checked (no case found; the hole-side mirror, a closing, works in one call). Within about 0.1 mm past an arc's radius the crate's own epsilons apply (oracle error up to 2 × `OFFSET_EPSILON`).
- **`offsetPath(path, d)`, d > 0:** the path doubled back on itself (a closed zero-area loop) is offset by `d` with self-intersect handling, giving the stroke outline with round ends; then normalised (a path that closes on itself leaves a hole).
- **C ABI** (`vendor/cavalier-contours/src/lib.rs`, `ABI_VERSION` 1, checked at load): `f64` buffers `[loopCount, per loop: flags, n, x, y, bulge …]` written straight into the module memory; exports `shape_offset`, `pline_offset`, `pline_boolean`. A trap (a Rust panic aborts) fails that call with rule `kernel` and the instance is replaced from the compiled module.
- **Build:** vendored per [ADR 0019 decision 6](../decisions/0019-2d-geometry-library.md#decision) (`npm run wasm:cavalier`, checksum test in `check`: [testing.md](../conventions/testing.md#commands)).

### Implementation (K2)

Code in `src/core/design/` (headless) plus one geometry helper; contract comments point here and to [design-v0.3.md](../modes/design-v0.3.md#shape-definition):

| File                       | Holds                                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shape.dto.ts`             | `ShapeDTO`, the item union generic in its quantity type (`ShapeItem<Q>`: DTOs, `Quantity`, `number`), the stored and the command-arg Zod schemas (args leave defaults out), limits (1000 items, 20 000 path segments) |
| `shape-items.ts`           | Items → chains of exact elements in the shape frame: primitives, paths (`arc`, `tangentArc`, closing line), fillets; per-item invariants                                                                              |
| `shape.ts`                 | `NamedShape` (loaded model), DTO mapping, `ShapeDefinition` (canonical numbers), `resolveDefinition`, the cached `resolveShape`, `shapeSummary` (resolved loops, area, bounds, smallest inside radius)                |
| `shape-users.ts`           | `operationsUsingShape`, `designChangeTargets` (which operations a pending key feeds; one place for Apply's tool choice, "chosen again" and the tool field)                                                            |
| `shape-commands.ts`        | `design.shape.*` commands and queries ([design-v0.3.md](../modes/design-v0.3.md#commands-and-queries-v03))                                                                                                            |
| `geometry/2d/crossings.ts` | `closedChainCrossing`: exact self-crossing test of a closed line/arc chain (sweep over bounding boxes; touching and tangency are not crossings, a stretch traced twice is)                                            |

- **Pure core, port passed in.** `resolveShape(port, definition)` takes the `Region2dPort` from `services.region2d`; without it shape commands fail with `internal.unexpected`. The definition is canonical numbers (mm, degrees), so tolerances and sources do not change the result or the cache key.
- **Steps.** Structure (`empty`, `firstItemAdd`, `openPathAlone`), then each item to a chain, collecting every issue; a closed chain is made counter-clockwise, checked for crossings, normalised alone; items fold with union / difference / intersect; a single item skips the final normalise; an empty result is `shapeEmpty`. Port errors are prefixed with the item's path.
- **Cache.** 128 entries LRU per port instance (`WeakMap`), keyed by the JSON of the definition; errors are cached too. Placement (step 4) has its own cache ([K3](#implementation-k3)).
- **Shapes load lazily.** `partFromDTO` loads only the shapes operations reference (`Part.shapes`, K3); the shape commands load and resolve the rest, so operation commands do not pay for unused shapes.
- **Performance** (`src/core/design/shape.perf.ts`, `npm run perf`, 2026-11-22): a 205-element shape (98-corner path with a 0.6 mm fillet at every vertex, a rectangle added, two islands) resolves in 0.86 ms uncached (the port's share ≈ 0.75 ms, [above](#performance)), 0.76 ms on a cache miss with the key, 14 µs on a hit; with one tool's checks (1.12 ms) **1.98 ms of the 3 ms budget**. A whole `design.shape.item.update` on that shape (parse, load, resolve, warnings, commit) takes 2.0 ms.

### Implementation (K3)

Operations take shapes ([design-v0.3.md § Operations that take a shape](../modes/design-v0.3.md#operations-that-take-a-shape)); contract comments point here.

| File                                 | Holds                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design/part.dto.ts`, `operation.ts` | The `named` shape kind (`shapeId`, `center`, `anchor`, `rotation`, `mirror`), `rotation` on rectangles, profile `side: 'on'`, `depth` (blind, `on` only), `tabs.positions`; `isGeneralShape` (named, or a rectangle with rotation ≠ 0); `shapesOf` and `Part.shapes` (referenced shapes only; a dangling `shapeId` is `input.malformed`, rule `unknownShape`) |
| `geometry/2d/place.ts`               | Mirror (x → −x) then counter-clockwise rotation (exact at multiples of 90°, no −0), translation; the **start point** of a loop (lowest `v`, then lowest `u`; an arc is split at its bottom) and `numberRegion` (each loop from its start point, holes and pieces by start point)                                                                              |
| `design/placement.ts`                | Step 4: `shapeDefinition` (a named shape's items; a rotated rectangle or circle as one item), `orientedShape` (cached), `placeShape` → outline relative to the **placed box** centre, its centre in the face frame and its size; `exactExtents` (re-anchoring); `shapeFacts` (open, loop count, loop length for validation)                                   |
| `design/geometry-input.ts`           | General shapes map to contours `region` / `path` (face frame, relative to `Shape.center` = placed box centre, numbered); a rectangle with rotation 0 and circles keep the v0.1 analytic contour, so v0.1/v0.2 inputs are byte-identical                                                                                                                       |
| `geometry/outline.ts`                | **The mapping G1, T1 and T2 consume:** `shapeOutline` (any contour as exact loops in the face frame), `pocketRegion` (the `generateRegionPocket` operation before the WCS turn), `profileChain`, `tabCentres` / `tabStretches`                                                                                                                                |
| `design/validate.ts`                 | Rules `floorRadiusShape`, `openNeedsOn`, `profileOneLoop`, `onlyOn`, `tabsNotAllowed`, `tabOutside`, `tabsOverlap`; `tabsFit` on the loop length                                                                                                                                                                                                              |

- **Placement.** The anchor point stays at `center`; rotation is about it; the anchor names a point of the bounding box of the oriented exact elements (arc extremes included). Re-anchoring a general shape uses that box rounded to 1e-9 mm (`exactExtents`), so the feature stays within 1 nm.
- **Cache.** `orientedShape` keeps 128 entries per port, keyed by (rotation, mirror, definition); the translation is applied per call (linear in the elements). Errors of a named shape are prefixed `shapes.<id>`.
- **Port threading.** The mappers take the port: `toGeometryInput(part, stock, port?)`, the evaluation scheduler (`region2d` option, from the app host), `partWarnings`, the tool choice, `toGeneratorInputs` / `ensureToolpath`. Without a port a general shape fails with `internal.unexpected` (a host bug).
- **Hashes.** The evaluation hash is the JSON of the geometry input, which holds the placed loops: a shape edit changes it. The toolpath `inputHash` hashes the plan's whole design part, shapes included.
- **Until G1, T1/T2, K4, T3.** Solids of general contours and of profiles `on` / with tab positions fail with `geometry.evaluation` (rule `shapeSolidLater`), so a part placing one has no evaluated model yet; generators refuse them with `plan.check` (rule `shapeToolpathLater`); parameter DFM checks skip general shapes (their width is `Infinity`); plan order and helix checks skip them. The renderer draws no outline for named or rotated shapes and edits only their placement.

## Where the 2D layer runs

| Host                         | Why                                                                                                                                                               | Loading                                                                                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dispatcher (commands)        | Resolving shapes, invariants and parameter DFM checks are synchronous in the command step ([design-v0.3.md § DFM](../modes/design-v0.3.md#dfm-checks-for-shapes)) | instantiated once at host start (`loadRegion2dSync`) from the file electron-vite copies next to the main chunks (`?asset`, `src/main/region2d/`); `services.region2d`. A failure stops the start (the file ships with the app)                                                   |
| `geometry`, `toolpath` lanes | Solids and toolpaths                                                                                                                                              | the host's bytes go in every worker's `init` (`region2dWasm`), prewarmed synchronously at init (≈ 1 ms) like `manifold.wasm`; tasks get the port from `TaskControl.region2d()`                                                                                                   |
| Renderer                     | Live outline, Shape Editor handles, snapping                                                                                                                      | **asynchronously** at window start (`loadRegion2d`, `src/renderer/src/geometry2d.ts`): Chromium refuses synchronous compiles over 4 KiB on the main thread. The module is inlined as a base64 data URL (no file:// fetch); the CSP allows compiling it with `'wasm-unsafe-eval'` |
| CLI and tests                | Same as the dispatcher                                                                                                                                            | the CLI as the app's dispatcher; tests `testing/node-wasm.ts`, CLI tests `DFYOM_TEST_REGION2D_WASM`                                                                                                                                                                              |

The module has no imports (ADR 0019), so one loader serves all hosts. The `.wasm` is vendored with its SHA-256, the pinned crate source and a rebuild script; CI checks the checksum and needs no Rust toolchain ([ADR 0019 decision 6](../decisions/0019-2d-geometry-library.md#decision), Q26, D29). Each host logs `2D geometry loaded` (info, with `ms`); the smoke e2e test checks the main, renderer and worker records in the built app.

## Resolving a shape

`resolveShape(definition) → AppResult<Region | Path>` (pure, in `src/core/design/shape.ts`):

1. Each item to loops in the shape frame: primitives analytically (exact arcs), paths by walking segments (`arc` from `to`, `radius`, `cw`, `large`; `tangentArc` from the previous element's end tangent), fillets as tangent arcs between neighbours.
2. Fold the items with their `op` through the port, `normalise` the result.
3. Validate: no crossings, area > ε (K2: the area rule replaces "every loop ≥ 3 elements or a circle", since a two-arc lens – the intersection of two circles – is a valid loop; normalise already drops lobes of < 2 elements).
4. Place: shape frame → face frame by the operation's anchor, rotation and mirror; anchors use the placed bounding box of the exact elements (arc extremes included).

Results are cached per (definition hash, placement): commands, the geometry mapper and the toolpath mapper call it many times per edit.

### Validity

- A closed `path` that crosses itself is refused (`shapeSelfIntersects`), not repaired: which side is "inside" is the user's intent. SVG import repairs instead and says so in the report (`fill-rule` decides).
- Shape quantities are formulas over **stock faces only** (`stock.side[1].x - 10`), not over operation surfaces: shapes are resolved before and independently of operations, so a shape can never depend on an operation that places it (K2).
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

`src/core/import/svg/`, pure and headless: an XML tokenizer of the SVG subset (no DOM, no dependency; `src/core` stays headless), transforms flattened into the element coordinates, units from `width`/`height`/`viewBox`, `fill-rule` to booleans, [arc fitting](#arc-fitting), the [import report](../modes/design-v0.3.md#svg-import) as data. Limits (refused with `input.malformed`, rule `svgLimit`): 10 MB file (UTF-8 bytes), 20 000 elements after fitting (refused before fitting already when the source has more segments), element nesting 256. The spike corpus (`spikes/2d/corpus/`, copied to `__fixtures__/`) and the exit drawing seed the tests.

### Implementation (I1 core)

The seam for `design.shape.import` (K2): the command reads the file in the prepared input, calls

```ts
importSvg(text: string, options?: { unit?: SvgUnit; split?: SvgSplit }): AppResult<SvgImport>
// SvgImport = { shapes: SvgShape[], report: SvgImportReport }
// SvgShape  = { name, source: { element }, items: ({ kind: 'loop', op: 'add' | 'subtract', loop } | { kind: 'path', path })[] }
```

and turns each `SvgShape` into a shape definition (`path` items from the [2D model](#2d-model) elements; `source: { file, element }`). Loops come by decreasing |area|, outer loops counter-clockwise, holes clockwise, never crossing, so folding them in order by `op` gives the filled area; a shape with an open path has exactly that one item. Elements are chained exactly (shared end points), arcs ≤ 180°, none shorter than `MIN_ELEMENT_LENGTH`, so they pass the 2D port's checks unchanged.

| File           | Holds                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xml.ts`       | Tokenizer: elements, quoted attributes, predefined and DOCTYPE entities (Illustrator's `&ns_svg;`), comments, CDATA; `svgSyntax` with the line, `svgLimit` for nesting |
| `path-data.ts` | Path data (SVG 2 grammar, compact numbers and arc flags) → subpaths of lines, cubics (quadratics elevated) and elliptical arcs in an affine-closed form                |
| `transform.ts` | The `transform` attribute and composition                                                                                                                              |
| `units.ts`     | Lengths, the root viewport and `preserveAspectRatio` → the user unit → shape frame matrix                                                                              |
| `curves.ts`    | Segments as parametric curves with cusps and break points; ellipses canonicalised by a 2×2 SVD (circular → exact arc)                                                  |
| `fit.ts`       | Biarc fitting, approach B (ported from `spikes/biarc/fit.ts`)                                                                                                          |
| `chain.ts`     | One subpath → one chain: fitted, joined exactly, closed when its ends meet, short elements merged                                                                      |
| `intersect.ts` | Line/arc intersections and overlaps                                                                                                                                    |
| `fill.ts`      | Fill classification and repair (below)                                                                                                                                 |
| `import.ts`    | Element walk, styles, basic shapes, grouping, report, limits, `importSvg`                                                                                              |
| `testing/`     | S5's independent oracle (two-sided deviation, kinks) for the tests                                                                                                     |

Rules:

- **Shape frame:** mm, x right, y up; the origin is the bottom-left corner of the viewport (SVG's y runs down), or y is mirrored about 0 when the file has no height. The root map and every `transform` (matrices, skew and reflections included) are applied to the segments **before** fitting, so the 0.01 mm holds in mm on the part; an ellipse stays an ellipse under any affine map, and a circle that stays a circle stays exact.
- **Units:** absolute `width`/`height` units (`mm`, `cm`, `in`, `pt`, `pc`, `Q`) give the size; bare numbers and `px` take the `unit` option (`px96` default, `px72`, `mm`, `in`) and the report says the unit was assumed. A missing width or height follows the `viewBox` aspect; no size at all makes the `viewBox` user units the option's unit. Lengths inside the drawing may carry units (96 user units per inch, as CSS).
- **Elements:** `path`, `rect` (rounded corners as quarter ellipses; circular when `rx = ry`), `circle`, `ellipse`, `line`, `polyline`, `polygon`; `g`, `a` and `switch` (its first child) group. Text, images, `use`, nested `svg` and unknown elements are counted as skipped; definitions (`defs`, `symbol`, gradients, clip paths, markers, …) and other namespaces (editor metadata) are ignored silently; `display: none` and `visibility: hidden` elements are skipped as `hidden`. `clip-path`, `mask` and `<style>` sheets are ignored with a warning (the geometry comes in unclipped; only `style` attributes and presentation attributes are read).
- **Recoverable input** follows SVG's error handling and warns: path data is imported up to its first error (`pathData`), a shape with an invalid attribute is skipped (`attributeInvalid`), a malformed `transform` is ignored (`transformInvalid`). Malformed XML, a non-`svg` root (`svgNotSvg`), a bad `viewBox` or size (`svgViewport`) and a drawing with nothing to import (`svgEmpty`) are errors. The importer never throws (a fuzz test truncates and garbles files).
- **Fill:** `fill` colours, `fill="none"` and strokes are ignored: every closed subpath is an area, its element's `fill-rule` (attribute, `style` or inherited) decides which areas are holes, and the elements of one shape combine **even-odd** (a loop drawn as its own element inside another becomes a hole, as CAM drawings mark holes). A loop with the same fill on both sides is dropped. Loops that cross, touch inside an element or overlap (self-intersections included) are **repaired**: split at their intersections, the edges between filled and unfilled kept and chained again with the filled side on the left (taking the sharpest left turn at a vertex, so pieces touching at a point stay separate). Counted as `loopsRepaired` with a warning.
- **Subpaths:** a closed subpath (`Z`, or ends within the 0.01 mm chord tolerance: `gapsClosed`) is a loop, else an open path. Open paths are shapes of their own, named "‹name› path n".
- **Grouping** (`split`): `element` (default) one shape per top-level element (a top-level group with everything in it), `file` one shape, `loop` one shape per outer loop with the holes directly inside it. Names: `inkscape:label`, else `id`, else "Path 2", "Group 3"; `source.element` is `#id`, else `tag[n]`.
- **Report** (`SvgImportReport`): viewport size, bounds, unit and whether assumed, elements imported and skipped by tag, Béziers and elliptical arcs fitted, max deviation (in-fit estimate), corners kept at cusps, micro corners and tiny segments merged, loops repaired and dropped, gaps closed, loop / open path / line / arc counts, warnings (`rule`, message, element).

Measured: the exit drawing imports as its two shapes with 156 arcs and 3 lines, max deviation 0.0093 mm (in-fit estimate; the oracle agrees within 0.01 mm both ways), every S5 corpus case gives S5's element counts.

## Performance

Budgets on the Apple M1 Pro class reference, measured by `npm run perf`:

| Measure                                                           | Budget   | Spike evidence (ADR 0019)                |
| ----------------------------------------------------------------- | -------- | ---------------------------------------- |
| Resolve + parameter checks of a 200-element shape, in the command | ≤ 3 ms   | one offset 0.14 ms, union 0.26 ms (WASM) |
| Part evaluation with three shape operations (500 elements total)  | ≤ 50 ms  | S3: 40 ms                                |
| Pocket toolpath of the spike's star (200 + 2 islands)             | ≤ 500 ms | 20 rings 1.1 ms                          |

The port's share, measured by `src/core/geometry/2d/region2d.perf.ts` (K1, 2026-11-22): sync load 1.7 ms; a 206-element shape folded from items and normalised 0.75 ms plus one tool's checks (offset, opening, difference) 1.2 ms – together ≈ 2 ms of the 3 ms budget, the rest is left for `resolveShape` ([K2](#implementation-k2): resolve 0.86 ms + checks 1.12 ms = 1.98 ms); the star's 15 pocket rings 1.5 ms; a union with a 2000-element star 12.5 ms. The whole pocket toolpath of the star (T1, `src/core/toolpath/region-pocket.perf.ts`, 4 levels and finishing): ≈ 9 ms.

SVG import (`src/core/import/svg/svg.perf.ts`, I1, 2026-11-22, Node, loaded machine): 2000 random G1 cubics in one path → 14 144 elements in ≈ 200–300 ms (fitting ≈ 40 µs per cubic as S5, the rest the fill check of the 14 k-element loop); a 9.8 MB file of 2400 rounded rectangles (19 200 elements, at the limit) ≈ 0.5 s; 60 overlapping circles repaired into 2 loops ≈ 11 ms. Import runs once per command in the prepared input, so no budget row; the perf test guards 0.5 / 1.5 / 0.5 s.

Evaluation cost follows **chords** (flattened segments at the chord tolerance), not elements: with [tiles](#geometry-for-shape-operations), ≈ 16 µs per chord (triangulate ≈ 3.6, `fromMesh` ≈ 3.2, booleans ≈ 8), so the 50 ms budget holds ≈ 3 000 chords per evaluation ([S3](../../spikes/prisms/results.md#cost-median-of-15-part-placement)). Single 500-element pockets take 15–39 ms; 2000-element shapes (5 000–7 000 chords) take 47–115 ms tiled (82–169 ms untiled) and do not fit: they run under a documented limit ([Decisions](#decisions-d29)).

## Decisions (D29)

Settled with the user when this doc was accepted (D29, 2026-11-22, the recommendations taken):

- **Shapes over the chord budget** (2000 elements: 47–115 ms, [Performance](#performance)): a documented limit, no hard refusal – each subtraction stays one evaluation step (≤ ≈ 60 ms, abortable between steps) – plus the DFM info note `dfm.shapeHeavy` when a shape operation's chords exceed the budget ([design-v0.3.md § DFM checks](../modes/design-v0.3.md#dfm-checks-for-shapes)). A coarser chord tolerance for such shapes is not used.
- **Two-sided deviation check:** tests only (I1's oracle); production code keeps the in-fit estimate, which stayed ≤ 9.9 µm on every S5 case ([Arc fitting](#arc-fitting)).
- **WASM build** (Q26): vendored with its SHA-256, pinned crate source and a rebuild script; CI checks the checksum, no Rust toolchain ([Where the 2D layer runs](#where-the-2d-layer-runs)).

## Open questions

- Report the touching-island defect upstream with the spike fixture (ADR 0019 open question).
