// Calibration cut (v0.5 RV9) in the app against the fake bridge: the navigator opens it with the
// plan, the check suggests a spot and its problems disable Run, the checked program is previewed,
// Run waits for homing, the cut is kept per machine, readings give the suggestions ($101 line to
// copy, the library tool Ø with Undo), the ladder's chosen step its preset; axe.
// Spec: docs/modes/run-calibration.md
import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import type { CallReply } from '../../../../shared/preload-api'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { runStoreOf } from './run-store'
import { expectNoAxeViolations, renderUi } from '../../test/render'

const ok = (value: unknown = {}): CallReply => ({ ok: true, value, revision: 0 })
const envelope = {
  travel: [800, 600, 100] as [number, number, number],
  homingMask: 0,
  pullOff: 1,
  softLimits: true,
}

const checked = (over: object = {}) => ({
  setupId: 'setup-1',
  at: [130, 30],
  toolId: 'snap-1',
  tools: [{ id: 'snap-1', name: 'Flat 6', diameter: 6 }],
  footprint: { x: [105, 155], y: [18, 42] },
  stockTop: { x: [0, 180], y: [0, 60] },
  depth: 2,
  cutting: { spindleSpeed: 18000, feedRate: 800, plungeRate: 200, stepdown: 1 },
  lines: ['G90', 'G0 Z10', 'X120 Y30', 'G1 Z-1 F200', 'X140', 'M30'],
  sections: [],
  seconds: 95,
  problems: [],
  findings: [],
  travelChecked: false,
  ...over,
})

async function renderRun() {
  const s = await planSetup()
  await s.create({ machineLibraryItemId: s.machineId })
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
  bridge.handle('run.settings.check', () => ok({ settings: { '100': 80, '101': 80 } }))
  const calls: { name: string; args: unknown }[] = []
  let check: object = checked()
  bridge.handle('run.calibration.check', (args) => {
    calls.push({ name: 'run.calibration.check', args })
    return ok(check)
  })
  bridge.handle('run.calibration.start', (args) => {
    calls.push({ name: 'run.calibration.start', args })
    return ok({ jobId: 'cal-1' })
  })
  bridge.handle('job.get', () => ok({ state: 'running', progress: { done: 3, total: 6 } }))
  bridge.handle('job.wait', () =>
    ok({ state: 'finished', outcome: { ok: true, value: { lines: 6, toolChanges: 1 } } }),
  )
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
  const setCheck = (c: object) => {
    check = c
  }
  return { ...r, nav, push, bridge, calls, setCheck, shell, machineId: s.machineId }
}

const dialog = () => screen.getByRole('dialog', { name: 'Calibration cut' })
const run = () => within(dialog()).getByRole('button', { name: 'Run calibration cut' })

