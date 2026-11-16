# Glossary

Status: draft

Industry-standard terms as used in DFYOM. This list seeds the in-app wiki ([principles.md §5](principles.md#5-user-friendly-beginner-friendly-highly-graphical)). One line each; detailed explanations belong to the wiki content, not here.

| Term                | Meaning in DFYOM                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Stock               | Raw material blank a part is cut from; comes from the stock library.                                                               |
| Working area        | Region of the stock a part's design is constrained to.                                                                             |
| Part                | A designed object made of operations and features; a project holds many.                                                           |
| Operation           | A single cutting action: facing, pocketing, drilling, profiling, chamfering, line/curve/shape cut, …                               |
| Feature             | A named group of operations (e.g. a bolt hole = drilling + pocketing + chamfering + threading).                                    |
| Generalized tool    | A tool requirement rather than a concrete tool, e.g. "fly cutter or any finishing end mill ≥ 1/4″".                                |
| Tolerance           | Allowed deviation attached to an operation or surface; loose by default.                                                           |
| Reference           | Datum an operation/surface is dimensioned from; part zero by default.                                                              |
| Tabs                | Small bridges left by cutout operations (profile, line/curve/shape cuts) to hold the part in the stock.                            |
| Plan                | Ordered sequence of setups that manufactures one or more parts.                                                                    |
| Setup               | One fixturing of the stock on a machine: stock + part placement, workholding, probing/zeroing, tool changes, passes.               |
| Workholding         | Devices holding the stock (vises, clamps, vacuum table, …); from a library.                                                        |
| Pass                | One toolpath run of a tool (roughing, finishing, …).                                                                               |
| Air-cutting         | Tool moving at feed rate without engaging material.                                                                                |
| DFM                 | Design for Manufacturability.                                                                                                      |
| gCode               | Machine instruction language exported per setup and executed in run mode.                                                          |
| Virtual machine     | Simulated CNC used for automated testing of runs ([conventions/testing.md](conventions/testing.md)).                               |
| Fillet              | Rounded transition between surfaces; in DFYOM a retained region of a cutting operation.                                            |
| Floor fillet        | Fillet between a pocket floor and its walls (bottom radius); made with a bull-nose or ball end mill.                               |
| Round-over          | Fillet on a convex (top) edge; made with a round-over bit or 3D passes.                                                            |
| Retained region     | DFYOM term: zone inside an operation's removal region that it deliberately leaves standing (tabs, fillets).                        |
| Carving             | Machining a 3D relief surface from vector shapes and profiles; expanded into passes in plan mode.                                  |
| Stepover            | Lateral distance between adjacent passes of a tool.                                                                                |
| Stepdown            | Depth of material removed per pass along Z.                                                                                        |
| Scallop height      | Height of the ridges left between adjacent passes of a rounded tool; limits stepover for a given surface tolerance.                |
| General tolerance   | Tolerance applied to untoleranced dimensions (ISO 2768 / title block tolerance); inherited in DFYOM.                               |
| Symmetric tolerance | Equal upper and lower deviation (`10 ±0.05`).                                                                                      |
| Bilateral tolerance | Different upper and lower deviations (`10 +0.1/−0.05`); unilateral when one is 0.                                                  |
| Limit dimensions    | Tolerance stated as min and max values instead of nominal ± deviations; not in v0.1.                                               |
| Nominal value       | The stated size a tolerance's deviations are measured from.                                                                        |
| Deviation           | Signed difference between a limit and the nominal value (upper and lower deviation).                                               |
| Quantity            | A value with kind, unit, exact value and optional tolerance, as entered by the user ([quantities.md](architecture/quantities.md)). |
| Unit system         | A project's display unit system, metric (mm) or inch.                                                                              |
| Basic dimension     | GD&T: theoretically exact value toleranced by a feature control frame. Not used in DFYOM.                                          |
| Engraving           | Cutting shallow grooves along paths (on-line) or shallow flat-bottom pockets from vector shapes.                                   |
| V-carving           | Engraving with a V-bit whose depth follows the shape's local width, so corners come out sharp.                                     |
| Medial axis         | Centerline of a shape (points equidistant from two or more edges); drives V-carving depth.                                         |
| Vectorization       | Tracing a raster image into vector paths (also "image tracing").                                                                   |
| Working folder      | Unpacked copy of an open project in app data, kept current after every change; used for crash recovery.                            |
| Save history        | The last verified archives of a project, kept in app data ([persistence.md](architecture/persistence.md)).                         |
