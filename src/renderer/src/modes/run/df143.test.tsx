// Hardening DF143: the probe check, "Unlock and back off" in the alarm panel, the unverified
// position gate and the advanced user's skipped spindle confirmation.
// Spec: docs/modes/run-probing.md#probe-check-df143, docs/modes/run-machine.md#unlock-and-back-off-df143,
// docs/modes/run.md#advanced-user-df143
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { AlarmPanel } from './AlarmPanel'
import { runGates } from './machine-state'
import {
  NO_PROBE_CHECK,
  probeChecked,
  probeCheckForKind,
  probeCheckOnStatus,
  type ProbeCheck,
} from './probe-check'
import { SpindleControl } from './SpindleControl'

function open(over: Partial<RunStatus> = {}): RunStatus {
  return {
    ...closedStatus(),
    connection: { state: 'open', target: 'virtual', timeScale: 1 },
    state: 'Idle',
    homed: true,
    ...over,
  }
}

describe('probe check (DF143)', () => {
  it('passes once the input went touching, then open, for the kind in use', () => {
    let c: ProbeCheck = probeCheckForKind(NO_PROBE_CHECK, 'plate')
    c = probeCheckOnStatus(c, open())
    expect(probeChecked(c, 'plate')).toBe(false)
    c = probeCheckOnStatus(c, open({ pins: 'P' }))
    expect(probeChecked(c, 'plate')).toBe(false)
    c = probeCheckOnStatus(c, open({ pins: '' }))
    expect(probeChecked(c, 'plate')).toBe(true)
    // touching again later keeps it passed
    expect(probeChecked(probeCheckOnStatus(c, open({ pins: 'PX' })), 'plate')).toBe(true)
    // another probe kind starts it again
    expect(probeChecked(probeCheckForKind(c, 'tool'), 'tool')).toBe(false)
    // a disconnect (or a reconnect) starts it again
    const off = probeCheckOnStatus(c, closedStatus())
    expect(probeChecked(off, 'plate')).toBe(false)
    expect(off.kind).toBe('plate')
  })

  it('open alone never passes it', () => {
    let c = probeCheckForKind(NO_PROBE_CHECK, 'plate')
    for (let i = 0; i < 3; i++) c = probeCheckOnStatus(c, open({ pins: 'X' }))
    expect(probeChecked(c, 'plate')).toBe(false)
  })
})

describe('position unverified (DF143)', () => {
  it('blocks Start until homed; jogging stays allowed', () => {
    const gates = runGates(open({ positionUnverified: true }), { planChosen: true })
    expect(gates.start).toBe(
      'Home the machine first: the position is unverified after the limit switch.',
    )
    expect(gates.jog).toBeNull()
    expect(runGates(open(), { planChosen: true }).start).toBeNull()
  })
})

describe('Unlock and back off (DF143)', () => {
  const limit = (over: Partial<RunStatus> = {}): RunStatus =>
    open({
      state: 'Alarm',
      homed: false,
      alarm: { code: 1, text: 'Hard limit', jog: [1, 0, 0] },
      pins: 'X',
      ...over,
    })
  const backOff = (onBackOff = vi.fn()) => ({
    distance: 3,
    units: 'mm' as const,
    busy: false,
    onBackOff,
  })

  it('offers the move off the switch opposite the jog, for an advanced user', async () => {
    const onBackOff = vi.fn()
    const { user } = renderUi(<AlarmPanel status={limit()} backOff={backOff(onBackOff)} />)
    expect(screen.getByText(/jogs X− 3(\.0+)? mm off the switch/)).toBeInTheDocument()
    expect(screen.getByText(/stays unverified until you home again/)).toBeInTheDocument()
    await expectNoAxeViolations()
    await user.click(screen.getByRole('button', { name: 'Unlock and back off' }))
    expect(onBackOff).toHaveBeenCalledOnce()
  })

  it('is not offered without the advanced setting, outside a jog, or in a run', () => {
    const { rerender } = renderUi(<AlarmPanel status={limit()} />)
    expect(screen.queryByRole('button', { name: 'Unlock and back off' })).toBeNull()
    rerender(
      <AlarmPanel status={limit({ alarm: { code: 1, text: 'Hard limit' } })} backOff={backOff()} />,
    )
    expect(screen.queryByRole('button', { name: 'Unlock and back off' })).toBeNull()
    rerender(
      <AlarmPanel
        status={limit({
          job: {
            jobId: 'run-1',
            phase: 'streaming',
            line: 1,
            total: 10,
            planId: 'p',
            setupId: 's',
          } as unknown as NonNullable<RunStatus['job']>,
        })}
        backOff={backOff()}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Unlock and back off' })).toBeNull()
  })

  it('says why when the way off is not known', () => {
    renderUi(
      <AlarmPanel
        status={limit({ alarm: { code: 1, text: '', jog: [0, 0, 0] }, pins: '' })}
        backOff={backOff()}
      />,
    )
    expect(screen.getByText(/The way off the switch is not known/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unlock and back off' })).toBeNull()
  })
})

describe('advanced user: Start spindle (DF143)', () => {
  it('starts without the confirmation', async () => {
    const onSpindle = vi.fn(async () => {})
    const { user } = renderUi(
      <SpindleControl
        status={open()}
        machine={{ spindleControl: 'gcode', minSpindle: 6200, maxSpindle: 24000 }}
        onSpindle={onSpindle}
        confirmStart={false}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Start spindle' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onSpindle).toHaveBeenCalledWith(true, 15000)
  })
})
