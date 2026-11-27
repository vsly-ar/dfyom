// The jog guard in the run window (hardening DF133 RW3): what the guard checks against (the run's
// setup, its items and the tool in the spindle, set by `useJogGuardSync` while in Run mode), when
// it is on (Q184: homed, G54 set, items; the Jog menu's switch, Q186), where a jog starts (the end
// of the jogs this window queued, else the last report while Idle and settled) and the notice a
// guarded stop writes in the jog pads. Pure.
// Doc: docs/modes/run-workholding.md#jogs, #implementation-rw3
import type { UnitSystem } from '../../../../core/project/document'
import type { GuardSetup } from '../../../../core/run/guarded-jog'
import { STOCK_TOP, type JogContact } from '../../../../core/run/jog-guard'
import type { RunStatus } from '../../../../core/run/service'
import type { Vec3 } from '../../../../core/toolpath/model'
import { lengthSource } from '../../messages/dfm'
import { runMessages } from '../../messages/run'

/** What the guard checks a jog against, for one run setup. */
export interface JogGuardSetup {
  /** `planId:setupId`: a change of it is a setup change (the switch turns back on). */
  readonly key: string
  readonly setup: GuardSetup
  /** The setup's work zero (X, Y) in the setup frame: setup = WCS + zero. */
  readonly zero: readonly [number, number]
  /** Item names by id ("Toe clamp 2"). */
  readonly names: Readonly<Record<string, string>>
}

/** The jog notice (reserved line in the jog pads, DF34). */
export type GuardNotice =
  /** A jog stopped short at the margin (shown once the machine is there). */
  | { readonly kind: 'stopped'; readonly item: string; readonly contact: JogContact }
  /** Nothing sent: the move would come within the margin at once. */
  | { readonly kind: 'blocked'; readonly item: string; readonly contact: JogContact }
  /** Nothing sent: the machine still moves after a stop, so the guard has no start. */
  | { readonly kind: 'moving' }
  /** "Jog past once" pressed: the next jog or Go to goes unguarded. */
  | { readonly kind: 'pastOnce' }

/** "Jog past once" lasts this long (ms, Q186). */
export const PAST_ONCE_MS = 30_000
/** After a jog cancel the reported position is trusted again only after this (ms). */
export const SETTLE_MS = 400
/** A queued jog's end is forgotten when an Idle report comes this long (ms) after it was sent. */
export const JOG_END_STALE_MS = 1000

/** Q184: homed, G54 set (not 0 0 0), a setup with items and a tool, the switch on. */
export function guardActive(
  status: RunStatus,
  setup: JogGuardSetup | undefined,
  off: boolean,
): setup is JogGuardSetup {
  return (
    setup !== undefined &&
    !off &&
    status.connection.state === 'open' &&
    status.homed &&
    !status.workZero.every((v) => v === 0)
  )
}

/** MPos − WPos of the report (G54 plus any G92). */
export const wcoOf = (s: RunStatus): Vec3 => [
  s.mpos[0] - s.wpos[0],
  s.mpos[1] - s.wpos[1],
  s.mpos[2] - s.wpos[2],
]

/**
 * Where a guarded jog starts (MPos): the end of the jogs this window queued, else the report's
 * position while Idle and not just after a jog cancel (the machine may still decelerate); else
 * undefined (not sent).
 */
export function jogStart(
  status: RunStatus,
  queuedEnd: Vec3 | undefined,
  cancelAt: number | undefined,
  now: number,
): Vec3 | undefined {
  if (queuedEnd !== undefined) return queuedEnd
  if (status.state !== 'Idle') return undefined
  if (cancelAt !== undefined && now - cancelAt < SETTLE_MS) return undefined
  return status.mpos
}

const near = (a: Vec3, b: Vec3, eps: number) => a.every((v, i) => Math.abs(v - b[i]!) <= eps)

/** Whether a report shows the machine at rest at `end` (within the report's 0.001 mm, and a bit). */
export const arrived = (s: RunStatus, end: Vec3): boolean =>
  s.state === 'Idle' && near(s.mpos, end, 0.002)

/** The item's name for a contact ("the stock top" for the stock). */
export function contactItem(setup: JogGuardSetup, contact: JogContact): string {
  if (contact.itemId === STOCK_TOP) return runMessages.guard.stockTop
  return setup.names[contact.itemId] ?? runMessages.guard.anItem
}

/** The notice's text: "Stopped 2 mm from Toe clamp 2 (collet nut)." */
export function guardNoticeText(n: GuardNotice, units: UnitSystem): string {
  const g = runMessages.guard
  switch (n.kind) {
    case 'stopped':
      return g.stopped(lengthSource(n.contact.gap, units), n.item, g.part[n.contact.part])
    case 'blocked':
      return g.blocked(n.item, g.part[n.contact.part])
    case 'moving':
      return g.moving
    case 'pastOnce':
      return g.pastOnceArmed
  }
}
