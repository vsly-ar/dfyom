# Geometry

Status: draft · Decision: [ADR 0007](../decisions/0007-layered-geometry-without-brep-kernel.md) · Terms: [glossary.md](../glossary.md)

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

A surface id is derived from the operation and the surface's role, e.g. `pocket1.floor`, `pocket1.wall[2]`, `profile1.tab[0].top`. Ids do not depend on computed topology, so references in [expressions](quantities.md#expressions-and-references) survive edits. This avoids the topological naming problem of B-rep CAD. Each surface carries a tolerance (own or inherited).

In meshes, surface ids are carried as Manifold `faceID`s under original ids reserved per operation (`Manifold.reserveIDs`), so every output triangle maps back to its surface after booleans. Always key by original id + face id together.

### Representation: contour + profile (offset-loft)

A 2.5D removal or retained region is a **closed contour** plus a **profile** of (offset, z) levels. Floor fillets, chamfers and round-overs are all profiles. They are built by our own **offset-loft** (one offset ring per level, bands between them, labelled when built). The loft is valid while every contour radius is ≥ the largest offset – the same limit a bull-nose or chamfer tool imposes, so the check doubles as a DFM warning. Below it, a Minkowski sum (inset prism ⊕ sphere) is the fallback.

## Carving and engraving (vector-based)

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

## Evaluation rules

- Removals **overshoot** the stock and **overlap** each other; they never just touch (face-touching solids stay separate shells, and shared boundaries leave slivers).
- Segment counts (arcs, fillet levels) are derived from the tolerance. Arcs are inscribed, so meshes always keep slightly more material – the safe direction.
- Build labelled meshes near the origin and translate afterwards (JS mesh I/O is float32). Meshes are derived data; never read dimensions back from them.
- After each evaluation check `status()` and `decompose()`: extra pieces reveal parts that are not held (e.g. tabs that connect to nothing) – a DFM warning.
- Tolerate degenerate triangles in output meshes.
- Clipper2 float functions default to 2 decimals – always pass a precision.
- WASM objects are freed through one ownership helper (arena per evaluation).

## Layers

| Layer           | Implementation                                                                                                       | Used for                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Analytic model  | Own, in `src/core`                                                                                                   | Source of truth: operations, surfaces, references, tolerances.              |
| 2D              | `clipper2-ts`; Manifold `CrossSection` for 2D→3D; `cavalier-contours-js` candidate for arc offsets                   | Boundaries, offsets, tabs, 2.5D toolpaths (arcs kept for G2/G3).            |
| 3D solid        | `manifold-3d` (mesh booleans)                                                                                        | Previews, in-process stock between setups, cut-apart pieces, collisions.    |
| Vector surfaces | Own; medial-axis library to choose                                                                                   | Paths with Béziers, V-carve depths, relief profiles, drop-cutter toolpaths. |
| Import          | SVG/DXF vectors; raster images traced to vectors; meshes (STL, OBJ, 3MF) for reference; STEP converted to mesh later | Carving/engraving sources, reference models.                                |

All libraries sit behind interfaces (ports) in `src/core`; heavy evaluation runs in workers ([overview.md#threading](overview.md#threading)).

## Open questions

- Conflicts: one operation's retained region inside another operation's removal region (DFM warning? priority?).
- 4th/5th axis: `z = f(x, y)` surfaces stop working there; what replaces them.
- Raster-to-vector tracing: `@visioncortex/vtracer` (MIT, WASM, Bézier output, still alpha) or Potrace (GPL, best black-and-white quality – allowed by [ADR 0014](../decisions/0014-gpl-3-or-later-license.md)); how much the user can tune the tracing.
- Medial axis for V-carving – candidates: JSPoly (JS port of Boost.Polygon Voronoi, used by Kiri:Moto; segments only), `flo-mat` (MIT, works on Béziers directly), CGAL via WASM (GPL, allowed). Needs its own spike.
- Arc-preserving offsets: `cavalier-contours-js` (young, single maintainer) vs. a WASM build of the Rust `cavalier_contours` crate.
- Minkowski fallback on non-convex pockets (not measured); memory growth in a long-lived worker.
- Simulation model (Z-map vs. dexel – internal to simulation only); performance budget.
