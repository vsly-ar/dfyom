// Check alignment (v0.5 RV6) in the app against the fake bridge: the Probing section's button
// waits for the X/Y zero; the pointer's corner stops at the gap, the first move in the safe order
// (Z up first) to the corner at the sighting height, Next along the outline at the trace feed,
// the perimeter's Continue; Measure refused for a Z plate with why, and with the bit: two edge
// probes give the angle and the nudge; axe.
// Spec: docs/modes/alignment.md#check-alignment-rv6
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
type V3 = [number, number, number]

async function renderRun(opts: { probe?: 'tool'; zero?: boolean } = {}) {
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
  // G54 at machine (−250, −150, −80) on the stock top
  const wco: V3 = opts.zero === false ? [0, 0, 0] : [-250, -150, -80]
  const at = (mpos: V3, state: RunStatus['state'] = 'Idle') =>
    push({
      state,
      mpos,
      wpos: [mpos[0] - wco[0], mpos[1] - wco[1], mpos[2] - wco[2]],
    })
  bridge.handle('run.status.get', () => ok(status))
  bridge.handle('run.connection.open', () => {
    queueMicrotask(() =>
      push({ connection: { state: 'open', target: 'virtual', timeScale: 1 }, state: 'Alarm' }),
    )
    return ok({})
  })
  bridge.handle('run.machine.home', () => {
    queueMicrotask(() => {
      push({
        homed: true,
        envelope: { ...envelope, travel: [...envelope.travel] },
        workZero: wco,
      })
      at([-300, -200, -82])
    })
    return ok({ jobId: 'home-1' })
  })
  const probeResults: unknown[] = []
  let probes = 0
  bridge.handle('run.machine.probe', () => ok({ jobId: `probe-${++probes}` }))
  bridge.handle('job.wait', (args) => {
    const id = (args as { jobId: string }).jobId
    const n = id.startsWith('probe-') ? Number(id.slice(6)) : 0
    return ok({ state: 'finished', outcome: { ok: true, value: probeResults[n - 1] ?? {} } })
  })
  bridge.handle('run.virtual.stock', () => ok({}))
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
  await r.user.click(within(nav()).getByRole('button', { name: 'Connect' }))
  await screen.findByRole('group', { name: 'Machine' })
  await r.user.click(within(nav()).getByRole('button', { name: 'Home' }))
  await within(screen.getByRole('group', { name: 'Machine' })).findByText('Idle')
  return { ...r, nav, at, callsOf, probeResults }
}

const dialog = () => screen.getByRole('dialog', { name: 'Check alignment' })
const jogs = (t: { callsOf: (n: string) => unknown[] }) =>
  t.callsOf('run.machine.jog') as { to: V3; feed: number }[]

