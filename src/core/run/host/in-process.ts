/**
 * The machine host in the same thread, over a paired in-memory `Endpoint`: messages are
 * structured-cloned and delivered on a later microtask, as across a process.
 * For tests (docs/modes/run-v0.1.md#testing).
 */
import type { Endpoint } from '../../workers/protocol'
import type { TimerHost } from '../clock'
import type { MachineHostFactory } from './client'
import { runMachineHost, type MachineHostOptions } from './host'

export interface InProcessHostOptions {
  readonly timers: TimerHost
  readonly throttleMs?: MachineHostOptions['throttleMs']
  /** Sees every message main sends (tests). */
  readonly spy?: (message: unknown) => void
}

export function inProcessHostFactory(opts: InProcessHostOptions): MachineHostFactory {
  return (events) => {
    let alive = true
    let toHost: ((m: unknown) => void) | undefined
    let exiting = false
    const exit = () => {
      if (exiting) return
      exiting = true
      void host.shutdown()
      // messages posted before the exit are still delivered, as from a process
      queueMicrotask(() => {
        alive = false
        events.exit(null)
      })
    }
    const endpoint: Endpoint = {
      post: (m) => {
        const copy = structuredClone(m)
        queueMicrotask(() => alive && events.message(copy))
      },
      onMessage: (l) => (toHost = l),
    }
    const host = runMachineHost(endpoint, {
      timers: opts.timers,
      proc: 'worker',
      ...(opts.throttleMs === undefined ? {} : { throttleMs: opts.throttleMs }),
      onDisconnected: exit,
    })
    return {
      post: (m) => {
        opts.spy?.(m)
        const copy = structuredClone(m)
        queueMicrotask(() => alive && toHost?.(copy))
      },
      terminate: exit,
    }
  }
}
