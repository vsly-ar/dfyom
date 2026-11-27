// Go to coordinates (DF128) in the app against the fake bridge: the DRO values open the dialog on
// their frame and axis, the fields start at the position, Enter sends the steps in the safe order,
// the gates and findings, Escape restores a field / stops / closes, and the jog hotkeys stay off
// while it is open. GT2: the planned steps published for the run scene's path, the "Go to…" item
// in the jog section's menu and the `G` key, the placement at the end edge without a dark scrim.
// Spec: docs/modes/run-goto.md (GT1, GT2)
import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import type { CallReply } from '../../../../shared/preload-api'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { runMessages } from '../../messages/run'
import { currentStep, parseGoToField } from './GoToDialog'
import { runStoreOf } from './run-store'

const ok = (value: unknown = {}): CallReply => ({ ok: true, value, revision: 0 })
const envelope = { travel: [800, 600, 100] as const, homingMask: 0, pullOff: 1, softLimits: true }

async function renderRun() {
  const s = await planSetup()
  await s.create()
  const bridge = createFakeBridge()
  bridge.bind(s.d)
  let status: RunStatus = closedStatus()
  const push = (patch: Partial<RunStatus>) => {
    status = { ...status, ...patch }
    act(() => bridge.emitRunStatus(status))
  }
  bridge.handle('run.status.get', () => ok(status))
  bridge.handle('run.connection.open', () => {
    queueMicrotask(() =>
      push({ connection: { state: 'open', target: 'virtual', timeScale: 1 }, state: 'Alarm' }),
    )
    return ok({})
  })
  bridge.handle('run.machine.home', () => {
    queueMicrotask(() =>
      push({
        state: 'Idle',
        homed: true,
        envelope: { ...envelope, travel: [...envelope.travel] },
        // inside the stock: work zero at machine (−250, −150, −80), the tool 2 mm below it
        mpos: [-300, -200, -82],
        wpos: [-50, -50, -2],
        workZero: [-250, -150, -80],
      }),
    )
    return ok({ jobId: 'home-1' })
  })
  bridge.handle('job.wait', () => ok({ state: 'finished', outcome: { ok: true, value: {} } }))
  bridge.handle('run.machine.jog', () => ok({}))
  bridge.handle('run.machine.jogCancel', () => ok({}))
  const shell = createShell(bridge)
  shell.ui.getState().setMode('run')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  const nav = () => screen.getByRole('navigation', { name: 'Navigator' })
  await within(nav()).findByRole('button', { name: 'Connect' })
  await r.user.click(within(nav()).getByRole('radio', { name: 'Virtual machine' }))
  const callsOf = (name: string) => bridge.calls.filter((c) => c.name === name).map((c) => c.args)
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const dro = () => screen.getByRole('table', { name: 'Position' })
  return { ...r, nav, push, callsOf, dro, status: () => status, run: () => runStoreOf(bridge) }
}

type T = Awaited<ReturnType<typeof renderRun>>

async function connectAndHome(t: T) {
  await t.user.click(within(t.nav()).getByRole('button', { name: 'Connect' }))
  await screen.findByRole('group', { name: 'Machine' })
  await t.user.click(within(t.nav()).getByRole('button', { name: 'Home' }))
  await within(screen.getByRole('group', { name: 'Machine' })).findByText('Idle')
}

const dialog = () => screen.getByRole('dialog', { name: 'Go to' })
const field = (axis: string) =>
  within(dialog()).getByRole('textbox', { name: axis }) as HTMLInputElement
const goButton = () => within(dialog()).getByRole('button', { name: 'Go' })

