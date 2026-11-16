/**
 * Observable stream of everything dispatched: event types, ring buffer, subscriptions.
 * Doc: docs/architecture/commands.md#action-log
 *
 * Listeners run synchronously inside the dispatcher and must not throw.
 */
import type { Patch } from 'immer'
import type { ResultWire } from '../../shared/result'
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

export function createActionLog(opts: { capacity?: number } = {}): WritableActionLog {
  const capacity = opts.capacity ?? DEFAULT_LOG_CAPACITY
  const buffer: ActionEvent[] = []
  const subscribers = new Set<{ filter: LogFilter; listener: (e: ActionEvent) => void }>()
  let lastSeq = 0
  return {
    get lastSeq() {
      return lastSeq
    },
    append(e) {
      const event = { ...e, seq: ++lastSeq } as ActionEvent
      buffer.push(event)
      if (buffer.length > capacity) buffer.shift()
      for (const s of [...subscribers])
        if (matches(s.filter, event)) s.listener(view(s.filter, event))
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
      return buffer.filter((e) => e.seq > seq && matches(filter, e)).map((e) => view(filter, e))
    },
  }
}
