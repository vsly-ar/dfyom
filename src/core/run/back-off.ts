/**
 * Hardening DF143: "Unlock and back off" after a limit switch hit while jogging (advanced users):
 * which way and how far to jog off the switch. Pure; the machine host runs the sequence.
 * Doc: docs/modes/run-machine.md#unlock-and-back-off-df143
 */
import { fail, Ok, type AppResult } from '../../shared/result'
import { limitSwitches } from './grbl/status'
import type { Vec3 } from '../toolpath/model'

/** Back-off distance (mm) the setting offers by default, and its range. */
export const BACK_OFF_DEFAULT_MM = 3
export const BACK_OFF_MIN_MM = 0.5
export const BACK_OFF_MAX_MM = 10
/** Feed (mm/min) of the back-off jog: slow, so a switch released on the way stops it gently. */
export const BACK_OFF_FEED = 300
/** Jogs are refused from the back-off's start for at least this long (ms, wall time). */
export const BACK_OFF_QUIET_MS = 3000
/** A hard limit within this long (ms) after a jog was sent counts as hit by that jog. */
export const JOG_ALARM_WINDOW_MS = 500

/** −1, 0 or +1 per axis: the direction of a jog. */
export type JogDirection = readonly [-1 | 0 | 1, -1 | 0 | 1, -1 | 0 | 1]

/** The direction of a jog `by` (relative) or from `from` to `to` (machine coordinates). */
export function jogDirection(v: Vec3, from?: Vec3): JogDirection {
  const sign = (d: number): -1 | 0 | 1 => (Math.abs(d) < 1e-9 ? 0 : d > 0 ? 1 : -1)
  const d = (i: 0 | 1 | 2) => sign(v[i] - (from?.[i] ?? 0))
  return [d(0), d(1), d(2)]
}

/**
 * The relative move (mm) off the switch: on each pressed limit switch's axis (`Pn:`), or without
 * one reported on each axis the last jog moved, `distance` against the last jog's direction there.
 * A pressed switch on an axis the jog did not move (its end is unknown) is refused.
 */
export function backOffMove(
  last: JogDirection,
  pins: string | undefined,
  distance: number,
  where = 'backOffMove',
): AppResult<Vec3> {
  const pressed = limitSwitches(pins).map((a) => ({ X: 0, Y: 1, Z: 2 })[a] as 0 | 1 | 2)
  const axes = pressed.length > 0 ? pressed : ([0, 1, 2] as const).filter((i) => last[i] !== 0)
  const unknown = axes.filter((i) => last[i] === 0)
  if (axes.length === 0 || unknown.length > 0) {
    const names = unknown.map((i) => 'XYZ'[i]).join(', ')
    const message =
      axes.length === 0
        ? 'the last jog moved no axis: jog off the switch by hand'
        : `the ${names} limit switch is pressed but the last jog did not move ${names}: jog it off by hand`
    return fail('run.state', message, {
      where,
      data: { pins: pins ?? '' },
      issues: [{ path: [], rule: 'backOffDirection', message }],
    })
  }
  const move: [number, number, number] = [0, 0, 0]
  for (const i of axes) move[i] = -last[i] * distance
  return Ok(move)
}
