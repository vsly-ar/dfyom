# Workers

Status: implemented ([below](#implementation-task-29)) · Task: 2.9 of the [v0.1 plan](../plans/v0.1.md#2-core-srccore-headless) · Decision: [ADR 0016](../decisions/0016-compute-workers-in-dispatcher-process.md) · Jobs: [commands.md](commands.md#long-running-commands-jobs) · Errors: [boundaries.md](../conventions/error-handling/boundaries.md#async-workers-cancellation)

How heavy, pure computation (part evaluation, toolpath generation) leaves the thread that owns the project: which process hosts the workers, the message protocol, WASM lifetime, abort and pause, automatic evaluation after design edits, the plan-to-generator mapping, the toolpath cache, failure handling, agent visibility, logging, testing and budgets. Machine I/O is out of scope (utility process, [run.md](../modes/run.md)).

## Decisions

Settled with the user when this doc was accepted; the sections below specify them.

1. **Hosting:** `worker_threads` in the dispatcher's process for all dispatcher jobs, also in the GUI ([ADR 0016](../decisions/0016-compute-workers-in-dispatcher-process.md), superseding ADR 0008).
2. **A newer revision aborts** the running evaluation; evaluation starts only after a **trailing debounce** of 200 ms without edits, with no max wait ([below](#automatic-evaluation-after-design-edits)).
3. **Agents** wait with the `design.part.evaluate { partId }` job command and read jobs with `job.get` and `job.list` ([below](#jobs-for-agents)).
4. **Zod** checks the envelope and the payloads in both directions, including toolpaths; measured in this task, envelope-only plus spot checks if a plan operation's output check costs more than 5 ms.
5. **Pool:** two lanes (`geometry`, `toolpath`), one worker each.
6. **Timeouts** fail with a new code `op.timeout` (severity `warn`, not retryable).
7. **Step hooks:** `evaluatePart` and the four generators get an optional last parameter `steps: Steps = noSteps`.
8. **Every part** of an open project is evaluated automatically, the most recently edited first.
9. **A toolpath job continues** past a failed plan operation and reports each one.
10. **Caches** (evaluations, toolpaths) are in memory only.
11. **The plan-to-generator mapping** (`PlanOperationInput` → `GeneratorInput`) is part of task 2.9 ([below](#plan-operation-to-generator-input)).

## What runs on a worker

| Task name           | Pure function (in `src/core`)                                                                                               | Needs WASM | Caller                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `geometry.evaluate` | `kernel.withSolids((s) => evaluatePart(input, s, steps))` ([geometry.md](geometry.md#worker-and-renderer))                  | yes        | [Automatic evaluation](#automatic-evaluation-after-design-edits), `design.part.evaluate`                                        |
| `toolpath.generate` | `generateFacing` / `generatePocket` / `generateDrilling` / `generateProfile` on the `GeneratorInput`s of one plan operation | no         | `plan.toolpath.generate` job ([plan-v0.1.md](../modes/plan-v0.1.md#toolpath-generation-job)), export regenerating stale entries |
| test-only tasks     | Fixtures that loop steps, throw, exit or hang ([Testing](#testing)); registered only in the test worker entry               | no         | Tests                                                                                                                           |
| later               | Simulation, optimization, carving ([overview.md](overview.md#threading)); each gets a task name and its own row             | –          | –                                                                                                                               |

Everything the main thread does around a task stays cheap: building inputs (`toGeometryInput`, `planOperationInputs`, the [generator mapping](#plan-operation-to-generator-input)), hashing, cache lookups, posting messages.

## Hosting

The authoritative `ProjectDoc` and the dispatcher live in the process that owns the project: Electron main, or the headless/CLI Node process ([commands.md](commands.md#project-state)). Job handlers run there, so the workers they call run there too ([ADR 0016](../decisions/0016-compute-workers-in-dispatcher-process.md)).

| Work                                                   | Host                                                                                   | Why                                                                                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Part evaluation, toolpath generation (dispatcher jobs) | **`worker_threads`** in the dispatcher's process – the same code in the app and in CLI | Inputs come from the authoritative document; one evaluation serves UI, MCP and CLI; works with no window; a closed or crashed window never interrupts a job |
| Renderer-local work (none in v0.1)                     | **Web Worker** in the renderer                                                         | Only for work derived from what one window shows (e.g. later simulation playback); never for results agents can query                                       |
| Machine and device I/O                                 | Electron **utility process**                                                           | Unchanged; not a compute host                                                                                                                               |

- **Not a utility process for compute.** A utility process costs a process spawn, its own V8 and an extra hop; `worker_threads` already keep CPU off the main thread, and a worker crash never takes main down (a WASM trap is a JS exception, not a native crash). Revisit if a native addon ever runs in a worker.
- The worker code is environment-neutral (`src/core/workers/`): it talks to an `Endpoint` (`post`, `onMessage`), so a Web Worker host can reuse it unchanged when renderer-local work arrives.
- Results reach a renderer over the normal IPC push ([overview.md](overview.md#ipc)); the renderer never talks to a compute worker directly in v0.1.

### Lanes and pool

- One app-wide pool per process, shared by all open projects, with two **lanes**, one worker each:
  - `geometry` – `geometry.evaluate`; keeps `manifold-3d` warm.
  - `toolpath` – `toolpath.generate`; no WASM.
- Each lane has a FIFO queue in the host. An evaluation never waits behind a toolpath job. Within the `geometry` lane, at most one evaluation per part is queued or running ([coalescing](#abort-on-a-newer-revision-and-stale-results)). Parallel toolpath generation across plan operations comes later, if measurements ask for it.
- Workers spawn lazily on the first task, except the `geometry` worker, which is prewarmed when the first project opens (hides the cold WASM init). Idle workers are `unref()`ed so a CLI process can exit; app quit and CLI exit `terminate()` all workers.
- Bundling: the worker entry (`src/main/workers/entry.ts`, adapting `parentPort` to an `Endpoint`) is a separate electron-vite main-process entry (`?modulePath`/`?nodeWorker` import, verified in implementation); headless and CLI use the same file. `resourceLimits.maxOldGenerationSizeMb` (1 024) keeps a runaway JS heap from affecting main; WASM memory is not covered and is watched by [heap measurement](#wasm-lifetime).

## Contract changes

`WorkerPort` stays the seam job handlers call (`ctx.services.workers`, [commands.md](commands.md#long-running-commands-jobs)). Today a `WorkerTask` carries its `run` function, which cannot cross a thread. The port therefore sends only the task **name**; the worker looks it up in a registry of the same task objects (`src/core/commands/jobs.ts`, `src/core/workers/`):

```ts
type Lane = 'geometry' | 'toolpath'

interface WorkerTask<I, O> {
  readonly name: string // 'geometry.evaluate', 'toolpath.generate'
  readonly lane: Lane
  readonly input: z.ZodType<I> // checked in the worker
  readonly output: z.ZodType<O> // checked in the host
  readonly timeoutMs: number // wall-clock, excluding paused time
  run(input: I, ctl: TaskControl): AppResult<O> | AsyncAppResult<O>
}

/** Inside the worker (or inline in the fake). */
interface TaskControl {
  readonly steps: Steps
  readonly log: Logger
  readonly solids: () => AsyncAppResult<SolidKernel> // loaded once per worker, geometry lane only
}

/** Synchronous control for pure code: abort/pause between steps, progress per step. */
interface Steps {
  step(p?: { done: number; total?: number; label?: string }): AppResult<void> // Err(op.aborted) once aborted
}

/** Host side, passed by the job handler. Adds pause to today's `{ signal, progress }`. */
interface WorkerControl {
  readonly signal: AbortSignal
  readonly progress: (p: JobProgress) => void
  readonly pause?: PauseState // JobContext exposes it; absent for automatic evaluations
}
```

- `WORKER_TASKS` (`src/core/workers/tasks.ts`) lists the production tasks; the worker entry registers them, the test entry adds fixtures. An unknown name is `internal.unexpected` (a bug).
- `evaluatePart(input, solids, steps = noSteps)` and every generator `(input, steps = noSteps)` gain an **optional** last parameter; with the default they stay pure, synchronous and unchanged for existing callers and tests.
- `ToolpathGenerator` in `src/core/plan/inputs.ts` (async, `PlanOperationInput` + `checkpoint`) is a placeholder from 2.13 that no generator implements; it is removed in favour of the [mapping](#plan-operation-to-generator-input) plus the synchronous generators.
- `inProcessWorkers` stays as the fake ([Testing](#testing)).

## Message protocol

One protocol for both worker kinds, defined as Zod discriminated unions on `type` in `src/core/workers/protocol.ts` with `PROTOCOL_VERSION = 1`.

### Host → worker

| `type` | Fields                                                                               | Notes                                                                           |
| ------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `init` | `protocol`, `workerId`, `lane`, `logLevel`, `wasm?` (`ArrayBuffer`)                  | First message; the worker answers `ready` or exits. `wasm` only for `geometry`. |
| `run`  | `id` (task run id), `task` (name), `input`, `control` (`SharedArrayBuffer`, 4 bytes) | One task at a time per worker; the host never sends `run` before `result`.      |

**Abort, pause and resume are not messages.** The pure code is synchronous, so the worker cannot read its message queue while it computes. The host writes the run's state into `control` (`Int32Array[0]`: 0 run, 1 pause, 2 abort) with `Atomics.store` + `Atomics.notify`; `Steps.step()` reads it with `Atomics.load` and parks on pause with `Atomics.wait` (allowed in workers). `SharedArrayBuffer` is always available in Node `worker_threads`; a future renderer Web Worker host needs cross-origin isolation or falls back to `terminate()` for abort.

### Worker → host

| `type`       | Fields                                                                         | Notes                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`      | `protocol`, `workerId`, `initMs`, `heapBytes?`                                 | After `init` (and WASM load, if prewarmed). `protocol` is checked by the host.                                                                                                                          |
| `progress`   | `id`, `done`, `total?`, `label?`                                               | From `Steps.step(p)`; throttled in the worker to one per 50 ms plus the final tick; the job throttles again (`JobRun`).                                                                                 |
| `checkpoint` | `id`, `state: 'paused' \| 'running'`, `label?`                                 | The worker parked at a step (or left it): confirms that a pause took effect and where ("pocket1: level 3/8").                                                                                           |
| `log`        | `batch` (`LogRecord[]`)                                                        | From `createLogForwarder` ([Logging](#logging-from-workers)).                                                                                                                                           |
| `result`     | `id`, `result` (`ResultWire<O>`), `stats` (`ms`, `heapBytes?`, `liveObjects?`) | Exactly one per `run`, also for `op.aborted`. Oxide values do not survive cloning, hence `toWire`/`fromWire` ([boundaries.md](../conventions/error-handling/boundaries.md#async-workers-cancellation)). |

### Zod at the boundary

- **Envelope** (`HostMessage`, `WorkerMessage`): parsed on every receipt, both sides, with `parseWith`. A malformed message to the worker answers `result` `Err(input.malformed)` when its `id` is readable, else it is logged and dropped. A malformed message to the host is a worker fault: the run fails with `internal.unexpected` and the worker is [recycled](#worker-death-timeouts-and-restart).
- **Payloads:** the worker parses `input` with `task.input` (catches cloning surprises such as a model class instance or an oxide `Option` in the input); the host parses `result` values with `task.output` (typed arrays as `z.instanceof(Float32Array)` etc.), toolpaths included. Task 2.9 measures the output check per plan operation; above 5 ms it falls back to the envelope plus spot checks (first and last move of each pass, `stats`).

### Transferred vs. cloned

| Data                                                                             | How                                                                                                                                                       |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PartEvaluation.positions`, `indices`, `triangleSurface` buffers (worker → host) | **Transferred** (zero copy). The worker asserts each array owns its whole buffer (`byteOffset` 0, full length), so a transfer never detaches a neighbour. |
| `PartGeometryInput`, `GeneratorInput`s, warnings, `Toolpath` moves, errors       | **Structured clone** (plain JSON-like data; inputs are small)                                                                                             |
| `wasm` in `init`                                                                 | Cloned once per worker start; the host keeps the bytes for restarts                                                                                       |
| `control`                                                                        | **Shared** (`SharedArrayBuffer`), neither cloned nor transferred                                                                                          |
| Mesh host → renderer                                                             | Copied by Electron IPC (it cannot transfer `ArrayBuffer`s); ≤ about 1 MB at the 20 000-triangle budget                                                    |

Toolpath moves are cloned as objects in v0.1; packing them into typed arrays is a later optimization if the [budgets](#performance-budgets) say so.

## WASM lifetime

Extends [geometry.md](geometry.md#wasm-lifetime-and-ownership):

- **Load once per worker.** The host reads `manifold.wasm` (bundled asset; resolved by the main build, not by `src/core`) once and sends it in `init`; the worker calls `loadManifold({ wasmBinary })` on prewarm or on the first task and keeps the `SolidKernel` for its lifetime. Passing the bytes makes `heapBytes()` measurable.
- **Measure after every task:** `heapBytes()` and `liveObjects()` go into `result.stats`; the host logs them at `debug` and keeps the last value per worker.
- **Recycling policy** (soak data: 16 MB plateau, no growth, so no recycling by count):
  - `liveObjects() > 0` after a task → leak bug: log `error`, recycle after the result is delivered.
  - `heapBytes()` > 512 MB after a task → recycle when idle (WASM memory never shrinks, so one huge part would otherwise pin it).
  - Any `internal.unexpected` from a geometry task (e.g. an Emscripten `RuntimeError` on allocation failure) → recycle: the module state may be corrupt.
- Recycling = `terminate()` and lazy respawn with the kept bytes; the cold cost is the [spawn budget](#performance-budgets).

## Abort and pause

- **Granularity.** Pure code calls `steps.step()` between steps; nothing interrupts a step (a running WASM call cannot be interrupted at all). **Rule: no step takes longer than 50 ms** on the reference parts of the [budgets](#performance-budgets), so abort latency stays within budget.
  - Evaluation: after each operation's solids are built, after the union, after the subtraction, after `toMesh`, after each check (each piece's `toMesh`, each `retainedRemoved` pair). The batch union is the one large WASM call; if `npm run perf` shows it above 50 ms on the stress case (30 pockets + 120 drills, 232 ms in total), it is split into chunked unions with a step between chunks.
  - Toolpaths: per level (step-down) and per pass inside each generator, per hole for drilling; the job checkpoints per plan operation in the host ([plan-v0.1.md](../modes/plan-v0.1.md#toolpath-generation-job)).
- **Abort.** `signal` aborts → host writes 2 to `control` → the next `step()` returns `Err(op.aborted)`; the task returns it, `withSolids` frees the arena on that `Err`. The host **resolves the run at once** with `op.aborted` and does not wait for the worker; the lane stays busy until the worker's `result` arrives (at most one step later) or the [abort grace](#worker-death-timeouts-and-restart) ends in `terminate()`.
- **Pause.** Only jobs pause (automatic evaluations have no `PauseState`). `job.pause` → host writes 1 → the worker parks at the next step (`checkpoint` `paused`). `job.resume` writes 0 and notifies. Abort while parked wakes it with `op.aborted`. The job's own `ctx.checkpoint()` between operations keeps working as today.
- **Partial results are never published.**
  - Evaluation: an aborted evaluation yields nothing; the previous result stays in the [store](#abort-on-a-newer-revision-and-stale-results).
  - Toolpaths: every plan operation is its own task, so operations finished before the abort are complete and stay in the [cache](#toolpath-cache); the aborted operation's finished levels are dropped. The job ends in `op.aborted` with `data.completed` (plan operation ids).

## Automatic evaluation after design edits

A per-dispatcher `EvaluationScheduler` (`src/core/design/evaluation.ts`, headless; timers through an injected `Timer` port like `Clock`) keeps each part's evaluation current. It is not a job: one job per edit would flood the action log and job table.

### Triggers and debounce

- The scheduler listens to the dispatcher's commits (action-log subscription with patches). A part is **dirty** when a patch touches it (`parts/<id>/…`); undo/redo count the same. On project open every part is dirty; dirty parts are served most recently edited first.
- For a dirty part it computes `toGeometryInput` and its **input hash** (`hashJson` from `src/core/plan/snapshot.ts`, the function behind the plan's `inputHash`). An unchanged hash (e.g. a rename) does nothing.
- **Trailing debounce of 200 ms per part, no max wait.** Every change restarts the part's timer. While edits keep arriving (a slider drag, a held arrow key, an agent's burst of commands), nothing is requested and no new result is shown: the viewport keeps the last result, marked outdated (UI: task 3.6). When the part has had no change for 200 ms, one evaluation of its latest input runs.
- Why 200 ms: pointer-move events arrive every 8–17 ms and key auto-repeat every 30–50 ms, so even a slow drag never pauses that long mid-gesture and never starts an evaluation it would abort; deliberate pauses between separate edits are longer. 200 ms plus a warm evaluation (≈ 17 ms, ≤ 50 ms budget) and the worker overhead keeps the result within ≈ 250 ms of the last edit, still read as a direct response. 150 ms would fire inside slow drags; 250 ms adds felt lag without saving work.
- A part whose `toGeometryInput` fails (e.g. an expression error) is `failed` with that error at once; it is not sent to a worker.

### Abort on a newer revision and stale results

- **A newer revision aborts the running evaluation** of that part as soon as the change arrives (unchanged from [geometry.md](geometry.md#worker-and-renderer)), and starts the debounce again. At most one evaluation per part runs; nothing queues behind it. Since the next evaluation waits 200 ms anyway and the worker is free again within one step (≤ 50 ms), the abort never delays it.
- An evaluation is also aborted when its part is removed, its project closes, or it [times out](#worker-death-timeouts-and-restart).
- Every request is tagged `{ partId, revision, inputHash }`. The result store accepts a result only if its `revision` is newer than the stored one (rejects out-of-order and post-restart stragglers, e.g. a result that finished just before its abort was seen), and drops results for removed parts.
- **Current** means: the stored result's `inputHash` equals the hash of the part in the current document. Results are keyed by hash, not revision, so edits to other parts or plans never make a part's evaluation stale.
- A small per-part LRU (8 results by hash) makes undo/redo back to an evaluated state an instant `done` without a worker run (still after the debounce, so a burst of undos stays quiet).
- Deterministic errors (`geometry.evaluation`, input errors) are stored as `failed` for that hash and not retried; a crash or timeout is retried once on a fresh worker, then stored as `failed`.

### `evaluation` status

| Value     | Meaning                                                                                    |
| --------- | ------------------------------------------------------------------------------------------ |
| `done`    | A result for the part's current input hash exists and is `Ok`                              |
| `pending` | Debouncing or running for the current hash, or no result yet                               |
| `failed`  | The result for the current hash is an `Err`; the status carries the `AppError` (wire form) |

`design.warning.list` returns `{ warnings, evaluation, error? }`, merging the geometry warnings of a `done` result as specified in [design.md](../modes/design.md#dfm-warnings-task-28-wiring); for `pending`/`failed` it returns the parameter warnings only. Command results keep the synchronous warnings and never wait.

## Plan operation to generator input

`planOperationInputs(doc, planId, ids?)` (2.13) returns `PlanOperationInput`s that hold **models** (`Part`, `Stock`, `Tool`, `Option<Machine>`, `ResolvedFeeds` with `Option` fields): they do not survive structured cloning. The 2.10 generators take plain `GeneratorInput`s. Task 2.9 adds the mapper `toGeneratorInputs(input: PlanOperationInput) → AppResult<GeneratorRequest>` (`src/core/toolpath/inputs.ts`), run in the **host**; only its plain output crosses to the worker.

| `GeneratorInput` field  | From `PlanOperationInput`                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planOperationId`       | `planOperationId`                                                                                                                                                                      |
| `tool` (`ToolpathTool`) | `tool` + `toolSnapshotId`: type, `diameter`, effective `cornerRadius` (0 flat, RE bull nose, D/2 ball), `fluteLength`, drill `pointAngle`, all canonical mm/degrees                    |
| `cutting`               | `feeds.fields` unwrapped (`spindleSpeed`, `feedRate`, `plungeRate`, and `stepdown`/`stepover` except for drilling); a missing applicable field is `plan.check` (a 2.13 bug if reached) |
| `heights`               | `setup.clearanceHeight`, `setup.retractHeight`                                                                                                                                         |
| `stock`                 | `stock` → `StockGeometry` (same mapping as `toGeometryInput`)                                                                                                                          |
| `operation`             | each of `operations` → `OperationGeometry` through the design mapper on the plan's `part` (`on` resolved to `onZ`), so geometry and toolpaths share one mapping                        |
| `strategy`              | `strategy` without `kind`, per kind; drilling narrows to its cycle's fields                                                                                                            |
| `maxFeedRate`           | `machine` axes' `maxFeedRate`, absent without a machine copy                                                                                                                           |

- **Drilling:** one plan operation groups holes; the generator takes one hole. The mapper emits one `DrillingInput` per hole, in **nearest-neighbour order** starting from the hole nearest the work zero (XY 0, 0); the worker runs them in that order (one step per hole) and joins them into one `Toolpath`: passes concatenated (each hole's toolpath starts and ends at clearance), `stats` recomputed with `toolpathStats(passes, maxFeedRate)`. Starting from the previous operation's end point (`previousPlanOperationId`) is a later refinement; `inputHash` already covers it.
- **Drilling `helix`** needs `rampAngle` and `direction`, which 2.13's `ResolvedStrategy` does not resolve yet: task 2.9 adds them to the drilling strategy in `strategy.ts` with the pocket's defaults (3°, `climb`).
- `GeneratorRequest` is `{ kind, inputs: GeneratorInput[] }` (one entry except for drilling), the `toolpath.generate` task's input, checked by its Zod schema in the worker.

## Toolpath cache

- **Where:** an in-memory `ToolpathCache` per dispatcher (`src/core/toolpath/cache.ts`), injected through `Services` so the job handler, `plan.toolpath.get` and export share it. Not in `ProjectDoc`, not persisted.
- **Key:** `inputHash` from `planOperationInputs` – content-addressed and chained over the machining order, so a duplicated plan or an undo back to earlier inputs hits the same entry. A second map remembers, per (plan, plan operation), the hash of its last generated toolpath, to return a stale one for preview.
- **Job flow** (`plan.toolpath.generate`, `src/core/toolpath/generate.ts`): `planOperationInputs` in the host (`plan.check`/`plan.order` findings fail the job before any worker runs) → for each plan operation in machining order: `await ctx.checkpoint()`; on a cache hit skip, else `toGeneratorInputs`, `workers.run(toolpathGenerate, request, ctl)` and store the `Ok` value. Operations run one after another on the `toolpath` lane. `done`/`total` count plan operations; worker level progress updates the label. A generator `Err` does not stop the job: the result lists each operation as `generated`, `cached` or `failed` with its error; the job is `Ok` unless aborted.
- **`plan.toolpath.get`:** computes the current `inputHash`; returns the entry for it with `stale: false`, else the last generated one with `stale: true`, else `{ toolpath: null, stale: true }`.
- **Invalidation:** none needed – any changed input is a different hash. Library edits do not reach plans until `plan.libraryItem.update` changes the plan's copy (a document change).
- **Eviction:** LRU by estimated size (moves × 64 B), cap 128 MB per project; closing the project drops it. Eviction only costs a regeneration; export regenerates missing or stale entries. Persisting the cache would also need a generator version in the key; not in v0.1.

## Worker death, timeouts and restart

| Event                                                                                               | Handling                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A task throws                                                                                       | Caught in the worker loop (`tryCatch`) → `result` `Err(internal.unexpected)`; the worker survives (geometry lane: [recycled](#wasm-lifetime))                                                                                                 |
| Worker `error` event, `exit` with a non-zero code, `messageerror`, malformed message                | The in-flight run fails with `internal.unexpected`, `data: { workerId, lane, task, exitCode }` ([boundaries.md](../conventions/error-handling/boundaries.md#async-workers-cancellation)); the worker is discarded                             |
| Timeout (`task.timeoutMs`; evaluation 10 s, toolpath per plan operation 60 s; paused time excluded) | Host writes abort; the run fails with the new code `op.timeout` (severity `warn`, not retryable: a slow input, not a bug); if no `result` arrives within the grace, `terminate()`                                                             |
| Abort grace (1 s after abort or timeout) ends without a `result`                                    | `terminate()`; the lane frees; logged `warn`                                                                                                                                                                                                  |
| Restart                                                                                             | Lazy: the next queued task spawns a fresh worker (geometry: with the kept WASM bytes). The task that crashed is not replayed by the pool; callers decide (evaluation: [retry once](#abort-on-a-newer-revision-and-stale-results); jobs: fail) |
| Crash loop (3 crashes in 60 s on a lane)                                                            | The lane stops spawning for 30 s; its tasks fail fast with `internal.unexpected` ("worker lane unavailable"); logged `error`                                                                                                                  |
| Protocol version mismatch in `ready`                                                                | `internal.unexpected` (a build bug); no retry                                                                                                                                                                                                 |

## Jobs for agents

- `plan.toolpath.generate` stays a `job` command: `{ jobId }`, progress, `job.pause`/`job.resume`/`job.abort` and lifecycle events in the action log, exactly as [commands.md](commands.md#long-running-commands-jobs) defines. Only the `WorkerPort` behind it changes.
- Automatic evaluations are **not** jobs and not in the action log (debug log only). Agents see them through:
  - `design.warning.list` → `evaluation` ([status](#evaluation-status));
  - `design.part.evaluate { partId }` – a `job` command for agents and CLI scripts that need to wait: it skips the debounce for the part's current input hash, joins a running evaluation of that hash (never starts a duplicate) and finishes with `{ evaluation, warnings }`. A newer revision of the part aborts it like any evaluation (`op.aborted`); the agent re-dispatches.
- `job.get { jobId } → { name, state, progress?, startRevision, outcome? }` and `job.list → { jobs }` (running and the retained finished jobs) are queries over the dispatcher's existing `job(id)` and its finished-job buffer. Whether MCP/CLI adapters also offer a blocking wait is up to the adapter tasks (3.x, [llm-api.md](llm-api.md)).
- Meshes are not exposed to agents; `PartEvaluation.volume`, `pieces` and `stats` may be added to a query when an agent needs them.

## Logging from workers

Per [logging.md](../conventions/logging.md#forwarding):

- The worker creates `createEntryLogger({ level, bindings: { proc: 'worker', worker: workerId, lane } })` with the level from `init`, and a `createLogForwarder` whose `send` posts `{ type: 'log', batch }`. Each task gets `log.child({ task, run: id })`.
- The host passes each batch to `createForwardReceiver` with origin `{ proc: 'worker' }`; `ForwardOrigin` gains an optional `worker` id so drop summaries name the worker. The host treats workers as untrusted senders like renderers (same limits).
- Uncaught errors inside the worker are logged at `error` and the worker keeps running (logging.md rule); the host logs worker exits, recycles, timeouts and crash loops itself, in `scope: 'workers'`.

## Testing

| Layer                     | What                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit, in-process fake     | `inProcessWorkers` runs `task.run` inline with `Steps` backed by the `AbortSignal` (pause is a no-op inside a step). New default option `clone: true`: input and output go through `structuredClone` + the task's Zod schemas, so cloning and schema bugs show up without threads. Used by command, scheduler and job-handler tests.                                                                                                                      |
| Unit, protocol and pool   | Schemas accept/reject each message; the pool (`src/core/workers/pool.ts`) against a fake `WorkerFactory`/`Endpoint`: queueing per lane, abort resolves at once, grace → `terminate`, timeout → `op.timeout`, crash → `internal.unexpected`, crash-loop backoff, recycle rules, protocol mismatch.                                                                                                                                                         |
| Unit, scheduler and cache | Fake clock and timers, a controllable fake port (deferred results): trailing debounce (no request while edits keep arriving), abort on a newer revision, out-of-order rejection, undo hit, `failed` not retried, crash retried once, removed part, most recently edited first; cache keys, stale flag, LRU eviction.                                                                                                                                      |
| Unit, mapper              | `toGeneratorInputs` on the plan fixtures for every kind: values in canonical mm, effective corner radius, drilling nearest-neighbour order and the joined toolpath, helix fields; the output survives `structuredClone` unchanged.                                                                                                                                                                                                                        |
| Real `worker_threads`     | `src/main/workers/*.test.ts` under Vitest (Node): a `globalSetup` bundles the worker entry with Vite's build API into a temp `.mjs` (Node 22 cannot load the TS sources directly). Tests: evaluation of the test part end to end (transferred buffers arrive, `liveObjects()` 0), toolpaths of the test plan, abort and pause mid-task with a fixture task, crash, hang → timeout → terminate, respawn, log forwarding, heap plateau over 35 evaluations. |
| Performance               | `npm run perf` gains the worker round trip, the longest step, abort latency, the toolpath output check and spawn cost ([budgets](#performance-budgets)), and rechecks the 1 000-evaluation heap soak through a real worker.                                                                                                                                                                                                                               |

## Performance budgets

Reference as in [geometry.md](geometry.md#performance-budgets-v01) (Apple M1 Pro class, test part; the stress case where named). Measured by `npm run perf`; CI asserts only the heap plateau.

| Measure                                                                | Budget                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------ |
| Worker overhead per evaluation (post, Zod both sides, clone, transfer) | ≤ 5 ms                                                 |
| Main-thread time per evaluation result                                 | ≤ 2 ms                                                 |
| Last edit → current evaluation in the host (warm, test part)           | ≤ 250 ms (200 ms debounce + evaluation + overhead)     |
| Longest step between `steps.step()` calls (test part and stress case)  | ≤ 50 ms                                                |
| Abort: signal → run resolved with `op.aborted`                         | immediate (host); worker free ≤ 50 ms later (one step) |
| Worker spawn + WASM init (prewarm)                                     | ≤ 300 ms                                               |
| Progress messages per task                                             | ≤ 20 per second                                        |
| Toolpath output check (Zod) per plan operation                         | ≤ 5 ms, else envelope + spot checks                    |
| WASM heap growth over 1 000 evaluations through a worker               | ≤ 10 MB after warm-up (as geometry)                    |
| Toolpath generation, all operations of the test part                   | ≤ 500 ms                                               |

## Files

| File                                                                 | Contents                                                                                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/commands/jobs.ts`                                          | `WorkerTask`, `WorkerControl`, `WorkerPort`, `inProcessWorkers` (changed)                                                               |
| `src/core/commands/jobs.ts` (queries)                                | `job.get`, `job.list`                                                                                                                   |
| `src/core/workers/protocol.ts`                                       | Message schemas, `PROTOCOL_VERSION`                                                                                                     |
| `src/core/workers/steps.ts`                                          | `Steps`, `noSteps`, shared-buffer and signal-backed implementations                                                                     |
| `src/core/workers/tasks.ts`                                          | `WORKER_TASKS`: `geometry.evaluate`, `toolpath.generate`                                                                                |
| `src/core/workers/worker-loop.ts`                                    | Environment-neutral worker side over an `Endpoint`                                                                                      |
| `src/core/workers/pool.ts`                                           | Host side: lanes, queues, timeouts, recycling; implements `WorkerPort`                                                                  |
| `src/core/design/evaluation.ts`                                      | `EvaluationScheduler`, result store, `design.part.evaluate`                                                                             |
| `src/core/toolpath/inputs.ts`                                        | `toGeneratorInputs` (plan operation → generator inputs)                                                                                 |
| `src/core/toolpath/generate.ts`                                      | `plan.toolpath.generate` job, `plan.toolpath.get`                                                                                       |
| `src/core/toolpath/cache.ts`                                         | `ToolpathCache`                                                                                                                         |
| `src/core/toolpath/request.ts`                                       | `GeneratorRequest` (schema) and `generateRequest` (runs it in the worker, joins drilling holes)                                         |
| `src/core/geometry/schemas.ts`, `src/core/toolpath/schemas.ts`       | Zod schemas of the boundary data (`PartGeometryInput`, `PartEvaluation`, `DfmWarning`, generator inputs, `Toolpath` and its spot check) |
| `src/shared/errors/schema.ts`                                        | `AppErrorDataSchema`, `ResultWireSchema` (protocol, job outcomes, failed results)                                                       |
| `src/main/workers/entry.ts`, `port.ts`, `bundled.ts`                 | `worker_threads` entry (`parentPort` → `Endpoint`, uncaught errors logged), its bundled path (`?modulePath`)                            |
| `src/main/workers/node.ts`                                           | `nodeWorkerFactory`, `readManifoldWasm`, `createNodeWorkerPool` (log forwarding)                                                        |
| `src/main/workers/test-entry.ts`, `test-tasks.ts`, `global-setup.ts` | Test worker entry with fixture tasks, bundled for Vitest by the global setup                                                            |
| `src/main/workers/workers.perf.ts`                                   | The [budgets](#performance-budgets) through real workers                                                                                |

## Implementation (task 2.9)

Decisions and findings of the implementation, where this doc left room or proved wrong:

- **Lazy booleans.** manifold-3d evaluates booleans lazily: the steps after `union`/`subtract` were free and the whole cost landed in the next `status()`. `evaluatePart` now forces each stage (`status()` on every operation's solid, each union chunk, the union and the subtraction), so the work happens between the steps it belongs to.
- **Chunked union.** On the stress case the batch union took ≈ 145 ms in one call, so it is split into chunks of `UNION_CHUNK` = 25 operations (≈ 24 ms each, one step per chunk), then one union of the chunks (≈ 17 ms). Total stress evaluation 249 ms (was 232 ms). The final subtraction (≈ 44 ms) is one WASM call and cannot be split further; it is the longest step and close to the 50 ms rule on slower machines.
- **Full output check.** The full Zod check of a toolpath costs ≤ 0.2 ms per plan operation (503 moves), far under 5 ms, so the host checks every move; `ToolpathSpotSchema` (envelope plus first/last move per pass) exists for larger toolpaths but is unused.
- **`ready` carries `protocol`** (the table above), so the host can detect a mismatched worker build.
- **Scheduler details.** On `attach` (project open) every part is due at once, without debounce, in document order. `state(doc, partId)` looks the result up by the hash of the part in that document, so an undo back to an evaluated input reads `done` at once (no worker run). At most one evaluation is requested at a time, so a part that becomes due later but was edited more recently goes first. A crash or timeout (`internal.unexpected`, `op.timeout`) is retried once; the pool recycles a geometry worker after `internal.unexpected`, so the retry runs on a fresh one. The out-of-order rule (only newer revisions are stored) is a safeguard: with one request at a time and aborted results dropped it is not reachable through the scheduler.
- **`design.part.evaluate`** returns `{ evaluation: 'done' | 'failed', warnings, error? }` (a failed evaluation is an `Ok` job result carrying the error, like `design.warning.list`); it fails with `internal.unexpected` without an evaluation service.
- **`plan.toolpath.generate`** returns `{ operations: [{ planOperationId, status: 'generated' | 'cached' | 'failed', error? }] }`; `plan.toolpath.get` fails with `input.malformed` for an unknown plan or plan operation.
- **Drilling `helix` direction** is resolved as `climb` and not settable in v0.1 (the drilling strategy table has no `direction`); `rampAngle` became a drilling strategy key (helix only), as the table says.
- **`Timers` port** (`set`/`clear`, `systemTimers`) lives in `src/core/commands/context.ts` next to `Clock`.
- **manifold-3d import.** The package exports `.` for `import` only, which the CJS main build cannot `require`; `src/core/geometry/manifold` imports `manifold-3d/manifold.js` (exported without conditions) instead.
- **Not wired yet:** no project is opened through IPC/MCP/CLI before tasks 3.x, so the app creates the pool at start (workers spawn lazily, `terminate()` on quit) but no dispatcher gets an `EvaluationScheduler` or `ToolpathCache` and nothing prewarms the geometry worker; whoever opens a project wires `createEvaluationScheduler({ workers }).attach(dispatcher)`, `createToolpathCache()` and `prewarm('geometry')`.

### Measured (`npm run perf`, Apple M1 Pro class)

| Measure                                                     | Result                                                         | Budget              |
| ----------------------------------------------------------- | -------------------------------------------------------------- | ------------------- |
| Worker overhead per evaluation (post, Zod, clone, transfer) | 0.23 ms median, 0.31 ms p95 (wall 17.5 ms, task 17.2 ms)       | ≤ 5 ms              |
| Main-thread output check per evaluation                     | 0.01 ms median                                                 | ≤ 2 ms              |
| Last edit → current evaluation (warm, test part)            | 219 ms median, 223 ms max                                      | ≤ 250 ms            |
| Longest step, test part / stress case                       | 7 ms / 44 ms (the final subtraction)                           | ≤ 50 ms             |
| Abort: run resolved / worker free                           | ≤ 0.4 ms / 9–15 ms median, ≤ 22 ms max (stress case)           | immediate / ≤ 50 ms |
| Worker spawn + WASM init                                    | 44 ms median (in-worker init 11 ms)                            | ≤ 300 ms            |
| Progress messages                                           | ≤ 20 per second in the worker (≤ 21 in any second at the host) | ≤ 20 per second     |
| Toolpath output check per plan operation                    | ≤ 0.17 ms (pocket, 503 moves)                                  | ≤ 5 ms              |
| WASM heap over 1 000 evaluations through a worker           | 16 MB after warm-up, 0 MB growth, 0 live objects               | ≤ 10 MB             |
| Toolpaths of all test-part operations through the worker    | 5 ms                                                           | ≤ 500 ms            |
