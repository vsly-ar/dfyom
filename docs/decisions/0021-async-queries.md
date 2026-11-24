# 0021 – Async queries for reads that need a worker

Status: accepted · Date: 2026-11-24 · Spec: [commands.md § Async queries](../architecture/commands.md#async-queries), [reference-tools.md](../modes/reference-tools.md) · Decisions: Q72 of hardening DF60 (option A of the v0.4 follow-up's [Q42](../plans/v0.4-llm-first.md#questions-for-the-user)), answered by the user on 2026-11-24

## Context

Queries are synchronous: `run(doc, args, ctx): AppResult<R>` on the committed snapshot, no queue, no history ([commands.md § Queries](../architecture/commands.md#queries)). The reference tools of DF60 read the reference mesh, which lives only in the compute worker (it keeps the parsed mesh per asset, [workers.md](../architecture/workers.md)); the main thread never holds it. A level list or a fitted section takes 5–150 ms there. The read is side-effect free and its answer is small, but it cannot be computed synchronously.

Options considered:

1. **An async query kind**: like a query (no queue, the snapshot, no history), but `run` returns a promise and may call worker tasks. One call for an agent.
2. **Jobs**: `design.reference.find` as a `job`, started with one call and read with `job.wait`. Two calls for an agent, a job record per read, progress and abort it does not need.
3. **Keep a copy of the mesh in the dispatcher's thread** so the query stays synchronous: doubles the memory of every reference (up to the 1 M triangle warn limit) and blocks the queue's thread for the computation.

## Decision

Option 1:

- `AsyncQueryDef` (`async: true`, `run(…): AsyncAppResult<R>`), defined with `defineAsyncQuery`; `AnyQueryDef = QueryDef | AsyncQueryDef` in the registry, tools and JSON Schema.
- `Dispatcher.queryAsync` runs any query; it reads the snapshot committed when it starts, never enters the queue, names the start revision in its outcome and records the read baseline there. `query()` refuses async queries, so a sync caller cannot get a promise by accident.
- The agent session calls `queryAsync` for every query: agents see one kind of read-only tool.
- Async queries stay in the interactive budget; anything that may take seconds or should be cancellable remains a job.

## Consequences

- The reference tools are one call each (`design_reference_find`), with the same hints and result rules as other queries; the black-box flow (find, then import a section) is two calls, not four.
- Edits continue while an async query waits; its answer may describe a revision that is no longer current. The outcome's `revision` says which, and the stale-write rule treats the start revision as the read, so an agent cannot write on top of an edit it has not seen.
- Callers that need a synchronous answer (the session's `peek` for result summaries) keep using `query()`, which only takes sync queries.
- Option 2 was rejected for the two calls per read and the job bookkeeping on a read; option 3 for the memory and the blocked queue thread.