describe('Go to (DF128)', () => {
  it('the DRO values are Go to buttons, disabled with why until the position is known', async () => {
    const t = await renderRun()
    const x = within(t.dro()).getByRole('button', { name: 'Go to: X — work' })
    expect(x).toBeDisabled()
    expect(x).toHaveAccessibleDescription('Connect to a machine first.')
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Connect' }))
    await screen.findByRole('group', { name: 'Machine' })
    expect(
      within(t.dro()).getByRole('button', { name: 'Go to: Y — machine' }),
    ).toHaveAccessibleDescription('Home the machine first: the position is unknown.')
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Home' }))
    // the cells keep their names and text
    await waitFor(() =>
      expect(within(t.dro()).getByRole('cell', { name: 'Work position X' })).toHaveTextContent(
        '-50.000',
      ),
    )
    expect(within(t.dro()).getByRole('button', { name: 'Go to: X -50.000 work' })).toBeEnabled()
    await expectNoAxeViolations()
  })

  it('opens on the clicked frame and axis with the current position, focused and selected', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(within(t.dro()).getByRole('button', { name: 'Go to: Y -50.000 work' }))
    expect(within(dialog()).getByRole('radio', { name: 'Work (G54)' })).toBeChecked()
    expect(field('Y')).toHaveFocus()
    expect(field('Y').selectionStart).toBe(0)
    expect(field('Y').selectionEnd).toBe(field('Y').value.length)
    expect([field('X').value, field('Y').value, field('Z').value]).toEqual([
      '-50.000',
      '-50.000',
      '-2.000',
    ])
    // nothing to do yet
    expect(goButton()).toBeDisabled()
    expect(within(dialog()).getByText('Already there.')).toBeInTheDocument()
    await expectNoAxeViolations()
    await t.user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Go to' })).toBeNull()
    // focus back on the value that opened it
    expect(within(t.dro()).getByRole('button', { name: 'Go to: Y -50.000 work' })).toHaveFocus()

    await t.user.click(within(t.dro()).getByRole('button', { name: 'Go to: Z -82.000 machine' }))
    expect(within(dialog()).getByRole('radio', { name: 'Machine (G53)' })).toBeChecked()
    expect(field('Z')).toHaveFocus()
    expect(field('X').value).toBe('-300.000')
  })

  it('Enter sends the steps in the safe order from inside the stock; arrival closes the dialog', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(within(t.dro()).getByRole('button', { name: 'Go to: X -50.000 work' }))
    await t.user.keyboard('0')
    await t.user.clear(field('Y'))
    await t.user.type(field('Y'), '10 - 10')
    await t.user.clear(field('Z'))
    await t.user.type(field('Z'), '1')
    const steps = within(dialog()).getByRole('list', { name: 'Steps' })
    const items = within(steps).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent(/^1 · Up to Z /)
    expect(items[1]).toHaveTextContent(/^2 · To X 0\.000 Y 0\.000/)
    expect(items[2]).toHaveTextContent(/^3 · Down to Z 1\.000/)
    expect(within(dialog()).getByText(/at 2000 mm\/min · about \d+ s/)).toBeInTheDocument()
    expect(goButton()).toHaveAccessibleDescription(/1 · Up to Z/)
    await t.user.keyboard('{Enter}')
    await waitFor(() => expect(t.callsOf('run.machine.jog')).toHaveLength(3))
    const jogs = t.callsOf('run.machine.jog') as { to: number[]; feed: number }[]
    const safe = jogs[0]!.to[2]!
    // lifted above the stock top before X/Y, X/Y at that height, down last
    expect(safe).toBeGreaterThan(-80)
    expect(jogs).toEqual([
      { to: [-300, -200, safe], feed: 2000 },
      { to: [-250, -150, safe], feed: 2000 },
      { to: [-250, -150, -79], feed: 2000 },
    ])
    expect(within(dialog()).getByRole('status')).toHaveTextContent('Moving: step 1 of 3')
    t.push({ state: 'Jog', mpos: [-275, -175, safe] })
    expect(within(dialog()).getByRole('status')).toHaveTextContent('Moving: step 2 of 3')
    t.push({ state: 'Idle', mpos: [-250, -150, -79], wpos: [0, 0, 1] })
    expect(screen.queryByRole('dialog', { name: 'Go to' })).toBeNull()
  })

  it('Escape while moving stops (jog cancel) and closes; a stop short of the target says where', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(within(t.dro()).getByRole('button', { name: 'Go to: Z -2.000 work' }))
    await t.user.keyboard('5{Enter}')
    await waitFor(() => expect(t.callsOf('run.machine.jog')).toHaveLength(1))
    t.push({ state: 'Jog', mpos: [-300, -200, -80] })
    // the footer's Stop (jog cancel without a run job) leaves the dialog open: "Stopped at …"
    t.push({ state: 'Idle', mpos: [-300, -200, -79], wpos: [-50, -50, 1] })
    expect(within(dialog()).getByRole('status')).toHaveTextContent(
      'Stopped at X -50.000 Y -50.000 Z 1.000.',
    )
    expect(goButton()).toBeEnabled()
    await t.user.click(goButton())
    await waitFor(() => expect(t.callsOf('run.machine.jog')).toHaveLength(2))
    t.push({ state: 'Jog' })
    await t.user.keyboard('{Escape}')
    await waitFor(() => expect(t.callsOf('run.machine.jogCancel').length).toBeGreaterThan(0))
    expect(screen.queryByRole('dialog', { name: 'Go to' })).toBeNull()
  })

  it('Escape in an edited field restores it first; a second Escape closes', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(within(t.dro()).getByRole('button', { name: 'Go to: X -50.000 work' }))
    await t.user.keyboard('12')
    expect(field('X').value).toBe('12')
    await t.user.keyboard('{Escape}')
    expect(field('X').value).toBe('-50.000')
    await t.user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Go to' })).toBeNull()
  })

  it('the jog hotkeys do nothing while it is open, wherever the focus is', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(within(t.dro()).getByRole('button', { name: 'Go to: X -50.000 work' }))
    within(dialog()).getByRole('button', { name: 'Cancel' }).focus()
    await t.user.keyboard('d')
    await t.user.keyboard('{Shift}')
    // Space is the focused control's own (the checkbox toggles), never Z+
    const lift = within(dialog()).getByRole('checkbox', { name: 'Lift to the top first' })
    lift.focus()
    await t.user.keyboard('w')
    await t.user.keyboard(' ')
    expect(lift).toBeChecked()
    // in a field: Shift while typing never jogs Z−
    await t.user.click(field('X'))
    await t.user.keyboard('{Shift>}A{/Shift}')
    expect(t.callsOf('run.machine.jog')).toEqual([])
    await t.user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    // closed: WASD jogs again
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Home' }).parentElement!)
    await t.user.keyboard('d')
    await waitFor(() => expect(t.callsOf('run.machine.jog')).toHaveLength(1))
  })

  it('frames convert through the work offset; relative disables the frame; shortcuts fill', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(within(t.dro()).getByRole('button', { name: 'Go to: X -50.000 work' }))
    await t.user.keyboard('10')
    await t.user.click(within(dialog()).getByRole('radio', { name: 'Machine (G53)' }))
    expect([field('X').value, field('Y').value, field('Z').value]).toEqual([
      '-240.000',
      '-200.000',
      '-82.000',
    ])
    await t.user.click(within(dialog()).getByRole('radio', { name: 'Relative' }))
    expect(field('X').value).toBe('0.000')
    expect(within(dialog()).getByRole('radio', { name: 'Work (G54)' })).toBeDisabled()
    expect(
      within(dialog()).getByText('Relative moves are the same in both frames.'),
    ).toBeInTheDocument()
    await t.user.click(within(dialog()).getByRole('button', { name: 'Work zero XY' }))
    expect(within(dialog()).getByRole('radio', { name: 'Absolute' })).toBeChecked()
    expect(within(dialog()).getByRole('radio', { name: 'Work (G54)' })).toBeChecked()
    expect([field('X').value, field('Y').value, field('Z').value]).toEqual([
      '0.000',
      '0.000',
      '-2.000',
    ])
    await t.user.click(within(dialog()).getByRole('button', { name: 'Machine top Z' }))
    // the machine top (−pull-off) in the work frame
    expect(field('Z').value).toBe('79.000')
    await expectNoAxeViolations()
  })

  it('gates and findings: travel per axis, invalid text, alarm, jogging, spindle on', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(within(t.dro()).getByRole('button', { name: 'Go to: X -50.000 work' }))
    await t.user.keyboard('300')
    expect(goButton()).toBeDisabled()
    expect(
      within(dialog()).getByText(
        'X would leave the travel: the target is at machine 50.000, the travel is -800.000 to 0.000 mm.',
      ),
    ).toBeInTheDocument()
    expect(field('X')).toHaveAttribute('aria-invalid', 'true')
    await t.user.clear(field('X'))
    await t.user.type(field('X'), 'abc')
    expect(goButton()).toBeDisabled()
    expect(within(dialog()).getAllByText(/^Not a length/).length).toBeGreaterThan(0)
    await t.user.clear(field('X'))
    await t.user.type(field('X'), '0')
    expect(goButton()).toBeEnabled()
    t.push({ spindle: 12000 })
    expect(goButton()).toBeDisabled()
    expect(within(dialog()).getByRole('status')).toHaveTextContent('Stop the spindle first.')
    t.push({ spindle: 0, state: 'Jog' })
    expect(within(dialog()).getByRole('status')).toHaveTextContent('The machine is still jogging.')
    t.push({ state: 'Alarm', alarm: { code: 9, text: 'Homing fail' } })
    expect(goButton()).toBeDisabled()
    expect(within(dialog()).getByRole('status')).toHaveTextContent('Home the machine first.')
    // nothing was sent
    await t.user.click(goButton())
    expect(t.callsOf('run.machine.jog')).toEqual([])
    await expectNoAxeViolations()
  })
})

