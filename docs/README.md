# DFYOM documentation

The docs are the **source of truth**. Code implements what is documented here; when they disagree, fix one of them in the same change. How to write and maintain docs: [conventions/documentation.md](conventions/documentation.md).

## Map

| Area         | Document                                                                                                                                 | Status      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Product      | [vision.md](vision.md) – what DFYOM is and who it is for                                                                                 | accepted    |
| Product      | [principles.md](principles.md) – non-negotiable core principles                                                                          | accepted    |
| Product      | [roadmap.md](roadmap.md) – milestones as vertical slices                                                                                 | accepted    |
| Product      | [plans/v0.1.md](plans/v0.1.md) – v0.1 tasks and status (living document)                                                                 | accepted    |
| Product      | [glossary.md](glossary.md) – domain terms (industry standard)                                                                            | draft       |
| Modes        | [modes/design.md](modes/design.md) – DFM-first part design; v0.1 operations                                                              | accepted    |
| Modes        | [modes/plan.md](modes/plan.md) – setups, toolpaths, optimization, gCode export                                                           | draft       |
| Modes        | [modes/plan-v0.1.md](modes/plan-v0.1.md) – v0.1 plan subset: plan snapshots and status, one setup, tools, pass strategies, toolpaths     | accepted    |
| Modes        | [modes/run.md](modes/run.md) – machine control, sensors, automation                                                                      | draft       |
| Architecture | [architecture/overview.md](architecture/overview.md) – processes, source layout, threading                                               | draft       |
| Architecture | [architecture/llm-api.md](architecture/llm-api.md) – LLM/agent access, headless, multi-instance                                          | stub        |
| Architecture | [architecture/commands.md](architecture/commands.md) – shared command layer for UI, agents, CLI                                          | implemented |
| Architecture | [architecture/persistence.md](architecture/persistence.md) – project archive, working folder, save/recovery                              | accepted    |
| Architecture | [architecture/quantities.md](architecture/quantities.md) – units, tolerances, expressions (value objects)                                | implemented |
| Architecture | [architecture/geometry.md](architecture/geometry.md) – removal-based geometry, cutting-operation framework, layers                       | accepted    |
| Architecture | [architecture/library.md](architecture/library.md) – stock, tool and machine library; snapshots                                          | accepted    |
| Architecture | [architecture/feeds-speeds.md](architecture/feeds-speeds.md) – feeds-and-speeds calculator (surface speed, chip thinning, power)         | accepted    |
| Architecture | [architecture/grbl.md](architecture/grbl.md) – GRBL post-processor and virtual machine (emulator)                                        | accepted    |
| Conventions  | [conventions/error-handling/](conventions/error-handling/README.md) – Result/Option, AppError, invariant models, Zod parsing, migrations | implemented |
| Conventions  | [conventions/logging.md](conventions/logging.md) – structured logs                                                                       | implemented |
| Conventions  | [conventions/testing.md](conventions/testing.md) – unit → virtual machine → real machine                                                 | draft       |
| Conventions  | [conventions/versioning.md](conventions/versioning.md) – automatic version bump                                                          | implemented |
| Conventions  | [conventions/documentation.md](conventions/documentation.md) – how docs are written                                                      | accepted    |
| Decisions    | [decisions/](decisions/) – architecture decision records (ADRs)                                                                          | –           |

## Status values

- **stub** – placeholder; scope only, nothing decided.
- **draft** – being designed; may change freely; do not implement yet without confirming.
- **accepted** – agreed; implementation may start / is in progress.
- **implemented** – code exists and links back here.
