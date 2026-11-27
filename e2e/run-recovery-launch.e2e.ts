// Recovery after DFYOM itself went (hardening DF129, RC6) in the real app, on the virtual machine:
// a one-pocket plan in a saved project runs; mid-run its record (`run.record`, what a serial run
// journals) is taken and the app quits. The test leaves that record as a `running` journal with
// the program copy next to it, as a crash would (the virtual machine journals nothing itself).
// On the next launch the first window switches to Run mode with the recovery panel ("DFYOM was
// closed unexpectedly…"); the user opens the project from the panel (the 3D view draws the
// toolpath with the ghost tool, the part before it dimmed), ticks the checklist,
// connects (never by itself), homes, restores the run's work zero (the virtual machine forgets
// it across launches), resumes near where it stopped: the pre-flight starts at the suggested
// line, the lead-in waits at the tool, the rest runs to Idle.
// Light and dark screenshots go to DFYOM_RENDERS_DIR when set (df129-launch-*.png).
// Windows stay hidden (fixture). Selectors are roles and accessible names.
// Docs: docs/modes/run-recovery.md#implementation-rc6, docs/conventions/testing.md#end-to-end
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { RunJournal } from '../src/core/run/journal'
import type { RunStatus } from '../src/core/run/service'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { closeApp, expect, launchApp, test, zeroXyz } from './app.fixture'

type Dfyom = { dfyom: PreloadApi }

async function bridgeCall<T>(page: Page, name: string, args: object = {}): Promise<T> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  const r = await page.evaluate(([n, a]) => (globalThis as unknown as Dfyom).dfyom.call(n, a), [
    name,
    args,
  ] as const)
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

const rendersDir = process.env['DFYOM_RENDERS_DIR']