// Hardening DF140: "=0" sets an axis's work zero, "→0" goes to it through Go to.
// Spec: docs/modes/run-goto.md#go-to-work-zero-per-axis-df140
describe('the DRO’s =0 and →0 (DF140)', () => {
  const goZero = (t: T, axis: string) =>
    within(t.dro()).getByRole('button', { name: `Go to work ${axis} zero` })

  it('=0 and →0 per axis, with tooltips saying what they do; →0 disabled with why', async () => {
    const t = await renderRun()
    const setX = within(t.dro()).getByRole('button', { name: 'Set X zero' })
    expect(setX).toHaveTextContent('=0')
    expect(goZero(t, 'X')).toHaveTextContent('→0')
    expect(goZero(t, 'X')).toBeDisabled()
    expect(goZero(t, 'X')).toHaveAccessibleDescription('Connect to a machine first.')
    await connectAndHome(t)
    for (const axis of ['X', 'Y', 'Z']) expect(goZero(t, axis)).toBeEnabled()
    act(() => goZero(t, 'Z').focus())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Go to work Z 0: moves Z only, down or up to the work zero. The machine moves.',
    )
    act(() => goZero(t, 'X').focus())
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        'Go to work X 0: raises Z to the safe height first if it is lower, then moves X only; Z stays up. The machine moves.',
      ),
    )
    act(() => setX.focus())
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        'Set X zero: the current X position becomes work X 0 (G54). Nothing moves.',
      ),
    )
    await expectNoAxeViolations()
    // the Go to gate: not while jogging, not with the spindle on
    t.push({ state: 'Jog' })
    expect(goZero(t, 'X')).toHaveAccessibleDescription('The machine is still jogging.')
    t.push({ state: 'Idle', spindle: 12000 })
    expect(goZero(t, 'Y')).toHaveAccessibleDescription('Stop the spindle first.')
    expect(t.callsOf('run.machine.jog')).toEqual([])
  })

  it('→0 X from inside the stock: up to the safe height, then X alone; Z stays up; arrival closes', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(goZero(t, 'X'))
    await waitFor(() => expect(t.callsOf('run.machine.jog')).toHaveLength(2))
    const jogs = t.callsOf('run.machine.jog') as { to: number[]; feed: number }[]
    const safe = jogs[0]!.to[2]!
    expect(safe).toBeGreaterThan(-80)
    expect(jogs).toEqual([
      { to: [-300, -200, safe], feed: 2000 },
      { to: [-250, -200, safe], feed: 2000 },
    ])
    // the Go to dialog follows the move, its fields at the target
    expect(field('X').value).toBe('0.000')
    expect(within(dialog()).getByRole('status')).toHaveTextContent('Moving: step 1 of 2')
    t.push({ state: 'Idle', mpos: [-250, -200, safe], wpos: [0, -50, safe + 80] })
    expect(screen.queryByRole('dialog', { name: 'Go to' })).toBeNull()
  })

  it('→0 Z moves Z alone, one step', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    t.push({ mpos: [-300, -200, -60], wpos: [-50, -50, 20] })
    await t.user.click(goZero(t, 'Z'))
    await waitFor(() => expect(t.callsOf('run.machine.jog')).toHaveLength(1))
    expect(t.callsOf('run.machine.jog')).toEqual([{ to: [-300, -200, -80], feed: 2000 }])
  })
})

