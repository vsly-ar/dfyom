/**
 * Jogs through the workholding guard (hardening DF133 RW3): the `run.machine.jog` arguments of a
 * step or a continuous (hold) jog, checked by `jogGuard` when the guard is on. Without a contact
 * the jog is exactly today's command (`{ by }`, or `{ by, continuous }` to the travel edge); a
 * contact shortens it to the stop point, sent as an absolute machine target (`{ to }`), so GRBL
 * plans the deceleration to it (Q185); a move that may not start at all sends nothing.
 * Doc: docs/modes/run-workholding.md#jogs, #implementation-rw3
 *
 * Pure and headless. Machine positions are MPos (mm); the guard works in the setup frame:
 * setup = MPos − WCO + offset, WCO = MPos − WPos of the last status (G54 plus any G92) and offset
 * the setup's work zero (X, Y) and the Z reference surface's `zeroLevel` (Z).
 */
import type { Vec3 } from '../toolpath/model'
import type { EnvelopeSegment } from '../plan/workholding/envelope'
import type { Prism } from '../plan/workholding/obstacles'
import { jogGuard, type JogContact } from './jog-guard'

export type Axis3 = 0 | 1 | 2

/** A jog the pad, a hotkey or a dialog's pad asks for. */
export type JogRequest =
  | { readonly kind: 'step'; readonly axis: Axis3; readonly mm: number; readonly feed: number }
  | { readonly kind: 'hold'; readonly axis: Axis3; readonly sign: 1 | -1; readonly feed: number }

/** The arguments of one `run.machine.jog`. */
export interface JogArgs {
  readonly by?: readonly [number, number, number]
  readonly to?: readonly [number, number, number]
  readonly feed: number
  readonly continuous?: true
}

/** What the guard checks against (the setup's items, the tool in the spindle). */
export interface GuardSetup {
  readonly envelope: readonly EnvelopeSegment[]
  readonly prisms: readonly Prism[]
  readonly margin: number
  readonly stock?: { readonly length: number; readonly width: number }
}

export interface GuardedJogInput {
  readonly request: JogRequest
  /** Where the jog starts (MPos, mm): the end of the jogs still queued, else the last report. */
  readonly from: Vec3
  /** MPos − WPos of the last status (mm). */
  readonly wco: Vec3
  /** The setup frame's offset from the WCS: the setup's work zero X, Y and `zeroLevel`. */
  readonly offset: Vec3
  /** The controller's travel (`$130–$132`, mm), the continuous jog's far end; absent: unknown. */
  readonly travel?: Vec3
  readonly setup: GuardSetup
}

export type GuardedJog =
  /** Send `args`; `contact` when the guard shortened the jog, `end` its machine end when known. */
  | {
      readonly kind: 'send'
      readonly args: JogArgs
      readonly end?: Vec3
      readonly contact?: JogContact
    }
  /** Nothing is sent: the move would come within the margin at once. */
  | { readonly kind: 'blocked'; readonly contact: JogContact }

/**
 * Below this (mm) a shortened jog is not sent (blocked): twice the guard's stop backoff, so a
 * click at the stop point does not creep on by thousandths.
 */
export const MIN_JOG_MM = 0.02

/** Today's command for a jog, unguarded (the guard off, past once, or not active). */
export function plainJogArgs(request: JogRequest): JogArgs {
  const by: [number, number, number] = [0, 0, 0]
  if (request.kind === 'step') {
    by[request.axis] = request.mm
    return { by, feed: request.feed }
  }
  by[request.axis] = request.sign
  return { by, feed: request.feed, continuous: true }
}

/** The machine end of a plain jog from `from` (a hold: at the travel edge), when known. */
export function plainJogEnd(request: JogRequest, from: Vec3, travel?: Vec3): Vec3 | undefined {
  const end: [number, number, number] = [from[0], from[1], from[2]]
  if (request.kind === 'step') end[request.axis] += request.mm
  else if (travel === undefined) return undefined
  else end[request.axis] = edgeOf(request, travel)
  return end
}

/** The travel edge a continuous jog runs to (machine, mm), as the host's `jogToEdge`. */
const edgeOf = (request: JogRequest & { kind: 'hold' }, travel: Vec3): number =>
  request.sign > 0 ? 0 : -travel[request.axis]

/** Rounds `v` to 0.001 mm (the host's `$J` precision) towards `from`, never past the stop. */
function towards(v: number, from: number): number {
  const k = 1000
  return v >= from ? Math.floor(v * k + 1e-9) / k : Math.ceil(v * k - 1e-9) / k
}

/**
 * `guardedJog`: the jog `request` from `from` through `jogGuard`. A step without a contact is
 * today's `{ by }`; a hold without a contact (or with the travel unknown, which the host refuses
 * anyway) today's continuous jog. With a contact: `{ to }` at the stop point (rounded towards the
 * start), or `blocked` when that is less than `MIN_JOG_MM` from the start.
 */
export function guardedJog(input: GuardedJogInput): GuardedJog {
  const { request, from, wco, offset, travel, setup } = input
  const plain = (): GuardedJog => {
    const end = plainJogEnd(request, from, travel)
    return { kind: 'send', args: plainJogArgs(request), ...(end === undefined ? {} : { end }) }
  }
  if (request.kind === 'hold' && travel === undefined) return plain()
  const to = plainJogEnd(request, from, travel)!
  const toSetup = (m: Vec3): Vec3 => [
    m[0] - wco[0] + offset[0],
    m[1] - wco[1] + offset[1],
    m[2] - wco[2] + offset[2],
  ]
  const r = jogGuard({
    from: toSetup(from),
    to: toSetup(to),
    envelope: setup.envelope,
    prisms: setup.prisms,
    margin: setup.margin,
    ...(setup.stock === undefined ? {} : { stock: setup.stock }),
  })
  if (r.contact === undefined) return plain()
  // back to the machine frame, each axis rounded towards the start (never further than allowed)
  const stop: [number, number, number] = [0, 0, 0]
  for (const i of [0, 1, 2] as const) stop[i] = towards(r.allowed[i] + wco[i] - offset[i], from[i])
  // a one-axis jog: the other axes stay exactly where they are
  for (const i of [0, 1, 2] as const) if (i !== request.axis) stop[i] = from[i]
  if (Math.abs(stop[request.axis] - from[request.axis]) < MIN_JOG_MM)
    return { kind: 'blocked', contact: r.contact }
  return { kind: 'send', args: { to: stop, feed: request.feed }, end: stop, contact: r.contact }
}
