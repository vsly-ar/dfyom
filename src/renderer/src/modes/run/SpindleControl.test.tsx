// The spindle under the jog pad (v0.5 RV1). Spec: docs/modes/run-machine.md#spindle-while-jogging-rv1
import { act, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { spindleRange, SpindleControl } from './SpindleControl'

const ROUTER = { spindleControl: 'gcode', minSpindle: 6200, maxSpindle: 24000 } as const

function statusWith(over: Partial<RunStatus> = {}): RunStatus {
  return {
    ...closedStatus(),
    connection: { state: 'open', target: 'virtual', timeScale: 1 },
    state: 'Idle',
    homed: true,
    ...over,
  }
}

describe('SpindleControl (v0.5 RV1)', () => {
  it('starts after the confirmation at the chosen speed; Off is never confirmed', async () => {
    const onSpindle = vi.fn(async () => {})
    const { user } = renderUi(
      <SpindleControl status={statusWith()} machine={ROUTER} onSpindle={onSpindle} />,
    )
    expect(screen.getByRole('status', { name: 'Spindle: Off' })).toBeInTheDocument()
    const speed = screen.getByRole('slider', { name: 'Spindle speed' })
    // the middle of 6200–24000, rounded to 1000 rpm
    expect(speed).toHaveAttribute('aria-valuetext', '15000 rpm')
    expect(speed).toHaveAttribute('aria-valuemin', '6200')
    act(() => speed.focus())
    await user.keyboard('{ArrowRight}')
    expect(speed).toHaveAttribute('aria-valuetext', '15100 rpm')
    // off: nothing sent on a speed change
    expect(onSpindle).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Start spindle' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Start the spindle?' })
    expect(dialog).toHaveTextContent('The spindle starts at 15100 rpm.')
    await expectNoAxeViolations()
    await user.click(screen.getByRole('button', { name: 'Start spindle' }))
    expect(onSpindle).toHaveBeenLastCalledWith(true, 15100)
    await user.click(screen.getByRole('button', { name: 'Stop spindle' }))
    expect(onSpindle).toHaveBeenLastCalledWith(false)
  })

  it('in a jog: Start is disabled with the reason; a turning spindle shows accent and takes a speed', async () => {
    const onSpindle = vi.fn(async () => {})
    const { user, rerender } = renderUi(
      <SpindleControl
        status={statusWith({ state: 'Jog' })}
        machine={ROUTER}
        onSpindle={onSpindle}
      />,
    )
    const start = screen.getByRole('button', { name: 'Start spindle' })
    expect(start).toBeDisabled()
    expect(start).toHaveAccessibleDescription(
      'Stop the jog first: the spindle turns on only while the machine is idle.',
    )
    expect(screen.getByRole('button', { name: 'Stop spindle' })).toBeEnabled()
    await expectNoAxeViolations()
    rerender(
      <SpindleControl
        status={statusWith({
          state: 'Jog',
          spindle: 12000,
          spindleDirection: 'cw',
          manualSpindle: { rpm: 12000 },
        })}
        machine={ROUTER}
        onSpindle={onSpindle}
      />,
    )
    const state = screen.getByRole('status', { name: 'Spindle: 12000 rpm · CW' })
    expect(state).toHaveAttribute('data-on')
    // a new speed while jogging goes to the host (the spindle override)
    const speed = screen.getByRole('slider', { name: 'Spindle speed' })
    act(() => speed.focus())
    await user.keyboard('{PageUp}')
    expect(onSpindle).toHaveBeenCalledWith(true, expect.any(Number))
  })

  it('during a run Stop has the reason; a manual spindle and laser mode say why there is none', async () => {
    const running = statusWith({
      state: 'Run',
      job: {
        jobId: 'run-1',
        phase: 'streaming',
        line: 3,
        startedAt: '2026-11-27T10:00:00.000Z',
        elapsedSeconds: 1,
      },
    })
    const { rerender } = renderUi(
      <SpindleControl status={running} machine={ROUTER} onSpindle={() => {}} />,
    )
    expect(screen.getByRole('button', { name: 'Stop spindle' })).toHaveAccessibleDescription(
      'The run controls the spindle: Stop stops the run and the spindle.',
    )
    rerender(
      <SpindleControl
        status={statusWith()}
        machine={{ spindleControl: 'manual', maxSpindle: 30000 }}
        onSpindle={() => {}}
      />,
    )
    expect(screen.getByText(/set by hand/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start spindle' })).toBeNull()
    rerender(
      <SpindleControl
        status={statusWith({ laserMode: true })}
        machine={ROUTER}
        onSpindle={() => {}}
      />,
    )
    expect(screen.getByText(/laser mode/)).toBeInTheDocument()
    await expectNoAxeViolations()
  })

  it('the range: minSpeed–maxSpeed, the default inside it', () => {
    expect(spindleRange(ROUTER)).toEqual({ min: 6200, max: 24000, initial: 15000 })
    expect(spindleRange({ maxSpindle: 1000 })).toEqual({ min: 100, max: 1000, initial: 1000 })
  })
})