describe('Go to (DF128 GT2)', () => {
  it('publishes the planned steps for the 3D path as the fields change, and clears them on close', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(within(t.dro()).getByRole('button', { name: 'Go to: X -50.000 work' }))
    // already there: no path
    expect(t.run().getState().goToPreview).toBeUndefined()
    await t.user.keyboard('0')
    // machine coordinates: from the position, lifted to the safe height (stock top + the setup's
    // clearance), across, down
    await waitFor(() =>
      expect(t.run().getState().goToPreview).toEqual({
        from: [-300, -200, -82],
        points: [
          [-300, -200, -70],
          [-250, -200, -70],
          [-250, -200, -82],
        ],
      }),
    )
    // live: another target, another path; an invalid field, none
    await t.user.clear(field('Z'))
    await t.user.type(field('Z'), '20')
    await waitFor(() =>
      expect(t.run().getState().goToPreview?.points).toEqual([
        [-300, -200, -60],
        [-250, -200, -60],
      ]),
    )
    await t.user.clear(field('Z'))
    await t.user.type(field('Z'), 'abc')
    await waitFor(() => expect(t.run().getState().goToPreview).toBeUndefined())
    await t.user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(t.run().getState().goToPreview).toBeUndefined()
  })

  it('sits at the end edge over a clear scrim, still modal', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(within(t.dro()).getByRole('button', { name: 'Go to: X -50.000 work' }))
    expect(dialog()).toHaveAttribute('data-placement', 'end')
    // still modal: the rest of the window is hidden from the accessibility tree
    expect(screen.queryByRole('navigation', { name: 'Navigator' })).toBeNull()
    expect(document.querySelector('[data-placement="end"]:not([role="dialog"])')).not.toBeNull()
  })

  it('G opens it in the work frame with X focused; not while typing, with a modifier or during a job', async () => {
    const t = await renderRun()
    // not connected: nothing
    await t.user.keyboard('g')
    expect(screen.queryByRole('dialog', { name: 'Go to' })).toBeNull()
    await connectAndHome(t)
    // typing a g in a text field never opens it
    const custom = within(t.nav()).getByRole('textbox', { name: 'Custom jog step (mm)' })
    custom.focus()
    await t.user.keyboard('g')
    expect(screen.queryByRole('dialog', { name: 'Go to' })).toBeNull()
    custom.blur()
    await t.user.keyboard('{Meta>}g{/Meta}{Control>}g{/Control}')
    expect(screen.queryByRole('dialog', { name: 'Go to' })).toBeNull()
    await t.user.keyboard('g')
    expect(within(dialog()).getByRole('radio', { name: 'Work (G54)' })).toBeChecked()
    expect(field('X')).toHaveFocus()
    // in the dialog, g is text
    await t.user.keyboard('g')
    expect(field('X').value).toBe('g')
    await t.user.keyboard('{Escape}{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Go to' })).toBeNull()
    // during a run job: nothing
    t.push({
      state: 'Run',
      job: { jobId: 'run-1', phase: 'streaming', line: 1, startedAt: '', elapsedSeconds: 0 },
    })
    document.body.focus()
    await t.user.keyboard('g')
    expect(screen.queryByRole('dialog', { name: 'Go to' })).toBeNull()
  })

  it('the jog section menu has "Go to…" (G), disabled with why until homed; focus returns to the menu button', async () => {
    const t = await renderRun()
    const menuButton = () => within(t.nav()).getByRole('button', { name: 'Jog options' })
    const openMenu = async () => {
      menuButton().focus()
      await t.user.keyboard('{Enter}')
    }
    await openMenu()
    const item = await screen.findByRole('menuitem', { name: /Go to…/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveTextContent('Connect to a machine first.')
    await t.user.keyboard('{Escape}')
    await connectAndHome(t)
    await openMenu()
    await t.user.click(await screen.findByRole('menuitem', { name: /Go to…/ }))
    await waitFor(() => expect(field('X')).toHaveFocus())
    expect(within(dialog()).getByRole('radio', { name: 'Work (G54)' })).toBeChecked()
    await expectNoAxeViolations()
    await t.user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(menuButton()).toHaveFocus())
  })

  it('the time estimate reads in minutes past a minute', () => {
    expect(runMessages.goTo.seconds(6)).toBe('about 6 s')
    expect(runMessages.goTo.seconds(60)).toBe('about 1 min')
    expect(runMessages.goTo.seconds(125)).toBe('about 2 min 5 s')
  })
})

