// Jog pad, step picker and jog hotkeys (DF88): click vs hold timing (fake timers), the custom
// step, hotkey styles, focus rules and Escape. Doc: docs/conventions/ui.md#jog-position-and-probing-df88
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import type { JogKeyStyle } from '../../../../shared/settings'
import { cssRule } from '../../test/css'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { UiProvider } from '../../ui'
import { HOLD_DELAY_MS } from './jog-press'
import { JogPad, type JogControls } from './JogPad'
import { hiddenEdges, keepInView } from './JogStepPicker'
import { jogHotkeysActive, useJogHotkeyListener } from './useJogHotkeys'

function controls(patch: Partial<JogControls> = {}): JogControls & { log: string[] } {
  const log: string[] = []
  return {
    log,
    units: 'mm',
    step: 10,
    custom: undefined,
    feed: 2000,
    feedRange: { min: 100, max: 5000, step: 100 },
    setStep: (s) => log.push(`setStep ${s}`),
    setCustom: (s) => log.push(`setCustom ${s}`),
    setFeed: (f) => log.push(`setFeed ${f}`),
    jog: (axis, sign) => log.push(`step ${axis}${sign}`),
    holdStart: (axis, sign) => log.push(`hold ${axis}${sign}`),
    holdEnd: () => log.push('end'),
    cancel: () => log.push('cancel'),
    ...patch,
  }
}

