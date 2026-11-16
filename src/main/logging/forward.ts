// Writes entries forwarded by renderers (and later the utility process) through the root logger.
// Doc: docs/conventions/logging.md#port-and-helpers
import type pino from 'pino'
import { z } from 'zod'
import { atBoundary, type ErrorReporter } from '../../shared/boundary'
import { LOG_LEVELS, RESERVED_LOG_KEYS, type LogLevel } from '../../shared/logging'
import { parseWith } from '../../shared/parse'

/** A batch from an untrusted process: shape-checked, bounded. */
const batchSchema = z
  .array(z.looseObject({ level: z.enum(LOG_LEVELS), msg: z.string().max(10_000) }))
  .max(1_000)

/** Who sent the batch; set by main from the IPC sender, never taken from the batch. */
export interface ForwardOrigin {
  readonly proc: 'renderer' | 'utility' | 'worker'
  readonly win?: number
}

export type ForwardReceiver = (batch: unknown, origin: ForwardOrigin) => Promise<void>

/**
 * `base` is the root pino logger without `proc` (see createMainLogging). Redaction and
 * the `err` serializer of `base` apply to forwarded entries too. A malformed batch is
 * reported once through `report` (`input.malformed`) and dropped.
 */
export function createForwardReceiver(base: pino.Logger, report: ErrorReporter): ForwardReceiver {
  const children = new Map<string, pino.Logger>()
  const childFor = (origin: ForwardOrigin): pino.Logger => {
    const key = `${origin.proc}:${origin.win ?? ''}`
    let child = children.get(key)
    if (child === undefined) {
      child = base.child(origin.win === undefined ? { proc: origin.proc } : { ...origin })
      children.set(key, child)
    }
    return child
  }

  return async (batch, origin) => {
    await atBoundary(
      { kind: 'system', name: 'logging.forward', args: { proc: origin.proc, win: origin.win } },
      () =>
        parseWith(batchSchema, batch, 'logging.forward').map((records) => {
          const log = childFor(origin)
          for (const r of records) {
            const fields: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(r))
              if (!RESERVED_LOG_KEYS.includes(k)) fields[k] = v
            log[r.level as LogLevel](fields, r.msg)
          }
        }),
      report,
    )
  }
}
