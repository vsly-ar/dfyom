# Spike S5: biarc fitting of Béziers and elliptical arcs

Status: draft (spike report, 2026-11-22) · Task: S5 in [plans/v0.3.md § Spikes](../plans/v0.3.md#2-spikes) · Spec it informs: [shapes.md § Arc fitting](../architecture/shapes.md#arc-fitting), [design-v0.3.md § SVG import](../modes/design-v0.3.md#svg-import) · Harness and tests: [`spikes/biarc/`](../../spikes/biarc/harness.ts) · Raw output: [`spikes/biarc/results.md`](../../spikes/biarc/results.md) · Terms: [glossary.md](../glossary.md) (biarc, chord tolerance)

## Question

Can quadratic and cubic Béziers and SVG elliptical arcs become lines and circular arcs within the 0.01 mm chord tolerance, tangent-continuous (G1), on the SVG corpus and on nasty cases? How many elements does it take, how long, and which method should task I1 build?

## Method

- **Source curves** ([`curves.ts`](../../spikes/biarc/curves.ts)): cubics; quadratics degree-elevated to cubics (exact); SVG arcs converted from the endpoint to the centre form (SVG 1.1 F.6.5, radii scaled up when too small, zero radii make a line); circular arcs stay exact (one bulge); lines stay lines. Cusps (B′ = 0) and inflections come from the roots of B′ × B″ (a quadratic for a cubic); ellipse vertices are the break points of an ellipse.
- **Approaches** ([`fit.ts`](../../spikes/biarc/fit.ts)); all split at cusps first (the curve has no tangent there, so a corner is correct):

  | Id  | Approach                  | Join point / step                                                                                                                                   | Split on error     |
  | --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
  | A   | Classic biarc             | Equal tangent lengths (handles C and S shapes)                                                                                                      | Parameter midpoint |
  | B   | Riskus / Šír style        | Pre-split at inflections and ellipse vertices so every piece is C-shaped; join at the **incenter** of the tangent triangle (equal lengths if not C) | Parameter midpoint |
  | C   | Greedy tangent arc spline | From the current point and tangent, the longest single tangent arc within tolerance (bisection), then a closing biarc onto the end tangent          | – (marches along)  |

- **In-fit error estimate:** 24 curve samples per piece, distance to the elements, plus a guard that rejects element chains more than 10 % longer than the sampled curve (a looping biarc can pass near every sample).
- **Line fallback:** an arc becomes a line only when its sagitta ≤ 0.1 µm **and** its half sweep (the kink it leaves) ≤ 0.1 mrad; the fit runs at 0.01 mm − 0.1 µm. Arcs over 180° are split in two (CavalierContours bulge ≤ 1). Collinear lines merge.
- **Oracle** ([`oracle.ts`](../../spikes/biarc/oracle.ts), independent of the fit): two-sided sampled distance between the elements (64 samples each) and the curve flattened to 0.1 µm; kink angle at every join inside a chain and between each chain end and the source curve's own tangent, so neighbouring curves stay G1 wherever the source is. Vitest ([`fit.test.ts`](../../spikes/biarc/fit.test.ts), in `npm test`) asserts deviation ≤ 0.01 mm, kink ≤ 0.1 mrad, no gaps and no forced pieces for every case.
- **Corpus** ([`corpus.ts`](../../spikes/biarc/corpus.ts)): S1's heart, letter D and gear; a 64-cubic superellipse like the exit-criteria outline; cusp, near-cusp (1 µm off), loop, one and two inflections, control point on the end point, straight cubic, collinear backtracking, nearly straight (1 nm), huge radii (1.5 µm and 50 µm bow over 300 mm), tiny (0.05 mm heart, r 0.005 mm arcs), ellipse, thin ellipse (200 × 2 mm, end radius 0.01 mm), flat elliptical arc (radii 10⁵ mm), Q/T chain; and seeded chains of 1000 and 5000 random G1 cubics for throughput. Node 26, Apple M1 Pro class.

## Results

Elements (arcs + lines) at 0.01 mm; max two-sided deviation in µm. Every A and B row passes the oracle; kinks are ≤ 6·10⁻¹⁴ rad except where the line fallback acted (≤ 0.1 mrad by construction).

| Case                        | A         | B             | C                | S1 3-point arcs (not G1) |
| --------------------------- | --------- | ------------- | ---------------- | ------------------------ |
| heart (6 cubics)            | 48 · 8.4  | **40** · 9.5  | 39 · 9.8         | 28, 14 kinked joins      |
| letter D (4 curves + lines) | 42 · 9.6  | 50 · 9.7      | 42 · 9.5         | 34, 20 kinked joins      |
| gear (lines + arcs, exact)  | 74 · 0.06 | 74 · 0.06     | 74 · 0.06        | –                        |
| oval (64 cubics)            | 144 · 9.2 | **136** · 9.6 | 132 · 9.6        | –                        |
| ellipse (2 SVG arcs)        | 56 · 5.2  | **48** · 9.9  | 92 · 9.5         | –                        |
| thin ellipse                | 56 · 8.5  | **40** · 7.0  | 6622 · 9.5       | –                        |
| cusp / near-cusp            | 20 / 20   | 16 / 18       | 48 / 48          | –                        |
| whole corpus (21 cases)     | 646       | **604**       | 7315             | –                        |
| 1000 random cubics          | 11 524    | **7778**      | blows up (below) | –                        |

Time: B fits the whole corpus in 2.4 ms and random cubics at **27–33 µs per cubic** (5000 cubics in 136 ms); A takes about twice as long (54–62 µs) and makes about 50 % more elements on random cubics. C took 494 ms for the corpus (471 ms of it on the thin ellipse) and, on the first 50 random cubics, 13 s and 218 230 elements (5 curves over 1000 elements, one hit the 100 000-step guard).

Tolerance sweep (B): the heart takes 108 / 64 / 40 / 32 / 28 elements at 0.001 / 0.005 / 0.01 / 0.02 / 0.05 mm, roughly n ∝ tol^-⅓ as expected for biarcs; a biarc is the floor, so a curve never takes fewer than 2 elements (the 64-cubic oval stays at 128).

Nasty cases (B):

- **Cusp:** two chains with a true corner at the cusp, 16 elements. Correct: the source has no tangent there.
- **Near-cusp** (1 µm off a cusp): the turn happens within the tolerance; two **micro corners** (single lines over pieces shorter than the tolerance where no biarc exists, 1.6·10⁻⁹ mm long here). A and C happen to step over it (no micro corner). These lines are far below the port's 1·10⁻⁴ mm merge limit ([shapes.md § 2D port](../architecture/shapes.md#2d-port)) and must be merged away.
- **Inflections:** B splits there first; deviation 4.3 µm and the same count as A.
- **Control point on the end point:** the tangent comes from B″ (and B‴ if both controls coincide); fine for all.
- **Straight cubic, collinear backtracking, 1 nm off straight:** exact lines (1, 3 and 1–3 lines); the backtracking cubic has two cusps and turns into three collinear lines with corners of 180°.
- **Huge radii:** a 300 mm cubic bowed 1.5 µm gives two arcs of R 7.5 km; bowed 50 µm, two arcs of R 225 m. Replacing the second by a line (as a "radius > 10 m becomes a line" rule would) is 0.05 mm off, five times the tolerance.
- **Tiny:** a 0.05 mm heart takes 6 arcs (shortest 7.5 µm), r 0.005 mm circular arcs stay exact; thin-ellipse ends come down to r 0.03 mm.

## Comparison

| Criterion     | A classic        | B Riskus/Šír                       | C greedy arc spline                                                                                                       |
| ------------- | ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Elements      | baseline         | −7 % corpus, −33 % random cubics   | about equal on smooth corpus cases, explodes elsewhere                                                                    |
| Time          | 55–62 µs / cubic | 27–33 µs / cubic                   | ms to seconds per curve                                                                                                   |
| Robustness    | good             | good (micro corners at near-cusps) | poor: the chain tangent drifts from the curve and the arcs zigzag; needed a bridging biarc, a 5 % margin and a step guard |
| Deviation use | 5–9.6 µm         | 4–9.9 µm                           | always at the edge; the 24-sample estimate missed by 2 % without the margin                                               |
| Code          | smallest         | + inflection roots, incenter       | most                                                                                                                      |

## Recommendation

Build **B** in I1: split at cusps (corners) and at inflections and ellipse vertices (G1 joins), incenter biarcs, midpoint subdivision on error, the sampled estimate with the length guard, the line fallback by sagitta and turn, arcs over 180° split, collinear lines merged, micro corners merged into their neighbours. It is the fastest and smallest output, simple, and passed every case. 20 000 elements (the import limit) is about 2500–3000 cubics (B averages 6.7 elements per cubic on the heart, 7.8 on random cubics); 10 MB of path data can exceed it, so the limit is reachable but generous.

## Changes the draft docs should take

For [shapes.md § Arc fitting](../architecture/shapes.md#arc-fitting) and [design-v0.3.md § SVG import](../modes/design-v0.3.md#svg-import) when they are next edited (not folded in by the spike):

1. **Drop "arcs whose radius exceeds 10 m become lines".** It is not a deviation rule: a 225 m arc over 300 mm is 0.05 mm off its chord. Use the fallback above (sagitta ≤ 0.1 µm and half sweep ≤ 0.1 mrad, budget taken from the tolerance). Whether a huge-radius G2/G3 goes out as `G1` (GRBL works in float32, so km radii lose precision in IJK) is the **post's** decision, by sagitta against its own tolerance — add that to [plan-v0.3.md](../modes/plan-v0.3.md) / [grbl.md](../architecture/grbl.md).
2. **Name the method:** cusp split (corner), inflection and ellipse-vertex split, incenter join, midpoint subdivision, 24-sample estimate with a length guard; the oracle and corpus here become I1's tests.
3. **Cusps are corners.** G1 holds wherever the source has a tangent; the import report should count corners kept at cusps and micro corners (alongside "Béziers fitted, max deviation").
4. **Micro corners** at near-cusps produce elements far below 1·10⁻⁴ mm; the fitter merges them before the shape reaches the port (the existing `segmentTooShort` rule then never fires for imports).
5. **Arcs over 180°** are split in two (bulge ≤ 1 for CavalierContours); circular SVG arcs and full circles therefore give 1–2 elements, not 1.
6. **Element floor:** each fitted curve gives ≥ 2 elements; a merge of consecutive arcs with a common centre (within tolerance) could reduce traced outlines like the 64-cubic oval (136 elements) and is optional.

## Open questions

- Should the oracle (or a cheaper two-sided check) run in I1 production code as a safety net for the report's "max deviation", or only in tests? The in-fit estimate stayed below 9.9 µm for B on every case and 100 random cubics.
