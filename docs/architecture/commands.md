# Command layer

Status: implemented · Decision: [ADR 0005](../decisions/0005-shared-command-layer.md) · Errors: [error-handling](../conventions/error-handling/README.md) · Agent mapping: [llm-api.md](llm-api.md)

Every state change or privileged action is a **command**; every read an agent can make is a **query**. Both are defined once in `src/core/commands/` and dispatched by thin adapters (UI via [IPC](overview.md#ipc), MCP and CLI per [ADR 0011](../decisions/0011-mcp-and-cli-agent-api.md)). Adapters only map input → `dispatch` → output; they contain no domain logic.

## Files

The code is the contract; each file's header links back here. No adapters yet (IPC/MCP/CLI: v0.1 tasks 3.x).

| File                                    | Contents                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/core/commands/define.ts`           | `DocumentCommand`, `EffectCommand`, `JobCommand`, `BuiltinCommand`, `QueryDef`, `defineCommand`, …    |
| `src/core/commands/context.ts`          | `CommandContext`, `JobContext`, `Source`, `IdGenerator`, `Clock`, `Services` (ports)                  |
| `src/core/commands/registry.ts`         | Registry of all commands and queries; name checks; `APP_COMMANDS`/`APP_QUERIES`                       |
| `src/core/commands/dispatcher.ts`       | Per-project queue and pipeline ([below](#dispatcher-pipeline)); `dispatch`, `query`                   |
| `src/core/commands/history.ts`          | Immer setup, patch execution, undo/redo stacks; `history.undo`/`history.redo`                         |
| `src/core/commands/action-log.ts`       | Event types, ring buffer, subscriptions                                                               |
| `src/core/commands/jobs.ts`             | `JobHandle`, progress, pause/resume/abort, `WorkerPort` (+ in-process stub); `job.*` control commands |
| `src/core/commands/permission.ts`       | `PermissionPolicy` port and the default policy                                                        |
| `src/core/commands/json-schema.ts`      | Tool descriptors from Zod                                                                             |
| `src/core/commands/testing.ts`          | Test helpers ([Testing](#testing))                                                                    |
| `src/core/commands/commands.fixture.ts` | Test-only commands used by the command-layer tests                                                    |
| `src/core/project/document.ts`          | `ProjectDoc` – the state document commands act on (v0.1: `{ name, unitSystem }` only so far)          |

## Naming

- `<area>.<object>.<verb>`, lowercase, camelCase within a segment: `design.pocket.add`, `plan.operation.move`, `run.job.start`. Area-level actions have two segments, `<area>.<verb>`: `history.undo`, `job.abort`. Names are unique across commands and queries (`NAME_PATTERN` in `registry.ts`).
- Areas: `project`, `design`, `plan`, `run`, `library`, `history`, `job`, `app`.
- Command verbs: `add`, `update`, `remove`, `move`, `apply`, `generate`, `start`, … Query verbs: `get`, `list`, `find`, `preview`.
- The name is the stable id used by UI, agents, CLI, logs and `EntryPoint.name` ([boundaries.md](../conventions/error-handling/boundaries.md#entry-points-ui-agent-cli-automation)). Transport-specific renaming (e.g. `.` → `_` for clients that reject dots) lives in the MCP adapter.

## Command definition

```ts
// src/core/commands/define.ts
type CommandKind = 'document' | 'effect' | 'job'

interface CommandMeta<A> {
  readonly name: string // naming convention above
  readonly summary: string // agent/tool description; imperative, one sentence
  readonly title: (args: A) => string // UI label, undo menu text ("Add pocket")
  readonly machine: boolean // affects a real machine → permission check
}

interface DocumentCommand<S extends z.ZodType, R> extends CommandMeta<z.output<S>> {
  readonly kind: 'document' // sync, undoable, changes ProjectDoc only
  readonly args: S
  readonly result: z.ZodType<R>
  readonly run: (draft: Draft<ProjectDoc>, args: z.output<S>, ctx: CommandContext) => AppResult<R>
}

interface EffectCommand<S extends z.ZodType, R> extends CommandMeta<z.output<S>> {
  readonly kind: 'effect' // async, not undoable, never touches ProjectDoc (save, export, jog)
  readonly args: S
  readonly result: z.ZodType<R>
  readonly run: (doc: ProjectDoc, args: z.output<S>, ctx: CommandContext) => AsyncAppResult<R>
}

interface JobCommand<S extends z.ZodType, R> extends CommandMeta<z.output<S>> {
  readonly kind: 'job' // long-running; dispatch returns { jobId } at once
  readonly args: S
  readonly result: z.ZodType<R>
  readonly run: (doc: ProjectDoc, args: z.output<S>, ctx: JobContext) => AsyncAppResult<R>
}

interface CommandContext {
  readonly source: Source // { kind: EntryPoint['kind']; id: string } – window, agent session, script
  readonly ids: IdGenerator // deterministic in tests
  readonly clock: Clock
  readonly services: Services // injected ports; keeps src/core headless
}
interface JobContext extends CommandContext {
  readonly signal: AbortSignal
  readonly progress: (p: { done: number; total?: number; label?: string }) => void
  readonly checkpoint: () => Promise<void> // resolves when not paused; rejects (AbortError) once aborted
}
```

The sketch above is abridged; `define.ts` and `context.ts` are the contract. Differences there: `run`/`title` are method signatures (so typed definitions fit the registry's `AnyCommand`), and a fourth kind, `builtin`, marks commands the dispatcher executes itself (`history.undo`/`history.redo`, `job.pause`/`job.resume`/`job.abort`). `Services` has the `workers` port, the optional `library` service ([library.md](library.md#storage)) and the optional `project` session ([persistence.md](persistence.md#files), used by `project.save`); queries receive `services` too. The machine port arrives with run mode (task 3.9).

Rules:

- `undoable` is not a flag: it follows from `kind` (`document` = undoable, others = not).
- A `document` handler is **synchronous** and pure apart from the draft and `ctx.ids`/`ctx.clock`. It never awaits, never calls services, never dispatches.
- Shared domain logic is called as plain functions from `src/core/<domain>`, not via nested dispatch. One command = one undo step.
- Args use the [quantity](quantities.md) DTOs as entered (e.g. `"1/16\""`); models are built inside the handler with `Model.create()` and their `AppError`s returned unchanged.
- `effect` and `job` handlers read the immutable `ProjectDoc` snapshot current at start; a job that must change the document does so with one follow-up document command ([Jobs](#long-running-commands-jobs)).

## Project state

- `ProjectDoc` is one immutable tree (records keyed by id) of **plain JSON DTOs**; handlers build models from them with `Model.create()` and write DTOs back, so patches and the log stay JSON – the content of the [working folder documents](persistence.md#files-and-folders). Each committed change increments `revision`.
- Document handlers mutate an **[Immer](https://immerjs.github.io/immer/) draft** (dependency `immer`, MIT); the dispatcher derives forward and inverse **patches**. Handlers contain no undo code.
- **Immer configuration** (`history.ts`): a dedicated `Immer` instance (no global settings shared with other code), `enablePatches()`, and **auto-freeze on** – every committed document is deeply frozen (initial documents too), so snapshots read by effects, jobs, replicas and history entries cannot be mutated by accident. Cost: freezing the changed subtrees on each commit.
- `revision` lives in the dispatcher, not in `ProjectDoc` (so it never appears in patches). It only grows: undo and redo are commits too and increment it.
- Not in `ProjectDoc` (so not in undo): selection, camera, panel layout (UI state per window), run/machine state (owned by the utility process, [ADR 0008](../decisions/0008-threading-split-by-job.md)), job state, derived caches.
- The authoritative `ProjectDoc` lives in the **main process**: one dispatcher per open project (works headless and for attached agents). Renderers and workers hold read replicas kept current by the patch stream; UI edits cost one IPC round trip.

## Dispatcher pipeline

`dispatch(name, rawArgs, source, opts?: { expectedRevision?: number }): AsyncAppResult<CommandOutcome>` – adapters call it inside `atBoundary`.

| #   | Step                                                                                                   | Failure              |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------- |
| 1   | Look up `name` in the registry                                                                         | `command.unknown`    |
| 2   | `parseWith(def.args, rawArgs, name)`                                                                   | `input.malformed`    |
| 3   | Enqueue on the project's FIFO queue ([Concurrency](#concurrency))                                      | –                    |
| 4   | Revision check ([Stale writes](#stale-writes))                                                         | `command.conflict`   |
| 5   | If `def.machine`: `policy.check(def, args, source)` – rules in [run.md#safety](../modes/run.md#safety) | `permission.denied`  |
| 6   | Execute by kind (below); stray throws → `internal.unexpected`                                          | handler's `AppError` |
| 7   | Emit one action-log event (success **and** failure)                                                    | –                    |

Execute `document`: `createDraft(doc)` → `run` → on `Err` drop the draft (state, history and revision unchanged: **no partial patches**) → on `Ok` `finishDraft` with patches; empty patches = no-op, no history entry; otherwise commit, `revision++`, push history entry, clear redo stack, publish patches.

`CommandOutcome` is `{ value, revision }`: the handler's result and the revision after the command; a job's `value` is `{ jobId }`. Steps 1–2 fail before queueing but are still logged (step 7). A rejected or failing command never blocks the queue.

Robustness rules (all tested in `dispatcher.test.ts`):

- `dispatch` never rejects and `query` never throws: any stray throw (schema, handler, title) becomes `internal.unexpected`.
- Everything that can fail – the handler, `title(args)`, the history entry's size – runs **before** the commit; after the commit nothing can throw, so there is never a changed document without its history entry.
- A document result that contains Immer drafts (e.g. `Ok({ d: draft })`) is a bug → `internal.unexpected`, no commit (drafts are revoked by `finishDraft`).
- Parsed args, patches and inverse patches are deeply frozen once and shared read-only by the handler, history entries and log events; event `args`/`outcome` are JSON copies, so freezing never touches caller-owned objects.

Error codes `command.unknown` (also for unknown queries), `command.conflict` (retryable) and `permission.denied` are in [`ERROR_CODES`](../../src/shared/errors/codes.ts).

The default `PermissionPolicy` (`permission.ts`) is conservative until [run.md#safety](../modes/run.md#safety) is specified: UI sources are allowed, every other source kind is denied. The port is injected per dispatcher (`createDispatcher({ policy })`) and may be async.

## Undo / redo

- One **linear** history per project, shared by all sources: anyone undoes the top entry, whoever made it; the `undo`/`redo` event and the entry show whose step it was. `history.undo` / `history.redo` are commands (logged, agent-callable) that create no entry of their own.
- Entry: `{ seq, command, args, source, title, patches, inversePatches, revisionBefore, revisionAfter, at }`.
- Undo applies the top entry's `inversePatches`; redo re-applies `patches` – handlers are never re-run, so generated ids and timestamps stay stable.
- Any new document commit clears the redo stack. No coalescing: gestures already produce one command each.
- `effect`/`job` commands never touch history. Opening or resetting a project starts an empty history.
- Undo history is kept **in memory only** in v0.1, capped by count/size (defaults: 500 entries, 50 M chars of JSON counting args, patches and inverse patches; oldest dropped first, the newest entry is always kept); it is lost on close or crash.
- The entry `seq` is the action-log `seq` of the command event that created it.
- Undo/redo with nothing to do returns `Ok({ entrySeq: null })` and is logged as a plain `command` event; a real step returns `{ entrySeq }` and is logged as an `undo`/`redo` event.

## Action log

Observable stream of everything dispatched, for attached agents ([principles §1](../principles.md#1-llm-first)), the UI history panel and tests.

```ts
// src/core/commands/action-log.ts
interface EventBase {
  seq: number
  at: string
  source: Source
  revision: number
}
type ActionEvent = EventBase &
  (
    | {
        type: 'command'
        name: string
        args: unknown
        outcome: ResultWire<unknown>
        patches?: readonly Patch[]
      }
    | { type: 'undo' | 'redo'; entrySeq: number; patches?: readonly Patch[] } // patches applied (undo: inverse)
    | {
        type: 'job'
        jobId: string
        name: string // the job command
        state: 'started' | 'paused' | 'resumed' | 'finished'
        outcome?: ResultWire<unknown> // on 'finished'
      }
  )

interface ActionLog {
  subscribe(filter: LogFilter, listener: (e: ActionEvent) => void): () => void // filter: sources, names, withPatches
  since(seq: number, filter?: LogFilter): readonly ActionEvent[] // replay after reconnect (bounded ring buffer)
  readonly lastSeq: number
}
```

- `args` are summarized with `summarizeArgs`; patches are included only when the subscriber asks (replicas do, agents usually don't). Undo/redo events carry patches too, so a replica can follow the document from the log alone.
- `outcome` is the command's value (not the whole `CommandOutcome`; the event has its own `revision`).
- Each dispatch logs exactly one event: an `undo`/`redo` event for a real history step, otherwise a `command` event (also for `job.*` control and the dispatch that starts a job). Job lifecycle events (`started`, `paused`, `resumed`, `finished`) are additional events emitted on actual state changes.
- `names` filters match `history.undo`/`history.redo` for undo/redo events and the job command's name for job events.
- `since` returns only what the ring buffer still holds (defaults: 1 000 events and 20 M chars of event JSON, oldest dropped first, the newest always kept): a subscriber that sees a gap after its last `seq` must resync the full document.
- Events are deeply frozen. Listeners run synchronously in the dispatcher; a throwing listener is isolated (the others still run, the dispatch is unaffected) and reported as `internal.unexpected` to the optional `onListenerError` callback (`createDispatcher({ onListenerError })`), otherwise dropped.
- Queries and job progress ticks are not logged here (progress: [Jobs](#long-running-commands-jobs)).
- The log is not the persisted project history; persistence stays as defined in [persistence.md](persistence.md). MCP mapping: [llm-api.md](llm-api.md).

## Queries

```ts
interface QueryDef<S extends z.ZodType, R> {
  readonly name: string // e.g. design.pocket.get, plan.operation.list
  readonly summary: string
  readonly args: S
  readonly result: z.ZodType<R>
  readonly run: (doc: ProjectDoc, args: z.output<S>, ctx: QueryContext) => AppResult<R>
}
```

- Side-effect free; read the latest committed snapshot without queueing (immutable state is always consistent); no history, no action-log event.
- Every query result carries the `revision` it read (`query(name, rawArgs, source): AppResult<{ value, revision }>`), so an agent can pass it as `expectedRevision`. A successful query records the source's read revision ([Stale writes](#stale-writes)).
- The UI may call the same query functions directly on its replica.

## Long-running commands (jobs)

- `dispatch` of a `job` returns `{ jobId }` once started; the queue is released immediately.
- `JobHandle`: `state`, `progress` (throttled stream, separate from Results – [boundaries.md](../conventions/error-handling/boundaries.md#async-workers-cancellation)), `result: AsyncAppResult<R>`.
- Control: `job.pause`, `job.resume`, `job.abort` commands (agent-callable, logged). Abort → `op.aborted`. Work runs in workers / the utility process per [ADR 0008](../decisions/0008-threading-split-by-job.md).
- Undo: a job is not undoable. If its result changes `ProjectDoc`, it is applied by one `document` command at the end (one undo step), dispatched with `expectedRevision` = revision at job start → `command.conflict` if the inputs changed meanwhile. The handle exposes that revision as `startRevision`; in v0.1 the caller (adapter or script) dispatches the follow-up.
- Pausing takes effect at the handler's next `ctx.checkpoint()`. Aborting rejects every pending and later checkpoint with an `AbortError` (a handler may await several checkpoints concurrently; resume and abort wake them all); a job that ends after an abort always yields `op.aborted`. Controlling a finished job is a no-op that reports `{ state: 'finished' }`; an unknown `jobId` → `input.malformed` (issue rule `unknownJob`).
- The dispatcher retains the newest 100 finished jobs (`maxFinishedJobs`); older ones are evicted, after which `job(id)` returns `None` and `job.*` answers like an unknown id. The `finished` log event keeps the outcome.
- Heavy work goes through the `WorkerPort` in `ctx.services.workers`. Until task 2.9 the port is backed by `inProcessWorkers` (runs tasks inline); the handler itself runs in-process in the dispatcher's process.

## Concurrency

- One FIFO queue per project serializes all commands from all sources (UI windows, agents, CLI, scripts). Document commands are synchronous, so each runs atomically.
- `effect` commands hold the queue until done (save must see a stable doc); `job` commands do not.

### Stale writes

- A **source** is a per-session identity: `{ kind: EntryPoint['kind'], id }` – `'ui' | 'agent' | 'cli' | 'automation' | 'system'` (one window, MCP session, CLI invocation or script run). The dispatcher records each source's last read revision (any query result) and last own commit.
- Only queries whose result depends on `ProjectDoc` count as a read: a query with `readsDocument: false` (e.g. `library.*.get`/`.list`, which read app data) records no baseline.
- `expectedRevision` is optional. If given, it must equal the current `revision` – for every source and every command kind. A matching `expectedRevision` is an explicit baseline: no prior read is needed.
- Without it, a command from any non-UI source (agent, CLI, automation, system) that can change `ProjectDoc` – a `document` command, `history.undo` or `history.redo` – is accepted only if every revision since that source's last read or last own commit was made by that same source (no baseline yet = rejected). Otherwise → `command.conflict`, whose message tells the agent to re-query and retry. Since own commits advance the baseline, this is implemented as "baseline = current revision".
- `effect`, `job` and `job.*` commands do not write the document and are not subject to the baseline rule (machine commands are gated by the permission policy instead).
- UI-source commands are never rejected by this check.

## JSON Schema for agent tools

- `json-schema.ts` builds one descriptor per command/query: `{ name, description: summary, inputSchema: z.toJSONSchema(def.args, { io: 'input' }), outputSchema: z.toJSONSchema(def.result, { io: 'output' }) }`.
- Field descriptions come from `.describe()` / `.meta()` on the schema; no hand-written tool schemas.
- Arg/result schemas must be JSON-representable (no `z.date()`, functions, unrepresentable transforms); a registry test enforces it.

## Testing

Per [testing.md](../conventions/testing.md):

- `runCommand(doc, def, args)` (in `testing.ts`) runs a document command without a dispatcher (args parsed by its schema) and returns `{ result, next, patches, inversePatches }`. It takes the definition rather than a name, so no registry is needed.
- Generic **undo law** for every document command fixture: `apply(next, inverse) ≡ doc` and `apply(doc, patches) ≡ next` (`expectUndoLaw(doc, def, args)`).
- Other helpers: `fakeIds()`, `fakeClock()`, `uiSource()`, `agentSource()`, `testContext()`.
- Registry test: unique names, naming convention, non-empty `summary`, every schema converts to JSON Schema.
- Dispatcher tests with fake services, ids and clock: `Err` leaves doc/history/revision unchanged; one log event per dispatch; permission denial; FIFO order; `command.conflict`.
- Adapter tests: the MCP tool list equals the registry (parity is structural).

## Open questions

Not blocking v0.1.

- **Persisting undo history** (working folder for crash recovery, or the archive for undo after reopening) – revisit after v0.1.
- **Batch command** (`project.batch`, several commands as one undo step) – not in v0.1; add if agents need it.
