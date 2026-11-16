# 0007 – Layered geometry without a B-rep kernel

Status: draft (pending spike) · Date: 2026-11-16

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

No general B-rep kernel. Our own analytic model is the source of truth; Clipper2 (2D), Manifold (3D) and our own vector-surface layer (V-carving, reliefs) evaluate it, all behind ports in `src/core`.

To be confirmed by a **throwaway spike**: stock with pocket (with fillets) + drill + chamfer + profile with tabs, built with Clipper2 and Manifold in a worker. The spike measures performance and checks CavalierContours' bindings.

## Consequences

- Small bundle, fast evaluation, permissive licenses.
- Fillets, tabs and carving must fit the cutting-operation framework; arbitrary free-form solid modeling is out of scope.
- STEP import later requires a separate converter (e.g. OpenCascade run only at import time).
