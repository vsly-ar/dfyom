# 0007 – Layered geometry without a B-rep kernel

Status: accepted · Date: 2026-11-16

## Context

DFYOM designs parts as stock minus material removed by cutting operations ([geometry.md](../architecture/geometry.md)). Fillets are modifiers of cutting operations, carving and engraving are operation-driven and vector-based, STEP import is only a later nice-to-have (it can be converted at import), and no CAD export is planned. Candidates compared:

| Candidate                    | Type                 | Verdict                                                                              |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| OpenCascade (opencascade.js) | Exact B-rep          | Not needed: 10–50 MB WASM, slow booleans, manual memory; only STEP would justify it. |
| Manifold                     | Mesh booleans        | **Use** for 3D: fast, robust, small, Apache-2.0.                                     |
| Clipper2                     | 2D polygons          | **Use** for 2D: tiny, robust, Boost license.                                         |
| CavalierContours             | 2D offsets with arcs | **Candidate** for arc-preserving offsets (G2/G3); JS/WASM bindings to verify.        |
| truck, Fornjot               | Rust B-rep           | Too immature.                                                                        |
| three-bvh-csg, JSCAD         | JS mesh CSG          | Less robust and slower than Manifold.                                                |
| OpenCAMLib                   | CAM algorithms       | Reference only; no maintained WASM build. Drop-cutter is implemented ourselves.      |

## Decision

No general B-rep kernel. Our own analytic model is the source of truth; it is evaluated by:

- **2D:** `clipper2-ts` (pure TS port of Clipper2); Manifold's `CrossSection` for 2D that feeds straight into 3D. `cavalier-contours-js` stays the candidate for arc-preserving toolpath offsets (G2/G3).
- **3D:** `manifold-3d` mesh booleans.
- **Own primitives:** an **offset-loft** (closed contour + (offset, z) levels, labelled when built) for fillets and chamfers; our own vector-surface layer for V-carving and reliefs.

All of them sit behind ports in `src/core`. Rules for using them: [geometry.md#evaluation-rules](../architecture/geometry.md#evaluation-rules).

## Spike results

Throwaway spike on branch `spike/geometry` (`spikes/geometry/FINDINGS.md` there). Test part: stock with facing, pocket (inside corner radius + floor fillet), 4 drills, chamfer, profile with 4 tabs.

| Measure                          | Result                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Build time (Node worker, M1 Pro) | ~20 ms warm, ~55 ms cold (WASM init 6–8 ms)                                                                                        |
| Payload                          | `manifold.wasm` 541 KB + 82 KB glue; `clipper2-ts` 123 KB min                                                                      |
| Mesh                             | `status()` NoError; 2 444 triangles; volume +0.013 % vs. analytic at 0.01 mm tolerance (always more material – the safe direction) |
| Surface ids                      | 31 surfaces kept through all booleans via `faceID` + reserved original ids; every checked triangle matched its analytic surface    |
| Floor fillet                     | Offset-loft: 1 ms, 2 444 triangles at 0.01 mm. Minkowski: 7 ms. Stair slabs: 443 ms, 34 524 triangles (rejected)                   |
| Clipper2 options                 | `clipper2-ts` 0.09 ms/op vs. `clipper2-wasm` 0.07 (broken typings, manual memory)                                                  |

## Consequences

- Small bundle (under 1 MB vs. 10–50 MB for OpenCascade), fast evaluation, licenses compatible with [ADR 0014](0014-gpl-3-or-later-license.md).
- Fillets, tabs and carving must fit the cutting-operation framework; arbitrary free-form solid modeling is out of scope.
- Costs we accept: float32 mesh I/O from JS, manual WASM memory (needs an ownership helper), degenerate triangles in output meshes.
- STEP import later requires a separate converter (e.g. OpenCascade run only at import time).
