# Call chains and boundaries

Status: draft – ready for review · Part of [error handling](README.md) · Code blocks are the [reference design](README.md#reference-design)

How errors propagate and get enriched, where chains start (UI, agent, CLI, automation), and async/worker/cancellation rules.

## Call-chain enrichment

```ts
export function addChamferToPart(partId: string, input: ChamferProps): AppResult<Chamfer> {
  if (partId === '')
    return fail('model.invariant', 'part id is empty', { where: 'addChamferToPart' })
  return Chamfer.create(input).mapErr(ctx('addChamferToPart', { partId }))
}

export function previewChamferArea(partId: string, input: ChamferProps): AppResult<number> {
  const ch = addChamferToPart(partId, input)
  if (ch.isErr()) return ch // early return: Err<AppError> fits AppResult<number>
  const { sizeMm, angleDeg } = ch.unwrap() // allowed: checked in the same scope
  return Ok(0.5 * sizeMm * sizeMm * Math.tan((angleDeg * Math.PI) / 180))
}
```

Style: **early return** for multi-step logic (reads top-to-bottom, works the same in `async` functions); **`.map`/`.andThen`/`.mapErr` chains** for short pipelines. Don't nest `match` for control flow.

## Entry points: UI, agent, CLI, automation

Every chain starts in exactly one `atBoundary` call. It adds the entry frame (`kind:name` + summarized args), converts stray throws into `internal.unexpected`, and **reports once** (log at the code's severity + route to UI/agent/CLI). Lower layers never log-and-return the same error (that duplicates logs).

```ts
// → src/shared/boundary.ts
export interface EntryPoint {
  readonly kind: 'ui' | 'agent' | 'cli' | 'automation' | 'system'
  readonly name: string // stable action id, identical for UI and agent: 'design.chamfer.apply'
  readonly args?: unknown
}
export type ErrorReporter = (error: AppError, entry: EntryPoint) => void

export async function atBoundary<T>(
  entry: EntryPoint,
  run: () => AppResult<T> | Promise<AppResult<T>>,
  report: ErrorReporter,
): Promise<AppResult<T>> {
  let result: AppResult<T>
  try {
    result = await run()
  } catch (cause) {
    const e =
      cause instanceof AppError
        ? cause
        : new AppError('internal.unexpected', `unhandled throw in ${entry.name}`, { cause })
    result = Err(e)
  }
  if (result.isOk()) return result
  const enriched = result
    .unwrapErr()
    .withContext(`${entry.kind}:${entry.name}`, { args: summarizeArgs(entry.args) })
  report(enriched, entry)
  return Err(enriched)
}
```

Resulting frames for an agent call with an invalid angle: `Chamfer.create → addChamferToPart → agent:design.chamfer.apply { args }`.

| Entry             | Reporter does                                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI                | log; toast/inline message using `userMessage` (+ `issues` for forms); "details" expander shows `message` + frames.                                                                                                                        |
| Agent             | args are first checked with `parseWith(commandSchema, …)` ([helpers.md](helpers.md#parsing-untrusted-data-zod)); log; return `toWire(result)` – the agent gets `code`, `message`, `issues` with `params`, frames: enough to self-correct. |
| CLI               | log; print `message` (or `--json` wire); exit code by code area (mapping defined with the CLI doc).                                                                                                                                       |
| Automation script | log; surface to the run-mode supervisor ([modes/run.md](../../modes/run.md)); `severity: fatal` may trigger a safe stop (defined in run-mode safety spec).                                                                                |

The `report` function is injected so `src/core` stays headless; each process wires its own reporter (logger from [logging.md](../logging.md)).

## Async, workers, cancellation

- Async functions return `AsyncAppResult<T>`; inside use `await` + early return. No `.then` chains on Results.
- Long operations accept an `AbortSignal`. Cancellation is **not a failure**: it becomes `op.aborted` (severity `info`), and UIs show it neutrally.
- Worker/utility-process messages carry `ResultWire<T>`; the host side converts with `fromWire`. A worker crash is converted by the host into `internal.unexpected` with the exit info in `data`.
- Progress/pause/throttle are separate channels (see [architecture/overview.md#threading](../../architecture/overview.md#threading)), not encoded in Results.
