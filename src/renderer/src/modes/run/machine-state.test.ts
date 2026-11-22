import { describe, expect, it } from 'vitest'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import { formatFeed, formatLength, machineView, runGates, stepToMm } from './machine-state'

const open = (patch: Partial<RunStatus> = {}): RunStatus => ({
  ...closedStatus(),
  connection: { state: 'open', target: 'virtual', timeScale: 10 },
  state: 'Idle',
  homed: true,
  ...patch,
})
const job = (phase: NonNullable<RunStatus['job']>['phase'], extra = {}) => ({
  job: { jobId: 'j', phase, line: 1, startedAt: '', elapsedSeconds: 0, ...extra },
})

describe('machineView', () => {
  it.each([
    [closedStatus(), 'offline', 'Not connected'],
    [open(), 'idle', 'Idle'],
    [open({ state: 'Alarm' }), 'alarm', 'Alarm'],
    [open({ state: 'Alarm', alarm: { code: 2, text: '' } }), 'alarm', 'Alarm 2: soft limit'],
    [open({ state: 'Home' }), 'moving', 'Homing'],
    [open({ state: 'Jog' }), 'moving', 'Jogging'],
    [open({ state: 'Run', ...job('streaming') }), 'moving', 'Running'],
    [open({ state: 'Hold:0', ...job('held') }), 'hold', 'Feed hold'],
    [open({ state: 'Hold:0', ...job('programPause') }), 'hold', 'Paused (M0)'],
    [open({ ...job('toolChange', { toolChange: { n: 2, name: 'x' } }) }), 'action', 'Tool change'],
    [open({ state: 'Jog', ...job('toolChange') }), 'moving', 'Jogging'],
    [open({ ...job('done') }), 'idle', 'Idle'],
  ] as const)('%#: %s', (status, state, label) => {
    expect(machineView(status)).toEqual({ state, label })
  })

  it('a setup change between runs shows like a tool change while idle (E2)', () => {
    const setupChange = { setupChange: true }
    expect(machineView(open(), setupChange)).toEqual({ state: 'action', label: 'Setup change' })
    expect(machineView(open({ ...job('done') }), setupChange).label).toBe('Setup change')
    // moving, alarms and a running job still win
    expect(machineView(open({ state: 'Jog' }), setupChange).label).toBe('Jogging')
    expect(machineView(open({ state: 'Alarm' }), setupChange).label).toBe('Alarm')
    expect(machineView(open({ state: 'Run', ...job('streaming') }), setupChange).label).toBe(
      'Running',
    )
  })
})

describe('runGates', () => {
  it('explains every disabled control', () => {
    expect(runGates(closedStatus(), { planChosen: true }).jog).toBe(
      'Connect to the virtual machine first.',
    )
    const alarm = runGates(open({ state: 'Alarm', homed: false }), { planChosen: true })
    expect(alarm).toMatchObject({ home: null, unlock: null, jog: 'Home the machine first.' })
    expect(alarm.start).toBe('Home the machine first.')
    expect(runGates(open(), { planChosen: false }).start).toBe('Choose a plan first.')
    expect(runGates(open(), { planChosen: true })).toMatchObject({ start: null, jog: null })
  })

  it('allows jog and work zero during a tool change only', () => {
    const tc = runGates(open(job('toolChange')), { planChosen: true })
    expect(tc).toMatchObject({ jog: null, workZero: null, home: 'Not while a run is going.' })
    expect(runGates(open({ state: 'Run', ...job('streaming') }), { planChosen: true }).jog).toBe(
      'Not while a run is going.',
    )
  })

  it('a critical alarm needs a reset first', () => {
    const g = runGates(open({ state: 'Alarm', alarm: { code: 1, text: '' } }), {
      planChosen: true,
    })
    expect(g.home).toMatch(/^Reset the machine first/)
  })
})

describe('formatting', () => {
  it('shows lengths and feeds in the project units, without negative zero', () => {
    expect(formatLength(-401, 'mm')).toBe('-401.000')
    expect(formatLength(-0.0001, 'mm')).toBe('0.000')
    expect(formatLength(25.4, 'inch')).toBe('1.0000')
    expect(formatFeed(2540, 'inch')).toBe('100.0')
    expect(stepToMm('0.1', 'inch')).toBeCloseTo(2.54)
  })
})
