// Jogs through the workholding guard in the app (hardening DF133 RW3), against the fake bridge
// bound to a real project runtime with a toe clamp and pushed run statuses: without the guard
// (no items, not homed, G54 unset) the pad sends exactly today's commands; with it a step and a
// hold toward the clamp become a jog to the stop point, the notice names the clamp once the
// machine is there, "Jog past once" lets one jog through and re-arms, the Jog menu's switch turns
// it off until reconnect (the status line in the warning colour), a jog starting while the machine
// still moves after a cancel is not sent; the Z note after a tool change (Q190); axe.
// Doc: docs/modes/run-workholding.md#jogs, #implementation-rw3
import { act, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { libraryInput, machineValues } from '../../../../core/library/library.fixture'
import { planSetup } from '../../../../core/plan/plan.fixture'
import type { Footprint } from '../../../../core/plan/workholding/obstacles'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import type { CallReply } from '../../../../shared/preload-api'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { runStoreOf } from './run-store'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

const ok = (value: unknown = {}): CallReply => ({ ok: true, value, revision: 0 })
const OPEN = { connection: { state: 'open', target: 'virtual', timeScale: 1 } } as const
const G54 = [-200, -150, -60] as const
const envelope = { travel: [800, 600, 100], homingMask: 0, pullOff: 1, softLimits: true }

const xs = (f: Footprint) => (f.kind === 'circle' ? [f.center[0]] : f.points.map((p) => p[0]))
const ys = (f: Footprint) => (f.kind === 'circle' ? [f.center[1]] : f.points.map((p) => p[1]))

async function renderGuard(withItems = true) {
  const s = await planSetup()
  const { kind: _, ...m } = machineValues()
  const machineId = (
    (await s.run('library.machine.add', {
      values: { ...libraryInput({ ...m, name: 'ER11 router' }), holder: { preset: 'er11' } },
    })) as { id: string }
  ).id
  const planId = await s.create({ machineLibraryItemId: machineId })
  const setupId = s.plan(planId).setups[0]!.id
  if (withItems)
    await s.run('plan.workholding.set', {
      planId,
      setupId,
      items: [{ kind: 'toeClamp', edge: 'vMin', top: '20' }],
    })
  const bridge = createFakeBridge()
  bridge.bind(s.d)
  let status = closedStatus()
  bridge.handle('run.status.get', () => ok(status))
  bridge.handle('run.machine.jog', () => ok({}))
  bridge.handle('run.machine.jogCancel', () => ok({}))
  bridge.handle('run.align.goto', () => ok({ current: 'zero', target: [0, 0] }))
  const push = (patch: Partial<RunStatus>) => {
    status = { ...status, ...patch }
    act(() => bridge.emitRunStatus(status))
  }
  /** The tool tip at work position `w` (the setup's zero unmoved: WCS = setup frame), Idle. */
  const at = (w: readonly [number, number, number], patch: Partial<RunStatus> = {}) =>
    push({
      state: 'Idle',
      wpos: [...w],
      mpos: [w[0] + G54[0], w[1] + G54[1], w[2] + G54[2]],
      ...patch,
    })
  const shell = createShell(bridge)
  shell.ui.getState().setMode('run')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  const run = () => runStoreOf(bridge)
  const jogs = () => bridge.calls.filter((c) => c.name === 'run.machine.jog').map((c) => c.args)
  const nav = () => screen.getByRole('navigation', { name: 'Navigator' })
  await within(nav()).findByRole('button', { name: 'Connect' })
  // connected, homed, G54 set, a 10 mm step
  push({ ...OPEN, homed: true, workZero: [...G54], envelope: structuredClone(envelope) as never })
  act(() => run().getState().setJogStep(10))
  const aligns = () => bridge.calls.filter((c) => c.name === 'run.align.goto').map((c) => c.args)
  return { ...r, s, push, at, run, jogs, aligns, nav }
}

type T = Awaited<ReturnType<typeof renderGuard>>

/** The clamp's X extent and Y middle, the guard's margin and the tool's radius. */
async function clamp(t: T) {
  await waitFor(() => expect(t.run().getState().guardSetup).toBeDefined())
  const g = t.run().getState().guardSetup!
  const all = g.setup.prisms.map((p) => p.footprint)
  const minX = Math.min(...all.flatMap(xs))
  const midX = (minX + Math.max(...all.flatMap(xs))) / 2
  const midY = (Math.min(...all.flatMap(ys)) + Math.max(...all.flatMap(ys))) / 2
  const top = Math.max(...g.setup.prisms.map((p) => p.zMax))
  return { minX, midX, midY, top, margin: g.setup.margin, radius: g.setup.envelope[0]!.radius }
}

const jogButton = (t: T, name: string) => within(t.nav()).getByRole('button', { name })
const notice = (t: T) => t.nav().querySelector('[data-guard-notice] [role="status"]')

describe('jogs through the workholding guard (DF133 RW3)', () => {
  it('without items, not homed or with G54 unset: exactly today’s commands, no notice line', async () => {
    const t = await renderGuard(false)
    t.at([0, 0, 5])
    await t.user.click(jogButton(t, 'Jog X+'))
    await waitFor(() => expect(t.jogs()).toHaveLength(1))
    expect(t.jogs()[0]).toEqual({ by: [10, 0, 0], feed: expect.any(Number) })
    expect(t.nav().querySelector('[data-guard-notice]')).toBeNull()
    // a hold: today's continuous jog to the travel edge
    await act(() => t.run().getState().jogHoldStart('y', -1, 2000))
    expect(t.jogs()[1]).toEqual({ by: [0, -1, 0], feed: 2000, continuous: true })
    act(() => t.run().getState().jogHoldEnd())
  })

  it('G54 never set: no guard, today’s step even into the clamp', async () => {
    const u = await renderGuard(true)
    const c = await clamp(u)
    u.push({ workZero: [0, 0, 0], wpos: [c.minX - 20, c.midY, 5], mpos: [c.minX - 20, c.midY, 5] })
    act(() => u.run().getState().setJogStep(50))
    await u.user.click(jogButton(u, 'Jog X+'))
    await waitFor(() => expect(u.jogs()).toHaveLength(1))
    expect(u.jogs()[0]).toEqual({ by: [50, 0, 0], feed: expect.any(Number) })
  })

  it('a step toward the clamp stops at the margin; the notice names it; Jog past once lets one through', async () => {
    const t = await renderGuard()
    const c = await clamp(t)
    const start = [c.minX - 20, c.midY, 5] as const
    t.at(start)
    // the guard's line is reserved now, empty
    await waitFor(() => expect(notice(t)).toHaveTextContent(/^$/))
    act(() => t.run().getState().setJogStep(50))
    await t.user.click(jogButton(t, 'Jog X+'))
    await waitFor(() => expect(t.jogs()).toHaveLength(1))
    const sent = t.jogs()[0] as { to: [number, number, number]; by?: unknown }
    expect(sent.by).toBeUndefined()
    const stop = c.minX - c.margin - c.radius
    expect(sent.to[0]! - G54[0]).toBeLessThan(stop)
    expect(sent.to[0]! - G54[0]).toBeGreaterThanOrEqual(stop - 0.02)
    expect(sent.to[1]).toBeCloseTo(start[1] + G54[1], 6)
    expect(sent.to[2]).toBeCloseTo(start[2] + G54[2], 6)
    // the notice once the machine is there (not while it is on its way)
    t.push({ state: 'Jog', mpos: [sent.to[0]! - 5, sent.to[1]!, sent.to[2]!] })
    expect(notice(t)).toHaveTextContent(/^$/)
    t.at([sent.to[0] - G54[0], sent.to[1] - G54[1], sent.to[2] - G54[2]])
    await waitFor(() =>
      expect(notice(t)).toHaveTextContent(/^Stopped 2 mm from Toe clamp 1 \(tool\)\.$/),
    )
    const past = jogButton(t, 'Jog past once')
    expect(past).toHaveAccessibleDescription(
      'The next jog or Go to within 30 s is not checked against the workholding.',
    )
    await expectNoAxeViolations()

    // further in: nothing sent, the notice says why
    act(() => t.run().getState().setJogStep(1))
    await t.user.click(jogButton(t, 'Jog X+'))
    await waitFor(() =>
      expect(notice(t)).toHaveTextContent(
        'Not moved: the tool would come within the margin of Toe clamp 1.',
      ),
    )
    expect(t.jogs()).toHaveLength(1)

    // Jog past once: the next jog is today's command, then the guard is back
    await t.user.click(jogButton(t, 'Jog past once'))
    expect(notice(t)).toHaveTextContent('Next jog unguarded.')
    expect(within(t.nav()).queryByRole('button', { name: 'Jog past once' })).toBeNull()
    await t.user.click(jogButton(t, 'Jog X+'))
    await waitFor(() => expect(t.jogs()).toHaveLength(2))
    expect(t.jogs()[1]).toEqual({ by: [1, 0, 0], feed: expect.any(Number) })
    expect(notice(t)).toHaveTextContent(/^$/)
    t.at([sent.to[0] + 1 - G54[0], sent.to[1] - G54[1], sent.to[2] - G54[2]])
    await t.user.click(jogButton(t, 'Jog X+'))
    await waitFor(() => expect(notice(t)).toHaveTextContent(/^Not moved/))
    expect(t.jogs()).toHaveLength(2)
    // moving out is allowed: today's step
    await t.user.click(jogButton(t, 'Jog X−'))
    await waitFor(() => expect(t.jogs()).toHaveLength(3))
    expect(t.jogs()[2]).toEqual({ by: [-1, 0, 0], feed: expect.any(Number) })
  })

  it('a hold toward the clamp is a jog to the stop point; released early, no notice; a start while moving is refused', async () => {
    const t = await renderGuard()
    const c = await clamp(t)
    t.at([c.minX - 20, c.midY, 5])
    await waitFor(() => expect(notice(t)).not.toBeNull())
    await act(() => t.run().getState().jogHoldStart('x', 1, 2000))
    const sent = t.jogs()[0] as { to: number[]; continuous?: boolean }
    expect(sent.continuous).toBeUndefined()
    expect(sent.to[0]! - G54[0]).toBeLessThan(c.minX - c.margin - c.radius)
    t.push({ state: 'Jog', mpos: [sent.to[0]! - 8, sent.to[1]!, sent.to[2]!] })
    // released before the stop point: cancelled (0x85) as today, no "Stopped" notice
    act(() => t.run().getState().jogHoldEnd())
    await waitFor(() => expect(screen.queryAllByText(/Stopped/)).toHaveLength(0))
    // still decelerating (Jog), no queued end: a guarded step is not sent
    await t.user.click(jogButton(t, 'Jog X+'))
    await waitFor(() => expect(notice(t)).toHaveTextContent(/^Not moved: wait for the machine/))
    expect(t.jogs()).toHaveLength(1)
  })

  it('the Jog menu’s switch turns the guard off until reconnect; the status line warns', async () => {
    const t = await renderGuard()
    const c = await clamp(t)
    t.at([c.minX - 20, c.midY, 5])
    within(t.nav()).getByRole('button', { name: 'Jog options' }).focus()
    await t.user.keyboard('{Enter}')
    const item = await screen.findByRole('menuitemradio', { name: /Workholding guard/ })
    expect(item).toHaveAttribute('aria-checked', 'true')
    await expectNoAxeViolations()
    await t.user.click(item)
    expect(t.run().getState().guardOff).toBe(true)
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const line = await waitFor(() => {
      const l = document.querySelector('[data-workholding-trust]')
      expect(l).toHaveTextContent('Workholding guard off.')
      return l!
    })
    expect(line).toHaveAttribute('data-tone', 'warning')
    act(() => t.run().getState().setJogStep(50))
    await t.user.click(jogButton(t, 'Jog X+'))
    await waitFor(() => expect(t.jogs()).toHaveLength(1))
    expect(t.jogs()[0]).toEqual({ by: [50, 0, 0], feed: expect.any(Number) })
    // a reconnect turns it back on
    t.push(closedStatus())
    t.push({
      ...OPEN,
      homed: true,
      workZero: [...G54],
      envelope: structuredClone(envelope) as never,
    })
    expect(t.run().getState().guardOff).toBe(false)
    await waitFor(() =>
      expect(document.querySelector('[data-workholding-trust]')).toHaveTextContent(
        'Checks the clamps as placed in Plan, at the work zero.',
      ),
    )
  })

  it('after a tool-change wait, the Z note until the work zero Z is set (Q190)', async () => {
    const t = await renderGuard()
    await clamp(t)
    t.at([0, -50, 30])
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const line = () => document.querySelector('[data-workholding-trust]')
    await waitFor(() =>
      expect(line()).toHaveTextContent('Checks the clamps as placed in Plan, at the work zero.'),
    )
    const job = {
      jobId: 'run-1',
      phase: 'toolChange' as const,
      line: 1,
      startedAt: '2026-11-27T10:00:00Z',
      elapsedSeconds: 1,
      toolChange: { n: 1, name: 'Flat 6' },
    }
    t.push({ job })
    await waitFor(() =>
      expect(line()).toHaveTextContent(
        'Checks the clamps as placed in Plan, at the work zero. Z not set for this tool yet: heights may be off by the difference in tool length.',
      ),
    )
    // Probe Z / Set Z zero: G54 Z changes, the note goes
    t.push({ workZero: [G54[0], G54[1], G54[2] - 1.5] })
    await waitFor(() => expect(line()).not.toHaveTextContent('Z not set'))
  })
})

// ── DF133 RW4: Go to and the dialogs' moves through the guard ────────────────────────────────────

const goTo = () => screen.getByRole('dialog', { name: 'Go to' })
const goButton = () => within(goTo()).getByRole('button', { name: 'Go' })
const anywayBox = () =>
  within(goTo()).getByRole('checkbox', {
    name: 'Go anyway (the clamps are not where the plan says)',
  })

/** Opens Go to (work frame) and types the target. */
async function typeTarget(t: T, target: readonly [number, number, number]) {
  if (t.run().getState().goTo === undefined)
    act(() => t.run().getState().openGoTo({ frame: 'work', axis: 'x' }))
  for (const [i, axis] of (['X', 'Y', 'Z'] as const).entries()) {
    const f = within(goTo()).getByRole('textbox', { name: axis })
    await t.user.clear(f)
    await t.user.type(f, String(target[i]))
  }
}

describe('Go to and the dialogs’ moves through the workholding guard (DF133 RW4)', () => {
  it('a Go to down onto the clamp: a finding names the step, Go disabled, red path; Go anyway resets with the target', async () => {
    const t = await renderGuard()
    const c = await clamp(t)
    t.at([c.midX, c.midY - 40, c.top + 20])
    await typeTarget(t, [c.midX, c.midY, 5])
    const finding = await waitFor(() => {
      const f = goTo().querySelector('[data-guard-finding]')
      expect(f).not.toBeNull()
      return f!
    })
    expect(finding).toHaveTextContent(
      /^Step 2 \(down to Z 5\.000\) hits Toe clamp 1: the tool stops 2 mm above it at Z 2\d\.\d{3}\./,
    )
    expect(goButton()).toBeDisabled()
    expect(goButton()).toHaveAccessibleDescription(/Step 2 \(down to Z 5\.000\) hits Toe clamp 1/)
    // the 3D path turns red from the contact on (the down step, above the clamp)
    const hit = t.run().getState().goToPreview?.hit
    expect(hit?.step).toBe(1)
    expect(hit!.at[2] - G54[2]).toBeGreaterThan(c.top)
    // Enter does nothing either
    await t.user.type(within(goTo()).getByRole('textbox', { name: 'Z' }), '{Enter}')
    expect(t.jogs()).toHaveLength(0)
    await expectNoAxeViolations()

    // Go anyway: Go enabled for this target; a changed target unticks it
    await t.user.click(anywayBox())
    expect(anywayBox()).toBeChecked()
    expect(goButton()).toBeEnabled()
    await typeTarget(t, [c.midX, c.midY, 6])
    expect(anywayBox()).not.toBeChecked()
    expect(goButton()).toBeDisabled()
    await t.user.click(anywayBox())
    await t.user.click(goButton())
    await waitFor(() => expect(t.jogs()).toHaveLength(2))
    expect(t.jogs()[1]).toEqual({
      to: [c.midX + G54[0], c.midY + G54[1], 6 + G54[2]],
      feed: expect.any(Number),
    })
  })

  it('a clear target: no finding, the steps as before', async () => {
    const t = await renderGuard()
    const c = await clamp(t)
    t.at([c.midX, c.midY - 40, c.top + 20])
    await typeTarget(t, [c.midX - 60, c.midY - 40, c.top + 20])
    expect(goTo().querySelector('[data-guard-finding]')).toBeNull()
    await t.user.click(goButton())
    await waitFor(() => expect(t.jogs()).toHaveLength(1))
    expect(t.jogs()[0]).toEqual({
      to: [c.midX - 60 + G54[0], c.midY - 40 + G54[1], c.top + 20 + G54[2]],
      feed: expect.any(Number),
    })
  })

  it('DF140: the DRO’s →0 onto the clamp stops at the finding (nothing sent) until Go anyway', async () => {
    const t = await renderGuard()
    const c = await clamp(t)
    t.at([c.midX, c.midY, c.top + 20])
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const dro = screen.getByRole('table', { name: 'Position' })
    await t.user.click(within(dro).getByRole('button', { name: 'Go to work Z zero' }))
    await waitFor(() => expect(goTo().querySelector('[data-guard-finding]')).not.toBeNull())
    expect(goTo().querySelector('[data-guard-finding]')).toHaveTextContent(
      /^Step 1 \(down to Z 0\.000\) hits Toe clamp 1/,
    )
    expect(t.jogs()).toEqual([])
    expect(goButton()).toBeDisabled()
    await t.user.click(anywayBox())
    await t.user.click(goButton())
    await waitFor(() => expect(t.jogs()).toHaveLength(1))
    expect(t.jogs()[0]).toEqual({
      to: [c.midX + G54[0], c.midY + G54[1], G54[2]],
      feed: expect.any(Number),
    })
  })

  it('Jog past once also covers the next Go to (no checkbox), and only that one', async () => {
    const t = await renderGuard()
    const c = await clamp(t)
    t.at([c.midX, c.midY - 40, c.top + 20])
    act(() => t.run().getState().jogPastOnce())
    await typeTarget(t, [c.midX, c.midY, 5])
    const finding = goTo().querySelector('[data-guard-finding]')
    expect(finding).toHaveTextContent('Jog past once is armed: this move is not checked.')
    expect(within(goTo()).queryByRole('checkbox', { name: /Go anyway/ })).toBeNull()
    expect(goButton()).toBeEnabled()
    await t.user.click(goButton())
    await waitFor(() => expect(t.jogs()).toHaveLength(2))
    expect(t.run().getState().pastOnceUntil).toBeUndefined()
  })

  it('the store guards every move (touch-off spot, recovery): a hit sends nothing, anyway or guard off sends as today', async () => {
    const t = await renderGuard()
    const c = await clamp(t)
    t.at([c.midX, c.midY, c.top + 20])
    const down = [{ to: [c.midX + G54[0], c.midY + G54[1], 5 + G54[2]] as const, feed: 500 }]
    let sent = true
    await act(async () => {
      sent = await t.run().getState().moveTo(down)
    })
    expect(sent).toBe(false)
    expect(t.jogs()).toHaveLength(0)
    await waitFor(() =>
      expect(notice(t)).toHaveTextContent(
        'Not moved: the tool would come within the margin of Toe clamp 1.',
      ),
    )
    await act(async () => {
      sent = await t.run().getState().moveTo(down, { anyway: true })
    })
    expect(sent).toBe(true)
    expect(t.jogs()).toEqual([{ to: [...down[0]!.to], feed: 500 }])
    // G54 never set: the guard is off, today's move
    t.push({ workZero: [0, 0, 0] })
    await act(async () => {
      sent = await t.run().getState().moveTo(down)
    })
    expect(sent).toBe(true)
    expect(t.jogs()).toHaveLength(2)
  })
})

describe('recovery and the workholding guard (DF133 RW5)', () => {
  it('after a power loss the guard is off until home and zero, then guards the recovery moves', async () => {
    const t = await renderGuard()
    const c = await clamp(t)
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const line = () => document.querySelector('[data-workholding-trust]')
    const chip = () => document.querySelector('[data-clearance]')
    // the power came back: connected, Alarm, not homed (G54 is kept in the controller's EEPROM)
    t.push({ state: 'Alarm', homed: false })
    await waitFor(() =>
      expect(line()).toHaveTextContent('Home the machine to check jogs against the workholding.'),
    )
    expect(chip()).toBeNull()
    const into = [{ to: [c.midX + G54[0], c.midY + G54[1], 5 + G54[2]] as const, feed: 500 }]
    // the guard is off: a move would go as today (the host refuses it unhomed anyway)
    let sent = false
    await act(async () => {
      sent = await t.run().getState().moveTo(into)
    })
    expect(sent).toBe(true)
    // homed with the work zero (Step 4, Step 5): the guard is on, the chip names the clamp
    t.push({ homed: true })
    t.at([c.midX, c.midY - 40, c.top + 20])
    await waitFor(() =>
      expect(line()).toHaveTextContent('Checks the clamps as placed in Plan, at the work zero.'),
    )
    await waitFor(() => expect(chip()).toHaveTextContent(/^Clear: [\d.]+ mm to Toe clamp 1 \(/))
    // "Go to last position" and the panel's moves go through the store's guarded moveTo
    await act(async () => {
      sent = await t.run().getState().moveTo(into)
    })
    expect(sent).toBe(false)
    expect(t.jogs()).toHaveLength(1)
  })
})

describe('setup change and alignment pointer moves (DF133 RW6)', () => {
  it('after a setup change the items are outlined and the guard off until the work zero changes', async () => {
    const t = await renderGuard()
    const c = await clamp(t)
    t.at([c.minX - 20, c.midY, 5])
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const line = () => document.querySelector('[data-workholding-trust]')
    await waitFor(() => expect(line()).toHaveAttribute('data-workholding-trust', 'trusted'))
    // a run ended with this setup next: the store keeps the G54 of that moment
    const setupId = t.run().getState().guardSetup!.key.split(':')[1]!
    act(() =>
      t.run().setState({ setupChange: setupId, setupChangeOpen: true, setupChangeZero: [...G54] }),
    )
    await waitFor(() => expect(line()).toHaveAttribute('data-workholding-trust', 'zeroStale'))
    expect(line()).toHaveTextContent(
      'New setup: set its work zero to check jogs against the workholding.',
    )
    expect(document.querySelector('[data-clearance]')).toBeNull()
    const prompt = await screen.findByRole('dialog', { name: /^Setup change: setup 1/ })
    expect(prompt.querySelector('[data-setup-change-guard]')).toHaveTextContent(
      'Clamps outlined: jogs are not checked against them until you set this setup’s work zero.',
    )
    await expectNoAxeViolations()
    // the guard is off: today's step, even toward the clamp
    act(() => t.run().getState().setJogStep(50))
    await t.user.click(within(prompt).getByRole('button', { name: 'Jog X+' }))
    await waitFor(() => expect(t.jogs()).toHaveLength(1))
    expect(t.jogs()[0]).toEqual({ by: [50, 0, 0], feed: expect.any(Number) })
    // the new zero is set (any G54 change): solid and guarded again, the snapshot dropped
    t.push({ workZero: [G54[0], G54[1], G54[2] - 1] })
    await waitFor(() => expect(line()).toHaveAttribute('data-workholding-trust', 'trusted'))
    expect(prompt.querySelector('[data-setup-change-guard]')).toBeNull()
    expect(t.run().getState().setupChangeZero).toBeUndefined()
  })

  it('the alignment pointer’s jogs go through the guard: a pass below a clamp’s top is not sent', async () => {
    const t = await renderGuard()
    const c = await clamp(t)
    const setupId = t.run().getState().guardSetup!.key.split(':')[1]!
    /** The tip at work position `w` with work zero `g54`, Idle. */
    type V = readonly [number, number, number]
    const tip = (g54: V, w: V) =>
      t.push({
        state: 'Idle',
        workZero: [...g54],
        wpos: [...w],
        mpos: [w[0] + g54[0], w[1] + g54[1], w[2] + g54[2]],
      })
    // beyond the clamp from the zero, below its top
    const w = [2 * c.midX, 2 * c.midY, 5] as const
    // a high work zero: the machine top (−0.5) caps the clearance height below the clamp's top
    tip([G54[0], G54[1], -10], w)
    await act(() => t.run().getState().alignGoto(setupId, 'zero'))
    await waitFor(() =>
      expect(notice(t)).toHaveTextContent(/^Not moved: the .* within the margin of Toe clamp 1\.$/),
    )
    expect(t.aligns()).toHaveLength(0)
    // Jog past once covers it, and is used up
    act(() => t.run().getState().jogPastOnce())
    await act(() => t.run().getState().alignGoto(setupId, 'zero'))
    expect(t.aligns()).toHaveLength(1)
    expect(t.run().getState().pastOnceUntil).toBeUndefined()
    // the usual case: the clearance height clears the clamp, sent as before
    tip(G54, w)
    await act(() => t.run().getState().alignGoto(setupId, 'zero'))
    expect(t.aligns()).toHaveLength(2)
    expect(t.aligns()[1]).toEqual({ planId: expect.any(String), setupId, to: 'zero' })
  })
})
