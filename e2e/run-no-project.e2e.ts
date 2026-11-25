// Run mode without a project in the real app (hardening DF80): the app starts with no project,
// the start panel's "Go to Run" opens Run, a library machine is chosen, the virtual machine
// connects, homes, jogs and disconnects; no project is ever created, and a plan run says it needs
// one. Windows stay hidden (fixture). With DFYOM_RENDERS=1: df80-start-panel, df80-run-no-project and
// df80-run-no-project-connected (light and dark).
// Docs: docs/modes/run.md#run-without-a-project-df80, docs/conventions/testing.md#end-to-end
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

async function call(page: Page, name: string, args: object = {}): Promise<CallReply> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  return page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
}

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

/** With DFYOM_RENDERS=1: `name`-light.png and -dark.png (the theme set as Settings does). */
async function render(page: Page, name: string): Promise<void> {
  if (!RENDERS) return
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => {
      ;(
        globalThis as unknown as {
          document: { documentElement: { dataset: Record<string, string> } }
        }
      ).document.documentElement.dataset['theme'] = t
    }, theme)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${rendersDir}/${name}-${theme}.png` })
  }
}

test('Run without a project: start panel → Run → connect the emulator → home → jog → disconnect (DF80)', async ({
  dfyom,
}) => {
  test.setTimeout(90_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  // a machine profile in the library (app scope: no project needed)
  const added = await call(page, 'library.machine.add', {
    values: {
      name: 'Router',
      controller: 'grbl',
      travel: { x: '800', y: '600', z: '100' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'manual', maxSpeed: '24000' },
      programUnits: 'mm',
      toolChanger: 'none',
      homingCorner: 'backRight',
      pullOff: '1',
      softLimits: true,
      probePlateThickness: '10',
    },
  })
  expect(added.ok, JSON.stringify(added)).toBe(true)

  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const machine = page.getByRole('group', { name: 'Machine' })
  const cell = (name: string) =>
    inspector.getByRole('table', { name: 'Position' }).getByRole('cell', { name })

  // the start screen: no project, and the way to the machine
  await expect(navigator.getByRole('heading', { name: 'No project open' })).toBeVisible()
  await render(page, 'df80-start-panel')
  await navigator.getByRole('button', { name: 'Go to Run' }).click()
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  await expect(navigator.getByRole('combobox', { name: 'Plan' })).toHaveCount(0)
  await expect(navigator.getByRole('combobox', { name: 'Machine' })).toHaveText('Router')
  await expect(
    inspector.getByRole('heading', { name: 'Open a project to run a plan' }),
  ).toBeVisible()
  // a serial port is the default connection (DF101): choose the virtual machine
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: 'Max' }).click()
  await render(page, 'df80-run-no-project')

  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(machine.getByText('Virtual machine · Max')).toBeVisible()
  await expect(machine.getByText('Needs homing')).toBeVisible()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  for (const axis of ['X', 'Y', 'Z'])
    await expect(cell(`Machine position ${axis}`)).toHaveText('-1.000')

  await navigator.getByRole('radio', { name: '10 mm' }).click()
  await navigator.getByRole('button', { name: 'Jog X−' }).click()
  await expect(cell('Machine position X')).toHaveText('-11.000')
  await expect(machine.getByText('Idle')).toBeVisible()
  // the touch plate from the machine profile
  await expect(navigator.getByRole('button', { name: 'Probe Z' })).toBeEnabled()
  await render(page, 'df80-run-no-project-connected')

  // only a plan run needs a project
  const run = await call(page, 'run.job.start', { planId: 'plan1' })
  expect(run.ok).toBe(false)
  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  await expect(machine).toHaveCount(0)
  await expect(navigator.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
  // still no project
  const projects = await call(page, 'project.list')
  expect(projects).toMatchObject({ ok: true, value: { projects: [] } })
  expect(dfyom.rendererErrors).toEqual([])
})