describe('Check alignment (v0.5 RV6)', () => {
  it('waits for the X/Y zero', async () => {
    const t = await renderRun({ zero: false })
    const button = within(t.nav()).getByRole('button', { name: 'Check alignment…' })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(/Set the X\/Y zero first/)
  })

  it('pointer: corners at the gap, the safe first move, Next along the outline at 500 mm/min', async () => {
    const t = await renderRun()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Check alignment…' }))
    expect(within(dialog()).getByText(/^Stock 100\.000 × 60\.000 mm, from /)).toBeInTheDocument()
    const stops = within(dialog()).getByRole('list', { name: 'Stops' })
    expect(
      within(stops)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Front left corner · X -2.000 Y -2.000',
      'Front right corner · X 102.000 Y -2.000',
      'Back right corner · X 102.000 Y 62.000',
      'Back left corner · X -2.000 Y 62.000',
    ])
    await expectNoAxeViolations()
    await t.user.click(within(dialog()).getByRole('button', { name: 'Go to the first stop' }))
    const first = jogs(t)
    // Z up first (never lowered before X/Y), then across, then down to 2 mm above the top
    expect(first[0]!.to.slice(0, 2)).toEqual([-300, -200])
    expect(first[0]!.to[2]).toBeGreaterThan(-82)
    expect(first.at(-1)!.to).toEqual([-252, -152, -78])
    for (const j of first.slice(1, -1)) expect(j.to[2]).toBeGreaterThanOrEqual(first[0]!.to[2])
    t.at([-280, -180, -60], 'Jog')
    t.at([-252, -152, -78])
    expect(
      await within(dialog()).findByText(
        'At the front left corner (1 of 4). Look at the gap to the stock edge.',
      ),
    ).toBeInTheDocument()
    expect(within(stops).getAllByRole('listitem')[0]).toHaveAttribute('aria-current', 'step')
    await t.user.click(within(dialog()).getByRole('button', { name: 'Next' }))
    const next = jogs(t).slice(first.length)
    expect(next).toEqual([{ to: [-148, -152, -78], feed: 500 }])
    // Previous goes the other way round
    t.at([-200, -152, -78], 'Jog')
    t.at([-148, -152, -78])
    await within(dialog()).findByText(/^At the front right corner \(2 of 4\)/)
    await t.user.click(within(dialog()).getByRole('button', { name: 'Previous' }))
    expect(jogs(t).at(-1)).toEqual({ to: [-252, -152, -78], feed: 500 })
  })

  it('perimeter: Start the trace, Continue corner to corner, back at the start', async () => {
    const t = await renderRun()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Check alignment…' }))
    await t.user.click(within(dialog()).getByRole('radio', { name: 'Perimeter' }))
    await t.user.click(within(dialog()).getByRole('button', { name: 'Start the trace' }))
    const corners: V3[] = [
      [-148, -152, -78],
      [-148, -88, -78],
      [-252, -88, -78],
      [-252, -152, -78],
    ]
    t.at([-252, -152, -78])
    await within(dialog()).findByText(/^At the front left corner/)
    const names = ['front right corner', 'back right corner', 'back left corner']
    for (const [i, c] of corners.entries()) {
      await t.user.click(within(dialog()).getByRole('button', { name: 'Continue' }))
      expect(jogs(t).at(-1)).toEqual({ to: c, feed: 500 })
      t.at([c[0] + 1, c[1] + 1, c[2]], 'Jog')
      t.at(c)
      if (i < names.length) await within(dialog()).findByText(new RegExp(`^At the ${names[i]}`))
    }
    expect(
      await within(dialog()).findByText('Back at the start: the trace is done.'),
    ).toBeInTheDocument()
    expect(within(dialog()).getByRole('button', { name: 'Trace again' })).toBeEnabled()
  })

  it('a height below the top needs the bit’s side clear of the edge', async () => {
    const t = await renderRun()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Check alignment…' }))
    const bit = within(dialog()).getByRole('textbox', { name: 'Bit Ø' })
    await t.user.clear(bit)
    await t.user.type(bit, '6')
    const height = within(dialog()).getByRole('textbox', { name: 'Height' })
    await t.user.clear(height)
    await t.user.type(height, '-3')
    expect(
      within(dialog()).getByText(
        /the bit’s side would touch the edge: make the gap at least 3\.500/,
      ),
    ).toBeInTheDocument()
    expect(within(dialog()).getByRole('button', { name: 'Go to the first stop' })).toBeDisabled()
  })

  it('Measure: refused for a Z plate with why', async () => {
    const t = await renderRun()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Check alignment…' }))
    await t.user.click(within(dialog()).getByRole('radio', { name: 'Measure' }))
    expect(
      within(dialog()).getAllByText(/Measure touches the edge at two points/).length,
    ).toBeGreaterThan(0)
    expect(within(dialog()).getByRole('button', { name: 'Measure' })).toBeDisabled()
  })

  it('Measure with the bit: two front-edge probes, the angle and the nudge', async () => {
    const t = await renderRun({ probe: 'tool' })
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Check alignment…' }))
    await t.user.click(within(dialog()).getByRole('radio', { name: 'Measure' }))
    const bit = within(dialog()).getByRole('textbox', { name: 'Bit Ø' })
    await t.user.clear(bit)
    await t.user.type(bit, '6')
    // the front edge rises 0.5 mm over the 70 mm between the probes
    t.probeResults.push(
      { cycle: 'edge', y: { value: -150.1, uncertainty: 0.001 }, start: [-235, -145, -75] },
      { cycle: 'edge', y: { value: -149.6, uncertainty: 0.001 }, start: [-165, -145, -75] },
    )
    await t.user.click(within(dialog()).getByRole('button', { name: 'Measure' }))
    // the move to the first start (above the top, 5 mm inside the front edge)
    await waitFor(() => expect(jogs(t).at(-1)?.to).toEqual([-235, -145, -75]))
    t.at([-245, -150, -60], 'Jog')
    t.at([-235, -145, -75])
    await waitFor(() => expect(t.callsOf('run.machine.probe')).toHaveLength(1))
    const args = t.callsOf('run.machine.probe')[0] as { routine: unknown; probe: unknown }
    expect(args.routine).toEqual({ cycle: 'edge', axis: 'y', side: -1 })
    expect(args.probe).toEqual({ kind: 'tool', tipDiameter: 6 })
    // the routine ends over its start; then to the second start
    await waitFor(() => expect(jogs(t).at(-1)?.to).toEqual([-165, -145, -75]))
    t.at([-200, -145, -70], 'Jog')
    t.at([-165, -145, -75])
    const angle = (Math.atan(0.5 / 70) * 180) / Math.PI
    expect(
      await within(dialog()).findByText(
        `Turned ${angle.toFixed(3)}° counter-clockwise (± 0.001°).`,
      ),
    ).toBeInTheDocument()
    expect(
      within(dialog()).getByText(
        'Keep the front left corner where it is and move the front right corner 0.714 mm toward Y−.',
      ),
    ).toBeInTheDocument()
    await expectNoAxeViolations()
  })
})
