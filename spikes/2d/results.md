# Spike S1 results (2026-11-22, Node v26.7.0)

## Offsets: loops (expected) · arcs/lines out · max distance error · crossings

| Case                                                     | d    | cavalier-contours-js 0.1.1         | cavalier_contours 0.9.0 (WASM) | clipper2-ts 2.0.1-19 + re-fit |
| -------------------------------------------------------- | ---- | ---------------------------------- | ------------------------------ | ----------------------------- |
| pocket, 2 islands (in: 10/8)                             | 3    | 3 · 10/8 · 0.00 µm                 | 3 · 10/8 · 0.00 µm             | 3 · 11/9 · 5 µm               |
| pocket, 2 islands (in: 10/8)                             | 8    | 3 · 6/8 · 0.00 µm                  | 3 · 6/8 · 0.00 µm              | 3 · 6/9 · 3 µm                |
| pocket, 2 islands (in: 10/8)                             | 12   | 2 · 6/8 · 0.00 µm                  | 2 · 6/8 · 0.00 µm              | 2 · 6/9 · 4 µm                |
| pocket, 2 islands (in: 10/8)                             | -2   | 3 · 10/8 · 0.00 µm                 | 3 · 10/8 · 0.00 µm             | 3 · 11/9 · 3 µm               |
| neck 4 mm (split) (in: 2/2)                              | 1.9  | 1 · 6/2 · 0.00 µm                  | 1 · 6/2 · 0.00 µm              | 1 · 8/2 · 3 µm                |
| neck 4 mm (split) (in: 2/2)                              | 2.5  | 2 · 6/0 · 0.00 µm                  | 2 · 6/0 · 0.00 µm              | 2 · 8/0 · 3 µm                |
| neck 4 mm (split) (in: 2/2)                              | -1   | 1 · 4/4 · 856 µm · **4 crossings** | 1 · 2/2 · 0.00 µm              | 1 · 4/2 · 3 µm                |
| tangent arcs (wave) (in: 6/3)                            | 1    | 1 · 6/3 · 0.00 µm                  | 1 · 6/3 · 0.00 µm              | 1 · 6/3 · 2 µm                |
| tangent arcs (wave) (in: 6/3)                            | 3    | 1 · 6/3 · 0.00 µm                  | 1 · 6/3 · 0.00 µm              | 1 · 8/6 · 3 µm                |
| tangent arcs (wave) (in: 6/3)                            | 6    | 1 · 3/3 · 0.00 µm                  | 1 · 3/3 · 0.00 µm              | 1 · 3/3 · 3 µm                |
| tangent arcs (wave) (in: 6/3)                            | -2   | 1 · 9/3 · 0.00 µm                  | 1 · 9/3 · 0.00 µm              | 1 · 10/3 · 1 µm               |
| near-tangent (1e-6) (in: 6/3)                            | 1    | 1 · 6/3 · 0.00 µm                  | 1 · 6/3 · 0.00 µm              | 1 · 6/3 · 2 µm                |
| near-tangent (1e-6) (in: 6/3)                            | 3    | 1 · 6/3 · 0.00 µm                  | 1 · 6/3 · 0.00 µm              | 1 · 8/6 · 3 µm                |
| near-tangent (1e-6) (in: 6/3)                            | -2   | 1 · 9/3 · 0.00 µm                  | 1 · 9/3 · 0.00 µm              | 1 · 10/3 · 1 µm               |
| self-touching loop (in: 0/8)                             | 1    | 2 · 0/8 · 0.00 µm                  | 2 · 0/8 · 0.00 µm              | 2 · 0/8 · 0.00 µm             |
| self-touching loop (in: 0/8)                             | -1   | 1 · 6/8 · 0.00 µm                  | 1 · 6/8 · 0.00 µm              | 1 · 6/8 · 0.01 µm             |
| island touches outer (in: 2/4)                           | 1    | 1 · 4/6 · 702 µm                   | 1 · 4/6 · 702 µm               | 1 · 1/5 · 2 µm                |
| island touches outer (in: 2/4)                           | -1   | 2 · 6/4 · 0.00 µm                  | 2 · 6/4 · 0.00 µm              | 2 · 6/5 · 3 µm                |
| island touches outer, normalised by difference (in: 2/4) | 1    | 1 · 3/5 · 0.00 µm                  | 1 · 3/5 · 0.00 µm              | 1 · 1/5 · 2 µm                |
| island touches outer, normalised by difference (in: 2/4) | 3    | 1 · 3/5 · 0.00 µm                  | 1 · 3/5 · 0.00 µm              | 1 · 1/5 · 3 µm                |
| tiny segments (1e-5) (in: 360/396)                       | 2    | 1 · 360/0 · 0.00 µm                | 1 · 360/0 · 0.00 µm            | 1 · 2/0 · 1 µm                |
| tiny segments (1e-5) (in: 360/396)                       | -2   | 1 · 360/0 · 0.00 µm                | 1 · 360/2 · 0.00 µm            | 1 · 16/16 · 2 µm              |
| svg/bracket.svg (in: 12/8)                               | 1    | 4 · 12/8 · 0.00 µm                 | 4 · 12/8 · 0.00 µm             | 4 · 11/11 · 5 µm              |
| svg/bracket.svg (in: 12/8)                               | -1.5 | 4 · 12/8 · 0.00 µm                 | 4 · 12/8 · 0.00 µm             | 4 · 11/11 · 3 µm              |
| svg/gear.svg (in: 38/53)                                 | 1    | 2 · 74/36 · 0.00 µm                | 2 · 74/36 · 0.00 µm            | 2 · 73/37 · 3 µm              |
| svg/gear.svg (in: 38/53)                                 | -1.5 | 2 · 74/36 · 0.00 µm                | 2 · 74/36 · 0.00 µm            | 2 · 73/37 · 3 µm              |
| svg/heart.svg (in: 30/0)                                 | 1    | 1 · 49/0 · 0.00 µm                 | 1 · 49/0 · 0.00 µm             | 1 · 31/6 · 3 µm               |
| svg/heart.svg (in: 30/0)                                 | -1.5 | 1 · 41/0 · 0.00 µm                 | 1 · 41/0 · 0.00 µm             | 1 · 29/0 · 3 µm               |
| svg/letter-d.svg (in: 28/6)                              | 1    | 2 · 45/6 · 0.00 µm                 | 2 · 45/6 · 0.00 µm             | 2 · 30/6 · 3 µm               |
| svg/letter-d.svg (in: 28/6)                              | -1.5 | 2 · 45/6 · 0.00 µm                 | 2 · 45/6 · 0.00 µm             | 2 · 30/6 · 3 µm               |