describe('Calibration cut (v0.5 RV9)', () => {
  it('suggests a spot, refuses problems, runs, keeps the cut and suggests corrections', async () => {
    const t = await renderRun()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Calibration cut…' }))
    // the check without a spot: the suggested one fills the fields
    await waitFor(() =>
      expect(within(dialog()).getByRole('textbox', { name: 'Centre X (mm)' })).toHaveValue('130'),
    )
    expect(t.calls[0]?.args).toMatchObject({ test: 'dimension' })
    expect(t.calls[0]?.args).not.toHaveProperty('at')
    expect(within(dialog()).getByText(/6 lines, about/)).toBeVisible()
    expect(within(dialog()).getByText(/Connect and home to check the soft limits/)).toBeVisible()
    expect(run()).toBeDisabled()
    expect(run()).toHaveAccessibleDescription('Home the machine first.')
    // homed with a travel check: a problem keeps Run disabled
    t.setCheck(
      checked({
        travelChecked: true,
        problems: [{ rule: 'operation', message: 'Pocket 1', ref: 'op-1' }],
      }),
    )
    t.push({ state: 'Idle', homed: true, envelope })
    expect(await within(dialog()).findByText('Overlaps Pocket 1: move the spot.')).toBeVisible()
    expect(run()).toHaveAccessibleDescription('Fix the problems above first.')
    // moved: the check again at the typed spot
    t.setCheck(checked({ at: [140, 30], travelChecked: true }))
    const x = within(dialog()).getByRole('textbox', { name: 'Centre X (mm)' })
    await t.user.clear(x)
    await t.user.type(x, '140')
    await waitFor(() => expect(run()).toBeEnabled())
    expect(t.calls.at(-1)?.args).toMatchObject({ at: [140, 30], test: 'dimension' })
    // the viewport previews the checked program
    expect(runStoreOf(t.bridge).getState().calibrationPreview).toHaveLength(6)
    await expectNoAxeViolations()

    await t.user.click(run())
    await waitFor(() =>
      expect(t.calls.find((c) => c.name === 'run.calibration.start')?.args).toMatchObject({
        at: [140, 30],
        toolId: 'snap-1',
      }),
    )
    // kept per machine with the date; the readings section for it
    const textbox = await within(dialog()).findByRole('textbox', { name: 'Pocket X (mm)' })
    const saved = t.bridge.settingsPatches.at(-1) as {
      calibration: Record<string, { test: string; size: number; footprint: unknown }[]>
    }
    expect(saved.calibration[t.machineId]).toMatchObject([
      { test: 'dimension', size: 15, depth: 2, footprint: { x: [105, 155] } },
    ])
    // readings: Y scale off by 1 % (pocket and boss both 1 % large), the tool cuts 0.1 mm wide
    const type = async (name: string, v: string) =>
      t.user.type(within(dialog()).getByRole('textbox', { name: `${name} (mm)` }), v)
    await type('Pocket X', '15.1')
    await type('Boss X', '14.9')
    await type('Pocket Y', '15.25')
    await type('Boss Y', '15.05')
    expect(textbox).toHaveValue('15.1')
    const steps = await within(dialog()).findByText(/Y moves 1.00 % off/)
    expect(steps).toBeVisible()
    expect(within(dialog()).getByText('$101=79.208')).toBeVisible()
    expect(within(dialog()).getByText(/The tool cuts as Ø 6.1 mm/)).toBeVisible()
    await expectNoAxeViolations()
    // the library tool's Ø, written and written back (library edits have no history undo)
    const diameter = async () => {
      const r = await t.bridge.call('library.tool.get', { id: toolId })
      return (r.ok ? (r.value as { diameter: { source: string } }) : undefined)?.diameter.source
    }
    const toolId = (
      (await t.bridge.call('library.tool.list', {})) as {
        ok: true
        value: { items: { id: string; name: string }[] }
      }
    ).value.items.find((i) => i.name === 'Flat 6')!.id
    const before = await diameter()
    await t.user.click(within(dialog()).getByRole('button', { name: 'Set library Ø to 6.1 mm' }))
    expect(await within(dialog()).findByText('Library Ø set to 6.1 mm.')).toBeVisible()
    expect(await diameter()).toBe('6.100 mm')
    await t.user.click(within(dialog()).getByRole('button', { name: 'Undo' }))
    expect(await within(dialog()).findByText('Library Ø restored.')).toBeVisible()
    expect(Number.parseFloat((await diameter())!)).toBe(Number.parseFloat(before!))
    await t.user.click(within(dialog()).getByRole('button', { name: 'Save results' }))
    const after = t.bridge.settingsPatches.at(-1) as {
      calibration: Record<string, { readings?: Record<string, number>; summary?: string }[]>
    }
    expect(after.calibration[t.machineId]?.[0]?.readings).toMatchObject({ pocketY: 15.25 })
    expect(after.calibration[t.machineId]?.[0]?.summary).toContain('Y moves 1.00 % off')
  })

  it("the feed ladder's chosen step gives the preset", async () => {
    const t = await renderRun()
    t.push({ state: 'Idle', homed: true, envelope })
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Calibration cut…' }))
    t.setCheck(
      checked({
        travelChecked: true,
        vary: 'feed',
        steps: [
          { n: 1, factor: 0.7, feed: 560, stepdown: 1 },
          { n: 2, factor: 1, feed: 800, stepdown: 1 },
          { n: 3, factor: 1.3, feed: 1040, stepdown: 1 },
        ],
      }),
    )
    await t.user.click(within(dialog()).getByRole('radio', { name: 'Feed ladder' }))
    await waitFor(() =>
      expect(t.calls.at(-1)?.args).toMatchObject({ test: 'feedLadder', vary: 'feed' }),
    )
    await waitFor(() => expect(run()).toBeEnabled())
    await t.user.click(run())
    const pick = await within(dialog()).findByRole('combobox', { name: 'Best step' })
    await t.user.click(pick)
    await t.user.click(await screen.findByRole('option', { name: 'Step 3: 1040 mm/min (+30 %)' }))
    expect(
      await within(dialog()).findByText(/Set the tool's feed preset to 1040 mm\/min \(\+30 %/),
    ).toBeVisible()
  })
})
