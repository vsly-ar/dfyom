// Set X/Y zero (v0.5 RV5) in the app against the fake bridge: the Probing section opens it, the
// stock picture's picks (the plan's zero corner first), Probe disabled for a Z plate with the next
// step, the touch method (Touching per edge, the feeler and the bit's radius) to the confirmation
// and the G10 L20 values, Undo; the probe method with the bit as the probe (the routine's args and
// its result to the new zero); axe.
// Spec: docs/modes/run-probing.md#set-xy-zero-rv5
import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { libraryInput, machineValues } from '../../../../core/library/library.fixture'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import type { CallReply } from '../../../../shared/preload-api'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'

const ok = (value: unknown = {}): CallReply => ({ ok: true, value, revision: 0 })
const envelope = { travel: [800, 600, 100] as const, homingMask: 0, pullOff: 1, softLimits: true }

async function renderRun(opts: { probe?: 'tool' } = {}) {
  const s = await planSetup()
  if (opts.probe !== undefined)
    await s.run('library.machine.update', {
      id: s.machineId,
      revision: 1,
      values: { ...libraryInput(machineValues()), probe: { kind: opts.probe } },
    })
  await s.create(opts.probe === undefined ? {} : { machineLibraryItemId: s.machineId })
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
        mpos: [-300, -200, -82],
        wpos: [-50, -50, -2],
        workZero: [-250, -150, -80],
      }),
    )
    return ok({ jobId: 'home-1' })
  })
  let probeResult: unknown = {}
  bridge.handle('run.machine.probe', () => ok({ jobId: 'probe-1' }))
  bridge.handle('job.wait', (args) =>
    ok({
      state: 'finished',
      outcome: {
        ok: true,
        value: (args as { jobId: string }).jobId === 'probe-1' ? probeResult : {},
      },
    }),
  )
  bridge.handle('run.workZero.set', () => ok({}))
  bridge.handle('run.virtual.stock', () => ok({}))
  bridge.handle('run.machine.jog', () => ok({}))
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
  await r.user.click(within(nav()).getByRole('button', { name: 'Connect' }))
  await screen.findByRole('group', { name: 'Machine' })
  await r.user.click(within(nav()).getByRole('button', { name: 'Home' }))
  await within(screen.getByRole('group', { name: 'Machine' })).findByText('Idle')
  return {
    ...r,
    nav,
    push,
    callsOf,
    setProbeResult: (v: unknown) => {
      probeResult = v
    },
  }
}

const dialog = () => screen.getByRole('dialog', { name: 'Set X/Y zero' })
const pick = (name: string) => within(dialog()).getByRole('radio', { name })

