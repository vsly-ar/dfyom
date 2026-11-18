# Testing

Status: draft · Principle: [principles.md §2](../principles.md#2-testability)

## Layers

| Layer           | Tool                                                                                                       | Scope                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Unit            | Vitest (`vitest.config.mts`)                                                                               | `src/core`, `src/shared`, `scripts`. Colocated `*.test.ts` next to the code.                                                   |
| Component / UI  | _TBD_ – proposal in [ui.md](ui.md#testing)                                                                 | Renderer components, tooltips, previews.                                                                                       |
| End-to-end      | Vitest, spawned bundled CLI (headless); _TBD_ for the UI (Playwright for Electron, [ui.md](ui.md#testing)) | Whole app, driven like a user **and** like an agent ([llm-api.md](../architecture/llm-api.md)); see [End-to-end](#end-to-end). |
| Virtual machine | GRBL emulator ([ADR 0013](../decisions/0013-grbl-first-controller.md))                                     | Simulated CNC controller + simulated devices; run-mode tests without hardware ([modes/run.md](../modes/run.md)).               |
| Real machine    | _TBD_                                                                                                      | LLM-controlled runs on real hardware with minimal developer involvement; opt-in only.                                          |
| Performance     | Vitest, `*.perf.ts` (`vitest.perf.config.mts`, `npm run perf`)                                             | Benchmarks for heavy operations with budgets; not in `npm run check` (flaky timings).                                          |

## Commands

- `npm test` – all unit tests once; `npm run test:watch` – watch mode; `npm run perf` – performance budgets (e.g. [geometry](../architecture/geometry.md#performance-budgets-v01)).
- `npm run lint` – ESLint incl. layer import boundaries ([ADR 0015](../decisions/0015-eslint-with-typescript6-api.md)); `npm run lint:fix` applies safe fixes.
- `npm run format` / `npm run format:check` – Prettier (owns formatting; ESLint does not).
- `npm run check` – `typecheck` + `lint` + `format:check` + `test`. Run before committing.
- **CI** ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) runs `npm ci` + `npm run check` on every push and pull request to `main`, with Node from `.nvmrc`.

## End-to-end

The [v0.1 exit criteria](../plans/v0.1.md#exit-criteria) as tests (task 3.11). **Headless (done):** `src/main/cli/exit-criteria.fixture.ts` holds the flow once, with an assertion per criterion; two transports run it against the bundled CLI (`node_modules/.cache`, built by the Vitest global setup) with a temp `--data-dir`:

- `exit-criteria.mcp.test.ts`: an MCP SDK client spawns `dfyom mcp` over stdio; also checks the run's MCP progress notifications, and that CI runs `npm run check` (the third criterion).
- `exit-criteria.batch.test.ts`: `dfyom batch`, one JSON line per call, answered line by line (so tool changes can be continued).

| Criterion step                                                            | Asserted                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project with a rectangular stock                                          | `project.create`; the part's stock copy is a 100 × 60 × 20 block.                                                                                                                                                                                                                                    |
| Facing, pocket (corner radius, floor fillet), drilling, profile with tabs | The part's operations in order with their corner radius, floor radius and tab count; evaluation `done`.                                                                                                                                                                                              |
| Plan one setup                                                            | One setup; every design operation machined exactly once; toolpaths generated for every plan operation.                                                                                                                                                                                               |
| Export GRBL gCode                                                         | `plan.export` at the virtual machine's G54: soft-limit check ran, no warnings; the file equals the golden file `src/main/cli/__golden__/exit-criteria-bracket.nc` byte for byte; line count.                                                                                                         |
| Run on the virtual machine with progress shown                            | `run.job.start` at `max`: each tool change (marker + `M0`) and spindle pause waited for once and continued; the progress label names the tool change while waiting; progress `total` = program lines, never going back, ends complete; ends `Idle`, homed, no alarm, at the program's last position. |
| Save, close and reopen                                                    | Saved and not dirty; closed (project tools then fail); reopened (`alreadyOpen: false`) with the part and plan equal; re-export gives the same bytes.                                                                                                                                                 |

- **Golden file.** After an intended change to the post or a generator, update it with `npx vitest run src/main/cli/exit-criteria -u` and review the diff with the change. Under `CI=true` a missing golden file fails instead of being written.
- **Deterministic and fast.** No wall-clock assertions: the virtual machine runs at `max`, and `job.wait` is polled with a short timeout only to continue tool changes promptly. Each variant takes about 1 s, so both run in `npm test` (and CI); no separate script.
- **UI flow (pending):** the same criteria in the app via Playwright for Electron, after the UI shell (3.3), design (3.6), plan (3.7) and run (3.12) UIs.

## Docs lint

`scripts/docs-lint.test.mjs` (part of `npm test`) enforces [documentation.md](documentation.md): every doc is reachable from the [index](../README.md) (directly, via a folder link such as `decisions/`, or via an indexed folder README), has a valid `Status:` line in its first lines and the same status as in the index map, and every relative link and `#anchor` resolves (GitHub heading slugs).
