# Geometry

Status: implemented (2.5D, tasks 2.6–2.8; carving still draft) · Decision: [ADR 0007](../decisions/0007-layered-geometry-without-brep-kernel.md) · Operations: [design.md](../modes/design.md#operations-v01) · Values: [quantities.md](quantities.md) · Terms: [glossary.md](../glossary.md)

[2.5D evaluation (v0.1)](#25d-evaluation-v01) specifies tasks 2.6–2.8 of the [v0.1 plan](../plans/v0.1.md), all implemented in [`src/core/geometry/`](../../src/core/geometry/), including the [evaluation checks](#evaluation-checks) and the synchronous [parameter and tool checks](#parameter-and-tool-checks). The [Carving (later)](#carving-later) sections are still draft and must not be implemented yet.

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

| File                    | Contents                                                                                                                                                                                                                                         | Task                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| `model.ts`              | `PartGeometryInput` (stock size + operations resolved to float64 mm and degrees; `on` resolved to `onZ`; optional `references` for `surfaceMissing`), `Contour`, `Level`, `SurfaceId`, `DfmWarning`, constants ([precision](#evaluation-rules))  | 2.6 (warnings: 2.8) |
| `contour.ts`, `loft.ts` | Analytic offset, exact elements (lines, arcs) and flattening of rounded rectangles and circles (**one** implementation, shared with toolpaths); loft: `offsetLoft`, `offsetBand` → `LabelledMesh` (plain typed arrays, local frame)              | 2.6 (contour), 2.7  |
| `operations.ts`         | Per operation: removal, cut (kept side of a profile slot) and retained `LabelledMesh`es, nominal retained regions (for `retainedRemoved`) plus its surface table; the stock box                                                                  | 2.7                 |
| `solid-port.ts`         | `SolidPort`: `reserveOriginalId`, `fromMesh`, `union` (batch), `subtract`, `intersect`, `translate`, `status`, `decompose`, `volume`, `toMesh`; opaque `Solid`; `SolidKernel` (`withSolids`, `liveObjects`, `heapBytes`)                         | 2.6                 |
| `manifold/`             | `loadManifold(source)` → `SolidKernel` on `manifold-3d` with the arena; the **only** code importing `manifold-3d` or calling `.delete()`                                                                                                         | 2.6                 |
| `evaluate.ts`           | `evaluatePart(input, solids) → AppResult<PartEvaluation>`: build, compose, map surfaces, the two error checks (`status`, `airSurface`), then `checks.ts`; `testing/`: [test part](#testing), analytic and mesh oracles, test-only Node wasm host | 2.7 (checks: 2.8)   |
| `checks.ts`             | `geometryChecks`: pieces (`decompose`), `dfm.loosePiece`, `dfm.retainedRemoved`, `dfm.surfaceMissing` ([evaluation checks](#evaluation-checks))                                                                                                  | 2.8                 |
| `dfm.ts`                | `parameterChecks(input, { tools, unitSystem }) → DfmWarning[]`: synchronous, pure parameter and tool checks ([below](#parameter-and-tool-checks))                                                                                                | 2.8                 |
| `evaluate.perf.ts`      | [Performance budgets](#performance-budgets-v01), run by `npm run perf` (not part of `npm run check`)                                                                                                                                             | 2.7                 |

### Building the solids

Every solid is an offset-loft or offset band, **labelled at construction** – no unlabelled library primitives. `ov` = overshoot, `top` = 0 (stock top), `zf` = `on.z − depth`; `on.z` comes from the analytic model, never from a mesh. The stock is a labelled box `0..L × 0..W × −T..0`.

| Operation | Removal (levels as offset, z; offset > 0 = inward)                                                           | Retained                      |
| --------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Facing    | Rectangle `−ov..L+ov × −ov..W+ov`: (0, ov) → (0, −depth)                                                     | –                             |
| Pocket    | Shape: (0, ov) → (0, zf + f) → fillet levels → (f, zf); `f` = `floorRadius`                                  | Floor fillet, inside the loft |
| Drilling  | Circle: (0, ov) → (0, zf) → `through`: (0, −T − ov) · `flat`: cap · `drillPoint`: (r, zf − r / tan(angle/2)) | –                             |
| Profile   | Slot = outer prism − inner prism (both `−T − ov..ov`; the subtracted prism overshoots `2·ov`)                | Tabs: offset bands            |

Composition: one batch `union` of all `removal − retained`, then `stock − union`. A profile's removal is itself `outer prism − inner prism` (the "cut": the prism on the kept side, built circumscribed – see [evaluation rules](#evaluation-rules)). An `inside` profile whose slot covers the whole opening (the inset left inside the slot, half the narrowest size − `slotWidth`, is ≤ the chord tolerance) has no inner prism and no tabs (nothing to hold; DFM warning `dfm.tabsUnused` when `tabs.count` > 0). A fillet is built into its loft (the loft _is_ removal − retained); tabs are separate solids subtracted from their slot. Each mesh is built in a local frame centered on its contour and translated in Manifold (float64), per the [evaluation rules](#evaluation-rules).

### Offset-loft

A 2.5D removal is a **closed contour** plus a **profile** of (offset, z) levels; floor fillets and the drill point are profiles (chamfers and round-overs later).

- Each level is the contour offset by `offset`, flattened with **one parameterization for all levels**, so rings correspond segment by segment. Bands between rings are ruled quads; caps are fans (all v0.1 rings are convex). An arc whose offset radius is ≤ ε becomes one vertex and its band a fan; zero-length segments (≤ ε) are dropped; a ring collapsed to a point (drill tip) closes with a fan.
- Floor fillet levels: φₖ = k·π/(2n), offset = f(1 − cos φₖ), z = zf + f(1 − sin φₖ), n from the [chord tolerance](#evaluation-rules). `pointAngle` 180° is a flat bottom.
- Labels: straight-segment bands → `wall[i]`, arc bands → `corner[i]`, fillet bands → `floorFillet`, bottom cap → `floor`/`bottom`, overshoot faces → `air`.
- **Validity:** every contour radius ≥ the largest offset (the bull-nose tool limit, so it doubles as a DFM rule). design.md constraints (`floorRadius ≤ cornerRadius`, ≤ diameter/2) guarantee it in v0.1; a violation is a bug → `geometry.evaluation` (rule `loftInvalid`), never a silent fallback.
- **Offset band (tabs):** the points whose nearest shape point lies on the tab's stretch of the shape (width measured along the shape, positions as in [design.md](../modes/design.md#profile-with-tabs); arc length runs counter-clockwise from the start of `wall[0]`, and on a circle the first tab is at the front, −Y), between the offsets `outer` and `inner` that span the slot plus overshoot, from `−T − 2·ov` up to the tab top. `outside`: `outer` = −(`slotWidth` + `ov`), `inner` = min(`ov`, inradius / 2); `inside`: `outer` = −`ov`, `inner` = `slotWidth` + min(`ov`, (inradius − `slotWidth`) / 2) – so tiny shapes and narrow insets stay valid. Outline:
  - **End face:** the straight segment on the shape's inward normal at the tab's end point, from `outer` across the whole slot. If the normal reaches the shape's medial axis before `inner` – the centre of a corner arc smaller than `inner`, or the bisector of such a corner next to a wall end – the end face bends there and follows the medial axis (the corner bisector) to the inset corner at `inner`: beyond the medial axis the points are nearest to another element, so a straight continuation would cut into the neighbouring wall's slot.
  - **Far side** (beyond the slot's outer edge): the shape offset by `outer`; **near side**: the shape offset by `inner` (clamped: sharp inset corners) between the end faces. If both end faces meet on the medial axis (a tab within one small corner), the band closes there, covering the slot between them; where the two bends overlap on one bisector, the outline keeps only their difference, so it never intersects itself.
  - Labels: top cap `tab[i].top`; end faces incl. their bends `tab[i].end[0|1]` in contour direction (counter-clockwise from above); all other faces `air` (outside the slot, so they never survive). Tabs are retained regions and stay **inscribed** (their far side is outside the slot).
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
- **Chord tolerance** is 0.01 mm for every arc and fillet step in v0.1: every flattened point and chord stays within 0.01 mm of its arc, so meshes always keep slightly more material – the safe direction. Removals are flattened **inscribed** (vertices on the arc, sagitta r(1 − cos(α/2)) ≤ t: n = ⌈θ / (2·acos(1 − t/r))⌉); the kept-side prism subtracted from a profile slot **circumscribed** (edges tangent to the arc, vertex excess r(1/cos(α/2) − 1) ≤ t: n = ⌈θ / (2·acos(r / (r + t)))⌉ – inscribed there would widen the slot). Retained tab bands are not affected: they stay inscribed. n ≥ 1, and a closed circle has at least 3 (inscribed) or 4 (circumscribed) segments, so circles at or below the tolerance (e.g. a Ø0.02 drill) stay polygons of about their size. Meshes serve preview and checks only – toolpaths are analytic – so surface tolerances do not tighten it (later: simulation and carving derive it from the surface tolerance).
- Constants in `model.ts`: ε = 1e-6 mm (coincidence, collapse, zero length); `ov` = 1 mm; ε_V = 1e-3 mm³ (smallest volume that counts as a piece or an overlap).
- Removals **overshoot** the stock and **overlap** each other; they never just touch (face-touching solids stay separate shells, and shared boundaries leave slivers). A subtracted solid overshoots further than the one it cuts; retained regions overshoot their removal on every unlabelled side.
- Build labelled meshes near the origin and translate afterwards (JS mesh I/O is float32). Meshes are derived data; never read dimensions back from them.
- Tolerate degenerate triangles in output meshes. Coincident faces of user geometry (e.g. two pockets sharing a wall plane) may leave slivers; pieces ≤ ε_V are ignored.
- WASM objects are freed through one ownership helper ([arena per evaluation](#wasm-lifetime-and-ownership)).

### Evaluation checks

| Check                                                                    | Result                                                                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `status()` ≠ `NoError`                                                   | Error `geometry.evaluation` (new code, task 2.6); issue names the status                                        |
| A triangle labelled `air` or with an unknown (original id, face id)      | Error `geometry.evaluation`, rule `airSurface` (a bug)                                                          |
| `decompose()` yields more than one piece of volume > ε_V                 | Warning `dfm.loosePiece` per piece except the part; names the operations whose surfaces bound it (`tabs`)       |
| Nominal retained region (without overshoot) ∩ another op's removal > ε_V | Warning `dfm.retainedRemoved` naming both operations ([design.md](../modes/design.md#ordering-and-composition)) |
| A surface referenced by `on` or an expression has no triangles           | Warning `dfm.surfaceMissing` naming the referencing operation and parameter                                     |

Checks run in the worker after composition, in table order. Warnings follow [design.md DFM checks](../modes/design.md#dfm-checks) (operation, parameter, message, suggestion), are derived on every evaluation and never stored. Constraint and tool checks stay synchronous in the commands ([below](#parameter-and-tool-checks)). Settled in task 2.8:

- **Pieces.** `PartEvaluation.pieces` counts the pieces > ε_V (1 when the part and every offcut hang together through tabs; 0 if nothing is left). A piece is **waste** when it is bounded by a profile's `offcut` surface and by no profile's shape side (`wall[i]`, `corner[i]`, `tab[i].*` of any profile): tabs join a held part to its frame, and an opening's slug held by tabs joins the part, so the part's piece often carries offcut triangles too. **The part** is the largest piece that is not waste (the largest piece if all are), so a small part cut from a large stock is never reported in place of its offcut frame. Every other piece gets `dfm.loosePiece` with `params` `volume`, `offcut` (waste) and `operations` (the operations whose triangles bound it, stock excluded, in operation order); `operation` is the first profile among them (else the first one), `parameter` `tabs`. Each piece's operations come from one `toMesh` per piece, only when there is more than one.
- **Out of scope in v0.1: sliver connections.** Connectivity is topological: a 5 µm bridge (e.g. an inside slot that nearly covers an opening crossing the stock) or a 0.001 mm tab counts as holding. The parameter check `dfm.tabsThin` warns for tabs thinner or narrower than 1 mm / 1/32″; a minimum section of the joining material is not measured.
- **Spike part** (stock margin 3 < slot 6): the slot removes the whole frame, so the tabs end in the air; the only stock left is the four corners beyond the slot's rounded outer corners, which come loose (4 × `dfm.loosePiece`). The cause is named by the parameter check `dfm.slotLeavesStock`.
- **Nominal retained regions** (`operations.ts`): a tab is its offset band exactly across the slot (offsets 0 to `slotWidth`, from `stock.bottom` up to the tab top); a floor fillet is the prism `zf..zf + f` of the pocket contour minus the pocket's own loft (same flattening at offset 0, so no slivers). "Another op's removal" is that operation's net solid (removal − cut − retained). Axis-aligned bounds (removal meshes incl. overshoot) skip pairs that cannot meet; for a floor fillet, a removal whose bounds lie in XY inside the pocket contour inset by f is skipped too (the fillet zone is the ring between the contour and that inset), so drills and pockets in a pocket floor cost no booleans. One warning per (retaining operation, removing operation): `operation` = the retaining one, `parameter` `tabs` or `floorRadius`, `params` `by`, `regions` (e.g. `tab[0]`, `floorFillet`) and `volume`. Pockets merged on purpose (overlapping pockets whose floor fillets cut each other) are reported one way only: when two operations cut each other's retained regions, only the later one in design order is named as the remover.
- **Surface references** reach geometry as the optional `PartGeometryInput.references` (`operation`, `parameter`, `surface`), filled by the design mapper (`toGeometryInput`) from `on` and expression references, one entry per operation, parameter and surface; geometry never parses expressions.

#### Warning shape

`DfmWarning` (`model.ts`), consistent with the calculator's warnings ([feeds-speeds.md](feeds-speeds.md)): `code` (`dfm.*`), `severity` (`warning` or `info`), `message` (English, values in mm; the UI may re-render it from `code` + `params` in the project unit system), `operation` (id), `parameter` (when one is to blame), `params` (numbers in mm, strings, booleans, id lists) and an optional `suggestion` `{ relation: 'atLeast' | 'atMost', value }` in mm. Warnings are plain data and cross the worker boundary as is.

#### Parameter and tool checks

`parameterChecks(input, { tools, unitSystem })` in `dfm.ts` implements every DFM rule of the [design.md operation tables](../modes/design.md#operations-v01) that needs no solid. It is pure and total, takes the resolved `PartGeometryInput` and the whole tool library reduced to `DfmTool` (`type`, `diameter`, bull-nose `cornerRadius`; mm), and is called by the design commands and `design.warning.list` ([design.md](../modes/design.md#dfm-warnings-task-28-wiring)). With an empty library only the geometric rules run (`facingDeep`, `pocketDeepNarrow`, `cornerSharp`, `holeOutsideStock`, `holeDeep`, `slotLeavesStock`, `slotOpensStock`, `tabsNone`, `tabsUnused`, `tabsThin`). "End mill" means flat, bull-nose or ball. Every tool-size rule uses `TOOL_MATCH_TOLERANCE` = 0.01 mm – sizes within it count as equal: `pocketNoToolFits`, `cornerTooSmall`, `slotNoTool` (warn only below the tool size − 0.01 mm), `floorRadiusNoTool` (bull-nose radius within 0.01 mm, ball radius ≤ f + 0.01 mm) and `holeNoTool` (drill within 0.01 mm; a boring end mill smaller by more than 0.01 mm). Geometric thresholds use ε.

| Code                    | Operation (parameter)                         | Rule                                                                                                                                                                               | Severity |
| ----------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `dfm.facingDeep`        | facing (`depth`)                              | depth > 3 mm (metric) / 1/8″ (inch project)                                                                                                                                        | info     |
| `dfm.pocketNoToolFits`  | pocket (`shape`)                              | narrowest size (rectangle: shorter side; circle: diameter) < smallest end-mill diameter                                                                                            | warning  |
| `dfm.pocketDeepNarrow`  | pocket (`depth`)                              | depth > 4 × narrowest size                                                                                                                                                         | warning  |
| `dfm.cornerSharp`       | pocket, inside profile (`shape.cornerRadius`) | rectangle with `cornerRadius` 0 (always, also with an empty library)                                                                                                               | warning  |
| `dfm.cornerTooSmall`    | pocket, inside profile (`shape.cornerRadius`) | 0 < `cornerRadius` < smallest end-mill radius                                                                                                                                      | warning  |
| `dfm.floorRadiusNoTool` | pocket (`floorRadius`)                        | f > 0, no bull-nose with corner radius f and no ball end mill with radius ≤ f                                                                                                      | warning  |
| `dfm.holeOutsideStock`  | drilling (`center`)                           | the hole circle reaches outside the stock rectangle                                                                                                                                | warning  |
| `dfm.holeNoTool`        | drilling (`diameter`)                         | no drill of the diameter and no end mill smaller than it for helical boring: any end mill for `through`, a flat end mill for `flat`, none for `drillPoint` (boring makes no point) | warning  |
| `dfm.holeDeep`          | drilling (`depth`)                            | depth > 5 × diameter; a `through` hole's depth is the material below `on` (`onZ` + T)                                                                                              | info     |
| `dfm.slotLeavesStock`   | outside profile (`shape`)                     | stock margin (shape bounds to the stock edge, per side) < `slotWidth` on **every** side: the frame falls apart, "tabs hold nothing"; `params.sides`                                | warning  |
| `dfm.slotOpensStock`    | outside profile (`shape`)                     | margin < `slotWidth` on some sides only: the slot runs out of the stock there, the frame still holds; `params.sides` (`stock.side[i]`)                                             | info     |
| `dfm.slotNoTool`        | profile (`slotWidth`)                         | `slotWidth` < smallest end-mill diameter                                                                                                                                           | warning  |
| `dfm.tabsNone`          | profile (`tabs.count`)                        | `tabs.count` 0 and there is an offcut (not when an inside slot covers the opening)                                                                                                 | warning  |
| `dfm.tabsUnused`        | inside profile (`tabs.count`)                 | the slot covers the opening ([building the solids](#building-the-solids)) and `tabs.count` > 0: no tabs are built                                                                  | info     |
| `dfm.tabsThin`          | profile (`tabs.thickness`, `tabs.width`)      | tabs are built and their thickness or width < 1 mm (metric) / 1/32″ (inch project): too weak to hold (one warning per parameter)                                                   | warning  |

### Worker and renderer

- `evaluatePart` is a pure worker task run through the `WorkerPort` (host per [ADR 0008](../decisions/0008-threading-split-by-job.md), task 2.9). One evaluation per document revision serves UI, MCP and CLI; a newer revision aborts a running one (`op.aborted`). Results are derived data like toolpaths: cached by a hash of `PartGeometryInput`, not in `ProjectDoc`, not persisted. `design.warning.list` will add the warnings of the last finished evaluation to the parameter warnings ([design.md](../modes/design.md#dfm-warnings-task-28-wiring)).
- `PartEvaluation`: `positions` (Float32Array, part frame, mm, vertices split at surface boundaries), `indices` (Uint32Array), `triangleSurface` (Uint32Array, index into `surfaces`), `surfaces` (`SurfaceId[]`, only those with triangles), `volume`, `pieces` and `warnings` (geometry warnings only, [evaluation checks](#evaluation-checks)), `stats` (ms, triangles). Typed-array buffers are **transferred**, not copied.
- Renderer ([ADR 0010](../decisions/0010-react-three-fiber-viewport.md)): one `BufferGeometry` per evaluation, normals per surface (flat planes, smooth fillets); picking maps the raycast `faceIndex` through `triangleSurface` to a surface id; highlighting by surface; replaced geometries are disposed. The viewport never computes geometry.

### WASM lifetime and ownership

- One `manifold-3d` module per worker, initialized lazily on the first task (6–8 ms). The worker host passes the WASM in through `loadManifold(source)`: `wasmBinary` (bytes; also makes the heap size measurable) or `locateFile` (URL in a bundled web worker); with neither, the package's own lookup is used (works in Node). `src/core` needs no `fs`/`fetch`; tests read the binary through `process.getBuiltinModule` in `testing/node-wasm.ts`.
- `withSolids(fn)` opens an **arena** for one evaluation and hands `fn` a `SolidPort`; every WASM object it creates is registered there and deleted on exit (success, error or abort). Results are copied into plain typed arrays before the arena closes; no WASM object outlives an evaluation or crosses a worker boundary. Manifold exceptions are wrapped with `tryCatch` inside `manifold/` into `geometry.evaluation` ([error handling](../conventions/error-handling/README.md)); a `Solid` used outside its arena is `internal.unexpected` (a bug). `fromMesh` builds through manifold-3d's raw constructor and checks `status()` itself, because in 3.5.4 `Manifold.ofMesh` throws on a bad status without deleting the object (a leak per rejected mesh); the rejected object is owned by the arena and freed with it. `liveObjects()` counts unfreed objects (0 between evaluations; asserted in tests). Abort between steps arrives with the worker (task 2.9). Memory: a soak run of 1 000 evaluations shows the WASM heap plateau (measured: 16 MB after warm-up, no growth), so hosts need not recycle workers.

### Performance budgets (v0.1)

Reference: Apple M1 Pro class, [test part](#testing), chord tolerance 0.01 mm. Measured by a benchmark script outside `npm run check` (timings are flaky in CI); CI asserts only the triangle budget and the heap plateau.

| Measure                                 | Budget                | Spike             | Task 2.7 (no checks yet)        | Task 2.8 (with checks)          |
| --------------------------------------- | --------------------- | ----------------- | ------------------------------- | ------------------------------- |
| Warm evaluation incl. checks            | ≤ 50 ms               | 20 ms (no checks) | 16.3 ms median, 16.7 ms p95     | 16.8 ms median, 17.3 ms p95     |
| Cold: WASM init + first evaluation      | ≤ 150 ms              | 55 ms             | 52 ms (init 7 ms)               | 54–60 ms (init 8–9 ms)          |
| Output triangles                        | ≤ 20 000              | 2 444             | 2 328                           | 2 328                           |
| WASM heap growth over 1 000 evaluations | ≤ 10 MB after warm-up | unmeasured        | 0 MB (16 MB heap after warm-up) | 0 MB (16 MB heap after warm-up) |

Measured with `npm run perf` (Node, Apple M1 Pro class). The checks add about 0.5 ms on the test part: one `decompose` and one `intersect`, because the outside profile's bounds enclose pocket1's fillet zone (the profile is not inside the pocket's inset, so the prefilter cannot skip it; the intersection is empty). Cases that take the costly paths, also in `npm run perf`: `tabs.count` 0 (two pieces, a `toMesh` per piece) 16.1 ms median; a pocket over a tab (`retainedRemoved` booleans) 19.2 ms median; 30 filleted pockets with 4 flat drills in each floor (300 × 200 stock, 46 572 triangles – above the test-part triangle budget, a stress case) 232 ms median, the same as with `retainedRemoved` switched off (416 ms before the inset prefilter). In `npm run check`, tests assert the triangle budget, `liveObjects()` = 0 and the heap plateau over 35 evaluations.

### Testing

- **Test part** (fixture `testing/test-part.ts`, also evaluated with `cornerRadius` 3; fixes the spike's invalid part): stock 100 × 60 × 20; facing 0.5; pocket 40 × 25 × 8 centered, `cornerRadius` 4, `floorRadius` 2; 4 drills Ø6 on a centered 70 × 30 pattern (`through`, `flat`, 2 × `drillPoint` 118°, depth 12); profile `outside` 84 × 44 R5 centered, `slotWidth` 6, 4 tabs 8 × 3 (stock margin 8 ≥ slot width). Expected: `NoError`, one piece, no geometry warnings, every design.md surface id present (except `stock.top`, which the facing removes), mesh volume between analytic and analytic + the chord-error bound (`testPartChordBound`, ≈ 24 mm³; measured +20.7 mm³, +0.027 %), drill-point tips and tab tops at their analytic z. Variants: `tabs.count` 0 → `loosePiece`; a pocket over a tab → `retainedRemoved`; `side` `inside`.
- **Checks** (`checks.test.ts`, `dfm.test.ts`): pieces for one part, a part plus held offcut, a loose offcut (outside and inside profile without tabs; the offcut is reported even when larger than the part), a part split in two, the spike part; `retainedRemoved` for a tab and a floor fillet and its near misses; `surfaceMissing`; every parameter and tool warning triggered and not triggered (boundaries, empty library, inch threshold); 30 seeded random parts keep `NoError` with `pieces` = 1 exactly when there are tabs and one `loosePiece` per extra piece.
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
