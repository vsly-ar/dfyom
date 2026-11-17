# Testing

Status: draft · Principle: [principles.md §2](../principles.md#2-testability)

## Layers

| Layer           | Tool                                                                   | Scope                                                                                                            |
| --------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Unit            | Vitest (`vitest.config.mts`)                                           | `src/core`, `src/shared`, `scripts`. Colocated `*.test.ts` next to the code.                                     |
| Component / UI  | _TBD_ (Vitest + Testing Library or Playwright)                         | Renderer components, tooltips, previews.                                                                         |
| End-to-end      | _TBD_ (Playwright for Electron)                                        | Whole app, driven like a user **and** like an agent ([llm-api.md](../architecture/llm-api.md)).                  |
| Virtual machine | GRBL emulator ([ADR 0013](../decisions/0013-grbl-first-controller.md)) | Simulated CNC controller + simulated devices; run-mode tests without hardware ([modes/run.md](../modes/run.md)). |
| Real machine    | _TBD_                                                                  | LLM-controlled runs on real hardware with minimal developer involvement; opt-in only.                            |
| Performance     | Vitest, `*.perf.ts` (`vitest.perf.config.mts`, `npm run perf`)         | Benchmarks for heavy operations with budgets; not in `npm run check` (flaky timings).                            |

## Commands

- `npm test` – all unit tests once; `npm run test:watch` – watch mode; `npm run perf` – performance budgets (e.g. [geometry](../architecture/geometry.md#performance-budgets-v01)).
- `npm run lint` – ESLint incl. layer import boundaries ([ADR 0015](../decisions/0015-eslint-with-typescript6-api.md)); `npm run lint:fix` applies safe fixes.
- `npm run format` / `npm run format:check` – Prettier (owns formatting; ESLint does not).
- `npm run check` – `typecheck` + `lint` + `format:check` + `test`. Run before committing.
- **CI** ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) runs `npm ci` + `npm run check` on every push and pull request to `main`, with Node from `.nvmrc`.

## Docs lint

`scripts/docs-lint.test.mjs` (part of `npm test`) enforces [documentation.md](documentation.md): every doc is reachable from the [index](../README.md) (directly, via a folder link such as `decisions/`, or via an indexed folder README), has a valid `Status:` line in its first lines and the same status as in the index map, and every relative link and `#anchor` resolves (GitHub heading slugs).
