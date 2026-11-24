// Run mode's gCode panel in the real app (hardening DF84): a one-tool pocket planned through the
// bridge runs on the virtual machine; the panel under the 3D view opens, shows the streamed
// program, highlights the executing line as it advances and scrolls to follow it; the user's
// wheel turns Follow off, the Follow button brings it back; the panel collapses again.
// With DFYOM_RENDERS=1 light and dark renders go to design/features/renders/df84-gcode-panel-*.png.
// Windows stay hidden (fixture). Selectors are roles and accessible names.
// Docs: docs/modes/run.md#gcode-panel-df84, docs/conventions/ui.md#run-mode-safety-ui
import { resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

async function bridgeCall<T>(page: Page, name: string, args: object = {}): Promise<T> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

async function render(page: Page, name: string): Promise<void> {
  if (!RENDERS) return
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
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${rendersDir}/${name}-${theme}.png` })
  }
}

/** A block with one pocket for one end mill, on a machine with a gCode spindle, and the plan. */
async function pocketPlan(page: Page): Promise<void> {
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
          feedRate: '600',
          plungeRate: '150',
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
  await call('project.create', { name: 'gCode panel', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Pocket',
    stockLibraryItemId: stock.id,
  })
  await call('design.pocket.add', {
    partId,
    shape: {
      kind: 'rectangle',
      center: ['50', '30'],
      length: '60',
      width: '36',
      cornerRadius: '5',
    },
    depth: '2',
  })
  await call('project.apply', {})
  await call('plan.create', { partId, machineLibraryItemId: machine.id })
}

/** The line number of the list's executing row. */
async function executingLine(list: Locator): Promise<number> {
  const row = list.locator('[aria-current="step"]')
  if ((await row.count()) === 0) return 0
  return Number(await row.locator('span').first().textContent())
}

test('run: the gCode panel follows the executing line and stops following on a scroll (DF84)', async ({
  dfyom,
}) => {
  test.setTimeout(180_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  await pocketPlan(page)

  await page.keyboard.press('ControlOrMeta+3')
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  const machine = page.getByRole('group', { name: 'Machine' })

  // closed in a new window; open before a run, it says where the program will show
  const panel = page.getByRole('region', { name: 'gCode' })
  const disclosure = panel.getByRole('button', { name: 'gCode' })
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  await disclosure.click()
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  await expect(panel.getByText('The program shows here once a run starts.')).toBeVisible()
  // the 3D view ends above the panel
  const view = await page.getByRole('region', { name: '3D viewport' }).boundingBox()
  const box = await panel.boundingBox()
  expect(view!.y + view!.height).toBeLessThanOrEqual(box!.y + 1)

  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: '10×' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(machine.getByText('Virtual machine · 10×')).toBeVisible()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  await navigator.getByRole('radio', { name: '100 mm' }).click()
  for (const name of ['Jog X−', 'Jog Y−'])
    for (let i = 0; i < 4; i++) {
      await navigator.getByRole('button', { name }).click()
      await expect(machine.getByText('Idle')).toBeVisible()
    }
  await navigator.getByRole('radio', { name: '10 mm' }).click()
  for (let i = 0; i < 5; i++) {
    await navigator.getByRole('button', { name: 'Jog Z−' }).click()
    await expect(machine.getByText('Idle')).toBeVisible()
  }
  await navigator.getByRole('button', { name: 'Zero X Y Z' }).click()

  await inspector.getByRole('button', { name: 'Start run' }).click()
  await page
    .getByRole('dialog', { name: 'Start run?' })
    .getByRole('button', { name: 'Start run' })
    .click()
  const waits = () => page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
  const list = panel.getByRole('list', { name: 'Program lines' })
  const follow = panel.getByRole('button', { name: 'Follow' })
  await expect(list).toBeVisible({ timeout: 30_000 })
  await expect(follow).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.getByText(/^Line [\d,]+ \/ [\d,]+$/)).toBeVisible()

  // past the start's waits, while the pocket's lines stream
  const scrolled = () => list.evaluate((e) => (e as unknown as { scrollTop: number }).scrollTop)
  let first = 0
  await expect
    .poll(
      async () => {
        if (await waits().isVisible())
          await waits().getByRole('button', { name: 'Continue' }).click()
        first = await executingLine(list)
        return first
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(30)
  // the highlighted line advances and the list follows it: it stays in view, scrolled down
  await expect.poll(() => executingLine(list), { timeout: 30_000 }).toBeGreaterThan(first + 20)
  await expect.poll(scrolled).toBeGreaterThan(0)
  const current = list.locator('[aria-current="step"]')
  await expect(current).toBeInViewport()
  const listBox = (await list.boundingBox())!
  const rowBox = (await current.boundingBox())!
  expect(rowBox.y).toBeGreaterThanOrEqual(listBox.y)
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1)
  await render(page, 'df84-gcode-panel')

  // the user's wheel turns Follow off: the list no longer moves with the run
  await list.hover()
  await page.mouse.wheel(0, -400)
  await expect(follow).toHaveAttribute('aria-pressed', 'false')
  const held = await scrolled()
  await expect.poll(() => executingLine(list).catch(() => 0)).not.toBe(first)
  expect(await scrolled()).toBe(held)
  await follow.click()
  await expect(follow).toHaveAttribute('aria-pressed', 'true')
  await expect(list.locator('[aria-current="step"]')).toBeInViewport()

  const complete = page.getByText(/^Run complete: \d+ lines in/)
  for (;;) {
    await expect(waits().or(complete)).toBeVisible({ timeout: 120_000 })
    if (await complete.isVisible()) break
    const title = (await waits().getByRole('heading').first().textContent()) ?? ''
    await waits().getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('dialog', { name: title })).toBeHidden()
  }
  // the program stays readable after the run; every line has run
  await expect(panel.getByText(/^[\d,]+ lines$/)).toBeVisible()
  await expect(list.locator('[aria-current="step"]')).toHaveCount(0)
  await disclosure.click()
  await expect(list).toHaveCount(0)
  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  expect(dfyom.rendererErrors).toEqual([])
})
