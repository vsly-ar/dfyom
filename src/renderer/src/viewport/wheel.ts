// What a wheel event over the viewport does: a two-finger trackpad scroll pans, a pinch (or
// Ctrl + wheel) zooms to the cursor, a mouse wheel zooms to the cursor. Browsers send all three as
// `wheel` events, so the source is guessed from the event's shape. Pure, so it is unit-tested.
// Doc: docs/conventions/ui.md#viewport-task-35

/** The fields of a `WheelEvent` the classifier reads (`wheelDeltaY` is Chromium's legacy field). */
export interface WheelLike {
  readonly deltaX: number
  readonly deltaY: number
  /** 0 pixels, 1 lines, 2 pages (`WheelEvent.DOM_DELTA_*`). */
  readonly deltaMode: number
  readonly ctrlKey: boolean
  readonly wheelDeltaY?: number | undefined
}

export type WheelGesture = 'pan' | 'zoom'

/** The previous classified event, so one trackpad gesture (incl. its momentum) stays a pan. */
export interface WheelHistory {
  readonly gesture: WheelGesture
  readonly time: number
}

/** Events closer than this (ms) after a pan belong to the same trackpad gesture. */
export const WHEEL_GESTURE_GAP_MS = 120

/**
 * Pan or zoom, first rule that applies:
 * 1. `ctrlKey` → zoom (macOS reports a pinch as a wheel event with `ctrlKey`).
 * 2. Line or page mode → zoom (only mouse wheels send those).
 * 3. Shortly after a pan → pan (the rest of a trackpad gesture or its momentum).
 * 4. Non-zero `deltaX` or fractional `deltaY` → pan (wheels step one axis by whole pixels;
 *    Shift + wheel, which browsers turn into `deltaX`, pans sideways as well).
 * 5. Chromium's `wheelDeltaY`: a trackpad reports exactly −3 × `deltaY`, a wheel notch a
 *    multiple of 120 → pan if it matches, zoom otherwise.
 * 6. Otherwise zoom (the mouse-wheel behaviour, the safe default).
 */
export function classifyWheel(
  e: WheelLike,
  previous: WheelHistory | null = null,
  now = 0,
): WheelGesture {
  if (e.ctrlKey) return 'zoom'
  if (e.deltaMode !== 0) return 'zoom'
  if (previous?.gesture === 'pan' && now - previous.time < WHEEL_GESTURE_GAP_MS) return 'pan'
  if (e.deltaX !== 0 || !Number.isInteger(e.deltaY)) return 'pan'
  if (e.wheelDeltaY !== undefined && e.wheelDeltaY !== 0 && e.deltaY !== 0) {
    return e.wheelDeltaY === -3 * e.deltaY && e.wheelDeltaY % 120 !== 0 ? 'pan' : 'zoom'
  }
  return 'zoom'
}
