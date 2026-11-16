# Glossary

Status: draft

Industry-standard terms as used in DFYOM. This list seeds the in-app wiki ([principles.md §5](principles.md#5-user-friendly-beginner-friendly-highly-graphical)). One line each; detailed explanations belong to the wiki content, not here.

| Term             | Meaning in DFYOM                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Stock            | Raw material blank a part is cut from; comes from the stock library.                                                 |
| Working area     | Region of the stock a part's design is constrained to.                                                               |
| Part             | A designed object made of operations and features; a project holds many.                                             |
| Operation        | A single cutting action: facing, pocketing, drilling, profiling, chamfering, line/curve/shape cut, …                 |
| Feature          | A named group of operations (e.g. a bolt hole = drilling + pocketing + chamfering + threading).                      |
| Generalized tool | A tool requirement rather than a concrete tool, e.g. "fly cutter or any finishing end mill ≥ 1/4″".                  |
| Tolerance        | Allowed deviation attached to an operation or surface; loose by default.                                             |
| Reference        | Datum an operation/surface is dimensioned from; part zero by default.                                                |
| Tabs             | Small bridges left by cutout operations (profile, line/curve/shape cuts) to hold the part in the stock.              |
| Plan             | Ordered sequence of setups that manufactures one or more parts.                                                      |
| Setup            | One fixturing of the stock on a machine: stock + part placement, workholding, probing/zeroing, tool changes, passes. |
| Workholding      | Devices holding the stock (vises, clamps, vacuum table, …); from a library.                                          |
| Pass             | One toolpath run of a tool (roughing, finishing, …).                                                                 |
| Air-cutting      | Tool moving at feed rate without engaging material.                                                                  |
| DFM              | Design for Manufacturability.                                                                                        |
| gCode            | Machine instruction language exported per setup and executed in run mode.                                            |
| Virtual machine  | Simulated CNC used for automated testing of runs ([conventions/testing.md](conventions/testing.md)).                 |
