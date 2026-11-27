// Jog hotkey styles (DF88): which key jogs which axis, and where a key may jog. Pure.
// gSender style = gSender's default jog shortcuts (Sienci-Labs/gsender,
// src/app/src/features/Jogging/index.tsx: shift+right/left/up/down, shift+pageup/pagedown).
// Doc: docs/conventions/ui.md#jog-hotkeys
import type { JogKeyStyle } from '../../../../shared/settings'
import { isEditableTarget } from '../../shell/shortcuts'
import type { Axis } from './run-store'

export interface JogKey {
  /** The physical key (`KeyboardEvent.code`): its `keyup` ends the press. */
  readonly code: string
  readonly axis: Axis
  readonly sign: 1 | -1
}

type KeyInfo = Pick<KeyboardEvent, 'code' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>

type Map = Readonly<Record<string, readonly [Axis, 1 | -1]>>

const GAME: Map = {
  KeyW: ['y', 1],
  KeyA: ['x', -1],
  KeyS: ['y', -1],
  KeyD: ['x', 1],
  ShiftLeft: ['z', -1],
  ShiftRight: ['z', -1],
  Space: ['z', 1],
}
const GSENDER: Map = {
  ArrowRight: ['x', 1],
  ArrowLeft: ['x', -1],
  ArrowUp: ['y', 1],
  ArrowDown: ['y', -1],
  PageUp: ['z', 1],
  PageDown: ['z', -1],
}
const ARROWS: Map = {
  ArrowRight: ['x', 1],
  ArrowLeft: ['x', -1],
  ArrowUp: ['y', 1],
  ArrowDown: ['y', -1],
  Slash: ['z', -1],
  Quote: ['z', 1],
}

/** The keys of a style, for the shortcut list: [axis+direction, key text]. */
export const JOG_KEY_LABELS: Readonly<
  Record<Exclude<JogKeyStyle, 'off'>, readonly (readonly [string, string])[]>
> = {
  game: [
    ['Y+', 'W'],
    ['X−', 'A'],
    ['Y−', 'S'],
    ['X+', 'D'],
    ['Z−', 'Shift'],
    ['Z+', 'Space'],
  ],
  gsender: [
    ['X+', 'Shift+→'],
    ['X−', 'Shift+←'],
    ['Y+', 'Shift+↑'],
    ['Y−', 'Shift+↓'],
    ['Z+', 'Shift+Page Up'],
    ['Z−', 'Shift+Page Down'],
  ],
  arrows: [
    ['X+', '→'],
    ['X−', '←'],
    ['Y+', '↑'],
    ['Y−', '↓'],
    ['Z−', '/'],
    ['Z+', "'"],
  ],
}

/**
 * DF140: a jog button's key in a style (docs/conventions/ui.md#jog-pad-df140): `text` for the
 * tooltip (as the shortcut list), `aria` for `aria-keyshortcuts`, `badge` (the gray key cap on the
 * button) only for a single key.
 */
export interface JogKeyHint {
  readonly text: string
  readonly aria: string
  readonly badge?: string
}

type Dir = `${Axis}${'+' | '−'}`
const hint = (text: string, aria: string, badge?: string): JogKeyHint =>
  badge === undefined ? { text, aria } : { text, aria, badge }

const KEY_HINTS: Readonly<Record<Exclude<JogKeyStyle, 'off'>, Readonly<Record<Dir, JogKeyHint>>>> =
  {
    game: {
      'y+': hint('W', 'W', 'W'),
      'x−': hint('A', 'A', 'A'),
      'y−': hint('S', 'S', 'S'),
      'x+': hint('D', 'D', 'D'),
      'z−': hint('Shift', 'Shift', '⇧'),
      'z+': hint('Space', 'Space', '␣'),
    },
    gsender: {
      'x+': hint('Shift+→', 'Shift+ArrowRight'),
      'x−': hint('Shift+←', 'Shift+ArrowLeft'),
      'y+': hint('Shift+↑', 'Shift+ArrowUp'),
      'y−': hint('Shift+↓', 'Shift+ArrowDown'),
      'z+': hint('Shift+Page Up', 'Shift+PageUp'),
      'z−': hint('Shift+Page Down', 'Shift+PageDown'),
    },
    arrows: {
      'x+': hint('→', 'ArrowRight', '→'),
      'x−': hint('←', 'ArrowLeft', '←'),
      'y+': hint('↑', 'ArrowUp', '↑'),
      'y−': hint('↓', 'ArrowDown', '↓'),
      'z−': hint('/', '/', '/'),
      'z+': hint("'", "'", "'"),
    },
  }

/** DF140: the key of the jog button `axis`/`sign` in `style`; none with the jog keys off. */
export function jogKeyHint(style: JogKeyStyle, axis: Axis, sign: 1 | -1): JogKeyHint | undefined {
  if (style === 'off') return undefined
  return KEY_HINTS[style][`${axis}${sign > 0 ? '+' : '−'}`]
}

/** DF140: styles whose keys sit like the pad's 2-row key layout (W over A S D, ↑ over ← ↓ →). */
export function keyLayout(style: JogKeyStyle | undefined): boolean {
  return style === 'game' || style === 'arrows'
}

const SHIFT = new Set(['ShiftLeft', 'ShiftRight'])

/** The jog of a `keydown` in `style`, if it is one (modifiers other than the style's: none). */
export function jogKeyOf(e: KeyInfo, style: JogKeyStyle): JogKey | undefined {
  if (style === 'off' || e.ctrlKey || e.metaKey || e.altKey) return undefined
  const map = style === 'game' ? GAME : style === 'gsender' ? GSENDER : ARROWS
  // gSender's keys all need Shift; the arrow keys none (Shift+/ is "?", the shortcut list)
  if (style === 'gsender' && !e.shiftKey) return undefined
  if (style === 'arrows' && e.shiftKey) return undefined
  const hit = map[e.code]
  return hit === undefined ? undefined : { code: e.code, axis: hit[0], sign: hit[1] }
}

/** Whether the `keyup` of `code` ends a press of `pressed` in `style` (gSender: Shift too). */
export function endsPress(code: string, pressed: string, style: JogKeyStyle): boolean {
  return code === pressed || (style === 'gsender' && SHIFT.has(code))
}

/** Widgets that move with arrow and Page keys themselves. */
const ARROW_WIDGETS =
  '[role="slider"], [role="radio"], [role="radiogroup"], [role="tab"], [role="tablist"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="listbox"], [role="option"], [role="separator"], [role="list"], [role="grid"], [role="tree"], [role="treeitem"]'
const ARROW_CODES = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
])

/**
 * Whether a jog key may jog with the focus on `target`: never while typing (text fields, number
 * and quantity fields, selects, text boxes), never inside a dialog without a jog pad (a focused
 * confirmation never jogs), arrow/Page keys stay with a widget that uses them, and Space stays
 * with a focused jog pad button.
 */
export function jogTargetAllowed(target: EventTarget | null, code: string): boolean {
  if (isEditableTarget(target)) return false
  if (!(target instanceof Element)) return true
  const dialog = target.closest('[role="dialog"], [role="alertdialog"]')
  if (dialog !== null && dialog.querySelector('[data-jog-pad]') === null) return false
  if (ARROW_CODES.has(code) && target.closest(ARROW_WIDGETS) !== null) return false
  // a focused jog pad button presses itself with Space (JogPad's own click/hold); a button is
  // focused only when reached with the keyboard: a pointer press leaves no focus (DF140)
  if (code === 'Space' && target.closest('[data-jog-pad] button') !== null) return false
  return true
}
