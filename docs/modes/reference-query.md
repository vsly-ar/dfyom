# Reference query: levels, sections and holes of a reference model

Status: draft (proposed 2026-11-22 from the [LLM-first black-box test](../plans/v0.4-llm-first.md#source), finding F1; the v0.4 follow-up milestone (after v0.4, before v0.5); decisions below are proposals until the user answers [Q41–Q42](../plans/v0.4-llm-first.md#questions-for-the-user)) · Plan of record: [plans/v0.4-llm-first.md](../plans/v0.4-llm-first.md) · Base: [reference-model.md](reference-model.md) (import, placement, the "reference only" rule) · Section worker: [workers.md](../architecture/workers.md#what-runs-on-a-worker) (`reference.section`) · Shapes and arc fitting: [shapes.md](../architecture/shapes.md) · Agent API: [llm-api.md](../architecture/llm-api.md) · Terms: [glossary.md](../glossary.md)

Today an agent learns nothing about a reference model but its bounding box. In the black-box test it sliced and ray-cast the STL with its own Python scripts to find the cavity depth, the floors, the steps and the four holes, and took the outline from a fixture SVG. The app already cuts the mesh by a plane for the Shape Editor (`reference.section`, U3); this doc exposes that and two more measurements to agents and the UI, in a form that goes straight back into design commands.

The [reference-only rule](reference-model.md#rule-reference-only) stands: queries read the reference, nothing they return is linked to it. A shape made from a section is an ordinary shape that does not follow the mesh.

## Decisions

| Id   | Decision                                                                                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RQ-A | One query, `design.reference.find`, with a `kind` union (`levels`, `section`, `holes`): one MCP tool instead of three (budget, [Q41](../plans/v0.4-llm-first.md#questions-for-the-user)).                                                    |
| RQ-B | **Section → shape in one call** is `design.shape.import` with a reference source (`from`) beside the file path: the same command, the same import report, no new tool.                                                                       |
| RQ-C | Everything is measured **from a face** (a stock face target such as `stock.top`) in that face's [face frame](design-v0.2.md#face-frame), with depths positive into the stock: the frame design commands take, so results need no conversion. |
| RQ-D | Sections come back as **shape items** (`path` with `line`/`arc` segments, `circle` where a loop is a circle), fitted within a tolerance, with numbers as mm strings ready for `design.shape.add`.                                            |
| RQ-E | The queries run in the compute worker on the mesh it keeps per asset. Queries are synchronous today, so they need an **async query** kind ([Q42](../plans/v0.4-llm-first.md#questions-for-the-user), an ADR with the llm-api amendment).     |

## The query

`design.reference.find { partId, referenceId?, face?, kind, … }` – `referenceId` defaults to the part's only reference (refused with `input.malformed`, rule `referenceAmbiguous`, when there are several); `face` is a stock face target (default `stock.top`; operation surfaces are refused, rule `stockFaceOnly`, since a reference is placed on the stock). All lengths in results are mm numbers (levels, holes) or mm strings (shape items), rounded to 0.001 mm.

### `levels`: depth levels

Args: `{ kind: 'levels', limit?: 32, minArea?: 1 mm² }`.

- The mesh's triangles whose normal lies within 0.5° of the face's axis (±n), grouped into **levels** by height (triangles within 0.005 mm of each other's plane join one level).
- Each level: `{ depth, facing, area, bounds: [[u, v], [u, v]] }` – `depth` below the face at the stock level (0 = the stock face; negative above it, which happens when the reference sticks out); `facing` `up` (a floor seen from this face: machinable from it) or `down` (a ceiling: only from the opposite face); `area` in mm²; `bounds` in the face frame.
- Sorted by depth; at most `limit` (largest areas win), with `more: n` when cut. Levels under `minArea` are dropped.
- In the black-box test this one call gives the cavity floor (34.81 from the top), the part bottom, and the two bottom steps (1.77 / 4.19 from the bottom).

### `section`: a cut at a depth

Args: `{ kind: 'section', depth, tolerance?: 0.01 mm, loops?: 'all' | 'outer' | 'holes' }`.

- The mesh cut by the plane parallel to the face at `depth` (the worker task `reference.section`), its segments chained into closed loops (ends welded within 1e-4 mm; an unclosed chain from an open mesh is returned as an open path with `open: true`), oriented as a [region](../architecture/shapes.md#2d-model) (outer loops CCW, holes CW, by nesting) and **fitted** to lines and arcs within `tolerance` ([§ Fitting](#fitting-sections)).
- Result: `{ face, depth, loops: [{ role: 'outer' | 'hole', area, bounds, item }], fit: { elements, maxDeviation, corners } }`. `item` is a shape item in the face frame: a `circle { center, diameter }` when every point of the loop lies within `tolerance` of a circle, otherwise a closed `path { start, segments }`.
- Size guard: at most 5000 elements in total, else refused (`input.malformed`, rule `tooLarge`, with the element count and a hint to raise `tolerance` or use `loops`).

### `holes`: circular holes along the face's axis

Args: `{ kind: 'holes', maxDiameter?: 50 mm, limit?: 64 }`.

- Built from levels and sections: a section at the middle of every gap between consecutive levels (and just under the face); a loop with role `hole` that is a circle (fit within 0.02 mm) is a hole slice; slices whose centres agree within 0.05 mm stack into one hole.
- Each hole: `{ center: [u, v], diameter, depth, bottom, mouth?, steps }` – `depth` from the face; `bottom` `through` (it reaches the opposite stock face), `flat` or `cone` (with `coneAngle`, from the bottom's triangles); `mouth` `{ type: 'countersink', diameter, angle }` or `{ type: 'counterbore', diameter, depth }` when the top slices widen; `steps` the diameter per depth band for anything else.
- Only holes whose axis is the face's normal; the others show from the face they open on. Circular **bosses** (circle loops with role `outer`) are not holes and are left out.
- The black-box test's four bottom holes come back as Ø 2.44 × 3.94, `bottom: flat`, mouth flared to ≈ Ø 4.9: enough for a drilling, or a countersink [hole feature](design-v0.4.md#hole-feature) once v0.4 has it.

## Section to shape

`design.shape.import { partId, from: { referenceId?, face?, depth, tolerance?, loops? }, name?, split? }` – `from` and `path` are exclusive. The section is computed and fitted as above, then imported exactly as an SVG import's shapes are ([design-v0.3.md § SVG import](design-v0.3.md#svg-import)): `split` decides one region shape or one shape per outer loop with its holes; names default to "Section 12.5 mm" (+ " 2", …); the result carries the import report (elements, fitted arcs, max deviation, corners kept). One undo step; instant reaction.

- The shapes are in the face frame of `face`, so a pocket or profile on that face with the `named` shape at anchor `min`/`min` and `center` at the shape's own min corner lands exactly where the reference is. The result also returns that placement (`placeAt: { center, anchor }`) so the agent does not compute it.
- The Shape Editor gets "Section to shape" next to the section depth field (same command; [ui.md § Shape Editor](../conventions/ui.md) amendment, plan task 1.6).

## Fitting sections

A mesh section is a polyline whose vertices lie on the true surface and whose chords cut corners by the STL's own chord error. SVG import fits Béziers ([shapes.md § Arc fitting](../architecture/shapes.md#arc-fitting)); this needs a **polyline fitter** (`fitPolyline(points, tolerance, cornerAngle)` in the 2D layer):

- Corners: a vertex where the direction turns more than `cornerAngle` (default 15°) between neighbouring chords is kept as a corner; between corners the run is fitted with lines and tangent arcs (G1 continuous inside a run) so every input point lies within `tolerance` of the result.
- Spike S8 picks the method (biarcs through chord midpoints vs least-squares arc runs) on the enclosure STL: the outline and cavity sections in ≤ 300 elements each at 0.01 mm, within 0.02 mm of the section, no slivers under 0.05 mm.

## Performance

The worker keeps the last mesh read per asset (`reference.section` already does). Targets on the enclosure STL (49 806 triangles): `levels` < 100 ms, `section` with fitting < 200 ms, `holes` < 1 s; at the 1 M triangle warn limit, ten times that. New worker tasks `reference.levels` and `reference.holes`; `reference.section` gains chaining, orientation and fitting.

## Commands and queries

| Command / query         | Kind                                      | Args / result                           |
| ----------------------- | ----------------------------------------- | --------------------------------------- |
| `design.reference.find` | async query ([RQ-E](#decisions))          | [§ The query](#the-query)               |
| `design.shape.import`   | document command (existing; gains `from`) | [§ Section to shape](#section-to-shape) |

Errors: no reference or its asset unreadable (`input.malformed`, rules `noReference`, `unreadableFile`); a plane that misses the mesh is not an error (`loops: []`, a note). Budget: `find` ≈ 1.0 K characters of `tools/list`, `from` ≈ 0.3 K.

## UI (summary)

- Reference panel ([ui.md § Reference panel](../conventions/ui.md#reference-panel-hardening-df2df8); the reference inspector until DF3): a "Depths" list from `levels` (depth, facing, area); clicking one sets the Shape Editor's section depth.
- Shape Editor: "Section to shape" ([above](#section-to-shape)).
- Detected holes as markers on the ghost: later, with assisted recreation.

## Testing

- The enclosure STL fixture: `levels` finds the cavity floor, the bottom and both steps within 0.01 mm of the black-box test's values; `section` at mid-wall height matches the v0.3 X1 deviation check's section within 0.02 mm; `holes` from `stock.bottom` finds four holes at (±88.53, ±44.27) from the centre, Ø 2.44 ± 0.02.
- Synthetic meshes (the evaluated test part written as STL, as `stl.test.ts` does): counterbore, countersink, through and blind holes, a boss, an open mesh.
- Section → shape round trip: import, evaluate a pocket with it, section the part at the same depth: two-sided distance ≤ the tolerance.

## Not yet

| Item                                                               | Where                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| Silhouette (outline of the whole model seen from a face)           | Later; a section near the widest level serves                |
| Feature recognition into operations (pockets, steps, holes as ops) | Assisted recreation, later                                   |
| Holes along other axes than face normals; slots and obrounds       | With assisted recreation                                     |
| STEP references (exact faces instead of facets)                    | STEP import ([reference-model.md](reference-model.md#later)) |
