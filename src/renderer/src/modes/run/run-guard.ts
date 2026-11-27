// The jog guard in the run window (hardening DF133 RW3): what the guard checks against (the run's
// setup, its items and the tool in the spindle, set by `useJogGuardSync` while in Run mode), when
// it is on (Q184: homed, G54 set, items; the Jog menu's switch, Q186), where a jog starts (the end
// of the jogs this window queued, else the last report while Idle and settled) and the notice a
// guarded stop writes in the jog pads. RW4: the steps of a Go to or a touch-off move through the
// guard (`moveGuard`). RW5: the live clearance at the tool (`liveClearance`): the nearest item for
// the Position panel's chip and each item's tone for the scene. Pure.
// Doc: docs/modes/run-workholding.md#jogs, #implementation-rw3, #implementation-rw4,
// #implementation-rw5
import type { UnitSystem } from '../../../../core/project/document'
import {
  guardedMoves,
  type GuardedMoveHit,
  type GuardSetup,
} from '../../../../core/run/guarded-jog'
import {
  itemClearances,
  STOCK_TOP,
  type Clearance,
  type JogContact,
} from '../../../../core/run/jog-guard'
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

/** DF133 RW4: a Go to's or a touch-off move's first contact, with the item's name. */
export interface MoveFinding {
  readonly hit: GuardedMoveHit
  readonly item: string
}

/**
 * DF133 RW4 (Q187): the steps `to` (MPos) from `from` through the guard while it is on (the
 * setup's frame as for jogs); undefined when the guard is not on or every step is clear.
 */
export function moveGuard(
  status: RunStatus,
  setup: JogGuardSetup,
  from: Vec3,
  to: readonly Vec3[],
): MoveFinding | undefined {
  const hit = guardedMoves({
    from,
    to,
    wco: wcoOf(status),
    offset: [setup.zero[0], setup.zero[1], status.zeroLevel ?? 0],
    setup: setup.setup,
  })
  return hit === undefined ? undefined : { hit, item: contactItem(setup, hit.contact) }
}

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

/**
 * RW5: how close the envelope is to an item: `clear`, `close` (under 2 × margin, the Plan check's
 * "close" distance: amber), `inside` (at or within the margin: red; a guarded stop leaves the
 * margin less the guard's backoff, so "at the margin" counts).
 */
export type ClearanceTone = 'clear' | 'close' | 'inside'

/** Within this (mm) past the margin a position is at the margin (a guarded stop: red). */
export const AT_MARGIN_MM = 0.05

export function clearanceTone(gap: number, margin: number): ClearanceTone {
  if (gap <= margin + AT_MARGIN_MM) return 'inside'
  return gap < 2 * margin ? 'close' : 'clear'
}

/** RW5: the clearance at the tool: the nearest item (the chip) and the items' tones (the scene). */
export interface LiveClearance {
  readonly nearest: Clearance & { readonly item: string; readonly tone: ClearanceTone }
  /** Item id → tone, for the items that are not `clear`. */
  readonly tones: Readonly<Record<string, ClearanceTone>>
}

/**
 * The live clearance at the status' tool tip (WPos + the setup's work zero X, Y and `zeroLevel`:
 * the setup frame), or undefined without items.
 */
export function liveClearance(
  status: Pick<RunStatus, 'wpos' | 'zeroLevel'>,
  setup: JogGuardSetup,
): LiveClearance | undefined {
  const tip: Vec3 = [
    status.wpos[0] + setup.zero[0],
    status.wpos[1] + setup.zero[1],
    status.wpos[2] + (status.zeroLevel ?? 0),
  ]
  const all = itemClearances(tip, setup.setup.envelope, setup.setup.prisms)
  if (all.length === 0) return undefined
  const margin = setup.setup.margin
  const tones: Record<string, ClearanceTone> = {}
  let nearest = all[0]!
  for (const c of all) {
    const tone = clearanceTone(c.gap, margin)
    if (tone !== 'clear') tones[c.itemId] = tone
    if (c.gap < nearest.gap - 1e-12) nearest = c
  }
  return {
    nearest: {
      ...nearest,
      item: setup.names[nearest.itemId] ?? runMessages.guard.anItem,
      tone: clearanceTone(nearest.gap, margin),
    },
    tones,
  }
}
