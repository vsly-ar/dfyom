# Roadmap

Status: accepted

Milestones are vertical slices through all three modes. A milestone lists the docs that must be `accepted` before its implementation starts.

## v0.1 – 2.5D basics to the virtual machine

**Done 2026-11-21.**

**Goal:** prove the whole pipeline with the simplest geometry. Tasks and status: [plans/v0.1.md](plans/v0.1.md).

1. **Design:** rectangular stock from a library; facing, pocket (with inside corner radius), drilling, profile with tabs; values are [quantities](architecture/quantities.md).
2. **Plan:** one setup, one concrete tool per operation, basic passes; gCode export for GRBL ([ADR 0013](decisions/0013-grbl-first-controller.md)).
   - Feeds-and-speeds calculator (surface speed, chip thinning, power) suggesting values when no preset fits ([feeds-speeds.md](architecture/feeds-speeds.md)).
3. **Run:** stream the gCode to the **virtual machine** (GRBL emulator) and show progress.
4. **Cross-cutting:** command layer with undo ([commands.md](architecture/commands.md)), save/open ([persistence.md](architecture/persistence.md)), MCP + CLI access to everything above ([llm-api.md](architecture/llm-api.md)).

Docs to accept first: [quantities](architecture/quantities.md), [geometry](architecture/geometry.md) (kernel decided: [ADR 0007](decisions/0007-layered-geometry-without-brep-kernel.md)), [commands](architecture/commands.md), [persistence](architecture/persistence.md), [design mode](modes/design.md) (v0.1 operations only), plan-mode subset, virtual-machine spec, UI guidelines.

Out of scope: multiple setups, optimization, simulation beyond previews, carving, real machines.

## Direction

From user direction D15 (2026-11-21), accepted with the v0.2 review (D18, 2026-11-22). Goal: a fully working app ready for real work. Milestones take the **shortest path to the full CAM cycle with a reference model**: import a 3D model (STL, then STEP) as a reference, place it on the stock, recreate it in Design with typical operations, Plan it, Run it on the virtual machine. Recreating a reference proves the workflow, and designing complex parts from scratch follows from it. Assistance (align, size, snap, suggested operations) makes recreation fast. Verification order: automated tests for every step and the whole cycle first (golden-path e2e on the virtual machine, hidden windows), then the user by hand and on a real machine, then the user guiding LLM agents through real projects via the agent API and CLI.

## v0.2 – Faces, setups, placement, tools

**Done 2026-11-22.**

Scope from decisions D8–D17, accepted with the v0.2 review (D18, 2026-11-22); visuals approved (D25, 2026-11-22). Tasks, exit criteria and status: [plans/v0.2.md](plans/v0.2.md).

**Goal:** design and machine parts from more than one side, place features where a drawing dimensions them, and choose tools while designing; plus the first step of the reference cycle.