describe('Set X/Y zero (v0.5 RV5)', () => {
  it('opens from Probing: the plan zero corner picked, Probe disabled for a Z plate', async () => {
    const t = await renderRun()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Set X/Y zero…' }))
    expect(pick('Front left corner (X− Y−)')).toBeChecked()
    expect(within(dialog()).getByText(/Plan zero: this corner/)).toBeInTheDocument()
    // the virtual operator lays the plan's stock, off by (3.2, −1.7) mm from where G54 says
    const laid = t.callsOf('run.virtual.stock')[0] as { stock: { min: number[] }; touch: boolean }
    expect(laid.touch).toBe(false)
    expect(laid.stock.min[0]).toBeCloseTo(-250 + 3.2, 9)
    expect(laid.stock.min[1]).toBeCloseTo(-150 - 1.7, 9)
    // the touch method (the default here) switches the touch readout on
    await waitFor(() =>
      expect(t.callsOf('run.virtual.stock')).toContainEqual(
        expect.objectContaining({ touch: true }),
      ),
    )
    expect(within(dialog()).getByRole('radio', { name: 'Probe' })).toBeDisabled()
    expect(within(dialog()).getByRole('radio', { name: 'Touch' })).toBeChecked()
    expect(within(dialog()).getByText(/Probe X\/Y needs an XYZ corner plate/)).toBeInTheDocument()
    // arrows move the pick
    pick('Front left corner (X− Y−)').focus()
    await t.user.keyboard('{ArrowRight}')
    expect(pick('Front edge (Y−)')).toBeChecked()
    expect(pick('Front edge (Y−)')).toHaveFocus()
    await expectNoAxeViolations()
  })

  it('touch: Touching per edge with the feeler and the radius, the new zero, G10 L20, Undo', async () => {
    const t = await renderRun()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Set X/Y zero…' }))
    const bit = within(dialog()).getByRole('textbox', { name: 'Bit Ø' })
    await t.user.clear(bit)
    await t.user.type(bit, '6')
    const feeler = within(dialog()).getByRole('textbox', { name: 'Feeler' })
    await t.user.clear(feeler)
    await t.user.type(feeler, '0.1')
    const review = within(dialog()).getByRole('button', { name: 'Review' })
    expect(review).toBeDisabled()
    expect(within(dialog()).getByRole('group', { name: /jog/i })).toBeInTheDocument()
    await t.user.click(within(dialog()).getByRole('button', { name: 'Touching X− edge' }))
    t.push({ mpos: [-290, -203.1, -82], wpos: [-40, -53.1, -2] })
    await t.user.click(within(dialog()).getByRole('button', { name: 'Touching Y− edge' }))
    expect(within(dialog()).getByText('X− edge: touched at -300.000 mm.')).toBeInTheDocument()
    await t.user.click(review)
    // edges: X −300 + 3.1, Y −203.1 + 3.1; the plan's zero on that corner
    expect(
      within(dialog()).getByText('G54 X: -250.000 → -296.900 mm (-46.900)'),
    ).toBeInTheDocument()
    expect(
      within(dialog()).getByText('G54 Y: -150.000 → -200.000 mm (-50.000)'),
    ).toBeInTheDocument()
    await expectNoAxeViolations()
    await t.user.click(within(dialog()).getByRole('button', { name: 'Set zero' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Set X/Y zero' })).toBeNull())
    const set = t.callsOf('run.workZero.set') as { axes: string[]; values: number[] }[]
    expect(set).toHaveLength(1)
    expect(set[0]!.axes).toEqual(['x', 'y'])
    expect(set[0]!.values[0]).toBeCloseTo(-290 + 296.9, 9)
    expect(set[0]!.values[1]).toBeCloseTo(-203.1 + 200, 9)
    // Undo puts the old G54 X/Y back
    await t.user.click(await within(t.nav()).findByRole('button', { name: 'Undo zero change' }))
    const undo = (t.callsOf('run.workZero.set') as { values: number[] }[])[1]!
    expect(undo.values[0]).toBeCloseTo(-290 + 250, 9)
    expect(undo.values[1]).toBeCloseTo(-203.1 + 150, 9)
    await waitFor(() =>
      expect(within(t.nav()).queryByRole('button', { name: 'Undo zero change' })).toBeNull(),
    )
  })

  it('probe with the bit: the corner routine, its result with ± to the new zero', async () => {
    const t = await renderRun({ probe: 'tool' })
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Set X/Y zero…' }))
    expect(within(dialog()).getByRole('radio', { name: 'Probe' })).toBeChecked()
    const bit = within(dialog()).getByRole('textbox', { name: 'Bit Ø' })
    await t.user.clear(bit)
    await t.user.type(bit, '6.35')
    expect(within(dialog()).getByText(/the clip on the bit and on the stock/)).toBeInTheDocument()
    // DF143: probing waits for the probe check, the probe input live in the dialog
    expect(within(dialog()).getByRole('button', { name: 'Probe' })).toBeDisabled()
    const input = within(dialog()).getByRole('group', { name: 'Probe input' })
    expect(within(input).getByText('Open')).toBeInTheDocument()
    await expectNoAxeViolations()
    t.push({ pins: 'P' })
    expect(within(input).getByText('Touching')).toBeInTheDocument()
    t.push({ pins: '' })
    t.setProbeResult({
      cycle: 'corner',
      top: { value: -80, uncertainty: 0.001 },
      x: { value: -246.8, uncertainty: 0.002 },
      y: { value: -151.7, uncertainty: 0.001 },
      start: [-300, -200, -82],
    })
    await t.user.click(within(dialog()).getByRole('button', { name: 'Probe' }))
    const args = t.callsOf('run.machine.probe')[0] as {
      routine: unknown
      probe: { kind: string; tipDiameter: number }
    }
    expect(args.routine).toEqual({ cycle: 'corner', corner: [-1, -1] })
    expect(args.probe).toEqual({ kind: 'tool', tipDiameter: 6.35 })
    expect(
      await within(dialog()).findByText('X− edge at -246.800 ± 0.002 mm (machine)'),
    ).toBeInTheDocument()
    expect(within(dialog()).getByText('G54 X: -250.000 → -246.800 mm (+3.200)')).toBeInTheDocument()
    expect(within(dialog()).getByText('G54 Y: -150.000 → -151.700 mm (-1.700)')).toBeInTheDocument()
    // Back keeps nothing written
    await t.user.click(within(dialog()).getByRole('button', { name: 'Back' }))
    expect(t.callsOf('run.workZero.set')).toHaveLength(0)
  })
})
