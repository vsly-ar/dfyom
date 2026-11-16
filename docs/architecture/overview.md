# Architecture overview

Status: draft

## Source layout

| Path            | Runs in                                        | Responsibility                                                                                           |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/core/`     | anywhere (renderer, main, workers, CLI, tests) | Headless domain logic and models. **No** Electron, DOM or Node-only APIs.                                |
| `src/shared/`   | anywhere                                       | Cross-process contracts (types), helpers (Result/AppError/logging – see [conventions](../conventions/)). |
| `src/main/`     | Electron main process                          | Windows, app lifecycle, filesystem, devices/serial, IPC handlers, agent API server.                      |
| `src/preload/`  | Preload (sandboxed)                            | Typed bridge exposing `window.dfyom`; contract in `src/shared/preload-api.ts`.                           |
| `src/renderer/` | Renderer (React)                               | UI only; calls core directly for pure logic, and the bridge for privileged work.                         |
| `scripts/`      | Node (dev tooling)                             | Repo tooling, e.g. [version bump](../conventions/versioning.md).                                         |
| `docs/`         | –                                              | Source of truth ([README](../README.md)).                                                                |

Build: `electron-vite` (`electron.vite.config.ts`) – outputs to `out/{main,preload,renderer}`.

## IPC

- Renderer has `contextIsolation`, `sandbox` and no Node integration.
- All privileged capabilities go through a small typed preload API (contract: `src/shared/preload-api.ts`).
- Every capability exposed to the UI must also be reachable by agents ([llm-api.md](llm-api.md)) – ideally both are thin adapters over the same command layer in `src/core`.

## Threading

Heavy operations (toolpath generation, simulation, optimization) run off the UI thread (Web Workers / `worker_threads` / utility processes – to be decided in an ADR) and must provide:

- progress observability and UI indication,
- pause / abort,
- automatic throttling (not user-facing).

## Open questions

- Command layer design: [commands.md](commands.md) ([ADR 0005](../decisions/0005-shared-command-layer.md)).
- Persistence: [persistence.md](persistence.md) ([ADR 0006](../decisions/0006-project-archive-with-working-folder.md)).
- Geometry: [geometry.md](geometry.md) ([ADR 0007](../decisions/0007-layered-geometry-without-brep-kernel.md)).
