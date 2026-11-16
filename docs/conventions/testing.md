# Testing

Status: draft · Principle: [principles.md §2](../principles.md#2-testability)

## Layers

| Layer           | Tool                                           | Scope                                                                                                            |
| --------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Unit            | Vitest (`vitest.config.mts`)                   | `src/core`, `src/shared`, `scripts`. Colocated `*.test.ts` next to the code.                                     |
| Component / UI  | _TBD_ (Vitest + Testing Library or Playwright) | Renderer components, tooltips, previews.                                                                         |
| End-to-end      | _TBD_ (Playwright for Electron)                | Whole app, driven like a user **and** like an agent ([llm-api.md](../architecture/llm-api.md)).                  |
| Virtual machine | _TBD_                                          | Simulated CNC controller + simulated devices; run-mode tests without hardware ([modes/run.md](../modes/run.md)). |
| Real machine    | _TBD_                                          | LLM-controlled runs on real hardware with minimal developer involvement; opt-in only.                            |
| Performance     | _TBD_                                          | Benchmarks for heavy operations with budgets.                                                                    |

## Commands

- `npm test` – all unit tests once; `npm run test:watch` – watch mode.
- `npm run check` – typecheck + tests (run before committing).
