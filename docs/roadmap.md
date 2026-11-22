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

## Direction (draft proposal)

**Draft, from user direction D15 (2026-11-21); confirm at the v0.2 review.** Goal: a fully working app ready for real work. Milestones take the **shortest path to the full CAM cycle with a reference model**: import a 3D model (STL, then STEP) as a reference, place it on the stock, recreate it in Design with typical operations, Plan it, Run it on the virtual machine. Recreating a reference proves the workflow, and designing complex parts from scratch follows from it. Assistance (align, size, snap, suggested operations) makes recreation fast. Verification order: automated tests for every step and the whole cycle first (golden-path e2e on the virtual machine, hidden windows), then the user by hand and on a real machine, then the user guiding LLM agents through real projects via the agent API and CLI.

## v0.2 – Faces, setups, placement, tools (draft)

**Draft: scope assumed by decisions D8–D16 (2026-11-21), awaiting the user's batched review.** Tasks, exit criteria and the list of assumptions: [plans/v0.2.md](plans/v0.2.md).

**Goal:** design and machine parts from more than one side, place features where a drawing dimensions them, and choose tools while designing; plus the first step of the reference cycle.

1. **Strategy editing phase 2** (deferred from v0.1 as high priority, D3): plan-only edits of the design snapshot in the inspector and the plan scene drawing the plan's snapshot part. Phase 1 (strategy parameters and "Show calculation") is done ([ui.md](conventions/ui.md#plan-mode-task-37)).
2. **Faces** (D10): operations target any ±X/±Y/±Z face; face picking in the viewport ([design-v0.2.md](modes/design-v0.2.md#faces-and-face-targets), [geometry.md § Non-top faces](architecture/geometry.md#non-top-faces-v02-draft)).
3. **Placement anchors** (Q13 → D16): positions by one of nine points of the feature's bounding box ([design-v0.2.md](modes/design-v0.2.md#placement-anchors)).
4. **Tools in Design** (D11): each operation has a generalized or library tool, chosen automatically on Apply unless the user locked it ([design-v0.2.md](modes/design-v0.2.md#operation-tool)).
5. **Apply** (D13, D14, Q18 → D16): edits commit live; tool choice, draft plans and toolpaths wait for Enter or the "Apply N" button ([apply.md](architecture/apply.md)).
6. **Several setups** (D10, Q15 → D16): Plan derives one setup per approach direction, export per setup, a setup-change prompt in Run; no workholding and no in-process stock yet ([plan-v0.2.md](modes/plan-v0.2.md)).
7. **Reference model, core** (proposal from the user's direction, 2026-11-21): STL import as a ghost stored with the project, placement, fit to stock, visibility; never affects geometry ([reference-model.md](modes/reference-model.md)).
8. **Spike S1** for v0.3: choose the 2D offset and boolean library (lines and arcs) and record it in an ADR.

Docs to accept first: [design-v0.2.md](modes/design-v0.2.md), [plan-v0.2.md](modes/plan-v0.2.md), [apply.md](architecture/apply.md), [reference-model.md](modes/reference-model.md), [geometry.md § Non-top faces](architecture/geometry.md#non-top-faces-v02-draft), and the ui.md and persistence.md amendments they name.

Out of scope: general shapes, Shape Editor and SVG (v0.3); workholding and in-process stock; walls as face targets; user planes; STEP import; measure and snap.

## v0.3 – Shapes (draft)

**Draft (split assumed by D16, Q14).** Named shapes of lines and arcs on any face, cut `inside`, `outside` or on the centreline (Q12): general loops in geometry and toolpaths (pocket clearing with islands, profiles with free-form tabs; free-form floor fillets deferred, Q16), a Shape Editor from primitives with booleans, SVG import with an import report, and shape rotation. Starts from the 2D library chosen by spike S1. Toward the [direction](#direction-draft-proposal): **measure and snap to the reference**, since snapping needs shapes and anchors.

Next after v0.3, in the direction's order (unscheduled): STEP import, assisted recreation and deviation view, the golden-path reference cycle with a UX pass, real-machine readiness, LLM-first readiness for full cycles, from-scratch complex parts.

## Later (unordered)

Workholding library and in-process stock (air-cut avoidance across setups); walls and user planes as face targets; optimization; simulation and collision checks; vector carving and engraving; real-machine control with the safety spec; sensors and automation.

Low priority: plan warnings, feeds messages and lock reasons in the project's unit system through a message catalogue, as DFM warnings already are (deferred from v0.1 on 2026-11-21; today they are English with canonical units, [plan-v0.1.md](modes/plan-v0.1.md#implementation-task-314)).
