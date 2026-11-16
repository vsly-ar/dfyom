# DFYOM documentation

The docs are the **source of truth**. Code implements what is documented here; when they disagree, fix one of them in the same change. How to write and maintain docs: [conventions/documentation.md](conventions/documentation.md).

## Map

| Area         | Document                                                                                                                                 | Status      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Product      | [vision.md](vision.md) – what DFYOM is and who it is for                                                                                 | accepted    |
| Product      | [principles.md](principles.md) – non-negotiable core principles                                                                          | accepted    |
| Product      | [glossary.md](glossary.md) – domain terms (industry standard)                                                                            | draft       |
| Modes        | [modes/design.md](modes/design.md) – DFM-first part design                                                                               | draft       |
| Modes        | [modes/plan.md](modes/plan.md) – setups, toolpaths, optimization, gCode export                                                           | draft       |
| Modes        | [modes/run.md](modes/run.md) – machine control, sensors, automation                                                                      | draft       |
| Architecture | [architecture/overview.md](architecture/overview.md) – processes, source layout, threading                                               | draft       |
| Architecture | [architecture/llm-api.md](architecture/llm-api.md) – LLM/agent access, headless, multi-instance                                          | stub        |
| Conventions  | [conventions/error-handling/](conventions/error-handling/README.md) – Result/Option, AppError, invariant models, Zod parsing, migrations | implemented |
| Conventions  | [conventions/logging.md](conventions/logging.md) – structured logs                                                                       | stub        |
| Conventions  | [conventions/testing.md](conventions/testing.md) – unit → virtual machine → real machine                                                 | draft       |
| Conventions  | [conventions/versioning.md](conventions/versioning.md) – automatic version bump                                                          | accepted    |
| Conventions  | [conventions/documentation.md](conventions/documentation.md) – how docs are written                                                      | accepted    |
| Decisions    | [decisions/](decisions/) – architecture decision records (ADRs)                                                                          | –           |

## Status values

- **stub** – placeholder; scope only, nothing decided.
- **draft** – being designed; may change freely; do not implement yet without confirming.
- **accepted** – agreed; implementation may start / is in progress.
- **implemented** – code exists and links back here.
