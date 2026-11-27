// Jog hotkey styles and focus rules (DF88): docs/conventions/ui.md#jog-hotkeys
import { describe, expect, it } from 'vitest'
import { jogShortcuts } from '../../shell/ShortcutsDialog'
import { endsPress, jogKeyOf, jogTargetAllowed } from './jog-keys'

describe('jogShortcuts (the shortcut list, DF88)', () => {
  it('lists the chosen style and Escape; Off says where to turn them on', () => {
    expect(jogShortcuts('gsender')[0]).toEqual([
      'Shift+→',
      'Jog X+ (tap: one step, hold: until released)',
    ])
    expect(jogShortcuts('game').slice(-2)).toEqual([
      ['Esc', 'Stop jogging'],
      ['G', 'Go to coordinates…'],
    ])
    expect(jogShortcuts('off')[0]?.[1]).toBe('Jog keys are off (Settings → Jog keys)')
  })
})

const key = (
  code: string,
  mods: { shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean } = {},
) => ({
  code,
  shiftKey: mods.shift ?? false,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  altKey: mods.alt ?? false,
})
const jog = (k: ReturnType<typeof key>, style: Parameters<typeof jogKeyOf>[1]) => {
  const j = jogKeyOf(k, style)
  return j === undefined ? undefined : `${j.axis}${j.sign > 0 ? '+' : '-'}`
}

describe('jogKeyOf', () => {
  it('videogame: WASD for X/Y, Shift Z−, Space Z+', () => {
    expect(jog(key('KeyW'), 'game')).toBe('y+')
    expect(jog(key('KeyA'), 'game')).toBe('x-')
    expect(jog(key('KeyS'), 'game')).toBe('y-')
    expect(jog(key('KeyD'), 'game')).toBe('x+')
    expect(jog(key('ShiftLeft', { shift: true }), 'game')).toBe('z-')
    expect(jog(key('ShiftRight', { shift: true }), 'game')).toBe('z-')
    expect(jog(key('Space'), 'game')).toBe('z+')
    expect(jog(key('ArrowUp'), 'game')).toBeUndefined()
  })

  it('gSender: its defaults, Shift+arrows and Shift+Page Up/Down', () => {
    expect(jog(key('ArrowRight', { shift: true }), 'gsender')).toBe('x+')
    expect(jog(key('ArrowLeft', { shift: true }), 'gsender')).toBe('x-')
    expect(jog(key('ArrowUp', { shift: true }), 'gsender')).toBe('y+')
    expect(jog(key('ArrowDown', { shift: true }), 'gsender')).toBe('y-')
    expect(jog(key('PageUp', { shift: true }), 'gsender')).toBe('z+')
    expect(jog(key('PageDown', { shift: true }), 'gsender')).toBe('z-')
    expect(jog(key('ArrowRight'), 'gsender')).toBeUndefined()
    expect(endsPress('ShiftLeft', 'ArrowRight', 'gsender')).toBe(true)
    expect(endsPress('ShiftLeft', 'KeyW', 'game')).toBe(false)
  })

  it("arrow keys: arrows for X/Y, / Z−, ' Z+; not with Shift (Shift+/ is the list)", () => {
    expect(jog(key('ArrowUp'), 'arrows')).toBe('y+')
    expect(jog(key('ArrowLeft'), 'arrows')).toBe('x-')
    expect(jog(key('Slash'), 'arrows')).toBe('z-')
    expect(jog(key('Quote'), 'arrows')).toBe('z+')
    expect(jog(key('Slash', { shift: true }), 'arrows')).toBeUndefined()
  })

  it('off, and Ctrl/Cmd/Alt never jog', () => {
    expect(jog(key('KeyW'), 'off')).toBeUndefined()
    expect(jog(key('KeyS', { meta: true }), 'game')).toBeUndefined()
    expect(jog(key('KeyD', { ctrl: true }), 'game')).toBeUndefined()
    expect(jog(key('ArrowUp', { alt: true }), 'arrows')).toBeUndefined()
  })
})

describe('jogTargetAllowed', () => {
  const el = (html: string, select: string) => {
    document.body.innerHTML = html
    return document.querySelector(select)
  }

  it('never while typing: text and number fields, text areas, selects, text boxes', () => {
    expect(jogTargetAllowed(el('<input type="text">', 'input'), 'KeyW')).toBe(false)
    expect(jogTargetAllowed(el('<input type="number">', 'input'), 'KeyW')).toBe(false)
    expect(jogTargetAllowed(el('<textarea></textarea>', 'textarea'), 'Space')).toBe(false)
    expect(jogTargetAllowed(el('<div role="combobox" tabindex="0"></div>', 'div'), 'KeyA')).toBe(
      false,
    )
  })

  it('any other focus: the body, a button, a checkbox', () => {
    expect(jogTargetAllowed(document.body, 'KeyW')).toBe(true)
    expect(jogTargetAllowed(el('<button>Home</button>', 'button'), 'Space')).toBe(true)
    expect(jogTargetAllowed(el('<input type="checkbox">', 'input'), 'KeyD')).toBe(true)
  })

  it('a focused jog pad button keeps Space for itself; other keys still jog', () => {
    const b = el('<div data-jog-pad><button>Jog Z−</button></div>', 'button')
    expect(jogTargetAllowed(b, 'Space')).toBe(false)
    expect(jogTargetAllowed(b, 'KeyW')).toBe(true)
  })

  it('arrow and Page keys stay with a widget that uses them', () => {
    expect(
      jogTargetAllowed(el('<span role="slider" tabindex="0"></span>', 'span'), 'ArrowUp'),
    ).toBe(false)
    expect(jogTargetAllowed(el('<span role="slider" tabindex="0"></span>', 'span'), 'KeyW')).toBe(
      true,
    )
    expect(
      jogTargetAllowed(
        el('<div role="radiogroup"><button role="radio"></button></div>', 'button'),
        'ArrowLeft',
      ),
    ).toBe(false)
  })

  it('in a dialog only when it has a jog pad (the setup change), never a confirmation', () => {
    expect(
      jogTargetAllowed(el('<div role="alertdialog"><button>Home</button></div>', 'button'), 'KeyW'),
    ).toBe(false)
    expect(
      jogTargetAllowed(
        el('<div role="dialog"><div data-jog-pad></div><button>Later</button></div>', 'button'),
        'KeyW',
      ),
    ).toBe(true)
  })
})
