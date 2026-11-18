# Core principles

Status: accepted

Every feature, doc and PR is checked against these. Each principle links to where it is made concrete.

## 1. LLM-first

Everything a user can do, an LLM must be able to do too – possibly more. This includes multi-agent workflows, multiple app instances and headless operation. When an app window is visible with an agent attached and the user interacts with it, the agent **receives the user's actions**. Run-mode automations can be authored by an LLM (JS/TS/Python/Lua scripts) and/or an LLM session can actively watch a run (hooks, periodic checks) and decide whether to act.

Development is LLM-first too: docs and code are organized so an agent can navigate them.

→ [architecture/llm-api.md](architecture/llm-api.md), [conventions/documentation.md](conventions/documentation.md)

## 2. Testability

Everything is automatically testable with minimal-to-no developer action – including simulated runs on a **virtual machine** and LLM-controlled runs on a real machine.

→ [conventions/testing.md](conventions/testing.md)

## 3. Documentation before implementation

Everything is documented before it is implemented, and docs must not go stale. Docs **link** to the one doc (or code file) that owns a topic instead of restating it. **Contracts live in code** (types/interfaces), with references between code and docs in both directions.

→ [conventions/documentation.md](conventions/documentation.md)

## 4. Explicit errors: Result, Option, AppError, invariant models

Use [`oxide.ts`](https://www.npmjs.com/package/oxide.ts) `Option<T>` / `Result<T, E>` for function return contracts, and an app-specific `AppError` that is **enriched** as it travels up the call chain. Models enforce invariants in a private constructor; a static factory catches, classifies and returns a `Result`, so an invalid model can never exist.

→ [conventions/error-handling/](conventions/error-handling/README.md)

## 5. User-friendly, beginner-friendly, highly graphical

- Use **industry standard terms**; never replace them with simplified language. Make terms clickable in tooltips, leading to wiki-style learning content.
- Visualize as much as possible: illustrations (often **dynamic** to the entered params – e.g. a chamfer drawn with the entered angle and size, a bolt-hole preview), action previews, charts, formulas, animations, tables.
- Tooltips: short, helpful, using **real data**. Wiki help: more detailed, may or may not use real data.
- Show **recommended value ranges** and calculators based on real data, explaining what a value depends on and what it affects.

→ [conventions/ui.md](conventions/ui.md)

## 6. Performance and stability

- Heavy operations run off the UI thread, with observability, UI indication and pause/abort controls; automatic (not user-facing) throttling.
- Optimize reasonably, not prematurely; performance is tested too.
- Logs are on by default (not too verbose), structured, via a library, and integrate with `AppError`.

→ [architecture/overview.md#threading](architecture/overview.md#threading), [conventions/logging.md](conventions/logging.md)

## 7. Helper functions

Typical scenarios (Result, Option, AppError, logging, CLI, …) get prepared, documented helpers instead of ad-hoc code.

→ documented alongside each convention ([error-handling](conventions/error-handling/helpers.md), [logging](conventions/logging.md))
