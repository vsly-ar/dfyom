# 0019 – 2D geometry library: CavalierContours (Rust crate as WASM)

Status: accepted (2026-11-22, user decision D29; proposed 2026-11-21) · Date: 2026-11-21 · Design: [architecture/shapes.md](../architecture/shapes.md) · Spike: S1 ([plans/v0.2.md](../plans/v0.2.md#7-spike-for-v03)) · Built in: [shapes.md § 2D port](../architecture/shapes.md#2d-port) · For: [roadmap v0.3 – Shapes](../roadmap.md#v03--shapes)

## Context

v0.3 shapes are closed (and open) loops of lines and circular arcs ([roadmap](../roadmap.md#v03--shapes)). They need **offsets** (tool radius compensation inward and outward, repeated offsets for pocket clearing with islands, loop splitting in narrow necks) and **booleans** (union and difference for the Shape Editor and islands). Arcs should survive both, so the model stays analytic and gCode keeps G2/G3 ([geometry.md](../architecture/geometry.md#layers)). The 2D layer runs in `src/core` (headless, in worker lanes, the renderer and the CLI).

Candidates measured by the spike harness in [`spikes/2d/`](../../spikes/2d/harness.ts):

| Candidate                        | What                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **cavalier-contours-js 0.1.1**   | Pure TypeScript port of `cavalier_contours` **0.7.0** (npm)                                                                                        |
| **cavalier_contours 0.9.0 WASM** | The upstream Rust crate, built by the spike for `wasm32-unknown-unknown` behind a 60-line C ABI ([`cc-wasm/`](../../spikes/2d/cc-wasm/src/lib.rs)) |
| **clipper2-ts 2.0.1-19**         | TypeScript port of Clipper2 (polygons): arcs flattened in, a greedy arc re-fit out ([`refit.ts`](../../spikes/2d/refit.ts))                        |

Others were not measured: `clipper2-wasm` (same algorithm as clipper2-ts, polygons only), `@flatten-js/core` (arcs, but booleans only, no offsets), martinez/polyclip (polygon booleans only).

Method: the region convention is outer loops counter-clockwise, islands clockwise, a positive offset shrinks. The **offset oracle** checks that every output point lies exactly `|d|` from the input boundary (true for the boundary of an eroded or dilated region), sampled 5× per output segment against the exact lines and arcs. Crossings are counted on the outputs flattened to 2 µm. Clipper uses 1/3 of the 0.01 mm chord tolerance each for flattening, round joins and re-fitting. Raw output: [`spikes/2d/results.md`](../../spikes/2d/results.md); Apple M1 Pro class, Node 26.

## Measurements

### Correctness

Cells: loops out · arcs/lines out · max distance error; **bold** = wrong.

| Case (input arcs/lines)                    | d    | cavalier JS 0.1.1                      | cavalier WASM 0.9.0  | clipper2 + re-fit |
| ------------------------------------------ | ---- | -------------------------------------- | -------------------- | ----------------- |
| Pocket, 2 islands (10/8)                   | 3    | 3 · 10/8 · 0                           | 3 · 10/8 · 0         | 3 · 11/9 · 5 µm   |
| Pocket, 2 islands: island merges with wall | 12   | 2 · 6/8 · 0                            | 2 · 6/8 · 0          | 2 · 6/9 · 4 µm    |
| Neck 4 mm wide (2/2), splits               | 2.5  | 2 · 6/0 · 0                            | 2 · 6/0 · 0          | 2 · 8/0 · 3 µm    |
| Neck 4 mm wide, outward                    | −1   | **1 · 4/4 · 856 µm, 4 crossings**      | 1 · 2/2 · 0          | 1 · 4/2 · 3 µm    |
| Tangent arcs (wave, 6/3)                   | 3    | 1 · 6/3 · 0                            | 1 · 6/3 · 0          | 1 · 8/6 · 3 µm    |
| Near-tangent arcs (1e-6 mm)                | 3    | 1 · 6/3 · 0                            | 1 · 6/3 · 0          | 1 · 8/6 · 3 µm    |
| Self-touching loop (0/8)                   | 1    | 2 · 0/8 · 0                            | 2 · 0/8 · 0          | 2 · 0/8 · 0       |
| Island touching the outer loop             | 1    | **1 · 4/6 · 702 µm**                   | **1 · 4/6 · 702 µm** | 1 · 1/5 · 2 µm    |
| … same, region normalised by a difference  | 1    | 1 · 3/5 · 0                            | 1 · 3/5 · 0          | 1 · 1/5 · 2 µm    |
| Tiny segments: 360 arcs + 1e-5 mm lines    | −2   | 1 · 360/0 · 0                          | 1 · 360/2 · 0        | 1 · 16/16 · 2 µm  |
| SVG bracket (12/8)                         | 1    | 4 · 12/8 · 0                           | 4 · 12/8 · 0         | 4 · 11/11 · 5 µm  |
| SVG gear (38/53)                           | −1.5 | 2 · 74/36 · 0                          | 2 · 74/36 · 0        | 2 · 73/37 · 3 µm  |
| SVG heart, cubic Béziers (30/0)            | 1    | 1 · 49/0 · 0                           | 1 · 49/0 · 0         | 1 · 31/6 · 3 µm   |
| SVG letter D, quadratic + cubic (28/6)     | 1    | 2 · 45/6 · 0                           | 2 · 45/6 · 0         | 2 · 30/6 · 3 µm   |
| Star, 2000 segments + 2 islands            | 3    | **throws** (`view data must be valid`) | 3 · ok · 0           | 3 · ok · ≤ 5 µm   |

"0" means below 1e-12 mm. Every case is in the raw output; the table keeps the informative rows.

Pocket rings (tool r 3, stepover 2.4, until empty): CavalierContours offsets the previous ring, Clipper the original by the cumulative distance (erosions compose, see below).

| Fixture              | Candidate          | Rings | Arcs/lines total | Max error | Crossings |
| -------------------- | ------------------ | ----- | ---------------- | --------- | --------- |
| Pocket, 2 islands    | cavalier JS / WASM | 7     | 50/54            | 0         | 0         |
|                      | clipper2 + re-fit  | 7     | 54/59            | 5 µm      | 0         |
|                      | clipper2 polygons  | 7     | 0/3031           | 4 µm      | 0         |
| Star 200 + 2 islands | cavalier JS / WASM | 15    | 622/240          | 0         | 0         |
|                      | clipper2 + re-fit  | 15    | 775/259          | 5 µm      | 0         |
|                      | clipper2 polygons  | 15    | 0/18 999         | 5 µm      | 0         |

Booleans (area error vs. the analytic area): CavalierContours is exact (≤ 2e-6 mm²) on rect ∪ circle, rounded rect − circle, rect − inner circle (2 loops), tangent discs, collinear edges and a 1e-7 mm near-coincident union. Clipper + re-fit is within 0.03 mm² but splits the **tangent discs union into two loops with 2 crossings** (the shared point becomes two touching polygons).

Two CavalierContours defects reproduced in the JS port are **upstream 0.7.0 bugs fixed by 0.9.0**: a 0.7.0 WASM build gives the same 856 µm / 4 crossings on the outward neck and returns 140 garbage loops (0.2 mm error) on the 1500–2000 segment star where the JS port's debug assert throws. The touching-island defect remains in 0.9.0.

Found later (v0.3, LLM black-box test F3): the **spike defect** of 0.9.0's offset. An element much shorter than the offset between near-tangent neighbours (a 1 µm closing line between two arcs, left by an inset whose ends were rounded to 0.1 µm) has a raw offset that runs backwards; the crate keeps it, as it lies at the offset distance within its epsilons, so the result loop runs out and back along a few µm (a zero-width spike). Offsets of such a loop compound into open result loops and holes outside their outer loop. The port cuts the spikes out ([shapes.md § Implementation (K1)](../architecture/shapes.md#implementation-k1)); fixture: [`region-inset-fuzz.test.ts`](../../src/core/toolpath/region-inset-fuzz.test.ts).

Found later (hardening B2): the **collapse defect** of 0.9.0's offset. At offsets within about 1e-3 mm of the radius of an arc they collapse, the near-coincident intersections make the per-loop offset's slice stitching fail; it returns an open polyline, which the shape offset uses anyway (debug builds hit a `debug_assert` in `PlineViewData::from_slice_points`; the release WASM returns loops that cross, overlap or lie up to 10 mm off). About 8 % of such offsets of random regions failed; the WASM and native builds differ case by case (their math libraries round differently). Separately, a shrink past the radius of the arcs that round a hole's corners (a closing) returns no loop for that hole, at any offset. The port checks every offset result and retries in steps or with the offset nudged by up to 2e-3 mm ([shapes.md § Implementation (K1)](../architecture/shapes.md#implementation-k1)); corpus: [`offset-fuzz.test.ts`](../../src/core/geometry/2d/cavalier/offset-fuzz.test.ts).

### Speed (median ms)

Fixture: filleted star with n outer segments (half arcs) + 2 islands; "20 offsets" = 20 successive rings, stepover 0.4.

| n    | cavalier JS: 1 offset / 20 / union | cavalier WASM: 1 / 20 / union | clipper2 + re-fit: 1 / 20 / union | clipper2 polygons: 1 / 20 |
| ---- | ---------------------------------- | ----------------------------- | --------------------------------- | ------------------------- |
| 52   | 0.31 / 3.2 / 0.23                  | 0.04 / 0.51 / 0.05            | 0.68 / 107 / 0.18                 | 0.44 / 39                 |
| 200  | 0.76 / 78 / 1.1                    | 0.14 / 1.1 / 0.26             | 6.8 / 969 / 1.4                   | 4.0 / 1014                |
| 500  | 2.1 / 74 / 5.1                     | 0.29 / 1.5 / 1.3              | 96 / 3832 / 4.1                   | 101 / 4261                |
| 2000 | throws / throws / 2195             | 26 / 36 / 297                 | 3223 / 151 280 / 70               | 836 / 64 526              |

Timings come from the run in `results.md`. An earlier run with less load on the machine was up to 10× faster for the JS port and Clipper (e.g. clipper + re-fit 20 rings at n 200: 104 ms; JS port: 5 ms). WASM stayed within 10 %. The ranking is the same in both runs: WASM is 5–70× faster than the JS port and 10–4000× faster than Clipper. Only the 2000-segment union is faster with Clipper (70 vs 297 ms).

Clipper must offset the original by the cumulative distance: offsetting the previous polygon ring adds round-join points at every flattened vertex, which measured 42 394 segments and 2.7 s after 20 rings of the 52-segment star.

### Size, licence, upkeep, environment

| Candidate                  | Shipped size (min / gzip)                                           | Licence           | Upkeep (2026-11-21)                                                                                                      |
| -------------------------- | ------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| cavalier-contours-js 0.1.1 | 70 / 20 KiB                                                         | MIT OR Apache-2.0 | 1 maintainer, 2 releases (2026-08-08), 9 commits; ports 0.7.0 and lags two upstream releases                             |
| cavalier_contours 0.9.0    | WASM 256 / 86 KiB (opt-level 3; 192 / 70 KiB with `s`) + 2 KiB glue | MIT OR Apache-2.0 | 241 stars, 7 contributors, ≥ 100 commits in the last year, releases 0.7 (2026-01), 0.8 (08), 0.9 (08), last fix 2026-10  |
| clipper2-ts 2.0.1-19       | 65 / 17 KiB (+ re-fit 3 / 1 KiB)                                    | BSL-1.0           | 3 contributors, active (last release 2026-11-07); tracks PolyClipping/Clipper2 (the AngusJohnson repo was archived 2026) |

All three licences are compatible with GPL-3.0-or-later ([ADR 0014](0014-gpl-3-or-later-license.md)). All are headless: no DOM or Node-only APIs (checked in the sources). The WASM module has **no imports** (only its own memory), so it instantiates the same way in Electron main, `worker_threads`, renderer Web Workers and the CLI; the host supplies the bytes, exactly like `manifold.wasm` today ([geometry.md](../architecture/geometry.md#wasm-lifetime-and-ownership)).

## Decision

1. **Use CavalierContours, the upstream Rust crate (pinned, 0.9.x), compiled to WASM**, for every offset and boolean of line/arc loops in v0.3: tool radius compensation, pocket rings, Shape Editor booleans and islands. Arcs in, arcs out; exact to float precision.
2. **Behind a port in `src/core`** (like `SolidPort`), with our own thin C ABI (no wasm-bindgen, no imports), loaded in the geometry and toolpath lanes and in the renderer for the Shape Editor preview. Refined in [shapes.md § Where the 2D layer runs](../architecture/shapes.md#where-the-2d-layer-runs): the **dispatcher** (and the CLI and tests) hosts it too, because resolving shapes, invariants and parameter DFM checks run synchronously in the command step; the renderer instantiates it asynchronously at window start.
3. **The port normalises regions before offsetting**: islands are subtracted from the outer loop (and overlapping islands united) with the library's boolean first. This avoids the touching-island defect and gives `Shape` the non-intersecting loops it assumes. The crate has only loop-to-loop booleans, so the port composes multi-loop shape booleans (fold unions; differences that produce holes).
4. **Not the JS port**: same algorithm, but 5–70× slower than WASM, frozen at 0.7.0 with two defects the spike reproduced, and a single maintainer.
5. **Clipper2 is not the primary 2D library.** Its polygons stay a candidate for polygon-only checks (e.g. the rest-region check in the v0.2 scope research), decided when that check is designed. Its flatten + re-fit route works on this corpus (≤ 5 µm, about as many arcs as the input) but its offsets are 10–100× slower (more at 2000 segments), it splits tangent unions, and depends on our own fitter.
6. **The built `.wasm` is vendored** (Q26) in `vendor/cavalier-contours/` ([`Cargo.toml`](../../vendor/cavalier-contours/Cargo.toml)) with its SHA-256, the pinned crate source (`Cargo.toml` with `cavalier_contours = "=0.9.0"`, `Cargo.lock`, our C ABI in `src/lib.rs`) and the rebuild script `npm run wasm:cavalier` (pinned Rust 1.100.0 via rustup, reproducible paths; `--check` rebuilds and compares). `npm run check` verifies the checksum; CI needs no Rust toolchain; the module is rebuilt (and the checksum updated in the same commit) only when the crate or the ABI changes. Licences of the compiled crates: [`THIRD-PARTY-NOTICES.txt`](../../vendor/cavalier-contours/THIRD-PARTY-NOTICES.txt) (all used under MIT).

## Consequences

- A binary in git (≈ 256 KiB) that changes on crate bumps only; changing `src/lib.rs` or the crate needs a local Rust 1.100.0 with the `wasm32-unknown-unknown` target (decision 6).
- One more WASM module (≈ 70–86 KiB gzip) in the worker lanes and the renderer; instantiation is synchronous-capable and import-free.
- Upstream fixes arrive by bumping the crate; the spike's fixtures become regression tests of the port (v0.3 lane B).
- CavalierContours epsilons (position 1e-5, offset 1e-4 mm) sit well below the 0.01 mm chord tolerance; documented next to the tolerance rules in [geometry.md](../architecture/geometry.md#evaluation-rules).
- Béziers still have to become arcs on import (lane D). The spike's 3-point arc subdivision is not tangent-continuous; v0.3 needs real biarcs.

## Open questions

- Report the touching-island defect upstream with the spike fixture.
- Report the spike defect upstream (the enclosure inset fixture, reduced).
- Report the collapse defect upstream (a reduced case from the B2 corpus: the open polyline of `parallel_offset` at d = an arc's radius ± 1e-6, and the lost hole of a closing).
- Ellipses and elliptical SVG arcs: biarc approximation on import (lane D), not in the 2D library.
