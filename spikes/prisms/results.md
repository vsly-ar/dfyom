# Spike S3 results: labelled prisms of regions

Status: draft (spike report, 2026-11-22; Apple M1 Pro, Node v26.7.0, manifold-3d 3.5.4) · Task: [plans/v0.3.md § Spikes](../../docs/plans/v0.3.md#2-spikes) (S3) · Design: [shapes.md § Geometry for shape operations](../../docs/architecture/shapes.md#geometry-for-shape-operations) · Base: [geometry.md § Non-top faces](../../docs/architecture/geometry.md#non-top-faces-v02)

Question: can pockets of general regions (outer loop plus islands, lines and arcs) be built as labelled Manifold prisms – caps with holes by Manifold's `triangulate`, a wall per element – and subtracted from the stock on any face within the 50 ms evaluation budget, without slivers where cuts from two directions meet?

## What was built

Throwaway code in this folder against `src/core/geometry` (no app code changed):

- [`region.ts`](region.ts): the 2D model of shapes.md (`line` / `arc` elements, loops, regions), inscribed flattening at the 0.01 mm chord tolerance with the element index per chord, and two generators: **star** (one scalloped outer loop of lines and concave arcs, two circular islands) and **islands** (rounded-rectangle outer loop and a grid of rounded-square islands).
- [`prism.ts`](prism.ts): the labelled prism. Walls are quads per chord labelled `wall[i]` / `corner[i]` by element (index over all loops, loop 0 first); the floor cap (`floor`) and top cap (`air`) come from one `triangulate` call on the rings. Placement either as v0.2 does (`local`: vertices around the bounding-box centre, the floor level in the float64 placement) or `part`: every vertex placed into the part frame in float64, then the float32 mesh I/O.
- [`evaluate.ts`](evaluate.ts): a cut-down `evaluatePart` (stock − ∪ prisms, labels per triangle, `decompose` for pieces; no DFM checks) with a timing breakdown. [`stock.ts`](stock.ts): the stock with its faces split into tiles (see below).
- [`slivers.ts`](slivers.ts): a top pocket and a side pocket that abut on a plane perpendicular to both faces, share the floor level and the inner bound (non-dyadic sizes); with exact placement that plane disappears from the part, so every triangle left in it is a membrane or a step.
- Tests and tables: `npx vitest run -c spikes/prisms/vitest.config.mts --silent=false` ([`prisms.test.ts`](prisms.test.ts) plus three `profile-*.test.ts`). Typecheck: `npx tsc -p spikes/prisms`.

## Correctness

- Every element label survives the subtraction (500 and 2000 elements, star and islands, `+z`, `+x`, `-z`, both placements, plain and tiled stock); no `air` triangles; one piece; removed volume = flattened area × depth within 0.1 %.
- `triangulate` handles concave loops with holes (250 islands in one cap) and returns CCW triangles covering the area exactly. No new dependency: it is in manifold-3d.
- `CrossSection.extrude` of the same rings costs the same as the labelled mesh (star 2000: 141 vs 140 ms subtract), but cannot label walls per element. Labels are free.

## Cost (median of 15, `part` placement)

| Case                                                  | Elements | Chords | Triangles | Triangulate | To solid | Union + subtract | Total     | Tiled: union + subtract | Tiled: total |
| ----------------------------------------------------- | -------- | ------ | --------- | ----------- | -------- | ---------------- | --------- | ----------------------- | ------------ |
| star `+z`                                             | 50       | 365    | 1 472     | 0.96        | 1.08     | 3.7              | **6.2**   | 3.6                     | **7.0**      |
| islands `+z`                                          | 48       | 336    | 1 356     | 1.00        | 1.00     | 3.2              | **5.7**   | 3.8                     | **7.2**      |
| star `+z`                                             | 500      | 1 104  | 4 428     | 3.7         | 3.1      | 14.7             | **22.5**  | 9.8                     | **18.3**     |
| star `+x`                                             | 500      | 800    | 3 212     | 2.5         | 2.3      | 12.8             | **18.5**  | 8.5                     | **14.8**     |
| islands `+z`                                          | 504      | 2 288  | 9 164     | 6.8         | 7.3      | 20.2             | **36.4**  | 21.6                    | **38.7**     |
| islands `+x`                                          | 504      | 1 544  | 6 188     | 4.8         | 4.9      | 12.9             | **24.4**  | 13.8                    | **25.8**     |
| star `+z`                                             | 2000     | 3 106  | 12 436    | 16.2        | 9.3      | 140.0            | **168.5** | 31.3                    | **59.7**     |
| star `+x`                                             | 2000     | 2 052  | 8 220     | 8.5         | 6.0      | 69.4             | **85.8**  | 29.7                    | **46.9**     |
| islands `+z`                                          | 2000     | 7 028  | 28 124    | 25.4        | 22.7     | 58.3             | **111.8** | 61.2                    | **115.2**    |
| islands `+x`                                          | 2000     | 5 036  | 20 152    | 18.3        | 15.7     | 39.1             | **81.5**  | 41.1                    | **84.1**     |
| 3 ops: star `+z` 200, islands `−z` 200, star `+x` 100 | 500      | 2 012  | 8 074     | 5.5         | 5.7      | 27.0             | **40.0**  | 25.5                    | **39.3**     |

Times in ms. Flattening (≤ 0.25), mesh build (≤ 1), `toMesh` + labels (≤ 3.5) and `decompose` (≤ 4.3) are small and left out. The full table is printed by the test. `local` placement costs the same (3 ops: 39.9 ms).

- **The shapes.md budget holds:** three shape operations with 500 elements in all evaluate in 40 ms (budget 50), single 500-element pockets in 15–39 ms.
- **2000 elements do not fit:** 82–169 ms plain, 47–115 ms tiled. Cost follows **chords**, not elements: after tiling ≈ 16 µs per chord (triangulate ≈ 3.6, `fromMesh` ≈ 3.2, booleans ≈ 8), so 50 ms ≈ 3 000 chords per evaluation.

## Where the time goes

- **Caps are not the problem.** Our `triangulate` is 10–25 % of the total (16 ms for the 3 106-chord star). The plan's fallback "fan caps from the region's rings" is not needed, and a fan is only valid for star-shaped loops.
- **Manifold re-triangulates every crossed face as one polygon, and that is quadratic in the chords of the loop crossing it** ([`profile-loops.test.ts`](profile-loops.test.ts)). Subtracting a prism from the plain stock box: a circle of 1 000 / 3 000 / 6 000 chords costs 21 / 154 / 547 ms. A zigzag is cheaper, but just as quadratic. A pocket that is fully inside the stock (no face crossed) costs 8 ms for the 2000-element star; a through pocket (two faces crossed) costs 274 ms. `setTolerance(1e-4)` changes nothing.
- **Tiling the crossed face makes it near-linear** ([`profile-tiles.test.ts`](profile-tiles.test.ts)): with the stock faces split into tiles of their own face id (all labelled as the face), the 6 000-chord circle costs 561 → 78 ms (16 × 8 tiles), and the 3 000-chord circle 159 → 31 ms. In the spike evaluation, 15 mm tiles take the 2000-element star from 169 to 60 ms. They add ≈ 600 output triangles on a 200 × 120 × 30 stock, and change nothing where many short loops cross instead (islands).

## Slivers where two directions meet

The v0.2 backlog issue ([plans/v0.2.md § Known issues](../../docs/plans/v0.2.md#known-issues-and-risks): walls of two directions differ by float32 rounding). A top pocket and a side pocket abut on a shared plane, with the same floor level and the same inner bound, over 60 seeded cases (sides `±x`, `±y`, non-dyadic stock and positions):

| Placement                                                     | Cases with triangles in the shared plane | Cases with triangles thinner than 0.1 µm | Tiny pieces | Pieces ≠ 1 |
| ------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------- | ----------- | ---------- |
| `local` (v0.2: mesh around an offset, floor level in float64) | **33 / 60** (fixed case: 16 triangles)   | 34 / 60                                  | 0           | 0          |
| `part` (every vertex placed in float64, then float32)         | **0 / 60**                               | 0 / 60                                   | 0           | 0          |

The slivers are steps and membranes that stay attached, so they never show up as loose pieces: the ε_V piece filter does not hide them. In the `local` placement each mesh rounds its own offsets to float32. In the `part` placement, the same part-frame value rounds to the same float32 in every mesh, so walls meet walls and floors as exactly as levels meet in v0.2. Precision stays well inside the chord tolerance: half a float32 ulp is 3.8 nm at 100 mm and 30 nm at 1 m. The `part` placement costs nothing extra.

## Recommendation

1. **Build shape pockets as labelled prisms with Manifold's `triangulate`**, as shapes.md drafts. The caps fallback is not needed. Expose `triangulate` through the manifold adapter: it is plain data in and out, outside the arena, on the same module instance. The spike loaded a second instance.
2. **Place every vertex in float64 in the part frame before the float32 mesh I/O**, for every mesh, the stock included. This replaces the A1b "key level in the placement" rule and closes the wall-sliver backlog issue. G2 can fold into G1. It changes v0.1/v0.2 meshes by float32 rounding, so the golden files would change.
3. **Tile planar faces that later operations cross:** the stock faces and the floors of facings (≈ 15 mm tiles, several face ids mapped to one surface role). This bounds Manifold's quadratic face re-triangulation.
4. **State the budget in chords:** ≤ 50 ms for about 3 000 chords per evaluation. A 2000-element shape (5 000–7 000 chords) takes 60–115 ms even tiled. Either accept that as a documented limit (each subtraction stays ≤ 61 ms as one step), or reconsider the chord tolerance for such shapes.

## Open points for the docs

- design-v0.3.md § Surfaces: is `i` in `wall[i]` / `corner[i]` the element index over all loops (as the spike did), or counted per role as rectangles do (`wall[0..3]`, `corner[0..3]`)?
- Not measured: tabs on general loops, profile slot bands (`offset` needs the 2D port), and Manifold versions newer than 3.5.4, whose triangulator may scale differently.