describe('JogPad', () => {
  afterEach(() => vi.useRealTimers())

  it('has the step presets, the custom field and the feed slider, without axe violations', async () => {
    renderUi(<JogPad controls={controls()} disabledReason={null} reasonId="why" />)
    const presets = screen.getByRole('radiogroup', { name: 'Jog step presets' })
    expect(
      within(presets)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('aria-label')),
    ).toEqual(['0.1 mm', '1 mm', '5 mm', '10 mm', '20 mm', '50 mm', '100 mm'])
    expect(screen.getByRole('radio', { name: '10 mm' })).toBeChecked()
    expect(screen.getByRole('textbox', { name: 'Custom jog step (mm)' })).toHaveValue('')
    expect(screen.getByRole('slider', { name: 'Jog feed' })).toHaveAttribute(
      'aria-valuetext',
      '2000 mm/min',
    )
    expect(screen.queryByRole('radio', { name: 'Continuous' })).toBeNull()
    await expectNoAxeViolations()
  })

  it('a click jogs one step; a press held past the delay jogs until released (0x85)', () => {
    vi.useFakeTimers()
    const c = controls()
    renderUi(<JogPad controls={c} disabledReason={null} reasonId="why" />)
    const x = screen.getByRole('button', { name: 'Jog X+' })
    fireEvent.pointerDown(x, { button: 0, pointerId: 1 })
    act(() => {
      vi.advanceTimersByTime(HOLD_DELAY_MS - 50)
    })
    fireEvent.pointerUp(x, { pointerId: 1 })
    fireEvent.click(x, { detail: 1 })
    act(() => {
      vi.advanceTimersByTime(HOLD_DELAY_MS * 3)
    })
    expect(c.log).toEqual(['step x1'])

    const z = screen.getByRole('button', { name: 'Jog Z−' })
    fireEvent.pointerDown(z, { button: 0, pointerId: 1 })
    act(() => {
      vi.advanceTimersByTime(HOLD_DELAY_MS)
    })
    expect(c.log).toEqual(['step x1', 'hold z-1'])
    expect(z).toHaveAttribute('data-holding')
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    fireEvent.pointerUp(z, { pointerId: 1 })
    expect(c.log).toEqual(['step x1', 'hold z-1', 'end'])
    expect(z).not.toHaveAttribute('data-holding')
  })

  it('Space on a focused button: short = step, held = continuous; blur and disabling end a hold', () => {
    vi.useFakeTimers()
    const c = controls()
    const { rerender } = renderUi(<JogPad controls={c} disabledReason={null} reasonId="why" />)
    const y = screen.getByRole('button', { name: 'Jog Y+' })
    fireEvent.keyDown(y, { key: ' ' })
    fireEvent.keyUp(y, { key: ' ' })
    fireEvent.keyDown(y, { key: 'Enter' })
    act(() => {
      vi.advanceTimersByTime(HOLD_DELAY_MS)
    })
    fireEvent.blur(y)
    expect(c.log).toEqual(['step y1', 'hold y1', 'end'])
    fireEvent.pointerDown(y, { button: 0, pointerId: 1 })
    act(() => {
      vi.advanceTimersByTime(HOLD_DELAY_MS)
    })
    rerender(
      <UiProvider>
        <JogPad controls={c} disabledReason="Home the machine first." reasonId="why" />
      </UiProvider>,
    )
    expect(c.log).toEqual(['step y1', 'hold y1', 'end', 'hold y1', 'end'])
  })

  it('a press that is cancelled inside the delay sends nothing', () => {
    vi.useFakeTimers()
    const c = controls()
    renderUi(<JogPad controls={c} disabledReason={null} reasonId="why" />)
    const x = screen.getByRole('button', { name: 'Jog X−' })
    fireEvent.pointerDown(x, { button: 0, pointerId: 1 })
    fireEvent.pointerCancel(x, { pointerId: 1 })
    act(() => {
      vi.advanceTimersByTime(HOLD_DELAY_MS * 2)
    })
    expect(c.log).toEqual([])
  })

  it('chooses presets with click and arrow keys, and a custom step inline', () => {
    const c = controls()
    renderUi(<JogPad controls={c} disabledReason={null} reasonId="why" />)
    fireEvent.click(screen.getByRole('radio', { name: '0.1 mm' }))
    fireEvent.keyDown(screen.getByRole('radio', { name: '10 mm' }), { key: 'ArrowRight' })
    const field = screen.getByRole('textbox', { name: 'Custom jog step (mm)' })
    fireEvent.change(field, { target: { value: '2.5' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.change(field, { target: { value: '0' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Above 0, at most 1000 mm')).toBeInTheDocument()
    expect(c.log).toEqual(['setStep 0.1', 'setStep 20', 'setCustom 2.5'])
  })

  it('shows a custom step as chosen, and inch presets in inch projects', () => {
    const { rerender } = renderUi(
      <JogPad controls={controls({ step: 2.5 })} disabledReason={null} reasonId="why" />,
    )
    expect(screen.getByRole('textbox', { name: 'Custom jog step (mm)' })).toHaveValue('2.5')
    expect(screen.queryByRole('radio', { checked: true })).toBeNull()
    rerender(
      <UiProvider>
        <JogPad
          controls={controls({ units: 'inch', step: 2.54 })}
          disabledReason={null}
          reasonId="why"
        />
      </UiProvider>,
    )
    expect(screen.getByRole('radio', { name: '0.1 in' })).toBeChecked()
    expect(screen.getByRole('radio', { name: '0.001 in' })).toBeInTheDocument()
  })

  it('lays the step cells out in one row that scrolls sideways when narrower (DF102)', () => {
    renderUi(<JogPad controls={controls()} disabledReason={null} reasonId="why" />)
    const row = document.querySelector('[data-jog-steps]')!
    // the seven presets and the custom field are the row's cells, in order
    expect(within(row as HTMLElement).getAllByRole('radio')).toHaveLength(7)
    expect(row.lastElementChild).toBe(screen.getByRole('textbox', { name: 'Custom jog step (mm)' }))
    const css = 'src/renderer/src/modes/run/JogStepPicker.module.css'
    expect(cssRule(css, `.${row.className}`)).toMatchObject({
      display: 'flex',
      'overflow-x': 'auto',
      position: 'relative',
    })
    expect(cssRule(css, '.cell')).toMatchObject({ flex: '1 0 auto' })
  })

  it('keeps the chosen cell in view of the scrolled row, sideways only (DF102)', () => {
    const box = (props: Record<string, number>) => {
      const el = document.createElement('div')
      for (const [k, v] of Object.entries(props))
        Object.defineProperty(el, k, { value: v, writable: true, configurable: true })
      return el
    }
    const row = box({ clientWidth: 180, scrollLeft: 0 })
    keepInView(row, box({ offsetLeft: 40, offsetWidth: 30 }))
    expect(row.scrollLeft).toBe(0)
    keepInView(row, box({ offsetLeft: 200, offsetWidth: 56 }))
    expect(row.scrollLeft).toBe(200 + 56 + 2 - 180)
    keepInView(row, box({ offsetLeft: 2, offsetWidth: 28 }))
    expect(row.scrollLeft).toBe(0)
    // the ends with cells out of view, which fade
    expect(hiddenEdges(box({ clientWidth: 180, scrollWidth: 180, scrollLeft: 0 }))).toEqual({
      start: false,
      end: false,
    })
    expect(hiddenEdges(box({ clientWidth: 180, scrollWidth: 250, scrollLeft: 0 }))).toEqual({
      start: false,
      end: true,
    })
    expect(hiddenEdges(box({ clientWidth: 180, scrollWidth: 250, scrollLeft: 30 }))).toEqual({
      start: true,
      end: true,
    })
    expect(hiddenEdges(box({ clientWidth: 180, scrollWidth: 250, scrollLeft: 70 }))).toEqual({
      start: true,
      end: false,
    })
  })
})

function Hotkeys(props: {
  style: JogKeyStyle
  c: JogControls
  active?: boolean
  jogging?: boolean
}) {
  useJogHotkeyListener({
    style: props.style,
    active: props.active ?? true,
    canStop: true,
    jogging: props.jogging ?? false,
    controls: props.c,
  })
  return (
    <>
      <button>Home</button>
      <input aria-label="Name" />
    </>
  )
}

const down = (target: Element | Window, init: KeyboardEventInit) =>
  act(
    () =>
      void target.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
      ),
  )
const up = (target: Element | Window, init: KeyboardEventInit) =>
  act(
    () =>
      void target.dispatchEvent(
        new KeyboardEvent('keyup', { bubbles: true, cancelable: true, ...init }),
      ),
  )

describe('JogPad: the workholding guard’s notice (DF133 RW3)', () => {
  it('no line without the guard; a reserved line with it; the notice and Jog past once, without axe violations', async () => {
    const { unmount } = renderUi(
      <JogPad controls={controls()} disabledReason={null} reasonId="why" />,
    )
    expect(document.querySelector('[data-guard-notice]')).toBeNull()
    unmount()
    const c = controls({ guard: { notice: undefined, pastOnce: undefined } })
    const r = renderUi(<JogPad controls={c} disabledReason={null} reasonId="why" />)
    const line = document.querySelector('[data-guard-notice]')!
    expect(within(line as HTMLElement).getByRole('status')).toHaveTextContent(/^$/)
    expect(screen.queryByRole('button', { name: 'Jog past once' })).toBeNull()
    r.unmount()
    const s = controls({
      guard: {
        notice: 'Stopped 2 mm from Toe clamp 2 (collet nut).',
        pastOnce: () => s.log.push('past once'),
      },
    })
    const p = renderUi(<JogPad controls={s} disabledReason={null} reasonId="why" />)
    expect(
      within(document.querySelector('[data-guard-notice]') as HTMLElement).getByRole('status'),
    ).toHaveTextContent('Stopped 2 mm from Toe clamp 2 (collet nut).')
    await p.user.click(screen.getByRole('button', { name: 'Jog past once' }))
    expect(s.log).toEqual(['past once'])
    await expectNoAxeViolations()
  })
})

describe('jog hotkeys', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('videogame: a tap is one step, a hold jogs until keyup; repeats are ignored', () => {
    const c = controls()
    renderUi(<Hotkeys style="game" c={c} />)
    down(document.body, { key: 'w', code: 'KeyW' })
    up(document.body, { key: 'w', code: 'KeyW' })
    down(document.body, { key: ' ', code: 'Space' })
    act(() => {
      vi.advanceTimersByTime(HOLD_DELAY_MS)
    })
    down(document.body, { key: ' ', code: 'Space', repeat: true })
    down(document.body, { key: 'a', code: 'KeyA' })
    up(document.body, { key: ' ', code: 'Space' })
    down(document.body, { key: 'Shift', code: 'ShiftLeft', shiftKey: true })
    up(document.body, { key: 'Shift', code: 'ShiftLeft' })
    expect(c.log).toEqual(['step y1', 'hold z1', 'end', 'step z-1'])
  })

  it('a handled key is prevented: Space on a focused button jogs instead of pressing it', () => {
    const c = controls()
    renderUi(<Hotkeys style="game" c={c} />)
    const home = screen.getByRole('button', { name: 'Home' })
    const e = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    })
    act(() => void home.dispatchEvent(e))
    expect(e.defaultPrevented).toBe(true)
    const u = new KeyboardEvent('keyup', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    })
    act(() => void home.dispatchEvent(u))
    expect(u.defaultPrevented).toBe(true)
    expect(c.log).toEqual(['step z1'])
  })

  it('never while typing in a field', () => {
    const c = controls()
    renderUi(<Hotkeys style="game" c={c} />)
    const field = screen.getByRole('textbox', { name: 'Name' })
    down(field, { key: 'w', code: 'KeyW' })
    up(field, { key: 'w', code: 'KeyW' })
    act(() => {
      vi.advanceTimersByTime(HOLD_DELAY_MS)
    })
    expect(c.log).toEqual([])
  })

  it('gSender and arrow-key styles; Shift up ends a gSender hold', () => {
    const c = controls()
    const { rerender } = renderUi(<Hotkeys style="gsender" c={c} />)
    down(document.body, { key: 'ArrowRight', code: 'ArrowRight' })
    down(document.body, { key: 'ArrowRight', code: 'ArrowRight', shiftKey: true })
    act(() => {
      vi.advanceTimersByTime(HOLD_DELAY_MS)
    })
    up(document.body, { key: 'Shift', code: 'ShiftLeft' })
    down(document.body, { key: 'PageDown', code: 'PageDown', shiftKey: true })
    up(document.body, { key: 'PageDown', code: 'PageDown', shiftKey: true })
    rerender(<Hotkeys style="arrows" c={c} />)
    down(document.body, { key: '/', code: 'Slash' })
    up(document.body, { key: '/', code: 'Slash' })
    down(document.body, { key: "'", code: 'Quote' })
    up(document.body, { key: "'", code: 'Quote' })
    rerender(<Hotkeys style="off" c={c} />)
    down(document.body, { key: 'ArrowUp', code: 'ArrowUp' })
    up(document.body, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(c.log).toEqual(['hold x1', 'end', 'step z-1', 'step z-1', 'step z1'])
  })

  it('Escape stops a jog and drops a press inside the delay; inactive keys do nothing', () => {
    const c = controls()
    const { rerender } = renderUi(<Hotkeys style="game" c={c} jogging />)
    down(document.body, { key: 'd', code: 'KeyD' })
    down(document.body, { key: 'Escape', code: 'Escape' })
    up(document.body, { key: 'd', code: 'KeyD' })
    act(() => {
      vi.advanceTimersByTime(HOLD_DELAY_MS)
    })
    expect(c.log).toEqual(['cancel'])
    rerender(<Hotkeys style="game" c={c} active={false} />)
    down(document.body, { key: 'd', code: 'KeyD' })
    up(document.body, { key: 'd', code: 'KeyD' })
    expect(c.log).toEqual(['cancel'])
  })

  it('is active only while connected, idle or jogging, without a run job', () => {
    const open = (patch: Partial<RunStatus>): RunStatus => ({
      ...closedStatus(),
      connection: { state: 'open', target: 'serial', timeScale: 1 },
      homed: true,
      ...patch,
    })
    expect(jogHotkeysActive(closedStatus(), 'game')).toBe(false)
    expect(jogHotkeysActive(open({ state: 'Idle' }), 'game')).toBe(true)
    expect(jogHotkeysActive(open({ state: 'Jog' }), 'game')).toBe(true)
    expect(jogHotkeysActive(open({ state: 'Idle' }), 'off')).toBe(false)
    expect(jogHotkeysActive(open({ state: 'Alarm' }), 'game')).toBe(false)
    expect(
      jogHotkeysActive(
        open({
          state: 'Idle',
          job: {
            jobId: 'run-1',
            phase: 'toolChange',
            line: 4,
            startedAt: '2026-11-24T10:00:00Z',
            elapsedSeconds: 3,
          },
        }),
        'game',
      ),
    ).toBe(false)
  })
})

// Hardening DF140: the key layout, the key caps and tooltips, and a clicked pad button never
// keeping the jog keys. Doc: docs/conventions/ui.md#jog-pad-df140
describe('JogPad: the jog keys on the pad (DF140)', () => {
  const grid = () => screen.getByRole('button', { name: 'Jog Z+' }).parentElement!

  it('lays the pad out in two rows like the keys for videogame and arrow keys only', () => {
    for (const [keys, layout] of [
      ['game', 'keys'],
      ['arrows', 'keys'],
      ['gsender', null],
      ['off', null],
      [undefined, null],
    ] as const) {
      const r = renderUi(
        <JogPad
          controls={controls(keys === undefined ? {} : { keys })}
          disabledReason={null}
          reasonId="why"
        />,
      )
      expect(grid().getAttribute('data-layout')).toBe(layout)
      r.unmount()
    }
    const css = 'src/renderer/src/modes/run/Run.module.css'
    const keys = ".jogPad[data-layout='keys']:not([data-z-only])"
    expect(cssRule(css, keys)).toMatchObject({
      'grid-template-rows': 'repeat(2, var(--control-lg))',
    })
    // Z on the left; Y+ over Y−, between X− and X+
    expect(cssRule(css, `${keys} .zPlus`)).toMatchObject({ 'grid-area': '1 / 1' })
    expect(cssRule(css, `${keys} .zMinus`)).toMatchObject({ 'grid-area': '2 / 1' })
    expect(cssRule(css, `${keys} .yPlus`)).toMatchObject({ 'grid-area': '1 / 4' })
    expect(cssRule(css, `${keys} .xMinus`)).toMatchObject({ 'grid-area': '2 / 3' })
    expect(cssRule(css, `${keys} .yMinus`)).toMatchObject({ 'grid-area': '2 / 4' })
    expect(cssRule(css, `${keys} .xPlus`)).toMatchObject({ 'grid-area': '2 / 5' })
  })

  it('shows a single key as a key cap and every key in the tooltip, without axe violations', async () => {
    const r = renderUi(
      <JogPad controls={controls({ keys: 'game' })} disabledReason={null} reasonId="why" />,
    )
    const cap = (name: string) =>
      screen.getByRole('button', { name }).querySelector('[data-jog-key]')?.textContent
    expect(cap('Jog Y+')).toBe('W')
    expect(cap('Jog X−')).toBe('A')
    expect(cap('Jog Z+')).toBe('␣')
    expect(cap('Jog Z−')).toBe('⇧')
    expect(screen.getByRole('button', { name: 'Jog Z+' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Space',
    )
    act(() => screen.getByRole('button', { name: 'Jog X+' }).focus())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Jog X+D')
    await expectNoAxeViolations()
    r.unmount()

    // gSender's keys are combinations: no key cap, the keys in the tooltip
    renderUi(
      <JogPad controls={controls({ keys: 'gsender' })} disabledReason={null} reasonId="why" />,
    )
    const x = screen.getByRole('button', { name: 'Jog X+' })
    expect(x.querySelector('[data-jog-key]')).toBeNull()
    expect(x).toHaveAttribute('aria-keyshortcuts', 'Shift+ArrowRight')
    act(() => x.focus())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Shift+→')
  })

  it('a clicked step or Stop jog keeps no focus, so Space jogs Z+; a Tab-focused one keeps Space', async () => {
    const c = controls({ keys: 'game' })
    const { user } = renderUi(
      <>
        <JogPad controls={c} disabledReason={null} reasonId="why" />
        <Hotkeys style="game" c={c} />
      </>,
    )
    const one = screen.getByRole('radio', { name: '1 mm' })
    await user.click(one)
    expect(one).not.toHaveFocus()
    down(document.body, { key: ' ', code: 'Space' })
    up(document.body, { key: ' ', code: 'Space' })
    const stop = screen.getByRole('button', { name: 'Stop jog' })
    await user.click(stop)
    expect(stop).not.toHaveFocus()
    down(document.body, { key: ' ', code: 'Space' })
    up(document.body, { key: ' ', code: 'Space' })
    expect(c.log).toEqual(['setStep 1', 'step z1', 'cancel', 'step z1'])

    // reached with the keyboard: the button keeps the focus and its own Space and Enter
    const ten = screen.getByRole('radio', { name: '10 mm' })
    act(() => ten.focus())
    const e = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    })
    act(() => void ten.dispatchEvent(e))
    expect(e.defaultPrevented).toBe(false)
    fireEvent.click(ten, { detail: 0 })
    expect(ten).toHaveFocus()
    expect(c.log).toEqual(['setStep 1', 'step z1', 'cancel', 'step z1', 'setStep 10'])
  })
})
