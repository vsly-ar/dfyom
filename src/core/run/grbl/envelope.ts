/**
 * GRBL 1.1 machine coordinates (default build, no HOMING_FORCE_SET_ORIGIN): the travel spans
 * `[−$13x, 0]` per axis whatever the homing direction; `$23` decides where `$H` leaves the machine.
 * Pure; shared by the virtual machine, the host's jog check and the run scene.
 * Doc: docs/architecture/grbl.md#homing-and-machine-coordinates,
 * docs/modes/run.md#machine-coordinates-and-the-homing-corner-df33
 */
import type { HomingCorner } from '../../library/machine.dto'

type V3 = readonly [number, number, number]

/** What the controller enforces, from its `$$` (`$130–$132`, `$23`, `$27`, `$20`). */
export interface Envelope {
  /** mm, > 0 per axis. */
  readonly travel: V3
  /** `$23`: bit 0 X, bit 1 Y, bit 2 Z; a set bit homes towards −. */
  readonly homingMask: number
  /** `$27`, mm. */
  readonly pullOff: number
  /** `$20`. */
  readonly softLimits: boolean
}

/** `$23` of a homing corner (Z always homes up). */
export function homingMaskOf(corner: HomingCorner): number {
  return (corner.endsWith('Left') ? 1 : 0) | (corner.startsWith('front') ? 2 : 0)
}

/** True when axis `i` homes towards its negative end. */
export const homesNegative = (mask: number, i: number): boolean => ((mask >> i) & 1) === 1

/** Switch position (MPos) of axis `i`: 0 for + homing, −travel for − homing. */
export function switchAt(e: Pick<Envelope, 'travel' | 'homingMask'>, i: number): number {
  return homesNegative(e.homingMask, i) ? -e.travel[i]! : 0
}

/** MPos after `$H` per GRBL limits_go_home(): −pull-off, or −travel + pull-off on a − axis. */
export function homedPosition(e: Omit<Envelope, 'softLimits'>): [number, number, number] {
  const at = (i: number) =>
    homesNegative(e.homingMask, i) ? -e.travel[i]! + e.pullOff : -e.pullOff
  return [at(0), at(1), at(2)]
}

/** The envelope from `$$` values by number; undefined without a positive travel on each axis. */
export function envelopeOf(settings: Readonly<Record<string, number>>): Envelope | undefined {
  const t = [settings['130'], settings['131'], settings['132']]
  if (t.some((v) => v === undefined || !(v > 0))) return undefined
  return {
    travel: [t[0]!, t[1]!, t[2]!],
    homingMask: Math.trunc(settings['23'] ?? 0) & 7,
    pullOff: settings['27'] ?? 1,
    softLimits: (settings['20'] ?? 0) !== 0,
  }
}

export interface TravelViolation {
  readonly axis: 'x' | 'y' | 'z'
  /** MPos the move would end at, mm. */
  readonly target: number
  readonly min: number
  readonly max: number
}

/** First axis of `target` (MPos) outside `[−travel, 0]`, with GRBL's µm slack. */
export function travelViolation(travel: V3, target: V3): TravelViolation | undefined {
  for (let i = 0; i < 3; i++) {
    const v = target[i]!
    const min = -travel[i]!
    if (v > 1e-6 || v < min - 1e-6)
      return { axis: (['x', 'y', 'z'] as const)[i]!, target: v, min, max: 0 }
  }
  return undefined
}