## Booleans: loops (expected) · arcs/lines out · area error · crossings

| Case                          | cavalier-contours-js 0.1.1 | cavalier_contours 0.9.0 (WASM) | clipper2-ts 2.0.1-19 + re-fit           |
| ----------------------------- | -------------------------- | ------------------------------ | --------------------------------------- |
| rect ∪ circle                 | 1 · 2/4 · 0.0e+0 mm²       | 1 · 2/4 · 0.0e+0 mm²           | 1 · 2/4 · -2.6e-2 mm²                   |
| rounded rect − circle (notch) | 1 · 6/5 · -1.1e-13 mm²     | 1 · 6/5 · -1.1e-13 mm²         | 1 · 5/5 · -1.4e-4 mm²                   |
| rect − inner circle (hole)    | 2 · 2/4 · -1.1e-13 mm²     | 2 · 2/4 · -1.1e-13 mm²         | 2 · 1/5 · 2.4e-3 mm²                    |
| tangent discs ∪               | 1 · 4/0 · 0.0e+0 mm²       | 1 · 4/0 · 0.0e+0 mm²           | 2 · 2/2 · -7.2e-3 mm² · **2 crossings** |
| collinear edges ∪             | 1 · 0/8 · 0.0e+0 mm²       | 1 · 0/8 · 0.0e+0 mm²           | 1 · 0/4 · 0.0e+0 mm²                    |
| near-coincident ∪ (1e-7)      | 1 · 4/4 · -2.0e-6 mm²      | 1 · 4/4 · -2.0e-6 mm²          | 1 · 5/4 · -4.8e-4 mm²                   |

## Pocket rings (tool r = 3, stepover 2.4, up to 20 rings; CavalierContours offsets the previous ring, Clipper the original by the cumulative distance)

