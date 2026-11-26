# Construction surfaces

Status: accepted (by delegation, 2026-11-26: the user delegated draft confirmation, D70, so the recommended options below are **accepted by delegation (D70, 2026-11-26)** and the user may veto; flagged items are listed under [Flagged](#flagged-for-the-user)) · Hardening [DF118](../plans/hardening.md#intake-user-feedback-goes-here), user TG #369 · Research and reproduction: [2026-11-26-construction-surfaces.md](../research/2026-11-26-construction-surfaces.md) · Builds on: [design-v0.2.md § Surface table](design-v0.2.md#surface-table-per-direction), [geometry.md § Evaluation checks](../architecture/geometry.md#evaluation-checks), [design.md § Ordering and composition](design.md#ordering-and-composition) · Terms: [glossary.md](../glossary.md)

The user asked (TG #369): "if I wouldn't leave a small rim inside the 'Pocket for M5', it would show an error that this reference surface for 'M5 long hole' and 'Chamfer 1' no longer exists (because it was later removed by the chamfer). I guess a virtual surface should remain to be referenced against. Probably as a product of just the operation 'Pocket for M5' against the surface it references. And up the dependency tree to the stock face."

A **construction surface** is a surface of the [surface table](design-v0.2.md#surface-table-per-direction) that later cuts have removed from the finished part. References still resolve to its level: the producing operation applied to the surface it stands on, back to a stock face. That has always been how levels are computed. The [research](../research/2026-11-26-construction-surfaces.md#summary) found that only the mesh-based `dfm.surfaceMissing` check and the mesh-based pick glyphs treated a consumed surface as gone. This doc makes the term explicit, narrows the check and shows the surface.

## Decisions

| Id   | Decision (accepted by delegation, D70)                                                                                                                                                                                                                | Section                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| CS-A | **References stay analytic.** A surface id resolves through the surface table whether or not the finished part still has any of the face. No persistent or topological naming (research option 3)                                                     | [Resolution](#resolution)                 |
| CS-B | **`dfm.surfaceMissing` is replaced** by `dfm.surfaceCutAway` (warning). It is raised only when a later operation that is **not a dependant** of the surface removes all of it. Removal by the surface's own dependants is expected and raises nothing | [Check](#check-dfmsurfacecutaway)         |
| CS-C | **Shown, not hidden:** the `On` field and formula references of a construction surface carry a note "Cut away by Chamfer 1". In the 3D view the surface is drawn as a dashed construction outline at its level, and it can be picked there            | [UI](#ui)                                 |
| CS-D | **Agent API:** the evaluation outcome and `design.warning.list` list the part's construction surfaces with their consumers (output schemas only, `tools/list` unchanged)                                                                              | [Agent API](#agent-api)                   |
| CS-E | **No data change:** nothing is stored (construction is derived per evaluation), `schemaVersion` is unchanged, and there is no migration (pre-alpha rule)                                                                                              | [Persistence](#persistence-and-migration) |

## Resolution

Unchanged, and now a stated rule:

- A surface's level is `on.level − depth` (floors, flat bottoms), or the tab rule for tab tops, from its operation and its `on` surface, recursively down to a stock face ([design-v0.2.md § Surface table](design-v0.2.md#surface-table-per-direction)). Tolerances propagate as before.
- A reference is **valid** when the table defines the id for an earlier operation (`checkReferences`, `design.referenced`), and the operation is not disabled ([design.md § Disabling](design.md#disabling-operations-and-features-df106)). Whether the finished part still has triangles of that surface does not matter.
- **Construction surface** (derived per evaluation): a surface that is referenced (by `on`, `edgeOf`'s face or a formula), is defined by the table, and has no triangles in the evaluated part. A surface that keeps any triangles is an ordinary surface. Partial removal is never reported (as today).

## Check: `dfm.surfaceCutAway`

Replaces `dfm.surfaceMissing` (code, message and test; warnings are derived and never stored, so nothing persists the old code).

- **Dependants of a surface S:** the operations whose `on` is S, or whose formula references S, or whose `edgeOf` operation is a dependant, closed transitively over the [dependency graph](design.md#ordering-and-composition) (`designGraph` plus `edgeOf` and `on`). Owned operations of features count like any other (a hole's countersink standing on its counterbore floor).
- **Consumers of a construction surface S** (owner O, level ℓ, patch P = the face's region at ℓ: a pocket's shape region, a facing's stock face rectangle, a flat drilling bottom's circle, a tab's rectangle): the operations after O whose removal solid intersects the slab P × [ℓ − δ, ℓ] (in O's face frame, δ = 0.001 mm) by more than ε_V. Candidates are filtered by bounds first. This runs only for surfaces that lost all triangles, which is rare, so the evaluation budget is unaffected (measured in V1).
- **Rule:** if every consumer of S is a dependant of S, there is no warning (the user's case: the slot and Chamfer 1 both stand on the recess floor). Otherwise there is one `dfm.surfaceCutAway` per referencing operation and parameter (as today's check), `severity: 'warning'`, `params: { surface, by: [non-dependant consumer ids] }`. Message: "It starts from or refers to Facing 1 floor, which Facing 3 cuts away. Its level still holds, so the cut is measured from a surface the part no longer has. Check the depth or start from another surface."
- **Why keep a warning at all:** an unrelated later cut that erases the datum means the referencing cut's visible depth no longer matches its entered depth. For example, a pocket 5 mm deep from Facing 1's floor is only 3.3 mm deep after a later 2 mm facing. A dependant that cuts away its own face, such as a countersink or a stepped pocket of the same outline, keeps the intent.
- Geometry warnings order, merging and `design.warning.list` behave as for the old check ([design.md § DFM warnings](design.md#dfm-warnings-task-28-wiring)); the row in [geometry.md § Evaluation checks](../architecture/geometry.md#evaluation-checks) is updated in V1.

## UI

- **`On` field and formula references:** when the chosen surface is a construction surface, the field's support area shows a `note` (the standing-note style of design review U9, [ui.md](../conventions/ui.md)): "Cut away by Chamfer 1 · still measured from its level". The (i) tip explains a construction surface in one sentence. A `dfm.surfaceCutAway` warning replaces the note on its field.
- **`On` select:** construction surfaces stay listed (they already are, from the table) with a muted "(construction)" suffix.
- **3D view:** while an operation whose `on` is a construction surface is selected, or while pick mode offers one, the patch P is drawn at its level as a dashed outline in `--vp-selected` with a 12 % fill, and no depth write. That is the CAD datum-plane look, drawn from the evaluation's `construction` patches, not from the mesh. Pick mode places its normal glyph at the patch centroid, so it can be picked like any face. Under reduced motion it appears without the fade.
- **Hover and selection** of a construction surface in the navigator or the On select highlight the same outline. The viewport's text summary names it ("Pocket for M5 floor, cut away by Chamfer 1, shown as an outline.").

## Plan

- **No change to toolpaths or levels:** the plan reads levels from the surface table ([research § Where references are resolved](../research/2026-11-26-construction-surfaces.md#where-references-are-resolved-today)).
- **Z reference:** a construction surface is not a touch-off surface. The existing `cutAway` rule already refuses it with its own message ([z-reference.md](z-reference.md)). Its candidates list is unchanged.
- **Plan copy of the design** and plan operations' Design tab show the same note as the design inspector.

## Agent API

- No new tool and no new arg: `tools/list` is unchanged (≈ 111.6 K of 120 K).
- The evaluation outcome (`design.part.evaluate` via `job_wait` / `job_get`) and `design.warning.list` gain `construction: [{ surface, consumedBy: string[], referencedBy: [{ operationId, param }] }]` (output schema only; empty when none).
- `dfm.surfaceCutAway` replaces `dfm.surfaceMissing` in warnings. The primer ([`primer.ts`](../../src/core/agent/primer.ts)) gains one sentence: "A surface a later cut removes still resolves at its level (a construction surface); stand on it freely."
- `design.measure` `faceCentre` does not target construction surfaces (there are no triangles). Its `near` search is unchanged.

## Persistence and migration

Nothing is stored. `construction` is derived per evaluation, like warnings. No `schemaVersion` bump and no migration ([migrations.md § Pre-alpha](../conventions/error-handling/migrations.md#pre-alpha-exception-no-data-preservation-yet)). Projects such as clamps_40 can drop the 0.05 mm rim after V1.

## Risks

- **A silenced dependant consumption that was a mistake:** a chamfer far too wide eats its floor and nothing warns. Mitigation: the operation's own checks still run (`dfm.chamferTooDeep`, corner and fit checks), the note is visible on the `On` field, and the outline shows in 3D.
- **Coincident planes in the slab test:** a consumer that starts exactly at ℓ (the chamfer's cone top) touches the slab only on its face. Taking the slab below ℓ (δ) and the ε_V threshold make touching not count. V1 tests the clamps case, a same-outline stepped pocket, and a facing erasing a floor.
- **Cost:** the slab intersections run only for referenced surfaces with no triangles. V1 measures a 100-clone part in which every clone consumes its floor, against the evaluation budget ([apply.md](../architecture/apply.md)).

## Slices

| Slice | Scope (one agent each)                                                                                                                                                                                                                                                                                          | Done when                                                                                                                                                                                                                                                                                                                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1    | **Core check.** Dependants closure (`surfaces.ts`), consumers by slab intersection (`checks.ts`), `dfm.surfaceCutAway` replacing `dfm.surfaceMissing` (code list, renderer message, geometry.md row, design.md mentions), `construction` in `PartEvaluation` (ids, consumers, patch polygons in the face frame) | A core test rebuilds clamps_40 (recess, slot, chamfer 3.2 mm wide): no warning, and `construction` lists the recess floor consumed by the chamfer and the slot. Another test: facing 2 mm after a pocket on facing 1's floor gives `dfm.surfaceCutAway` naming the facing. A stepped pocket of the same outline gives no warning. The 100-clone cost is measured and recorded. `npm run check` passes |
| V2    | **Results and agent.** `construction` in `design.warning.list` and the evaluation outcome (output schemas), primer sentence, llm-api.md amendment (`tools/list` unchanged, measured)                                                                                                                            | An agent-tools test sees `construction` for the clamps part and `tools/list` size is unchanged                                                                                                                                                                                                                                                                                                        |
| V3    | **UI.** `On` note and "(construction)" suffix, the 3D dashed outline from the patches, pick glyph at the patch centroid, viewport text summary; ui.md section                                                                                                                                                   | UI test: selecting the slot shows the note and the outline; pick mode offers the consumed floor and picking it sets `on`. Hidden e2e capture of the clamps part reviewed                                                                                                                                                                                                                              |

## Flagged for the user

Nothing here is irreversible (no stored data, no migration). One behaviour change is accepted by delegation but worth a look: **consumption by a dependant no longer warns at all** (CS-B). If you would rather see an info note in the warnings list as well as the field note, say so. It is a one-line severity change in V1.
