// Writes entries forwarded by renderers (and later the utility process) through the root logger.
// The sender is untrusted: everything here is bounded. Doc: docs/conventions/logging.md#forwarding
import type pino from 'pino'
import { z } from 'zod'
import { atBoundary, type ErrorReporter } from '../../shared/boundary'
import { LOG_LEVELS, type Logger, type LogLevel } from '../../shared/logging'
import { parseWith } from '../../shared/parse'
import type { MainLogging } from './logger'

const batchSchema = z
  .array(z.looseObject({ level: z.enum(LOG_LEVELS), msg: z.string() }))
  .max(1_000)

/** Who sent the batch; set by main from the IPC sender, never taken from the batch. */
export interface ForwardOrigin {
  readonly proc: 'renderer' | 'utility' | 'worker'
  readonly win?: number
}

export type ForwardReceiver = (batch: unknown, origin: ForwardOrigin) => Promise<void>

export interface ForwardLimits {
  /** Token bucket per sender: refill rate (entries/s) and capacity. A malformed batch costs 1. */
  readonly perSecond: number
  readonly burst: number
  /** Serialized bytes written per batch; later entries are dropped. */
  readonly maxBatchBytes: number
  /** Serialized bytes of one entry's fields; larger → `{ truncated, bytes }`. */
  readonly maxEntryBytes: number
  /** Nesting levels kept in an entry's fields; deeper values → `'[depth]'`. */
  readonly maxDepth: number
  readonly maxMsgChars: number
}

export const FORWARD_LIMITS: ForwardLimits = {
  perSecond: 1_000,
  burst: 2_000,
  maxBatchBytes: 256 * 1024,
  maxEntryBytes: 16 * 1024,
  maxDepth: 3,
  maxMsgChars: 1_000,
}

export interface ForwardOptions extends Partial<ForwardLimits> {
  readonly now?: () => number
  readonly setTimer?: (fn: () => void, ms: number) => void
}

/** Copy of `value` (a field at nesting `level`, top = 1) with objects at `maxDepth` → `'[depth]'`. */
function limitDepth(value: unknown, level: number, maxDepth: number): unknown {
  if (typeof value !== 'object' || value === null) return value
  if (level >= maxDepth) return '[depth]'
  if (Array.isArray(value)) return value.map((v) => limitDepth(v, level + 1, maxDepth))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = limitDepth(v, level + 1, maxDepth)
  return out
}

function boundedFields(
  record: Record<string, unknown>,
  limits: ForwardLimits,
): { fields: Record<string, unknown>; bytes: number } {
  const fields: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record))
    if (k !== 'level' && k !== 'msg') fields[k] = limitDepth(v, 1, limits.maxDepth)
  let bytes: number
  try {
    bytes = JSON.stringify(fields).length
  } catch {
    return { fields: { unserializable: true }, bytes: 32 }
  }
  return bytes > limits.maxEntryBytes
    ? { fields: { truncated: true, bytes }, bytes: 40 }
    : { fields, bytes }
}

/**
 * Forwarded fields are nested under `fwd`, so a sender can't forge top-level fields
 * (`scope`, `entry`, `err`, `proc`, …). Redaction and the `err` serializer of the root logger
 * apply. A malformed batch is reported through `report` (`input.malformed`); drops are
 * summarized once per sender per second.
 */
export function createForwardReceiver(
  logging: Pick<MainLogging, 'base' | 'log'>,
  report: ErrorReporter,
  options: ForwardOptions = {},
): ForwardReceiver {
  const limits: ForwardLimits = { ...FORWARD_LIMITS, ...options }
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fn, ms) => void setTimeout(fn, ms).unref())
  const self: Logger = logging.log.child({ scope: 'logging' })

  interface Sender {
    readonly log: pino.Logger
    tokens: number
    last: number
    dropped: number
  }
  const senders = new Map<string, Sender>()
  const senderFor = (origin: ForwardOrigin): Sender => {
    const key = `${origin.proc}:${origin.win ?? ''}`
    let s = senders.get(key)
    if (s === undefined) {
      const bindings = origin.win === undefined ? { proc: origin.proc } : { ...origin }
      s = { log: logging.base.child(bindings), tokens: limits.burst, last: now(), dropped: 0 }
      senders.set(key, s)
    }
    const t = now()
    s.tokens = Math.min(limits.burst, s.tokens + ((t - s.last) * limits.perSecond) / 1_000)
    s.last = t
    return s
  }
  const drop = (s: Sender, origin: ForwardOrigin, n: number): void => {
    if (n <= 0) return
    if (s.dropped === 0)
      setTimer(() => {
        self.warn({ dropped: s.dropped, from: origin }, 'forwarded log entries dropped')
        s.dropped = 0
      }, 1_000)
    s.dropped += n
  }

  return async (batch, origin) => {
    const s = senderFor(origin)
    if (s.tokens < 1) {
      drop(s, origin, Array.isArray(batch) ? batch.length : 1)
      return
    }
    await atBoundary(
      { kind: 'system', name: 'logging.forward', args: { proc: origin.proc, win: origin.win } },
      () => {
        const parsed = parseWith(batchSchema, batch, 'logging.forward')
        if (parsed.isErr()) s.tokens -= 1
        return parsed.map((records) => {
          let written = 0
          let bytes = 0
          for (const r of records) {
            const { fields, bytes: n } = boundedFields(r, limits)
            if (s.tokens < 1 || bytes + n > limits.maxBatchBytes) break
            s.tokens -= 1
            bytes += n
            written++
            const msg =
              r.msg.length > limits.maxMsgChars ? `${r.msg.slice(0, limits.maxMsgChars)}…` : r.msg
            const hasFields = Object.keys(fields).length > 0
            s.log[r.level as LogLevel](hasFields ? { fwd: fields } : {}, msg)
          }
          drop(s, origin, records.length - written)
        })
      },
      report,
    )
  }
}