async function render(page: Page, name: string): Promise<void> {
  if (rendersDir === undefined) return
  for (const theme of ['light', 'dark'] as const) {
    // runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`
    await page.evaluate((t) => {
      const doc = (
        globalThis as unknown as {
          document: { documentElement: { setAttribute(n: string, v: string): void } }
        }
      ).document
      doc.documentElement.setAttribute('data-theme', t)
    }, theme)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${rendersDir}/${name}-${theme}.png` })
  }
}

/** A block with one pocket for one end mill, a gCode spindle, and the plan (as run-start-at). */
async function pocketPlan(page: Page): Promise<string> {
  const call = <T>(name: string, args: object = {}) => bridgeCall<T>(page, name, args)
  const stock = await call<{ id: string }>('library.stock.add', {
    values: {
      name: 'Block',
      shape: 'block',
      length: '100',
      width: '60',
      thickness: '20',
      material: { name: '6061-T6', class: 'aluminum' },
    },
  })
  await call('library.tool.add', {
    values: {
      name: 'Flat 6',
      type: 'flatEndMill',
      diameter: '6',
      fluteLength: '20',
      overallLength: '50',
      fluteCount: '2',
      toolMaterial: 'carbide',
      presets: [
        {
          name: 'Alu',
          materialClass: 'aluminum',
          spindleSpeed: '18000',
          feedRate: '900',
          plungeRate: '300',
          stepdown: '0.5',
          stepover: '2.4',
        },
      ],
    },
  })
  const machine = await call<{ id: string }>('library.machine.add', {
    values: {
      name: 'Shapeoko',
      controller: 'grbl',
      travel: { x: '800', y: '800', z: '100' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'gcode', maxSpeed: '24000' },
      programUnits: 'mm',
      toolChanger: 'none',
    },
  })
  await call('project.create', { name: 'Recover', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Pocket',
    stockLibraryItemId: stock.id,
  })
  await call('design.pocket.add', {
    partId,
    shape: {
      kind: 'rectangle',
      center: ['50', '30'],
      length: '30',
      width: '20',
      cornerRadius: '4',
    },
    depth: '2',
  })
  await call('project.apply', {})
  const { planId } = await call<{ planId: string }>('plan.create', {
    partId,
    machineLibraryItemId: machine.id,
  })
  return planId
}

test('after a crash: the next launch offers the panel; open the project, connect, home, resume near where it stopped, run to Idle (DF129 RC6)', async ({
  dfyom,
}) => {
  test.setTimeout(300_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const planId = await pocketPlan(page)
  const projectFile = join(dfyom.dataDir, 'Recover.dfyom')

  await page.keyboard.press('ControlOrMeta+3')
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  const machine = page.getByRole('group', { name: 'Machine' })
  const timeScale = async (p: Page, name: string) => {
    const nav = p.getByRole('navigation', { name: 'Navigator' })
    await nav.getByRole('combobox', { name: 'Time scale' }).click()
    await p.getByRole('option', { name }).click()
  }

  // the first launch: connect, home, zero over the stock, save, then run at real time
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await timeScale(page, 'Max')
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(machine.getByText('Virtual machine · Max')).toBeVisible()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  await bridgeCall(page, 'run.machine.jog', { by: [-400, -300, -60], feed: 5000 })
  await expect(
    inspector
      .getByRole('table', { name: 'Position' })
      .getByRole('cell', { name: 'Machine position Z' }),
  ).toHaveText('-61.000', { timeout: 30_000 })
  await expect(machine.getByText('Idle')).toBeVisible()
  await zeroXyz(page)
  await bridgeCall(page, 'project.save', { target: projectFile })
  const full = await bridgeCall<{ program: { lines: string[] } }>(page, 'run.job.check', {
    planId,
    program: true,
  })
  await timeScale(page, '1×')
  await inspector.getByRole('button', { name: 'Start run' }).click()
  const preflight = page.getByRole('dialog', { name: 'Start run?' })
  await preflight.getByRole('button', { name: 'Start run' }).click()
  // a few passes in (past any wait), then the record a serial run would have journaled
  const wait = page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
  await expect
    .poll(
      async () => {
        if (await wait.isVisible()) await wait.getByRole('button', { name: 'Continue' }).click()
        return (await bridgeCall<RunStatus>(page, 'run.status.get')).job?.line ?? 0
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(Math.min(60, full.program.lines.length / 2))
  await expect(wait).toBeHidden()
  const record = (await page.evaluate(() =>
    (globalThis as unknown as Dfyom).dfyom.run.record(),
  )) as RunJournal | null
  expect(record).toMatchObject({
    state: 'running',
    job: { kind: 'plan', project: { path: projectFile } },
    machine: { target: 'virtual' },
  })
  await closeApp(dfyom.app)
  // what a crash leaves: the journal still `running`, the program copy next to it
  await writeFile(join(dfyom.dataDir, 'run-journal.json'), JSON.stringify(record))
  await writeFile(join(dfyom.dataDir, 'run-program.nc'), full.program.lines.join('\n'))

  // the next launch: Run mode, the panel, nothing connected
  const again = await launchApp(dfyom.dataDir)
  try {
    const p = await again.app.firstWindow()
    await p.waitForLoadState('domcontentloaded')
    await p.setViewportSize({ width: 1440, height: 1100 })
    await expect(p.getByRole('radio', { name: 'Run' })).toBeChecked({ timeout: 30_000 })
    const insp = p.getByRole('complementary', { name: 'Inspector' })
    if (!(await insp.isVisible())) await p.getByRole('button', { name: 'Inspector' }).click()
    const panel = insp.getByRole('region', { name: 'The run was interrupted' })
    await expect(panel).toBeVisible()
    await expect(
      panel.getByText(/^DFYOM was closed unexpectedly while the run was streaming/),
    ).toBeVisible()
    const status = await bridgeCall<RunStatus>(p, 'run.status.get')
    expect(status.connection.state).toBe('closed')
    const i = status.lastRun!.interruption!
    expect(i).toMatchObject({ reason: 'appCrashed', launch: { program: true } })
    const suggested = i.suggestion!.line
    expect(suggested).toBeLessThanOrEqual(Math.max(i.executing, i.safest!.line))

    // reopen the project the run came from (unless the session reopened it)
    const open = panel.getByRole('button', { name: 'Open project' })
    if (await open.isVisible()) await open.click()
    await expect(open).toHaveCount(0, { timeout: 30_000 })
    await expect(p).toHaveTitle(/Recover/)
    // the 3D view draws the run's toolpath (generated again: the cache went with the app), the
    // ghost tool where it was last seen, the part before it dimmed and the rest live
    const view = p.getByRole('region', { name: '3D viewport' })
    await expect(view).toHaveAttribute('data-toolpath-segments', /^[1-9]\d*$/, { timeout: 60_000 })
    await expect(view).toHaveAttribute('data-ghost', '')
    const segments = Number(await view.getAttribute('data-toolpath-segments'))
    const done = Number(await view.getAttribute('data-toolpath-done'))
    expect(done).toBeGreaterThan(0)
    expect(done).toBeLessThan(segments)
    await render(p, 'df129-launch')

    // the checklist, then connect (the user's click), home from the panel
    for (const name of [/The bit is intact/, /The stock has not moved/, /Chips are cleared/])
      await panel.getByRole('checkbox', { name }).click()
    await panel.getByRole('button', { name: 'Checked' }).click()
    const mach = p.getByRole('group', { name: 'Machine' })
    await p
      .getByRole('navigation', { name: 'Navigator' })
      .getByRole('radio', { name: 'Virtual machine' })
      .click()
    await timeScale(p, 'Max')
    await panel.getByRole('button', { name: 'Connect to the virtual machine' }).click()
    await expect(mach.getByText('Virtual machine · Max')).toBeVisible({ timeout: 30_000 })
    await panel.getByRole('button', { name: 'Home the machine' }).click()
    await expect(mach.getByText('Idle')).toBeVisible({ timeout: 60_000 })

    // the virtual machine forgot G54: restore the run's, then go on
    await expect(panel.getByText(/^The work zero differs from the run’s/)).toBeVisible()
    await panel.getByRole('button', { name: 'Restore the run’s work zero' }).click()
    const restore = p.getByRole('alertdialog', { name: 'Restore the run’s work zero?' })
    await restore.getByRole('button', { name: 'Restore the run’s work zero' }).click()
    await expect(panel.getByText(/^The controller kept the work zero/)).toBeVisible({
      timeout: 30_000,
    })
    await panel.getByRole('button', { name: 'The work zero is right' }).click()

    // resume near where it stopped: the suggestion, in the original program's lines
    const near = panel.getByRole('button', { name: /Resume near where it stopped/ })
    await expect(near).toContainText('Recommended')
    await expect(near).toContainText(`line ${suggested}`)
    await render(p, 'df129-launch-choose')
    await near.click()
    const pre = p.getByRole('dialog', { name: 'Start run?' })
    const start = pre.getByRole('button', {
      name: `Start at line ${suggested.toLocaleString('en-GB')}`,
    })
    await expect(start).toBeEnabled({ timeout: 30_000 })
    await start.click()
    await expect(panel).toHaveCount(0)
    const waits = () => p.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
    const complete = p.getByText(/^Run complete: [\d,]+ lines in/)
    await expect(waits()).toBeVisible({ timeout: 30_000 })
    await expect(waits().getByText(/^This is the start’s tool wait/)).toBeVisible()
    for (;;) {
      await expect(waits().or(complete)).toBeVisible({ timeout: 120_000 })
      if (await complete.isVisible()) break
      const title = (await waits().getByRole('heading').first().textContent()) ?? ''
      await waits().getByRole('button', { name: 'Continue' }).click()
      await expect(p.getByRole('dialog', { name: title })).toBeHidden()
    }
    await expect(mach.getByText('Idle')).toBeVisible()
    const after = await bridgeCall<RunStatus>(p, 'run.status.get')
    expect(after.lastRun?.interruption).toBeUndefined()
    expect(again.rendererErrors).toEqual([])
  } finally {
    await closeApp(again.app)
  }
})