1. **Strategy editing phase 2** (deferred from v0.1 as high priority, D3): plan-only edits of the design snapshot in the inspector and the plan scene drawing the plan's snapshot part. Phase 1 (strategy parameters and "Show calculation") is done ([ui.md](conventions/ui.md#plan-mode-task-37)).
2. **Faces** (D10): operations target any ±X/±Y/±Z face; face picking in the viewport ([design-v0.2.md](modes/design-v0.2.md#faces-and-face-targets), [geometry.md § Non-top faces](architecture/geometry.md#non-top-faces-v02)).
3. **Placement anchors** (Q13 → D16): positions by one of nine points of the feature's bounding box ([design-v0.2.md](modes/design-v0.2.md#placement-anchors)).
4. **Tools in Design** (D11): each operation has a generalized or library tool, chosen automatically on Apply unless the user locked it ([design-v0.2.md](modes/design-v0.2.md#operation-tool)).
5. **Apply** (D13, D14, Q18 → D16): edits commit live; tool choice, draft plans and toolpaths wait for Enter or the "Apply N" button ([apply.md](architecture/apply.md)).
6. **Several setups** (D10, Q15 → D16): Plan derives one setup per approach direction, export per setup, a setup-change prompt in Run; no workholding and no in-process stock yet ([plan-v0.2.md](modes/plan-v0.2.md)).
7. **Reference model, core** (D15, kept in v0.2 by D17): STL import as a ghost stored with the project, placement, fit to stock, visibility; never affects geometry ([reference-model.md](modes/reference-model.md)).
8. **Spike S1** for v0.3: choose the 2D offset and boolean library (lines and arcs) and record it in an ADR.

Docs accepted first (2026-11-22): [design-v0.2.md](modes/design-v0.2.md), [plan-v0.2.md](modes/plan-v0.2.md), [apply.md](architecture/apply.md) ([ADR 0020](decisions/0020-apply-defers-derived-work.md)), [reference-model.md](modes/reference-model.md), [geometry.md § Non-top faces](architecture/geometry.md#non-top-faces-v02), and the [ui.md](conventions/ui.md#design-and-plan-controls-v02) and [persistence.md](architecture/persistence.md#assets-and-references-v02) amendments.

Out of scope: general shapes, Shape Editor and SVG (v0.3); workholding and in-process stock; walls as face targets; user planes; STEP import; measure and snap.

## v0.3 – Shapes

**Done (2026-11-22).**

**In progress** (docs accepted 2026-11-22, D29). Split from v0.2 by D16 (Q14), accepted with the v0.2 review (D18). Named shapes of lines and arcs on any face, cut `inside`, `outside` or on the centreline (Q12): general loops in geometry and toolpaths (pocket clearing with islands, profiles with free-form tabs; free-form floor fillets deferred, Q16), a Shape Editor from primitives with booleans, SVG import with an import report, and shape rotation. Starts from the 2D library chosen by spike S1. Toward the [direction](#direction): **measure and snap to the reference**, since snapping needs shapes and anchors.

Tasks, exit criteria (the user's enclosure recreated with its real outline) and status: [plans/v0.3.md](plans/v0.3.md). Docs accepted first (2026-11-22, D29): [design-v0.3.md](modes/design-v0.3.md), [plan-v0.3.md](modes/plan-v0.3.md), [architecture/shapes.md](architecture/shapes.md) and [ADR 0019](decisions/0019-2d-geometry-library.md); the [ui.md](conventions/ui.md) amendment for the Shape Editor follows before the Shape UI tasks (plan task 1.5). A parallel UI lane (D27, 2026-11-22): the [library window](conventions/ui-library-window.md) (B24) and the [view cube](conventions/ui-view-cube.md) (B25). Right after v0.3: hole-type [features](modes/features.md) (B23, D27).

## v0.4 – Features

**Done (2026-11-22).**

**Accepted** (D34, 2026-11-22: every recommendation of Q28–Q35, ISO metric from M1.6). Hole-type features (B23, D27) as planned right after v0.3: the feature model of [features.md](modes/features.md) (owned operations, read-only, removed only with their feature, D26), the **hole** feature (simple, counterbore, countersink) with ISO metric fastener tables (D30 Q7), the **chamfer operation** on circular edges with a **chamfer mill / V-bit** tool type (D30 Q12) for countersinks, and **Clones** in their first version (one face, source orientation kept, stable numbering; D30). Bounded to about v0.3's size: edge chamfers along shapes, the Field info views framework (D30 Q11), clone rotation, decorative patterns and inch tables come later.

Tasks, exit criteria (a lid for the v0.3 enclosure: countersunk and counterbored holes repeated by Clones) and answered questions: [plans/v0.4.md](plans/v0.4.md). Docs to accept first: [design-v0.4.md](modes/design-v0.4.md), [plan-v0.4.md](modes/plan-v0.4.md), [features.md](modes/features.md) (feature model and Clones), a [ui.md](conventions/ui.md) amendment, and the `tools/list` budget decision in [llm-api.md](architecture/llm-api.md).

## Hardening – make existing features work well (draft)

**Draft** (2026-11-22). Right after v0.4, user direction D43: find and fix bugs, improve UX and AX (agentic experience) and interact with a real machine, driven by the user's dogfood feedback. No new modelling features; the fixes to existing features from the LLM-first test move in from the follow-up below. Toward the [direction](#direction)'s second verification step (the user by hand and on a real machine): the serial connection to a GRBL controller behind an accepted [safety spec](modes/run.md#safety).

Tasks, exit criteria (the user cuts the v0.4 lid on their machine using only the app, and an agent over MCP designs one variant), the dogfood intake and questions Q47–Q54: [plans/hardening.md](plans/hardening.md).

## v0.4 follow-up – LLM-first gaps (draft)

**Draft** (2026-11-22). After v0.4 and the [hardening](#hardening--make-existing-features-work-well-draft) milestone, before v0.5: the user asked to investigate and fix the findings of the [LLM-first black-box test](plans/v0.4-llm-first.md#source) of the installed v0.3.2 app over MCP. Toward the [direction](#direction)'s last verification step (the user guiding agents through real projects) and real-machine readiness: an agent with the MCP tools only must take a reference model to safe programs and measure the result itself.

1. **Workholding** per setup (toe clamps, vise, screws, blocks, spoilboard / fixture plate, tape / vacuum): keep-out in toolpaths, links that hop over clamps, clearance from the highest item, a collision check of every move that guards the export ([workholding.md](modes/workholding.md)).
2. **Reference query** for agents: depth levels, sections as shapes in one call, circular hole detection ([reference-query.md](modes/reference-query.md)).
3. **Shape offset and placement scale**, partial-depth profiles (rabbets) and less DFM noise in waste ([design-llm-first.md](modes/design-llm-first.md)).
4. **Deviation check** of the evaluated part or the simulated cut against the reference ([deviation.md](modes/deviation.md)).
5. Agent API fixes from the test: result sizes, `job.wait` at tool changes, frames in the primer and the program header, the launcher, robust region offsets.

Tasks, exit criteria (an agent with MCP only recreates the enclosure base with four toe clamps, and the app measures the deviation) and questions Q37–Q46 (Q36, the slot, answered by the user): [plans/v0.4-llm-first.md](plans/v0.4-llm-first.md).

Next after the v0.4 follow-up, in the direction's order (unscheduled): STEP import, assisted recreation and deviation view, the golden-path reference cycle with a UX pass, real-machine readiness, LLM-first readiness for full cycles, from-scratch complex parts.

## Later (unordered)

Workholding library (items per setup arrive with the v0.4 follow-up) and in-process stock (air-cut avoidance across setups); walls and user planes as face targets; optimization; simulation and collision checks; vector carving and engraving; real-machine control with the safety spec; sensors and automation.

Low priority: plan warnings, feeds messages and lock reasons in the project's unit system through a message catalogue, as DFM warnings already are (deferred from v0.1 on 2026-11-21; today they are English with canonical units, [plan-v0.1.md](modes/plan-v0.1.md#implementation-task-314)).
