// Jog pad, step picker and jog hotkeys (DF88): click vs hold timing (fake timers), the custom
// step, hotkey styles, focus rules and Escape. Doc: docs/conventions/ui.md#jog-position-and-probing-df88
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import type { JogKeyStyle } from '../../../../shared/settings'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { HOLD_DELAY_MS } from './jog-press'
import { JogPad, type JogControls } from './JogPad'
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
    rerender(<JogPad controls={c} disabledReason="Home the machine first." reasonId="why" />)
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
      <JogPad
        controls={controls({ units: 'inch', step: 2.54 })}
        disabledReason={null}
        reasonId="why"
      />,
    )
    expect(screen.getByRole('radio', { name: '0.1 in' })).toBeChecked()
    expect(screen.getByRole('radio', { name: '0.001 in' })).toBeInTheDocument()
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
