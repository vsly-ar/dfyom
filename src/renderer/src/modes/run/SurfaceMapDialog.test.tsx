// Map stock surface (v0.5 RV10) in the app against the fake bridge: the Probing section opens it,
// the grid (columns × rows or a spacing) over the stock top less the margin, the probe check, one
// `run.machine.surfacePoint` job per point in serpentine order with the travel height following
// the last contact, the heat map and the map saved per plan and setup; a failed point keeps the
// rest and offers Retry from here; the pre-flight's "Follow the surface map" (off by default)
// passes the map to `run.job.check` and `run.job.start`; axe.
// Spec: docs/modes/run-surface.md
import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import type { CallReply } from '../../../../shared/preload-api'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'

const ok = (value: unknown = {}): CallReply => ({ ok: true, value, revision: 0 })
const envelope = {
  travel: [800, 600, 100] as [number, number, number],
  homingMask: 0,
  pullOff: 1,
  softLimits: true,
}
/** G54 (machine): the stock's work zero. */
const G54: [number, number, number] = [-300, -200, -60]
/** The stock top's machine Z at a machine X/Y: tilted 0.004 in X. */
const top = (x: number) => -60 + 0.004 * (x - G54[0])

async function renderRun() {
  const s = await planSetup()
  const planId = await s.create({ machineLibraryItemId: s.machineId })
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
  const points: { at: [number, number]; travelZ: number; zDistance: number }[] = []
  let failAt: number | undefined
  const outcomes = new Map<string, unknown>()
  bridge.handle('run.machine.surfacePoint', (args) => {
    const a = args as { at: [number, number]; travelZ: number; zDistance: number }
    points.push(a)
    const id = `pt-${points.length}`
    outcomes.set(
      id,
      points.length === failAt
        ? {
            ok: false,
            error: { code: 'machine.alarm', message: 'ALARM:5', issues: [], frames: [] },
          }
        : { ok: true, value: { z: top(a.at[0]), uncertainty: 0.001 } },
    )
    return ok({ jobId: id })
  })
  bridge.handle('job.wait', (args) =>
    ok({ state: 'finished', outcome: outcomes.get((args as { jobId: string }).jobId) }),
  )
  const checks: unknown[] = []
  bridge.handle('run.job.check', (args) => {
    checks.push(args)
    const map = (args as { surfaceMap?: unknown }).surfaceMap
    return ok({
      setupId: s.plan(planId).setups[0]!.id,
      findings: [],
      ...(map === undefined ? {} : { surface: { maxDz: 0.31, range: 0.4, split: 12 } }),
    })
  })
  const starts: unknown[] = []
  bridge.handle('run.job.start', (args) => {
    starts.push(args)
    return ok({ jobId: 'run-1' })
  })
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
  await r.user.click(within(nav()).getByRole('button', { name: 'Connect' }))
  await screen.findByRole('group', { name: 'Machine' })
  push({
    state: 'Idle',
    homed: true,
    envelope,
    workZero: G54,
    mpos: [G54[0] + 5, G54[1] + 5, -55],
    wpos: [5, 5, 5],
  })
  return {
    ...r,
    nav,
    push,
    bridge,
    points,
    checks,
    starts,
    planId,
    setupId: s.plan(planId).setups[0]!.id,
    setFailAt: (n: number | undefined) => (failAt = n),
  }
}

const dialog = () => screen.getByRole('dialog', { name: 'Map stock surface' })

type Saved = { surfaceMaps: Record<string, { z: (number | null)[]; cols: number; rows: number }> }

