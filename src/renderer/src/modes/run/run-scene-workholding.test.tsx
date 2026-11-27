// The Run scene's workholding through the app (hardening DF133 RW1), against the fake bridge bound
// to a real project runtime and pushed run statuses: the trust states of run-workholding.md
// § Trust (outlined, hidden, solid) with the Position panel's status line, the scene's items equal
// to the Plan viewport's at a moved work zero (and unmoved by a Z reference `zeroLevel`), and the
// holder ghost of the tool in the spindle at the tool marker (Q189: a tool-change wait's tool,
// kept for the connection). RW5: the live clearance chip (nearest item and distance, amber and red,
// a polite status that changes with the item or colour only), the items' and the holder ghost's
// colours, none with the guard switched off, the interrupted run's ghost red inside an item, and
// the tool-change dialog's guard line with the Z note.
// Doc: docs/modes/run-workholding.md#implementation-rw1, #implementation-rw5
import { act, screen, waitFor } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { libraryInput, machineValues } from '../../../../core/library/library.fixture'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import type { CallReply } from '../../../../shared/preload-api'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import type { RunScene } from '../../viewport'
import { usePlanScene } from '../plan/usePlanScene'
import { runStoreOf } from './run-store'
import { useRunScene } from './useRunScene'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

const probe: { plan: RunScene | null; run: RunScene | null } = { plan: null, run: null }
function SceneProbe(): null {
  const plan = usePlanScene('plan')
  const run = useRunScene('run')
  useEffect(() => {
    probe.plan = plan
    probe.run = run
  }, [plan, run])
  return null
}

const ok = (value: unknown = {}): CallReply => ({ ok: true, value, revision: 0 })

async function runScene() {
  const s = await planSetup()
  const { kind: _, ...m } = machineValues()
  const machineId = (
    (await s.run('library.machine.add', {
      values: { ...libraryInput({ ...m, name: 'ER11 router' }), holder: { preset: 'er11' } },
    })) as { id: string }
  ).id
  const planId = await s.create({ machineLibraryItemId: machineId })
  const setupId = s.plan(planId).setups[0]!.id
  await s.run('plan.workholding.set', {
    planId,
    setupId,
    items: [
      { kind: 'toeClamp', edge: 'vMin', top: '20' },
      { kind: 'screw', center: ['70', '40'], top: '3' },
    ],
  })
  // a moved work zero (DF78): the items are in the setup frame, the scene in the WCS
  await s.run('plan.setup.update', { planId, setupId, zero: { at: ['20', '10'] } })
  const bridge = createFakeBridge()
  bridge.bind(s.d)
  let status = closedStatus()
  bridge.handle('run.status.get', () => ok(status))
  const push = (patch: Partial<RunStatus>) => {
    status = { ...status, ...patch }
    act(() => bridge.emitRunStatus(status))
  }
  const shell = createShell(bridge)
  shell.ui.getState().setMode('plan')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
      <SceneProbe />
    </ShellProvider>,
  )
  return { ...r, s, planId, setupId, shell, push, run: () => runStoreOf(bridge) }
}

const OPEN = { connection: { state: 'open', target: 'virtual', timeScale: 1 } } as const

