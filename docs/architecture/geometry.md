# Geometry

Status: accepted · Decision: [ADR 0007](../decisions/0007-layered-geometry-without-brep-kernel.md) · Operations: [design.md](../modes/design.md#operations-v01) · Values: [quantities.md](quantities.md) · Terms: [glossary.md](../glossary.md)

[2.5D evaluation (v0.1)](#25d-evaluation-v01) specifies tasks 2.6–2.8 of the [v0.1 plan](../plans/v0.1.md); 2.6 and 2.7 are implemented in [`src/core/geometry/`](../../src/core/geometry/), the [evaluation checks](#evaluation-checks) (2.8) are not yet. The [Carving (later)](#carving-later) sections are still draft and must not be implemented yet.

## Principle: geometry comes from material removal

DFYOM does not model free-form solids. A part is **stock minus the material its cutting operations remove**:

```text
part = stock − ∪ ( removal(op) − retained(op) )
```

The design model is **analytic**: operations produce exact primitives (lines, arcs, planes, cylinders, cones, fillet surfaces) from their [quantities](quantities.md). Libraries (below) only evaluate this model; they are never the source of truth.

## Cutting-operation framework

Every cutting operation is defined by the same three parts:

| Part                 | Meaning                                                                                 | Examples                                         |
| -------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Removal region**   | What the operation would remove on its own.                                             | Pocket boundary + depth; profile path + depth.   |
| **Retained regions** | Modifiers: zones inside the removal region the operation deliberately leaves standing.  | Tabs (profile), fillets (pocket), …              |
| **Surfaces**         | Labeled surfaces the operation creates, including the surfaces of its retained regions. | Pocket floor and walls; tab top; fillet surface. |

"Retained region" is a DFYOM term for the shared mechanism, not an industry term; the user-facing names stay industry-standard (tab, fillet).

### Fillets as retained regions

| Fillet                          | Where                        | Made by (alternatives, as [generalized tool](../modes/design.md#generalized-tools) requirements)       |
| ------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| Inside corner radius            | Vertical corners of a pocket | Any end mill with radius ≤ fillet radius (a radius below the tool radius is impossible – DFM warning). |
| Floor fillet (bottom radius)    | Floor-to-wall edge           | Bull-nose end mill with matching corner radius (one pass), or ball end mill 3D passes.                 |
| Round-over (convex edge fillet) | Top edges                    | Round-over bit (one pass), or ball end mill 3D passes.                                                 |

The fillet becomes a retained region of the operation, and plan mode chooses how to machine it.

### Surfaces and stable ids

A surface id is derived from the operation and the surface's role, e.g. `pocket1.floor`, `pocket1.wall[2]`, `profile1.tab[0].top`. Ids do not depend on computed topology, so references in [expressions](quantities.md#expressions-and-references) survive edits. This avoids the topological naming problem of B-rep CAD. Each surface carries a tolerance (own or inherited). Mesh mapping: [Surface ids in meshes](#surface-ids-in-meshes).

## 2.5D evaluation (v0.1)

**Scope.** v0.1 contours are axis-aligned rounded rectangles and circles ([design.md](../modes/design.md#positioning-v01)), so every contour, offset, fillet ring and tab outline is computed **analytically** (exact arcs, flattened only when meshing) – as for toolpaths ([plan-v0.1.md](../modes/plan-v0.1.md#toolpath-generation-job)). v0.1 needs **no 2D library**: `clipper2-ts` and `CrossSection` enter with general shapes ([Layers](#layers)). The only geometry dependency is `manifold-3d` (exact version pinned, Apache-2.0).

### Modules (`src/core/geometry/`)

| File                    | Contents                                                                                                                                                                                                                                                      | Task               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `model.ts`              | `PartGeometryInput` (stock size + operations resolved to float64 mm and degrees; `on` resolved to `onZ`), `Contour`, `Level`, `SurfaceId`, constants ([precision](#evaluation-rules))                                                                         | 2.6                |
| `contour.ts`, `loft.ts` | Analytic offset, exact elements (lines, arcs) and flattening of rounded rectangles and circles (**one** implementation, shared with toolpaths); loft: `offsetLoft`, `offsetBand` → `LabelledMesh` (plain typed arrays, local frame)                           | 2.6 (contour), 2.7 |
| `operations.ts`         | Per operation: removal, cut (kept side of a profile slot) and retained `LabelledMesh`es plus its surface table; the stock box                                                                                                                                 | 2.7                |
| `solid-port.ts`         | `SolidPort`: `reserveOriginalId`, `fromMesh`, `union` (batch), `subtract`, `intersect`, `translate`, `status`, `decompose`, `volume`, `toMesh`; opaque `Solid`; `SolidKernel` (`withSolids`, `liveObjects`, `heapBytes`)                                      | 2.6                |
| `manifold/`             | `loadManifold(source)` → `SolidKernel` on `manifold-3d` with the arena; the **only** code importing `manifold-3d` or calling `.delete()`                                                                                                                      | 2.6                |
| `evaluate.ts`           | `evaluatePart(input, solids) → AppResult<PartEvaluation>`: build, compose, map surfaces, the two error checks (`status`, `airSurface`); warnings in `checks.ts` (2.8); `testing/`: [test part](#testing), analytic and mesh oracles, test-only Node wasm host | 2.7 (checks: 2.8)  |
| `evaluate.perf.ts`      | [Performance budgets](#performance-budgets-v01), run by `npm run perf` (not part of `npm run check`)                                                                                                                                                          | 2.7                |

### Building the solids

Every solid is an offset-loft or offset band, **labelled at construction** – no unlabelled library primitives. `ov` = overshoot, `top` = 0 (stock top), `zf` = `on.z − depth`; `on.z` comes from the analytic model, never from a mesh. The stock is a labelled box `0..L × 0..W × −T..0`.

| Operation | Removal (levels as offset, z; offset > 0 = inward)                                                           | Retained                      |
| --------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Facing    | Rectangle `−ov..L+ov × −ov..W+ov`: (0, ov) → (0, −depth)                                                     | –                             |
| Pocket    | Shape: (0, ov) → (0, zf + f) → fillet levels → (f, zf); `f` = `floorRadius`                                  | Floor fillet, inside the loft |
| Drilling  | Circle: (0, ov) → (0, zf) → `through`: (0, −T − ov) · `flat`: cap · `drillPoint`: (r, zf − r / tan(angle/2)) | –                             |
| Profile   | Slot = outer prism − inner prism (both `−T − ov..ov`; the subtracted prism overshoots `2·ov`)                | Tabs: offset bands            |

Composition: one batch `union` of all `removal − retained`, then `stock − union`. A profile's removal is itself `outer prism − inner prism` (the "cut": the prism on the kept side, built circumscribed – see [evaluation rules](#evaluation-rules)). An `inside` profile whose slot covers the whole opening (`slotWidth` ≥ half its narrowest size) has no inner prism and no tabs (nothing to hold). A fillet is built into its loft (the loft _is_ removal − retained); tabs are separate solids subtracted from their slot. Each mesh is built in a local frame centered on its contour and translated in Manifold (float64), per the [evaluation rules](#evaluation-rules).

### Offset-loft

A 2.5D removal is a **closed contour** plus a **profile** of (offset, z) levels; floor fillets and the drill point are profiles (chamfers and round-overs later).

- Each level is the contour offset by `offset`, flattened with **one parameterization for all levels**, so rings correspond segment by segment. Bands between rings are ruled quads; caps are fans (all v0.1 rings are convex). An arc whose offset radius is ≤ ε becomes one vertex and its band a fan; zero-length segments (≤ ε) are dropped; a ring collapsed to a point (drill tip) closes with a fan.
- Floor fillet levels: φₖ = k·π/(2n), offset = f(1 − cos φₖ), z = zf + f(1 − sin φₖ), n from the [chord tolerance](#evaluation-rules). `pointAngle` 180° is a flat bottom.
- Labels: straight-segment bands → `wall[i]`, arc bands → `corner[i]`, fillet bands → `floorFillet`, bottom cap → `floor`/`bottom`, overshoot faces → `air`.
- **Validity:** every contour radius ≥ the largest offset (the bull-nose tool limit, so it doubles as a DFM rule). design.md constraints (`floorRadius ≤ cornerRadius`, ≤ diameter/2) guarantee it in v0.1; a violation is a bug → `geometry.evaluation` (rule `loftInvalid`), never a silent fallback.
- **Offset band (tabs):** the open sub-path of the shape covering the tab (width measured along the shape, positions as in [design.md](../modes/design.md#profile-with-tabs); arc length runs counter-clockwise from the start of `wall[0]`, and on a circle the first tab is at the front, −Y), offset across the slot plus `ov` on both sides (on the shape side at most half the shape's inradius, so tiny shapes stay valid), from `−T − 2·ov` up to the tab top. Labels: top cap `tab[i].top`; end faces, normal to the shape, `tab[i].end[0|1]` in contour direction (counter-clockwise from above); all other faces `air` (outside the slot, so they never survive).
- **Minkowski fallback** (inset prism ⊕ ball, measured 7 ms on the convex spike pocket): for contours that fail the validity rule. Deferred to free-form shapes ([open questions](#later)); no v0.1 operation reaches it, so `loftInvalid` fails loudly instead.

### Surface ids in meshes

- Each operation (and the stock) gets one original id per evaluation (`Manifold.reserveIDs`, via `SolidPort.reserveOriginalId`); all its meshes share it, and `faceID` is the index into that operation's surface table. Index 0 is `air`; profiles add `offcut` (slot side away from the shape: may survive, not referenceable; listed in `PartEvaluation.surfaces` as e.g. `profile1.offcut`). Surfaces of zero size are left out (`corner[i]` when `cornerRadius` = 0; `wall[i]` of zero length when `cornerRadius` is half the size).
- After booleans every output triangle maps through (`runOriginalID`, `faceID`) to a surface; always key by both.

| Surface ids ([design.md](../modes/design.md#operations-v01)) | Built from                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `stock.top`, `.bottom`, `.side[0..3]`; `facing1.floor`       | Stock box (side 0 = front at y = 0, then counter-clockwise); facing bottom cap |
| `pocket1.floor`, `.wall[i]`, `.corner[i]`, `.floorFillet`    | Pocket loft: bottom cap, straight bands, arc bands, fillet bands               |
| `drill1.wall`, `drill1.bottom`                               | Drill loft: side bands; flat cap or point cone                                 |
| `profile1.wall[i]`, `.corner[i]`                             | Shape-side prism (inner for `outside`, outer for `inside`)                     |
| `profile1.tab[i].top`, `.tab[i].end[0\|1]`                   | Tab band top cap and end faces                                                 |

### Evaluation rules

- Input is **canonical float64 mm** ([quantities.md](quantities.md#value)); the design layer resolves quantities and expressions before evaluation, so geometry never sees `Quantity` objects or tolerances.
- **Chord tolerance** (maximum sagitta) is 0.01 mm for every arc and fillet step in v0.1: segments per arc n = ⌈θ / (2·acos(1 − t/r))⌉ ≥ 1, so meshes always keep slightly more material – the safe direction: removals are flattened **inscribed** (vertices on the arc); solids subtracted from a removal (the kept-side prism of a profile slot) **circumscribed** (edges tangent to the arc – inscribed there would widen the slot). Meshes serve preview and checks only – toolpaths are analytic – so surface tolerances do not tighten it (later: simulation and carving derive it from the surface tolerance).
- Constants in `model.ts`: ε = 1e-6 mm (coincidence, collapse, zero length); `ov` = 1 mm; ε_V = 1e-3 mm³ (smallest volume that counts as a piece or an overlap).
- Removals **overshoot** the stock and **overlap** each other; they never just touch (face-touching solids stay separate shells, and shared boundaries leave slivers). A subtracted solid overshoots further than the one it cuts; retained regions overshoot their removal on every unlabelled side.
- Build labelled meshes near the origin and translate afterwards (JS mesh I/O is float32). Meshes are derived data; never read dimensions back from them.
- Tolerate degenerate triangles in output meshes. Coincident faces of user geometry (e.g. two pockets sharing a wall plane) may leave slivers; pieces ≤ ε_V are ignored.
- WASM objects are freed through one ownership helper ([arena per evaluation](#wasm-lifetime-and-ownership)).

### Evaluation checks

| Check                                                                    | Result                                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `status()` ≠ `NoError`                                                   | Error `geometry.evaluation` (new code, task 2.6); issue names the status                                    |
| A triangle labelled `air` or with an unknown (original id, face id)      | Error `geometry.evaluation`, rule `airSurface` (a bug)                                                      |
| `decompose()` yields more than one piece of volume > ε_V                 | Warning `loosePiece` per piece except the largest; names the operations whose surfaces bound it (`tabs`)    |
| Nominal retained region (without overshoot) ∩ another op's removal > ε_V | Warning `retainedRemoved` naming both operations ([design.md](../modes/design.md#ordering-and-composition)) |
| A surface referenced by `on` or an expression has no triangles           | Warning `surfaceMissing` naming the referencing operation and parameter                                     |

Checks run in the worker after composition, in table order. Warnings follow [design.md DFM checks](../modes/design.md#dfm-checks) (operation, parameter, message, suggestion), are derived on every evaluation and never stored. Constraint and tool checks stay synchronous in the commands.

### Worker and renderer

- `evaluatePart` is a pure worker task run through the `WorkerPort` (host per [ADR 0008](../decisions/0008-threading-split-by-job.md), task 2.9). One evaluation per document revision serves UI, MCP and CLI; a newer revision aborts a running one (`op.aborted`). Results are derived data like toolpaths: cached by a hash of `PartGeometryInput`, not in `ProjectDoc`, not persisted. `design.warning.list` reads the last finished evaluation.
- `PartEvaluation`: `positions` (Float32Array, part frame, mm, vertices split at surface boundaries), `indices` (Uint32Array), `triangleSurface` (Uint32Array, index into `surfaces`), `surfaces` (`SurfaceId[]`, only those with triangles), `volume`, `pieces` and `warnings` (task 2.8), `stats` (ms, triangles). Typed-array buffers are **transferred**, not copied.
- Renderer ([ADR 0010](../decisions/0010-react-three-fiber-viewport.md)): one `BufferGeometry` per evaluation, normals per surface (flat planes, smooth fillets); picking maps the raycast `faceIndex` through `triangleSurface` to a surface id; highlighting by surface; replaced geometries are disposed. The viewport never computes geometry.

### WASM lifetime and ownership

- One `manifold-3d` module per worker, initialized lazily on the first task (6–8 ms). The worker host passes the WASM in through `loadManifold(source)`: `wasmBinary` (bytes; also makes the heap size measurable) or `locateFile` (URL in a bundled web worker); with neither, the package's own lookup is used (works in Node). `src/core` needs no `fs`/`fetch`; tests read the binary through `process.getBuiltinModule` in `testing/node-wasm.ts`.
- `withSolids(fn)` opens an **arena** for one evaluation and hands `fn` a `SolidPort`; every WASM object it creates is registered there and deleted on exit (success, error or abort). Results are copied into plain typed arrays before the arena closes; no WASM object outlives an evaluation or crosses a worker boundary. Manifold exceptions are wrapped with `tryCatch` inside `manifold/` into `geometry.evaluation` ([error handling](../conventions/error-handling/README.md)); a `Solid` used outside its arena is `internal.unexpected` (a bug). `liveObjects()` counts unfreed objects (0 between evaluations; asserted in tests). Abort between steps arrives with the worker (task 2.9). Memory: a soak run of 1 000 evaluations shows the WASM heap plateau (measured: 16 MB after warm-up, no growth), so hosts need not recycle workers.

### Performance budgets (v0.1)

Reference: Apple M1 Pro class, [test part](#testing), chord tolerance 0.01 mm. Measured by a benchmark script outside `npm run check` (timings are flaky in CI); CI asserts only the triangle budget and the heap plateau.

| Measure                                 | Budget                | Spike             | Task 2.7 (no checks yet)        |
| --------------------------------------- | --------------------- | ----------------- | ------------------------------- |
| Warm evaluation incl. checks            | ≤ 50 ms               | 20 ms (no checks) | 16.3 ms median, 16.7 ms p95     |
| Cold: WASM init + first evaluation      | ≤ 150 ms              | 55 ms             | 52 ms (init 7 ms)               |
| Output triangles                        | ≤ 20 000              | 2 444             | 2 328                           |
| WASM heap growth over 1 000 evaluations | ≤ 10 MB after warm-up | unmeasured        | 0 MB (16 MB heap after warm-up) |

Measured with `npm run perf` (Node, Apple M1 Pro class). In `npm run check`, tests assert the triangle budget, `liveObjects()` = 0 and the heap plateau over 35 evaluations.

### Testing

- **Test part** (fixture `testing/test-part.ts`, also evaluated with `cornerRadius` 3; fixes the spike's invalid part): stock 100 × 60 × 20; facing 0.5; pocket 40 × 25 × 8 centered, `cornerRadius` 4, `floorRadius` 2; 4 drills Ø6 on a centered 70 × 30 pattern (`through`, `flat`, 2 × `drillPoint` 118°, depth 12); profile `outside` 84 × 44 R5 centered, `slotWidth` 6, 4 tabs 8 × 3 (stock margin 8 ≥ slot width). Expected: `NoError`, one piece, no geometry warnings, every design.md surface id present (except `stock.top`, which the facing removes), mesh volume between analytic and analytic + 0.05 % (measured +0.027 %). Variants: `tabs.count` 0 → `loosePiece`; a pocket over a tab → `retainedRemoved`; `side` `inside`.
- **Oracles:** every triangle's centroid lies on its labelled analytic surface within the chord tolerance (2.7 checks planes, pocket walls, a corner cylinder, tab tops and ends; fillet and cone surfaces are covered by volume only); every primitive is closed with `status()` `NoError` and its volume matches its formula (closed forms in `testing/analytic.ts`, Pappus for fillets).
- **Edge cases:** `floorRadius` = `cornerRadius` (collapsed corner), `cornerRadius` = 0 and = min(length, width)/2, `floorRadius` = `depth`, `pointAngle` 180°, inside profile whose slot covers the opening; seeded random valid parameters per operation → `NoError`, no `air` triangle.
- Geometry tests run in Node against the real `manifold-3d`; other modules may use a fake `SolidPort`.

## Carving (later)

### Carving and engraving (vector-based)

The source of every carving and engraving is **vectors**: SVG/DXF or drawn paths (lines, arcs, Bézier curves). Raster images are **traced to vectors on import**; the design model never contains pixels.

Each operation takes a group of vector shapes plus a **profile** that turns them into removal geometry:

| Operation             | Defined by                                                                                                                    | Result                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Engraving (on-line)   | Open or closed paths + depth                                                                                                  | Groove along the path in the tool's shape.                               |
| Flat-bottom engraving | Closed shapes + depth                                                                                                         | A pocket ([framework](#cutting-operation-framework) applies unchanged).  |
| V-carving             | Closed shapes + V-bit angle (+ optional flat-bottom depth)                                                                    | Depth follows the shape's local width, derived from its **medial axis**. |
| Vector relief         | Closed shapes + profile: dome/round, angled, flat, sweep along one or two rails, revolve; shapes combine (add, subtract, max) | Smooth 3D surface.                                                       |

A carving **feature** (e.g. a sign: V-carved text + dome-relief border + flat-bottom background) is a group of such operations.

For 3-axis work the result is still a surface `z = f(x, y)`, but it is **evaluated analytically from the vectors** at any resolution. It is not stored as a pixel grid. Sampling (grids, meshes) happens only during plan-mode evaluation, at a resolution derived from the surface tolerance.

- Plan mode expands each operation into **passes**: roughing (Z-level), then finishing (raster/spiral following Z, or V-carve paths along the medial axis).
- **Stepover** is derived from the surface tolerance via **scallop height**, so the user specifies quality and the planner chooses the stepover.
- Optimization works on passes, the same as for all other operations, so carving needs no special case.

## Layers

| Layer           | Implementation                                                                                                                                                     | Used for                                                                    | v0.1                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------- |
| Analytic model  | Own, in `src/core`                                                                                                                                                 | Source of truth: operations, surfaces, references, tolerances.              | Yes                 |
| 2D              | Own analytic contours (v0.1); later `clipper2-ts` (always pass a precision to float functions), Manifold `CrossSection`, `cavalier-contours-js` candidate for arcs | Boundaries, offsets, tabs, 2.5D toolpaths (arcs kept for G2/G3).            | Analytic only       |
| 3D solid        | `manifold-3d` (mesh booleans)                                                                                                                                      | Previews, in-process stock between setups, cut-apart pieces, collisions.    | Previews and checks |
| Vector surfaces | Own; medial-axis library to choose                                                                                                                                 | Paths with Béziers, V-carve depths, relief profiles, drop-cutter toolpaths. | No                  |
| Import          | SVG/DXF vectors; raster images traced to vectors; meshes (STL, OBJ, 3MF) for reference; STEP converted to mesh later                                               | Carving/engraving sources, reference models.                                | No                  |

All libraries sit behind interfaces (ports) in `src/core`; heavy evaluation runs in workers ([overview.md#threading](overview.md#threading)).

## Open questions

### Later

- Free-form shapes (deferred): Minkowski fallback for contours that fail loft validity; measure it on non-convex pockets first.
- 4th/5th axis: `z = f(x, y)` surfaces stop working there; what replaces them.
- Raster-to-vector tracing: `@visioncortex/vtracer` (MIT, WASM, Bézier output, still alpha) or Potrace (GPL, best black-and-white quality – allowed by [ADR 0014](../decisions/0014-gpl-3-or-later-license.md)); how much the user can tune the tracing.
- Medial axis for V-carving – candidates: JSPoly (JS port of Boost.Polygon Voronoi, used by Kiri:Moto; segments only), `flo-mat` (MIT, works on Béziers directly), CGAL via WASM (GPL, allowed). Needs its own spike.
- Arc-preserving offsets: `cavalier-contours-js` (young, single maintainer) vs. a WASM build of the Rust `cavalier_contours` crate.
- Simulation model (Z-map vs. dexel – internal to simulation only); performance budget.