| Fixture              | Candidate                         | Rings | Loops total | Arcs/lines total | Max error over steps | Crossings |
| -------------------- | --------------------------------- | ----- | ----------- | ---------------- | -------------------- | --------- |
| pocket, 2 islands    | cavalier-contours-js 0.1.1        | 7     | 21          | 50/54            | 0.00 µm              | 0         |
| pocket, 2 islands    | cavalier_contours 0.9.0 (WASM)    | 7     | 21          | 50/54            | 0.00 µm              | 0         |
| pocket, 2 islands    | clipper2-ts 2.0.1-19 + re-fit     | 7     | 21          | 54/59            | 5 µm                 | 0         |
| pocket, 2 islands    | clipper2-ts (polygons, no re-fit) | 7     | 21          | 0/3031           | 4 µm                 | 0         |
| star 200 + 2 islands | cavalier-contours-js 0.1.1        | 15    | 34          | 622/240          | 0.00 µm              | 0         |
| star 200 + 2 islands | cavalier_contours 0.9.0 (WASM)    | 15    | 34          | 622/240          | 0.00 µm              | 0         |
| star 200 + 2 islands | clipper2-ts 2.0.1-19 + re-fit     | 15    | 34          | 775/259          | 5 µm                 | 0         |
| star 200 + 2 islands | clipper2-ts (polygons, no re-fit) | 15    | 34          | 0/18999          | 5 µm                 | 0         |

## Speed (median ms; Node, this machine). Fixture: filleted star of n segments + 2 islands

| n (outer)                                                             | Candidate                         | 1 offset                                   | 20 successive offsets                      | segments after 20 | union with rotated copy |
| --------------------------------------------------------------------- | --------------------------------- | ------------------------------------------ | ------------------------------------------ | ----------------- | ----------------------- |
| 52                                                                    | cavalier-contours-js 0.1.1        | 0.31                                       | 3.22                                       | 49                | 0.23                    |
| 52                                                                    | cavalier_contours 0.9.0 (WASM)    | 0.04                                       | 0.51                                       | 49                | 0.05                    |
| 52                                                                    | clipper2-ts 2.0.1-19 + re-fit     | 0.68                                       | 107.43                                     | 50                | 0.18                    |
| 52                                                                    | clipper2-ts (polygons, no re-fit) | 0.44                                       | 39.45                                      | 882               | 0.08                    |
| 200                                                                   | cavalier-contours-js 0.1.1        | 0.76                                       | 77.53                                      | 60                | 1.11                    |
| 200                                                                   | cavalier_contours 0.9.0 (WASM)    | 0.14                                       | 1.06                                       | 60                | 0.26                    |
| 200                                                                   | clipper2-ts 2.0.1-19 + re-fit     | 6.77                                       | 969.12                                     | 99                | 1.40                    |
| 200                                                                   | clipper2-ts (polygons, no re-fit) | 3.98                                       | 1014.29                                    | 1846              | 0.74                    |
| 500                                                                   | cavalier-contours-js 0.1.1        | 2.13                                       | 74.29                                      | 135               | 5.11                    |
| 500                                                                   | cavalier_contours 0.9.0 (WASM)    | 0.29                                       | 1.50                                       | 135               | 1.25                    |
| 500                                                                   | clipper2-ts 2.0.1-19 + re-fit     | 96.17                                      | 3832.11                                    | 261               | 4.12                    |
| 500                                                                   | clipper2-ts (polygons, no re-fit) | 100.68                                     | 4260.59                                    | 1846              | 11.36                   |
| 2000                                                                  | cavalier-contours-js 0.1.1        | throws: view data must be valid for source | throws: view data must be valid for source | –                 | 2194.60                 |
| 2000                                                                  | cavalier_contours 0.9.0 (WASM)    | 25.81                                      | 35.90                                      | 1010              | 296.56                  |
| 2000                                                                  | clipper2-ts 2.0.1-19 + re-fit     | 3223.03                                    | 151279.86                                  | 608               | 70.10                   |
| 2000                                                                  | clipper2-ts (polygons, no re-fit) | 836.14                                     | 64526.15                                   | 3542              | 115.98                  |
| Candidate                                                             | Minified                          | gzip -9                                    |
| ---                                                                   | ---                               | ---                                        |
| cavalier-contours-js (Shape offset + boolean)                         | 70.4 KiB                          | 20.2 KiB                                   |
| clipper2-ts (inflatePathsD, unionD, differenceD)                      | 64.9 KiB                          | 17.4 KiB                                   |
| clipper2-ts + spike re-fit + flatten                                  | 67.6 KiB                          | 18.5 KiB                                   |
| cc-wasm JS glue (candidates.ts adapter only)                          | 1.9 KiB                           | 1.0 KiB                                    |
| cc_wasm.wasm (cavalier_contours 0.9.0, opt-level 3, LTO, no wasm-opt) | 255.8 KiB                         | 85.7 KiB                                   |
