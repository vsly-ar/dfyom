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

## Next milestone (v0.2)

Goal and full scope not decided yet. Decided items, in priority order:

1. **Strategy editing in the plan inspector** (high priority, deferred from v0.1 on 2026-11-21): strategy parameters (direction, entry, cycle, allowances …), plan-only edits of the design snapshot, and the feeds calculator's derivation shown in the feeds card. Agents and the CLI already have the commands. With plan-only edits, the plan scene draws the plan's snapshot part instead of the design's current mesh. Known-issue rows in [plans/v0.1.md](plans/v0.1.md#known-issues-and-risks).
   - [x] Phase 1 (done 2026-11-21): strategy parameters in the inspector's Strategy group and the calculator's derivation ("Show calculation", `plan.operation.feeds.get`), [ui.md](conventions/ui.md#plan-mode-task-37).
   - [ ] Phase 2: plan-only edits of the design snapshot and drawing the plan's snapshot part in the plan scene (needs a design doc first).
2. **Faces, setups and tools in Design** (user decisions D10 and D11, 2026-11-21): operations target any ±X/±Y/±Z face, Plan derives one setup per direction, and each design operation has a tool field (generalized or specific, auto-chosen unless locked). Drafts awaiting confirmation: [design-v0.2.md](modes/design-v0.2.md), [plan-v0.2.md](modes/plan-v0.2.md), [geometry.md § Non-top faces](architecture/geometry.md#non-top-faces-v02-draft). Still open: shapes model (Q12), anchors (Q13), v0.2/v0.3 split (Q14), multi-setup without workholding or in-process stock (Q15), free-form fillets (Q16).

3. **Apply** (user decision D13, 2026-11-21): edits commit live; tool choice, draft plans following and toolpath regeneration wait for Enter in a field, Cmd/Ctrl+Enter or a top-right "Apply N" button with an explanatory tooltip; save and export apply first; agents auto-apply per call. Draft awaiting confirmation: [apply.md](architecture/apply.md) (open questions there). Settles Q17 of design-v0.2.

## Later (unordered)

Multiple setups and stock repositioning; optimization; simulation and collision checks; vector carving and engraving; real-machine control with the safety spec; sensors and automation.

Low priority: plan warnings, feeds messages and lock reasons in the project's unit system through a message catalogue, as DFM warnings already are (deferred from v0.1 on 2026-11-21; today they are English with canonical units, [plan-v0.1.md](modes/plan-v0.1.md#implementation-task-314)).