describe('Run scene workholding (DF133 RW1)', () => {
  it('outlined until homed, hidden until the zero is set, then solid as Plan draws them; the status line says why', async () => {
    const t = await runScene()
    await waitFor(() => expect(probe.plan?.workholding?.solids).toHaveLength(3))
    const planned = probe.plan!.workholding!.solids
    act(() => t.shell.ui.getState().setMode('run'))
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    const line = () => inspector.querySelector('[data-workholding-trust]')

    // not connected: the items at the plan's zero, outlined; no status line
    await waitFor(() => expect(probe.run?.workholding?.outlined).toBe(true))
    expect(probe.run!.workholding!.solids).toEqual(planned)
    expect(probe.run!.holder).toBeUndefined()
    expect(line()).toBeNull()

    // connected, not homed: outlined, no holder at the (unknown) position
    t.push({ ...OPEN, state: 'Alarm', mpos: [-100, -100, -10], wpos: [-100, -100, -10] })
    await waitFor(() => expect(line()).toHaveAttribute('data-workholding-trust', 'notHomed'))
    expect(line()).toHaveTextContent('Home the machine to check jogs against the workholding.')
    expect(probe.run!.workholding!.outlined).toBe(true)
    expect(probe.run!.holder).toBeUndefined()

    // homed, G54 never set: the items would stand at the machine origin, hidden
    t.push({ state: 'Idle', homed: true, mpos: [-1, -1, -1], wpos: [-1, -1, -1] })
    await waitFor(() => expect(probe.run?.workholding).toBeUndefined())
    expect(line()).toHaveTextContent('Set the work zero to check jogs against the workholding.')
    // the position is known: the holder at the tool marker
    expect(probe.run!.holder?.tip).toEqual([-1, -1, -1])

    // G54 set: solid, exactly the Plan viewport's items (moved zero included)
    t.push({ workZero: [-200, -150, -60], mpos: [-190, -130, -55], wpos: [10, 20, 5] })
    await waitFor(() => expect(probe.run?.workholding?.outlined).toBeUndefined())
    expect(probe.run!.workholding!.solids).toEqual(planned)
    expect(line()).toHaveTextContent('Checks the clamps as placed in Plan, at the work zero.')
    const ghost = probe.run!.holder!
    expect(ghost.tip).toEqual([10, 20, 5])
    expect(ghost.colliding).toBe(false)
    expect(ghost.label).toMatch(/^T1 Ø\d+(\.\d+)? mm · stickout \d+(\.\d+)? mm · ER11$/)
    expect(ghost.parts.map((p) => p.part)).toEqual(['tool', 'nut', 'body'])
    await expectNoAxeViolations()

    // Z0 on a surface 3 mm below the top (DF69): the tool 3 mm lower in the setup frame, the
    // items where they are
    t.push({ zeroLevel: -3 })
    await waitFor(() => expect(probe.run?.holder?.tip).toEqual([10, 20, 2]))
    expect(probe.run!.workholding!.solids).toEqual(planned)
  })

  it("a tool-change wait's tool stays the spindle's for the connection (Q189)", async () => {
    const t = await runScene()
    act(() => t.shell.ui.getState().setMode('run'))
    t.push({ ...OPEN, state: 'Idle', homed: true, workZero: [-200, -150, -60] })
    await waitFor(() => expect(probe.run?.holder?.label).toMatch(/^T1 /))
    const job = (phase: NonNullable<RunStatus['job']>['phase'], extra = {}) => ({
      job: {
        jobId: 'run-1',
        phase,
        line: 1,
        startedAt: '2026-11-27T10:00:00Z',
        elapsedSeconds: 1,
        ...extra,
      },
    })
    t.push({ ...job('toolChange', { toolChange: { n: 2, name: 'Flat 4' } }) })
    await waitFor(() => expect(probe.run?.holder?.label).toMatch(/^T2 /))
    t.push({ ...job('streaming') })
    // the run ends: the tool chucked at the wait stays the spindle's
    t.push({ ...job('done') })
    expect(probe.run!.holder!.label).toMatch(/^T2 /)
    // a new connection: the setup's first tool again
    t.push(closedStatus())
    t.push({ ...OPEN, state: 'Idle', homed: true, workZero: [-200, -150, -60] })
    await waitFor(() => expect(probe.run?.holder?.label).toMatch(/^T1 /))
  })
})