describe('Go to helpers', () => {
  it('parses lengths and expressions in the project unit', () => {
    expect(parseGoToField('12.5', 'mm')).toBe(12.5)
    expect(parseGoToField('-3', 'mm')).toBe(-3)
    expect(parseGoToField('100 - 2', 'mm')).toBe(98)
    expect(parseGoToField('1/2', 'inch')).toBeCloseTo(12.7)
    expect(parseGoToField('1in', 'mm')).toBeCloseTo(25.4)
    expect(parseGoToField('', 'mm')).toBeUndefined()
    expect(parseGoToField('abc', 'mm')).toBeUndefined()
  })

  it('finds the step under way, even when a report skipped a step end', () => {
    const steps = [
      { to: [0, 0, 10] as const, axis: 'z' as const },
      { to: [50, 0, 10] as const, axis: 'xy' as const },
      { to: [50, 0, 0] as const, axis: 'z' as const },
    ]
    expect(currentStep([0, 0, 5], [0, 0, 0], steps, 0)).toBe(0)
    expect(currentStep([25, 0, 10], [0, 0, 0], steps, 0)).toBe(1)
    expect(currentStep([50, 0, 4], [0, 0, 0], steps, 0)).toBe(2)
    // never back
    expect(currentStep([0, 0, 5], [0, 0, 0], steps, 2)).toBe(2)
  })
})
