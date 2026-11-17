# Workers

Status: draft · Task: 2.9 of the [v0.1 plan](../plans/v0.1.md#2-core-srccore-headless) · Decision: [ADR 0008](../decisions/0008-threading-split-by-job.md) · Jobs: [commands.md](commands.md#long-running-commands-jobs) · Errors: [boundaries.md](../conventions/error-handling/boundaries.md#async-workers-cancellation)

How heavy, pure computation (part evaluation, toolpath generation) leaves the thread that owns the project: which process hosts the workers, the message protocol, WASM lifetime, abort and pause, automatic evaluation after design edits, the toolpath cache, failure handling, agent visibility, logging, testing and budgets. Machine I/O is out of scope (utility process, [run.md](../modes/run.md)).

Draft: nothing here is implemented; the [open questions](#open-questions) need answers before the status moves to `accepted`.

## What runs on a worker

| Task name           | Pure function (in `src/core`)                                                                                   | Needs WASM | Caller                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `geometry.evaluate` | `kernel.withSolids((s) => evaluatePart(input, s, steps))` ([geometry.md](geometry.md#worker-and-renderer))      | yes        | [Automatic evaluation](#automatic-evaluation-after-design-edits), `design.part.evaluate`                                        |
| `toolpath.generate` | `generateFacing` / `generatePocket` / `generateDrilling` / `generateProfile` on one plan operation's input      | no         | `plan.toolpath.generate` job ([plan-v0.1.md](../modes/plan-v0.1.md#toolpath-generation-job)), export regenerating stale entries |
| test-only tasks     | Fixtures that loop steps, throw, exit or hang ([Testing](#testing)); registered only in the test worker entry   | no         | Tests                                                                                                                           |
| later               | Simulation, optimization, carving ([overview.md](overview.md#threading)); each gets a task name and its own row | –          | –                                                                                                                               |

Everything the main thread does around a task stays cheap: building inputs (`toGeometryInput`, `planOperationInputs`), hashing, cache lookups, posting messages.

## Hosting

The authoritative `ProjectDoc` and the dispatcher live in the process that owns the project: Electron main, or the headless/CLI Node process ([commands.md](commands.md#project-state)). Job handlers run there, so the workers they call run there too.

| Work                                                   | Host                                                                                   | Why                                                                                                                                                                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Part evaluation, toolpath generation (dispatcher jobs) | **`worker_threads`** in the dispatcher's process – the same code in the app and in CLI | Inputs come from the authoritative document; one evaluation serves UI, MCP and CLI; works with no window; a closed or crashed window never interrupts a job ([ADR 0008](../decisions/0008-threading-split-by-job.md)) |
| Renderer-local work (none in v0.1)                     | **Web Worker** in the renderer                                                         | Only for work derived from what one window shows (e.g. later simulation playback, picking acceleration); never for results agents can query                                                                           |
| Machine and device I/O                                 | Electron **utility process**                                                           | Unchanged ([ADR 0008](../decisions/0008-threading-split-by-job.md)); not a compute host                                                                                                                               |

- **Not a utility process for compute.** A utility process costs a process spawn, its own V8 and an extra hop; `worker_threads` already keep CPU off the main thread, and a worker crash never takes main down (a WASM trap is a JS exception, not a native crash). Revisit if a native addon ever runs in a worker.
- **Not renderer Web Workers for dispatcher jobs**, although ADR 0008 names them: the job handler runs in main, so a renderer worker would put every job behind IPC, break headless mode and tie jobs to a window's lifetime. This refines ADR 0008 for the GUI case – see [open question 1](#open-questions).
- The worker code is environment-neutral (`src/core/workers/`): it talks to an `Endpoint` (`post`, `onMessage`), so a Web Worker host can reuse it unchanged when renderer-local work arrives.
- Results reach a renderer over the normal IPC push ([overview.md](overview.md#ipc)); the renderer never talks to a compute worker directly in v0.1.

### Lanes and pool

- One app-wide pool per process, shared by all open projects, with two **lanes**, one worker each in v0.1 ([open question 5](#open-questions)):
  - `geometry` – `geometry.evaluate`; keeps `manifold-3d` warm.
  - `toolpath` – `toolpath.generate`; no WASM.
- Each lane has a FIFO queue in the host. An evaluation never waits behind a toolpath job. Within the `geometry` lane, at most one evaluation per part is queued ([coalescing](#coalescing-and-stale-results)).
- Workers spawn lazily on the first task, except the `geometry` worker, which is prewarmed when the first project opens (hides the cold WASM init). Idle workers are `unref()`ed so a CLI process can exit; app quit and CLI exit `terminate()` all workers.
- Bundling: the worker entry (`src/main/workers/entry.ts`, adapting `parentPort` to an `Endpoint`) is a separate electron-vite main-process entry (`?modulePath`/`?nodeWorker` import, to be verified in implementation); headless and CLI use the same file. `resourceLimits.maxOldGenerationSizeMb` (1 024) keeps a runaway JS heap from affecting main; WASM memory is not covered and is watched by [heap measurement](#wasm-lifetime).

## Contract changes

`WorkerPort` stays the seam job handlers call (`ctx.services.workers`, [commands.md](commands.md#long-running-commands-jobs)). Today a `WorkerTask` carries its `run` function, which cannot cross a thread. The port therefore sends only the task **name**; the worker looks it up in a registry of the same task objects. Proposed shapes (`src/core/commands/jobs.ts`, `src/core/workers/`):

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
- `evaluatePart(input, solids, steps = noSteps)` and every generator `(input, steps = noSteps)` gain an **optional** last parameter ([open question 7](#open-questions)); with the default they stay pure, synchronous and unchanged for existing callers and tests.
- `inProcessWorkers` stays as the fake ([Testing](#testing)).

## Message protocol

One protocol for both worker kinds ([ADR 0008](../decisions/0008-threading-split-by-job.md)), defined as Zod discriminated unions on `type` in `src/core/workers/protocol.ts` with `PROTOCOL_VERSION = 1`.

### Host → worker

| `type` | Fields                                                                               | Notes                                                                           |
| ------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `init` | `protocol`, `workerId`, `lane`, `logLevel`, `wasm?` (`ArrayBuffer`)                  | First message; the worker answers `ready` or exits. `wasm` only for `geometry`. |
| `run`  | `id` (task run id), `task` (name), `input`, `control` (`SharedArrayBuffer`, 4 bytes) | One task at a time per worker; the host never sends `run` before `result`.      |

**Abort, pause and resume are not messages.** The pure code is synchronous, so the worker cannot read its message queue while it computes. The host writes the run's state into `control` (`Int32Array[0]`: 0 run, 1 pause, 2 abort) with `Atomics.store` + `Atomics.notify`; `Steps.step()` reads it with `Atomics.load` and parks on pause with `Atomics.wait` (allowed in workers). `SharedArrayBuffer` is always available in Node `worker_threads`; a future renderer Web Worker host needs cross-origin isolation or falls back to `terminate()` for abort.

### Worker → host

| `type`       | Fields                                                                         | Notes                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`      | `workerId`, `initMs`, `heapBytes?`                                             | After `init` (and WASM load, if prewarmed).                                                                                                                                                             |
| `progress`   | `id`, `done`, `total?`, `label?`                                               | From `Steps.step(p)`; throttled in the worker to one per 50 ms plus the final tick; the job throttles again (`JobRun`).                                                                                 |
| `checkpoint` | `id`, `state: 'paused' \| 'running'`, `label?`                                 | The worker parked at a step (or left it): confirms that a pause took effect and where ("pocket1: level 3/8").                                                                                           |
| `log`        | `batch` (`LogRecord[]`)                                                        | From `createLogForwarder` ([Logging](#logging-from-workers)).                                                                                                                                           |
| `result`     | `id`, `result` (`ResultWire<O>`), `stats` (`ms`, `heapBytes?`, `liveObjects?`) | Exactly one per `run`, also for `op.aborted`. Oxide values do not survive cloning, hence `toWire`/`fromWire` ([boundaries.md](../conventions/error-handling/boundaries.md#async-workers-cancellation)). |

### Zod at the boundary

- **Envelope** (`HostMessage`, `WorkerMessage`): parsed on every receipt, both sides, with `parseWith`. A malformed message to the worker answers `result` `Err(input.malformed)` when its `id` is readable, else it is logged and dropped. A malformed message to the host is a worker fault: the run fails with `internal.unexpected` and the worker is [recycled](#worker-death-timeouts-and-restart).
- **Payloads:** the worker parses `input` with `task.input` (catches cloning surprises such as a model class instance or an oxide Result in the input); the host parses `result` values with `task.output` (typed arrays as `z.instanceof(Float32Array)` etc.). Cost and whether to keep output checks on for large toolpaths: [open question 4](#open-questions).

### Transferred vs. cloned

| Data                                                                             | How                                                                                                                                                       |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PartEvaluation.positions`, `indices`, `triangleSurface` buffers (worker → host) | **Transferred** (zero copy). The worker asserts each array owns its whole buffer (`byteOffset` 0, full length), so a transfer never detaches a neighbour. |
| `PartGeometryInput`, toolpath inputs, warnings, `Toolpath` moves, errors         | **Structured clone** (plain JSON-like data; inputs are small)                                                                                             |
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

- **Granularity.** Pure code calls `steps.step()` between steps; nothing interrupts a step.
  - Evaluation: after each operation's solids are built, after the union, after the subtraction, after `toMesh`, after the checks. Steps are a few ms on the test part, so abort mostly matters for the stress cases (232 ms).
  - Toolpaths: per level (step-down) and per pass inside each generator; the job checkpoints per plan operation in the host ([plan-v0.1.md](../modes/plan-v0.1.md#toolpath-generation-job)).
- **Abort.** `signal` aborts → host writes 2 to `control` → the next `step()` returns `Err(op.aborted)`; the task returns it, `withSolids` frees the arena on that `Err`. The host **resolves the run at once** with `op.aborted` and does not wait for the worker; the lane stays busy until the worker's `result` arrives or the [abort grace](#worker-death-timeouts-and-restart) ends in `terminate()`.
- **Pause.** Only jobs pause (automatic evaluations have no `PauseState`). `job.pause` → host writes 1 → the worker parks at the next step (`checkpoint` `paused`). `job.resume` writes 0 and notifies. Abort while parked wakes it with `op.aborted`. The job's own `ctx.checkpoint()` between operations keeps working as today.
- **Partial results are never published.**
  - Evaluation: an aborted evaluation yields nothing; the previous result stays in the [store](#coalescing-and-stale-results).
  - Toolpaths: every plan operation is its own task, so operations finished before the abort are complete and stay in the [cache](#toolpath-cache); the aborted operation's finished levels are dropped. The job ends in `op.aborted` with `data.completed` (plan operation ids).

## Automatic evaluation after design edits

A per-dispatcher `EvaluationScheduler` (`src/core/design/evaluation.ts`, headless; timers through an injected `Timer` port like `Clock`) keeps each part's evaluation current. It is not a job: one job per keystroke would flood the action log and job table.

### Triggers and debounce

- The scheduler listens to the dispatcher's commits (action-log subscription with patches). A part is **dirty** when a patch touches it (`parts/<id>/…`); undo/redo count the same. On project open every part is dirty.
- For a dirty part it computes `toGeometryInput` and its **input hash** (canonical JSON of `PartGeometryInput`, same hash function as the plan's `inputHash`). An unchanged hash (e.g. a rename) does nothing.
- **Debounce** per part: trailing 30 ms after the last change, **max wait** 200 ms, so a continuous slider drag still refreshes at least 5 times per second.
- A command that fails `toGeometryInput` (e.g. an expression error) leaves the part `failed` with that error; it is not sent to a worker.

### Coalescing and stale results

- **One in flight per part, latest wins.** While an evaluation runs, newer changes only replace the part's **pending** input; when the running one finishes, the pending one (if its hash still differs) starts. Intermediate revisions are skipped.
- **No abort on a newer revision** (unlike the current line in [geometry.md](geometry.md#worker-and-renderer)): with warm evaluations at ~17 ms, aborting on every change would starve a drag of results, and a slightly stale mesh is better live feedback than none ([open question 2](#open-questions)). An evaluation is aborted only when its part is removed, its project closes, or it [times out](#worker-death-timeouts-and-restart).
- Every request is tagged `{ partId, revision, inputHash }`. The result store accepts a result only if its `revision` is newer than the stored one (rejects out-of-order and post-restart stragglers), and drops results for removed parts.
- **Current** means: the stored result's `inputHash` equals the hash of the part in the current document. Results are keyed by hash, not revision, so edits to other parts or plans never make a part's evaluation stale.
- A small per-part LRU (8 results by hash) makes undo/redo back to an evaluated state an instant `done` without a worker run.
- Deterministic errors (`geometry.evaluation`, input errors) are stored as `failed` for that hash and not retried; a crash or timeout is retried once on a fresh worker, then stored as `failed`.

### `evaluation` status

| Value     | Meaning                                                                                    |
| --------- | ------------------------------------------------------------------------------------------ |
| `done`    | A result for the part's current input hash exists and is `Ok`                              |
| `pending` | Debouncing, queued or running for the current hash, or no result yet                       |
| `failed`  | The result for the current hash is an `Err`; the status carries the `AppError` (wire form) |

`design.warning.list` returns `{ warnings, evaluation, error? }`, merging the geometry warnings of a `done` result as specified in [design.md](../modes/design.md#dfm-warnings-task-28-wiring); for `pending`/`failed` it returns the parameter warnings only. Command results keep the synchronous warnings and never wait.

## Toolpath cache

- **Where:** an in-memory `ToolpathCache` per dispatcher (`src/core/toolpath/cache.ts`), injected through `Services` so the job handler, `plan.toolpath.get` and export share it. Not in `ProjectDoc`, not persisted ([open question 10](#open-questions)).
- **Key:** `inputHash` from `planOperationInputs(doc, planId, ids?)` – content-addressed, so a duplicated plan or an undo back to earlier inputs hits the same entry. A second map remembers, per (plan, plan operation), the hash of its last generated toolpath, to return a stale one for preview.
- **Job flow** (`plan.toolpath.generate`): `planOperationInputs` in the host → for each plan operation in plan order: `await ctx.checkpoint()`; on a cache hit skip, else `workers.run(toolpathGenerate, input, ctl)` and store the `Ok` value. Operations run one after another on the `toolpath` lane in v0.1. `done`/`total` count plan operations; worker level progress updates the label. A generator `Err` does not stop the job: the result lists each operation as `generated`, `cached` or `failed` with its error ([open question 9](#open-questions)).
- **`plan.toolpath.get`:** computes the current `inputHash`; returns the entry for it with `stale: false`, else the last generated one with `stale: true`, else `{ toolpath: null, stale: true }`.
- **Invalidation:** none needed – any changed input is a different hash. Library edits do not reach plans until `plan.libraryItem.update` changes the plan's copy (a document change).
- **Eviction:** LRU by estimated size (moves × 64 B), cap 128 MB per project; closing the project drops it. Eviction only costs a regeneration; export regenerates missing or stale entries.

## Worker death, timeouts and restart

| Event                                                                                               | Handling                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A task throws                                                                                       | Caught in the worker loop (`tryCatch`) → `result` `Err(internal.unexpected)`; the worker survives (geometry lane: [recycled](#wasm-lifetime))                                                                                  |
| Worker `error` event, `exit` with a non-zero code, `messageerror`, malformed message                | The in-flight run fails with `internal.unexpected`, `data: { workerId, lane, task, exitCode }` ([boundaries.md](../conventions/error-handling/boundaries.md#async-workers-cancellation)); the worker is discarded              |
| Timeout (`task.timeoutMs`; evaluation 10 s, toolpath per plan operation 60 s; paused time excluded) | Host writes abort; the run fails with a new code `op.timeout` ([open question 6](#open-questions)); if no `result` arrives within the grace, `terminate()`                                                                     |
| Abort grace (1 s after abort or timeout) ends without a `result`                                    | `terminate()`; the lane frees; logged `warn`                                                                                                                                                                                   |
| Restart                                                                                             | Lazy: the next queued task spawns a fresh worker (geometry: with the kept WASM bytes). The task that crashed is not replayed by the pool; callers decide (evaluation: [retry once](#coalescing-and-stale-results); jobs: fail) |
| Crash loop (3 crashes in 60 s on a lane)                                                            | The lane stops spawning for 30 s; its tasks fail fast with `internal.unexpected` ("worker lane unavailable"); logged `error`                                                                                                   |
| Protocol version mismatch in `ready`                                                                | `internal.unexpected` (a build bug); no retry                                                                                                                                                                                  |

## Jobs for agents

- `plan.toolpath.generate` stays a `job` command: `{ jobId }`, progress, `job.pause`/`job.resume`/`job.abort` and lifecycle events in the action log, exactly as [commands.md](commands.md#long-running-commands-jobs) defines. Only the `WorkerPort` behind it changes.
- Automatic evaluations are **not** jobs and not in the action log (debug log only). Agents see them through:
  - `design.warning.list` → `evaluation` ([status](#evaluation-status));
  - `design.part.evaluate { partId }` – a new `job` command for agents and CLI scripts that need to wait: it joins the scheduler's evaluation for the current input hash (never starts a duplicate) and finishes with `{ evaluation, warnings }` ([open question 3](#open-questions)).
- Agents need a way to read a job's state and outcome: proposed queries `job.get { jobId } → { name, state, progress?, startRevision, outcome? }` and `job.list`, over the dispatcher's existing `job(id)`. Whether MCP/CLI adapters also offer a blocking wait is up to the adapter tasks (3.x, [llm-api.md](llm-api.md)).
- Meshes are not exposed to agents; `PartEvaluation.volume`, `pieces` and `stats` may be added to a query when an agent needs them.

## Logging from workers

Per [logging.md](../conventions/logging.md#forwarding):

- The worker creates `createEntryLogger({ level, bindings: { proc: 'worker', worker: workerId, lane } })` with the level from `init`, and a `createLogForwarder` whose `send` posts `{ type: 'log', batch }`. Each task gets `log.child({ task, run: id })`.
- The host passes each batch to `createForwardReceiver` with origin `{ proc: 'worker' }`; `ForwardOrigin` gains an optional `worker` id so drop summaries name the worker. The host treats workers as untrusted senders like renderers (same limits).
- Uncaught errors inside the worker are logged at `error` and the worker keeps running (logging.md rule); the host logs worker exits, recycles, timeouts and crash loops itself, in `scope: 'workers'`.

## Testing

| Layer                     | What                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit, in-process fake     | `inProcessWorkers` runs `task.run` inline with `Steps` backed by the `AbortSignal` (pause is a no-op inside a step). New default option `clone: true`: input and output go through `structuredClone` + the task's Zod schemas, so cloning and schema bugs show up without threads. Used by command, scheduler and job-handler tests.                                                                                          |
| Unit, protocol and pool   | Schemas accept/reject each message; the pool (`src/core/workers/pool.ts`) against a fake `WorkerFactory`/`Endpoint`: queueing per lane, abort resolves at once, grace → `terminate`, timeout, crash → `internal.unexpected`, crash-loop backoff, recycle rules, protocol mismatch.                                                                                                                                            |
| Unit, scheduler and cache | Fake clock and timers, a controllable fake port (deferred results): debounce and max wait, one in flight per part, latest-wins, out-of-order rejection, undo hit, `failed` not retried, crash retried once, removed part; cache keys, stale flag, LRU eviction.                                                                                                                                                               |
| Real `worker_threads`     | `src/main/workers/*.test.ts` under Vitest (Node): a `globalSetup` bundles the worker entry with Vite's build API into a temp `.mjs` (Node 22 cannot load the TS sources directly). Tests: evaluation of the test part end to end (transferred buffers arrive, `liveObjects()` 0), abort and pause mid-task with a fixture task, crash, hang → timeout → terminate, respawn, log forwarding, heap plateau over 35 evaluations. |
| Performance               | `npm run perf` gains the worker round trip, edit-to-result latency and spawn cost ([budgets](#performance-budgets)), and rechecks the 1 000-evaluation heap soak through a real worker.                                                                                                                                                                                                                                       |

## Performance budgets

Reference as in [geometry.md](geometry.md#performance-budgets-v01) (Apple M1 Pro class, test part). Measured by `npm run perf`; CI asserts only the heap plateau.

| Measure                                                                | Budget                                     |
| ---------------------------------------------------------------------- | ------------------------------------------ |
| Worker overhead per evaluation (post, Zod both sides, clone, transfer) | ≤ 5 ms                                     |
| Main-thread time per evaluation result                                 | ≤ 2 ms                                     |
| Edit → current evaluation in the host (warm, incl. 30 ms debounce)     | ≤ 100 ms                                   |
| Worker spawn + WASM init (prewarm)                                     | ≤ 300 ms                                   |
| Abort: signal → run resolved with `op.aborted`                         | immediate (host); worker idle ≤ one step   |
| Progress messages per task                                             | ≤ 20 per second                            |
| WASM heap growth over 1 000 evaluations through a worker               | ≤ 10 MB after warm-up (as geometry)        |
| Toolpath generation, all operations of the test part                   | ≤ 500 ms (provisional; set with task 2.10) |

## Files (planned)

| File                                   | Contents                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `src/core/commands/jobs.ts`            | `WorkerTask`, `WorkerControl`, `WorkerPort`, `inProcessWorkers` (changed) |
| `src/core/workers/protocol.ts`         | Message schemas, `PROTOCOL_VERSION`                                       |
| `src/core/workers/steps.ts`            | `Steps`, `noSteps`, shared-buffer and signal-backed implementations       |
| `src/core/workers/tasks.ts`            | `WORKER_TASKS`: `geometry.evaluate`, `toolpath.generate`                  |
| `src/core/workers/worker-loop.ts`      | Environment-neutral worker side over an `Endpoint`                        |
| `src/core/workers/pool.ts`             | Host side: lanes, queues, timeouts, recycling; implements `WorkerPort`    |
| `src/core/design/evaluation.ts`        | `EvaluationScheduler` and result store                                    |
| `src/core/toolpath/cache.ts`           | `ToolpathCache`                                                           |
| `src/main/workers/entry.ts`, `node.ts` | `worker_threads` entry and `WorkerFactory`, WASM bytes, log forwarding    |

## Open questions

1. **ADR for hosting.** This doc runs all dispatcher jobs in `worker_threads` of the dispatcher's process, also in the GUI, where ADR 0008 names renderer Web Workers. _Recommended:_ write ADR 0016 "Compute workers in the dispatcher's process" superseding ADR 0008 (restating its machine-I/O half unchanged) when this doc is accepted.
2. **Newer revision: coalesce or abort?** [geometry.md](geometry.md#worker-and-renderer) says a newer revision aborts a running evaluation. _Recommended:_ coalesce (one in flight, latest pending, no abort), and update that line in geometry.md on acceptance.
3. **How agents wait for an evaluation.** _Recommended:_ a `design.part.evaluate { partId }` job command that joins the current evaluation, plus `job.get`/`job.list` queries; automatic evaluations stay out of the action log.
4. **Validating worker output with Zod.** _Recommended:_ always validate the envelope and evaluation results; for toolpaths validate too, measure in task 2.10, and fall back to envelope-only plus spot checks if it costs more than 5 ms per plan operation.
5. **Pool size.** _Recommended:_ two lanes (`geometry`, `toolpath`), one worker each in v0.1; parallel toolpath generation across plan operations later, if measurements ask for it.
6. **Timeout error code.** _Recommended:_ add `op.timeout` (severity `warn`, not retryable) to `ERROR_CODES` instead of reusing `internal.unexpected`, so agents can tell a slow input from a bug.
7. **Step hooks in pure code.** _Recommended:_ give `evaluatePart` and the four generators an optional last parameter `steps: Steps = noSteps`; no other signature change.
8. **Which parts are evaluated automatically.** _Recommended:_ every part of an open project, most recently edited first; revisit if projects with many parts make this costly.
9. **Toolpath job when one plan operation fails.** _Recommended:_ continue with the others and report each operation as `generated`, `cached` or `failed`; the job itself is `Ok` unless aborted.
10. **Persisting caches** (evaluations, toolpaths). _Recommended:_ no, in-memory only in v0.1; reconsider with large projects or slow toolpaths (the key would then also need a generator version).