describe('live clearance and colours (DF133 RW5)', () => {
  /** In Run with the inspector open, homed, G54 set; the screw's id, name and the margin. */
  async function trusted(t: Awaited<ReturnType<typeof runScene>>) {
    act(() => t.shell.ui.getState().setMode('run'))
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    t.push({ ...OPEN, state: 'Idle', homed: true, workZero: [-200, -150, -60] })
    await waitFor(() => expect(t.run().getState().guardSetup).toBeDefined())
    const g = t.run().getState().guardSetup!
    const screw = g.setup.prisms.find((p) => p.footprint.kind === 'circle')!
    return {
      margin: g.setup.margin,
      id: screw.itemId,
      name: g.names[screw.itemId]!,
      top: screw.zMax,
    }
  }
  /** The tool tip right above the screw (setup (70, 40), the zero at (20, 10)), `gap` over it. */
  const over = (t: Awaited<ReturnType<typeof runScene>>, top: number, gap: number) =>
    t.push({ wpos: [50, 30, top + gap], mpos: [-150, -120, top + gap - 60] })
  const chip = () => document.querySelector('[data-clearance]')
  const said = () =>
    screen
      .getAllByRole('status')
      .find((e) => /^(Nearest item|Close to|Within the margin)/.test(e.textContent ?? ''))

  it('the chip names the nearest item and its distance; amber, then red with the item and the holder', async () => {
    const t = await runScene()
    const c = await trusted(t)
    over(t, c.top, 3 * c.margin)
    await waitFor(() => expect(chip()).toHaveAttribute('data-clearance', 'clear'))
    expect(chip()).toHaveAttribute('data-item', c.id)
    expect(chip()).toHaveTextContent(`Clear: ${3 * c.margin} mm to ${c.name} (tool)`)
    expect(said()).toHaveTextContent(`Nearest item: ${c.name}.`)
    expect(probe.run!.workholding!.solids.some((x) => x.close || x.colliding)).toBe(false)
    await expectNoAxeViolations()
    // another report, the same item and colour: the announcement does not change
    const before = said()!.textContent
    over(t, c.top, 3 * c.margin - 0.4)
    await waitFor(() => expect(chip()).toHaveTextContent(`${3 * c.margin - 0.4} mm`))
    expect(said()!.textContent).toBe(before)

    // under 2 × margin: amber
    over(t, c.top, 1.5 * c.margin)
    await waitFor(() => expect(chip()).toHaveAttribute('data-clearance', 'close'))
    expect(said()).toHaveTextContent(`Close to ${c.name}.`)
    const screwSolid = () => probe.run!.workholding!.solids.find((x) => x.itemId === c.id)!
    await waitFor(() => expect(screwSolid().close).toBe(true))
    expect(probe.run!.holder!.colliding).toBe(false)

    // at the margin (a guarded stop): red, the holder ghost too
    over(t, c.top, c.margin)
    await waitFor(() => expect(chip()).toHaveAttribute('data-clearance', 'inside'))
    expect(chip()).toHaveTextContent(`Within the margin: ${c.margin} mm to ${c.name} (tool)`)
    expect(said()).toHaveTextContent(`Within the margin of ${c.name}.`)
    await waitFor(() => expect(screwSolid().colliding).toBe(true))
    expect(probe.run!.holder!.colliding).toBe(true)
    await expectNoAxeViolations()

    // the guard switched off by the user: the chip stays, the scene drops red and amber
    act(() => t.run().getState().setGuardOff(true))
    await waitFor(() => expect(screwSolid().colliding).toBeUndefined())
    expect(probe.run!.holder!.colliding).toBe(false)
    expect(chip()).toHaveAttribute('data-clearance', 'inside')

    // G54 never set (a state reason): no chip
    t.push({ workZero: [0, 0, 0] })
    await waitFor(() => expect(chip()).toBeNull())
  })

  it("the interrupted run's ghost tool is red when it was inside an item", async () => {
    const t = await runScene()
    const c = await trusted(t)
    const lastRun = (wpos: [number, number, number]) => ({
      lastRun: {
        jobId: 'run-1',
        planId: t.planId,
        setupId: t.setupId,
        outcome: 'failed',
        operations: [],
        interruption: {
          reason: 'machinePowerLost',
          at: '2026-11-27T14:32:07Z',
          startedAt: '2026-11-27T14:09:07Z',
          lines: 20,
          sent: 19,
          acknowledged: 17,
          executing: 16,
          executingFrom: 'estimate',
          lastReport: {
            at: '2026-11-27T14:32:06.800Z',
            state: 'Run',
            mpos: [0, 0, 0],
            wpos,
            feed: 600,
            spindle: 0,
          },
          workZero: { start: [-200, -150, -60], last: [-200, -150, -60] },
          tool: { n: 1, name: 'Flat 6' },
          spindle: { dir: 'cw', rpm: 0 },
          programHash: 'hash-1',
          suggestion: { line: 15, kind: 'pass' },
          safest: { line: 10, kind: 'operation', label: 'Pocket 1' },
        },
      },
    })
    // last seen in the screw's head (setup (70, 40), below its top)
    t.push(lastRun([50, 30, c.top - 1]) as never)
    await waitFor(() => expect(probe.run?.ghost).toBeDefined())
    expect(probe.run!.ghostColliding).toBe(true)
    // last seen well clear of every item
    t.push(lastRun([-150, -150, 40]) as never)
    await waitFor(() => expect(probe.run?.ghost?.[0]).toBe(-150))
    expect(probe.run!.ghostColliding).toBeUndefined()
  })

  it('the tool-change dialog names the tool the guard checks with, and the Z note until Z is set', async () => {
    const t = await runScene()
    await trusted(t)
    over(t, 3, 40)
    t.push({
      job: {
        jobId: 'run-1',
        phase: 'toolChange',
        line: 1,
        startedAt: '2026-11-27T10:00:00Z',
        elapsedSeconds: 1,
        toolChange: { n: 1, name: 'Flat 6' },
      },
    })
    const line = await waitFor(() => {
      const l = screen.getByRole('dialog').querySelector('[data-guard-tool]')
      expect(l).not.toBeNull()
      return l!
    })
    expect(line).toHaveTextContent(
      /^Jogs here are checked against the clamps with T1 Ø\d+(\.\d+)? mm · stickout \d+(\.\d+)? mm · ER11\. Z not set for this tool yet: heights may be off by the difference in tool length\.$/,
    )
    await expectNoAxeViolations()
    // Probe Z / Set Z zero: the note goes, the tool stays
    t.push({ workZero: [-200, -150, -61.5] })
    await waitFor(() => expect(line).not.toHaveTextContent('Z not set'))
    expect(line).toHaveTextContent(/^Jogs here are checked against the clamps with T1 /)
  })
})
