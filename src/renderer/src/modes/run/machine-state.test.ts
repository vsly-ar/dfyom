import { describe, expect, it } from 'vitest'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import {
  actionText,
  formatFeed,
  formatLength,
  machineView,
  needsHoming,
  positionKnown,
  runGates,
  stepToMm,
  stopGate,
  surfaceName,
  touchOffMoves,
} from './machine-state'

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
    // DF46: GRBL's start-up lock (no alarm code, not homed) is no error
    [open({ state: 'Alarm', homed: false }), 'needsHoming', 'Needs homing'],
    [
      open({ state: 'Alarm', homed: false, alarm: { code: 3, text: '' } }),
      'alarm',
      'Alarm 3: reset while moving',
    ],
    [open({ state: 'Alarm', alarm: { code: 2, text: '' } }), 'alarm', 'Alarm 2: soft limit'],
    [open({ state: 'Home' }), 'moving', 'Homing'],
    [open({ state: 'Jog' }), 'moving', 'Jogging'],
    [open({ state: 'Run', ...job('streaming') }), 'moving', 'Running'],
    [open({ state: 'Hold:0', ...job('held') }), 'hold', 'Feed hold'],
    // DF82: still decelerating after the hold (the job is not paused yet)
    [open({ state: 'Hold:1', ...job('held') }), 'hold', 'Holding…'],
    [open({ state: 'Run', ...job('held') }), 'hold', 'Holding…'],
    [open({ state: 'Hold:1' }), 'hold', 'Holding…'],
    [open({ state: 'Hold:0', ...job('programPause') }), 'hold', 'Paused by program'],
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
    expect(runGates(closedStatus(), { planChosen: true }).jog).toBe('Connect to a machine first.')
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

describe('stopGate (DF35)', () => {
  it.each([
    [closedStatus(), 'Connect to a machine first.'],
    [open(), 'Nothing to stop: the machine is not moving.'],
    [open({ state: 'Alarm' }), 'Nothing to stop: the machine is not moving.'],
    [open({ ...job('done') }), 'Nothing to stop: the machine is not moving.'],
    [open({ state: 'Jog' }), null],
    [open({ state: 'Home' }), null],
    [open({ state: 'Run' }), null],
    [open({ state: 'Hold:1' }), null],
    [open({ state: 'Door:0' }), null],
    [open({ ...job('toolChange') }), null],
  ] as const)('%#', (status, reason) => {
    expect(stopGate(status)).toBe(reason)
  })
})

describe('actionText (DF33)', () => {
  const travel = (data: Record<string, unknown>) => ({
    code: 'run.travel' as const,
    message: 'm',
    issues: [],
    frames: [{ where: 'machineHost.jog', data }],
  })
  it('words a travel refusal in the project unit; other codes keep their message', () => {
    expect(actionText(travel({ axis: 'x', target: 1, min: -800, max: 0 }), 'mm')).toBe(
      'X would leave the travel: max 0.000 mm, the jog would end at 1.000 mm.',
    )
    expect(actionText(travel({ axis: 'y', target: -812.8, min: -800, max: 0 }), 'inch')).toBe(
      'Y would leave the travel: min -31.4961 in, the jog would end at -32.0000 in.',
    )
    expect(actionText(travel({}), 'mm')).toBe(
      'The jog would leave the machine travel (soft limits).',
    )
    expect(
      actionText({ code: 'run.state', message: 'm', issues: [], frames: [] }, 'mm'),
    ).toBeUndefined()
  })
})

describe('needs homing and the known position (DF46)', () => {
  it('needs homing only in Alarm without a code before homing', () => {
    expect(needsHoming(open({ state: 'Alarm', homed: false }))).toBe(true)
    expect(needsHoming(open({ state: 'Alarm', homed: true }))).toBe(false)
    expect(needsHoming(open({ state: 'Idle', homed: false }))).toBe(false)
    expect(needsHoming(closedStatus())).toBe(false)
    // the gates stay those of Alarm
    const gates = runGates(open({ state: 'Alarm', homed: false }), { planChosen: true })
    expect(gates.jog).toBe('Home the machine first.')
    expect(gates.home).toBeNull()
  })

  it('the position is known only once homed', () => {
    expect(positionKnown(closedStatus())).toBe(false)
    expect(positionKnown(open({ homed: false }))).toBe(false)
    expect(positionKnown(open())).toBe(true)
  })
})

// docs/modes/z-reference.md#dfyom-run (DF69)
describe('touchOffMoves', () => {
  const wz = [-400, -300, -60] as const
  it('rises to the clearance height of the current zero first, never lowers Z', () => {
    // Z0 on the stock top: clearance 10 → MPos Z −50
    expect(touchOffMoves({ mpos: [-10, -10, -58], workZero: [...wz] }, [50, 30], 10)).toEqual([
      [-10, -10, -50],
      [-350, -270, -50],
    ])
    // Z0 on a floor 0.5 below the top: the top (and the clearance) is 0.5 higher
    expect(
      touchOffMoves({ mpos: [-10, -10, -58], workZero: [...wz], zeroLevel: -0.5 }, [50, 30], 10),
    ).toEqual([
      [-10, -10, -49.5],
      [-350, -270, -49.5],
    ])
    expect(touchOffMoves({ mpos: [-10, -10, -5], workZero: [...wz] }, [50, 30], 10)).toEqual([
      [-350, -270, -5],
    ])
    // capped at the machine top
    expect(touchOffMoves({ mpos: [-10, -10, -5], workZero: [-400, -300, -2] }, [0, 0], 10)).toEqual(
      [
        [-10, -10, 0],
        [-400, -300, 0],
      ],
    )
  })

  it('offers nothing at the spot', () => {
    expect(touchOffMoves({ mpos: [-350, -270, -58], workZero: [...wz] }, [50, 30], 10)).toEqual([])
  })

  it('names the surface without its level', () => {
    expect(surfaceName('Facing 1 floor, 0.50 below the stock top')).toBe('Facing 1 floor')
    expect(surfaceName('Pocket 2 floor')).toBe('Pocket 2 floor')
  })
})
