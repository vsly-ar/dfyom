// Run mode in the app (task 3.12, the run half of the exit criteria's UI flow, 3.11): a project
// with a planned part is set up through the window's bridge (the design and plan UIs are 3.6/3.7);
// then, through the UI only: connect to the virtual machine at max speed, home, jog, set the work
// zero, start the run through the pre-flight dialog, confirm every tool change and program pause,
// watch the progress, and end with the run complete. Selectors are roles and accessible names.
// Docs: docs/conventions/ui.md#run-mode-safety-ui, docs/conventions/testing.md#end-to-end
import type { Page } from '@playwright/test'
import { deg, feed, len, num, rpm } from '../src/core/library/library.fixture'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

async function bridgeCall<T>(page: Page, name: string, args: object = {}): Promise<T> {
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

const flat6 = {
  name: 'Flat 6',
  type: 'flatEndMill',
  diameter: len('6'),
  fluteLength: len('25'),
  overallLength: len('60'),
  fluteCount: num('2'),
  toolMaterial: 'carbide',
  presets: [
    {
      name: 'Alu finish',
      materialClass: 'aluminum',
      spindleSpeed: rpm('18000'),
      feedRate: feed('800'),
      plungeRate: feed('200'),
      stepdown: len('1'),
      stepover: len('3'),
    },
  ],
}
const drill6 = {
  name: 'Drill 6',
  type: 'drill',
  diameter: len('6'),
  fluteLength: len('30'),
  overallLength: len('66'),
  fluteCount: num('2'),
  pointAngle: deg('118'),
  presets: [],
}

/** A project with a 100 × 60 × 20 block: facing, a pocket and a hole; one plan with toolpaths. */
async function plannedProject(page: Page): Promise<void> {
  const call = <T>(name: string, args: object = {}) => bridgeCall<T>(page, name, args)
  const stock = await call<{ id: string }>('library.stock.add', {
    values: {
      name: 'Test block',
      shape: 'block',
      length: len('100'),
      width: len('60'),
      thickness: len('20'),
      material: { name: '6061-T6', class: 'aluminum' },
    },
  })
  for (const values of [flat6, drill6]) await call('library.tool.add', { values })
  const machine = await call<{ id: string }>('library.machine.add', {
    values: {
      name: 'Shapeoko',
      controller: 'grbl',
      travel: { x: len('800'), y: len('800'), z: len('100') },
      maxFeedRate: { x: feed('5000'), y: feed('5000'), z: feed('1000') },
      spindle: { control: 'manual', maxSpeed: rpm('30000') },
      programUnits: 'mm',
      toolChanger: 'none',
    },
  })
  await call('project.create', { name: 'Bracket', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Bracket',
    stockLibraryItemId: stock.id,
  })
  await call('design.facing.add', { partId, depth: '0.5' })
  await call('design.pocket.add', {
    partId,
    shape: { kind: 'rectangle', center: ['50', '30'], length: '40', width: '25' },
    depth: '4',
  })
  await call('design.drilling.add', {
    partId,
    center: ['15', '15'],
    diameter: '6',
    bottom: 'drillPoint',
    depth: '8',
  })
  const evaluated = await call<{ jobId: string }>('design.part.evaluate', { partId })
  await call('job.wait', { jobId: evaluated.jobId, timeoutSeconds: 60 })
  const { planId } = await call<{ planId: string }>('plan.create', {
    partId,
    machineLibraryItemId: machine.id,
  })
  // the drill has no feeds-and-speeds preset (plan known issue): give it cutting values
  const { plan } = await call<{
    plan: {
      setups: { operations: { id: string; tool?: string }[] }[]
      snapshots: { id: string; kind: string; values: { name: string } }[]
    }
  }>('plan.get', { planId })
  const drill = plan.snapshots.find((s) => s.kind === 'tool' && s.values.name === 'Drill 6')
  for (const op of plan.setups[0]!.operations.filter((o) => o.tool === drill?.id))
    await call('plan.operation.update', {
      planId,
      planOperationId: op.id,
      overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
    })
  const { jobId } = await call<{ jobId: string }>('plan.toolpath.generate', { planId })
  const done = await call<{ outcome?: { ok: boolean } }>('job.wait', {
    jobId,
    timeoutSeconds: 60,
  })
  expect(done.outcome?.ok, JSON.stringify(done)).toBe(true)
}

test('run mode: connect, home, jog, work zero, run at max with tool changes to the end', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await plannedProject(page)

  await page.keyboard.press('ControlOrMeta+3')
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  const nav = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const machine = page.getByRole('group', { name: 'Machine' })

  // not connected: no stop control yet; start explains why
  await expect(machine).toHaveCount(0)
  await expect(inspector.getByRole('button', { name: 'Start run' })).toBeDisabled()

  // connect at max speed: the virtual machine starts in Alarm (homing required)
  await nav.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: 'Max' }).click()
  await nav.getByRole('button', { name: 'Connect to virtual machine' }).click()
  await expect(machine.getByText('Virtual machine · Max')).toBeVisible()
  await expect(machine.getByRole('button', { name: 'Stop' })).toBeVisible()
  await expect(machine.getByText(/^Alarm/)).toBeVisible()
  await expect(nav.getByText('Home the machine first.').first()).toBeVisible()

  // home
  await nav.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  await expect(nav.getByText('Homed', { exact: true })).toBeVisible()

  // jog to the middle of the table, then set the work zero there
  await nav.getByRole('radio', { name: '100 mm' }).click()
  for (const name of ['Jog X−', 'Jog Y−']) {
    for (let i = 0; i < 4; i++) {
      await nav.getByRole('button', { name }).click()
      await expect(machine.getByText('Idle')).toBeVisible()
    }
  }
  await nav.getByRole('radio', { name: '10 mm' }).click()
  for (let i = 0; i < 5; i++) {
    await nav.getByRole('button', { name: 'Jog Z−' }).click()
    await expect(machine.getByText('Idle')).toBeVisible()
  }
  const dro = inspector.getByRole('table', { name: 'Position' })
  await expect(dro.getByRole('cell', { name: 'Machine position X' })).toHaveText('-401.000')
  await nav.getByRole('button', { name: 'Zero X Y Z' }).click()
  await expect(dro.getByRole('cell', { name: 'Work position X' })).toHaveText(/^0\.000/)
  await expect(dro.getByRole('cell', { name: 'Work position Z' })).toHaveText(/^0\.000/)

  // pre-flight, then the run; every tool change and program pause is confirmed in its dialog
  await inspector.getByRole('button', { name: 'Start run' }).click()
  const preflight = page.getByRole('dialog', { name: 'Start run?' })
  await expect(preflight.getByText('Shapeoko')).toBeVisible()
  await expect(preflight.getByRole('listitem')).toHaveText(['Flat 6', 'Drill 6', 'Flat 6'])
  await expect(preflight.getByRole('button', { name: 'Start run' })).toBeFocused()
  await preflight.getByRole('button', { name: 'Start run' }).click()

  const progress = inspector.getByRole('progressbar', { name: 'Run progress' })
  await expect(progress).toBeVisible()
  const complete = inspector.getByText(/^Run complete: \d+ lines in/)
  const waits: string[] = []
  for (;;) {
    const wait = page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
    await expect(wait.or(complete)).toBeVisible({ timeout: 30_000 })
    if (await complete.isVisible()) break
    const title = (await wait.getByRole('heading').first().textContent()) ?? ''
    waits.push(title)
    if (title.startsWith('Tool change'))
      await expect(wait.getByText(/^Change to (Drill|Flat) 6\.$/)).toBeVisible()
    await wait.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('dialog', { name: title })).toBeHidden()
  }
  expect(waits.filter((w) => w.startsWith('Tool change'))).toEqual([
    'Tool change 2',
    'Tool change 1',
  ])
  expect(waits.filter((w) => w.startsWith('Program pause')).length).toBeGreaterThan(0)
  // progress ends complete: lines done = total
  const [, done, total] = /Line (\d+) \/ (\d+)/.exec((await inspector.textContent()) ?? '') ?? []
  expect(Number(done)).toBeGreaterThan(0)
  expect(done).toBe(total)
  await expect(machine.getByText('Idle')).toBeVisible()

  await nav.getByRole('button', { name: 'Disconnect' }).click()
  await expect(machine).toHaveCount(0)
  expect(dfyom.rendererErrors).toEqual([])
})
