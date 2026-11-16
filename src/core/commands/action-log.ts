/**
 * Observable stream of everything dispatched: event types, ring buffer, subscriptions.
 * Doc: docs/architecture/commands.md#action-log
 *
 * Listeners run synchronously inside the dispatcher; a throwing listener is isolated (reported
 * via `onListenerError`), so it can never break a dispatch. Events are deeply frozen.
 */
import { freeze, type Patch } from 'immer'
import type { AppError } from '../../shared/errors/app-error'
import { tryCatch, type ResultWire } from '../../shared/result'
import { sameSource, type Source } from './context'

interface EventBase {
  readonly seq: number
  readonly at: string
  readonly source: Source
  /** Document revision after the event. */
  readonly revision: number
}

export type ActionEventBody =
  | {
      readonly type: 'command'
      readonly name: string
      /** Summarized with `summarizeArgs`. */
      readonly args: unknown
      readonly outcome: ResultWire<unknown>
      readonly patches?: readonly Patch[]
    }
  | {
      readonly type: 'undo' | 'redo'
      readonly entrySeq: number
      /** Patches applied to the document (an undo's are the entry's inverse patches). */
      readonly patches?: readonly Patch[]
    }
  | {
      readonly type: 'job'
      readonly jobId: string
      /** Name of the job command. */
      readonly name: string
      readonly state: 'started' | 'paused' | 'resumed' | 'finished'
      /** Only on `finished`. */
      readonly outcome?: ResultWire<unknown>
    }

export type ActionEvent = EventBase & ActionEventBody

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type NewActionEvent = DistributiveOmit<ActionEvent, 'seq'>

export interface LogFilter {
  /** Only events from these sources. */
  readonly sources?: readonly Source[]
  /** Only these names (`history.undo`/`history.redo` for undo/redo, the job command for job events). */
  readonly names?: readonly string[]
  /** Include patches (replicas do, agents usually don't). */
  readonly withPatches?: boolean
}

export interface ActionLog {
  subscribe(filter: LogFilter, listener: (e: ActionEvent) => void): () => void
  /** Retained events with `seq` greater than the given one (bounded: check the first seq for gaps). */
  since(seq: number, filter?: LogFilter): readonly ActionEvent[]
  readonly lastSeq: number
}

export interface WritableActionLog extends ActionLog {
  append(e: NewActionEvent): ActionEvent
}

export const DEFAULT_LOG_CAPACITY = 1000
export const DEFAULT_LOG_MAX_CHARS = 20_000_000

function eventName(e: ActionEvent): string {
  switch (e.type) {
    case 'undo':
    case 'redo':
      return `history.${e.type}`
    case 'command':
    case 'job':
      return e.name
  }
}

function matches(f: LogFilter, e: ActionEvent): boolean {
  if (f.sources !== undefined && !f.sources.some((s) => sameSource(s, e.source))) return false
  if (f.names !== undefined && !f.names.includes(eventName(e))) return false
  return true
}

function view(f: LogFilter, e: ActionEvent): ActionEvent {
  if (f.withPatches === true || !('patches' in e)) return e
  const { patches: _omitted, ...rest } = e
  return rest
}

export interface ActionLogOptions {
  /** Max retained events (default 1 000). */
  readonly capacity?: number
  /** Max total JSON size of retained events, in characters (default 20 M); the newest is always kept. */
  readonly maxChars?: number
  /** Receives listener throws as `internal.unexpected` (default: dropped). Other listeners still run. */
  readonly onListenerError?: (error: AppError) => void
}

function jsonSize(e: ActionEvent): number {
  const r = tryCatch(() => JSON.stringify(e).length, 'internal.unexpected', 'unserializable event')
  return r.isOk() ? r.unwrap() : 0
}

export function createActionLog(opts: ActionLogOptions = {}): WritableActionLog {
  const capacity = opts.capacity ?? DEFAULT_LOG_CAPACITY
  const maxChars = opts.maxChars ?? DEFAULT_LOG_MAX_CHARS
  const buffer: { event: ActionEvent; size: number }[] = []
  const subscribers = new Set<{ filter: LogFilter; listener: (e: ActionEvent) => void }>()
  let lastSeq = 0
  let totalChars = 0
  const deliver = (listener: (e: ActionEvent) => void, e: ActionEvent) => {
    const r = tryCatch(() => listener(e), 'internal.unexpected', 'action-log listener threw')
    if (r.isErr())
      opts.onListenerError?.(r.unwrapErr().withContext('ActionLog.append', { seq: e.seq }))
  }
  return {
    get lastSeq() {
      return lastSeq
    },
    append(e) {
      // Frozen once: events (and the patches/args they share with history) are read-only for all.
      const event = freeze({ ...e, seq: ++lastSeq } as ActionEvent, true)
      const size = jsonSize(event)
      buffer.push({ event, size })
      totalChars += size
      while (buffer.length > 1 && (buffer.length > capacity || totalChars > maxChars))
        totalChars -= buffer.shift()?.size ?? 0
      for (const s of [...subscribers])
        if (matches(s.filter, event)) deliver(s.listener, view(s.filter, event))
      return event
    },
    subscribe(filter, listener) {
      const sub = { filter, listener }
      subscribers.add(sub)
      return () => {
        subscribers.delete(sub)
      }
    },
    since(seq, filter = {}) {
      return buffer
        .map((b) => b.event)
        .filter((e) => e.seq > seq && matches(filter, e))
        .map((e) => view(filter, e))
    },
  }
}