describe('Map stock surface (v0.5 RV10)', () => {
  it('lays out the grid, probes it in serpentine order and keeps the map per setup', async () => {
    const t = await renderRun()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Map stock surface…' }))
    const map = () => within(dialog()).getByRole('button', { name: 'Map surface' })
    expect(within(dialog()).getByText(/^5 × 4 points/)).toBeVisible()
    // the spacing alternative: the counts follow
    await t.user.click(within(dialog()).getByRole('radio', { name: 'Spacing' }))
    expect(within(dialog()).getByRole('textbox', { name: 'Spacing (mm)' })).toBeVisible()
    await t.user.click(within(dialog()).getByRole('radio', { name: 'Columns × rows' }))
    const cols = within(dialog()).getByRole('textbox', { name: 'Columns' })
    await t.user.clear(cols)
    await t.user.type(cols, '3')
    const rows = within(dialog()).getByRole('textbox', { name: 'Rows' })
    await t.user.clear(rows)
    await t.user.type(rows, '3')
    // DF143: Map waits for the probe check
    expect(map()).toBeDisabled()
    expect(map()).toHaveAccessibleDescription(/test the probe/)
    t.push({ pins: 'P' })
    t.push({ pins: '' })
    await waitFor(() => expect(map()).toBeEnabled())
    await t.user.click(map())
    await waitFor(() => expect(t.bridge.settingsPatches.at(-1)).toHaveProperty('surfaceMaps'))
    expect(t.points).toHaveLength(9)
    // serpentine: the second row right to left; the first from here with the long search
    const xs = t.points.map((p) => p.at[0])
    expect(xs[3]).toBeGreaterThan(xs[5]!)
    expect(t.points[0]).toMatchObject({ travelZ: -55, zDistance: 25 })
    expect(t.points[1]!.travelZ).toBeCloseTo(top(t.points[0]!.at[0]) + 2, 6)
    expect(t.points[1]!.zDistance).toBe(7)
    const saved = (t.bridge.settingsPatches.at(-1) as Saved).surfaceMaps[
      `${t.planId}/${t.setupId}`
    ]!
    expect(saved).toMatchObject({ cols: 3, rows: 3, workZero: [G54[0], G54[1]] })
    expect(saved.z.every((v) => v !== null)).toBe(true)
    const heat = within(dialog()).getByRole('img', { name: /^Surface map: lowest/ })
    expect(heat).toHaveAccessibleName(/9 of 9 points/)
    await expectNoAxeViolations()
    // Clear map
    await t.user.click(within(dialog()).getByRole('button', { name: 'Clear map' }))
    expect(t.bridge.settingsPatches.at(-1)).toEqual({
      surfaceMaps: { [`${t.planId}/${t.setupId}`]: null },
    })
  })

  it('a failed point keeps the measured ones; Retry from here probes the rest', async () => {
    const t = await renderRun()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Map stock surface…' }))
    t.push({ pins: 'P' })
    t.push({ pins: '' })
    t.setFailAt(3)
    await t.user.click(within(dialog()).getByRole('button', { name: 'Map surface' }))
    await within(dialog()).findByText('Point 3 failed: the points before it are kept.', {
      exact: false,
    })
    const saved = (t.bridge.settingsPatches.at(-1) as Saved).surfaceMaps[
      `${t.planId}/${t.setupId}`
    ]!
    expect(saved.z.filter((v) => v !== null)).toHaveLength(2)
    t.setFailAt(undefined)
    await t.user.click(within(dialog()).getByRole('button', { name: 'Retry from here' }))
    await waitFor(() => expect(t.points).toHaveLength(3 + 18))
    await within(dialog()).findByRole('button', { name: 'Map surface' })
    const done = (t.bridge.settingsPatches.at(-1) as Saved).surfaceMaps[`${t.planId}/${t.setupId}`]!
    expect(done.z.every((v) => v !== null)).toBe(true)
  })

  it('the pre-flight offers Follow the surface map, off by default; ticked it goes to check and start', async () => {
    const t = await renderRun()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Map stock surface…' }))
    t.push({ pins: 'P' })
    t.push({ pins: '' })
    await t.user.click(within(dialog()).getByRole('button', { name: 'Map surface' }))
    await waitFor(() => expect(t.points).toHaveLength(20))
    await within(dialog()).findByRole('button', { name: 'Clear map' })
    await t.user.click(within(dialog()).getByRole('button', { name: 'Close' }))
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await t.user.click(within(inspector).getByRole('button', { name: 'Start run' }))
    const preflight = screen.getByRole('dialog', { name: 'Start run?' })
    const follow = within(preflight).getByRole('checkbox', { name: 'Follow the surface map' })
    expect(follow).not.toBeChecked()
    await within(preflight).findByText('Inside the travel at this work zero.')
    expect(t.checks.at(-1)).not.toHaveProperty('surfaceMap')
    await t.user.click(follow)
    await within(preflight).findByText(/The program moves by up to 0.310 mm/)
    expect(t.checks.at(-1)).toMatchObject({
      surfaceMap: { setupId: t.setupId, cols: 5, rows: 4, maxRange: 1 },
    })
    await expectNoAxeViolations()
    const start = within(preflight).getByRole('button', { name: 'Start run' })
    await waitFor(() => expect(start).toBeEnabled())
    await t.user.click(start)
    expect(t.starts.at(-1)).toMatchObject({ surfaceMap: { cols: 5, rows: 4 } })
  })
})
