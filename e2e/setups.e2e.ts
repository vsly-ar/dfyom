// The setup panel in the real app (v0.2 task F6): a part machined from the top and the bottom is
// built and planned through the bridge (keeps this test on the panel; the whole flow through the
// UI is golden-path-v0.2.e2e.ts); then, through plan mode's UI only: the setups in machining order
// with their direction, WCS corner and rotation and their nested operations, reorder with Alt+↑/↓
// and by the setup's drag grip (hardening U3; with DFYOM_RENDERS=1 light and dark review renders of
// the held drag go to design/features/renders/hu3-plan-drag-*.png),
// the setup inspector's rotation, toolpath generation and one gCode program per setup exported
// from the panel. Windows stay hidden (fixture). Selectors are roles and accessible names.
// Docs: docs/conventions/ui.md#design-and-plan-controls-v02, docs/conventions/testing.md#end-to-end
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
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

/** Light and dark renders without touching the page (a drag is held meanwhile). */
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

/** The export dialog answers the suggested file name in `dir`. */
async function stubExportDialog(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, folder) => {
    dialog.showSaveDialog = ((...args: unknown[]) => {
      const options = args.at(-1) as { defaultPath?: string }
      const name = (options.defaultPath ?? 'out.nc').split(/[\\/]/).at(-1)!
      return Promise.resolve({ canceled: false, filePath: `${folder}/${name}` })
    }) as typeof dialog.showSaveDialog
  }, dir)
}

/** Library items, a project with a top facing and pocket and a bottom facing, and its plan. */
async function bottomAndTopPlan(page: Page): Promise<void> {
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
      fluteLength: '25',
      overallLength: '60',
      fluteCount: '2',
      toolMaterial: 'carbide',
      presets: [
        {
          name: 'Alu finish',
          materialClass: 'aluminum',
          spindleSpeed: '18000',
          feedRate: '800',
          plungeRate: '200',
          stepdown: '1',
          stepover: '3',
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
      spindle: { control: 'manual', maxSpeed: '30000' },
      programUnits: 'mm',
      toolChanger: 'none',
    },
  })
  await call('project.create', { name: 'Two sides', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Two sides',
    stockLibraryItemId: stock.id,
  })
  await call('design.facing.add', { partId, depth: '0.5' })
  await call('design.pocket.add', {
    partId,
    shape: { kind: 'rectangle', center: ['50', '30'], length: '40', width: '25' },
    depth: '4',
  })
  await call('design.facing.add', { partId, on: 'stock.bottom', depth: '0.5' })
  await call('plan.create', { partId, machineLibraryItemId: machine.id })
}

test('setup panel: setups in machining order, reorder, rotation and one program per setup', async ({
  dfyom,
}) => {
  test.setTimeout(90_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  await stubExportDialog(dfyom.app, dfyom.dataDir)
  await bottomAndTopPlan(page)

  await page.getByRole('radio', { name: 'Plan' }).click()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const setups = navigator.getByRole('list', { name: 'Setups in machining order' })
  const setupRow = (name: RegExp) => setups.getByRole('button', { name })
  /** Clicks a row at its start: with keyboard focus its move and menu buttons overlay its end. */
  const pick = (name: RegExp) => setupRow(name).click({ position: { x: 24, y: 12 } })
  await expect(setupRow(/^1\. Bottom/)).toContainText('G54 back left · 0°')
  await expect(setupRow(/^2\. Top/)).toContainText('G54 front left · 0°')
  await expect(
    navigator
      .getByRole('list', { name: 'Plan operations of Top in machining order' })
      .getByRole('button', { name: /^Pocket 1/ }),
  ).toBeVisible()

  // reorder from the keyboard, and back
  await setupRow(/^1\. Bottom/).focus()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(setupRow(/^1\. Top/)).toBeVisible()
  await expect(setupRow(/^2\. Bottom/)).toBeFocused()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(setupRow(/^1\. Bottom/)).toBeFocused()

  // reorder by the setup's grip in its start gutter (U3): Bottom below Top, then back by keys
  const items = setups.locator(':scope > li')
  await items.first().hover()
  const grip = (await items.first().locator('[data-reorder-grip]').first().boundingBox())!
  const below = (await items.nth(1).boundingBox())!
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2, below.y + below.height - 4, { steps: 8 })
  await expect(items.nth(1)).toHaveAttribute('data-drop', 'after')
  await render(page, 'hu3-plan-drag')
  await page.mouse.up()
  await expect(setupRow(/^1\. Top/)).toBeVisible()
  await expect(navigator.getByText('Moved Bottom to position 2 of 2.')).toBeAttached()
  await setupRow(/^2\. Bottom/).focus()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(setupRow(/^1\. Bottom/)).toBeFocused()

  // the setup inspector: turn the bottom setup a quarter; the row shows it
  await pick(/^1\. Bottom/)
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  await expect(inspector.getByText('Bottom face up to the spindle')).toBeVisible()
  await inspector.getByRole('radio', { name: '90°' }).click()
  await expect(setupRow(/^1\. Bottom/)).toContainText('· 90°')

  // generate, then export the selected setup, then the other one
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 30_000 })
  const done = page.getByRole('dialog', { name: 'gCode exported' })
  for (const [i, name] of [
    [1, 'Bottom'],
    [2, 'Top'],
  ] as const) {
    await pick(new RegExp(`^${i}\\. ${name}`))
    await navigator.getByRole('button', { name: `Export ${name} gCode…` }).click()
    await expect(done.getByText(`Setup ${name} (${i} of 2)`)).toBeVisible({ timeout: 30_000 })
    await done.getByRole('button', { name: 'Close' }).click()
    await expect(done).toBeHidden()
    const file = `${dfyom.dataDir}/two-sides-s${i}.nc`
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain(`(Setup ${i} of 2: ${name})`)
  }

  // DF67: a feed rate past the machine's limit: the row's count stays put while the row is
  // hovered (no action button; the row menu is its context menu), and a click on it shows the
  // operation's findings first in its inspector
  const pocketRow = navigator.getByRole('button', { name: /^Pocket 1/ })
  await pocketRow.click({ position: { x: 24, y: 12 } })
  const feed = inspector.getByLabel('Feed rate', { exact: true })
  await feed.fill('9000')
  await feed.press('Enter')
  const count = pocketRow.locator('[title*="click to show them in the inspector"]').first()
  await expect(count).toBeVisible()
  await pocketRow.click({ position: { x: 24, y: 12 } }) // deselect
  const before = (await count.boundingBox())!
  await pocketRow.hover()
  expect(await count.boundingBox()).toEqual(before)
  await count.click()
  const checks = inspector.getByRole('region', { name: 'Checks' })
  await expect(checks).toBeFocused()
  await expect(pocketRow).toHaveAttribute('aria-pressed', 'true')
  await render(page, 'df67-findings')
  // right-click opens the row's menu
  await pocketRow.click({ button: 'right' })
  await expect(page.getByRole('menu', { name: /^Actions for Pocket 1/ })).toBeVisible()
  await render(page, 'df67-row-menu')
  await page.keyboard.press('Escape')
  expect(dfyom.rendererErrors).toEqual([])
})

// DF78 (alignment phase 1): the top setup's work zero moved left of the stock (negative X is
// valid), a stock corner added as an alignment point from the inspector's menu, its marker in the
// viewport, and the exported program's header naming both. With DFYOM_RENDERS=1 light and dark
// renders go to design/features/renders/df78-alignment-*.png.
// Doc: docs/modes/alignment.md#setup-work-zero-q61, docs/conventions/ui.md#design-and-plan-controls-v02
test('setup work zero and alignment points: inspector, viewport marker, program header', async ({
  dfyom,
}) => {
  test.setTimeout(90_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  await stubExportDialog(dfyom.app, dfyom.dataDir)
  await bottomAndTopPlan(page)

  await page.getByRole('radio', { name: 'Plan' }).click()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const setups = navigator.getByRole('list', { name: 'Setups in machining order' })
  const top = setups.getByRole('button', { name: /^2\. Top/ })
  await top.click({ position: { x: 24, y: 12 } })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  await expect(inspector.getByRole('heading', { name: 'Work zero' })).toBeVisible()

  // X −20: left of the stock
  const x = inspector.getByLabel('Work zero X', { exact: true })
  await x.fill('-20')
  await x.press('Enter')
  await expect(top).toContainText('G54 X -20 mm Y 0 mm')

  // the top's back-right corner from the menu: WCS X 120 Y 60
  await inspector.getByRole('button', { name: 'Add an alignment point' }).click()
  const menu = page.getByRole('menu', { name: 'Add an alignment point' })
  await menu.getByRole('menuitem', { name: /Top back-right corner/ }).click()
  const list = inspector.getByRole('list', {
    name: 'Alignment points in the order the spindle visits them',
  })
  await expect(list.getByLabel('Point 1 name', { exact: true })).toHaveValue(
    'Top back-right corner',
  )
  await expect(list.getByText(/X 120 mm\s+Y 60 mm/)).toBeVisible()
  await expect(page.locator('[data-align-point]')).toHaveCount(1)
  await list.getByLabel('Point 1 name', { exact: true }).hover()
  await render(page, 'df78-alignment')

  // the program names the zero and the point
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 30_000 })
  await top.click({ position: { x: 24, y: 12 } })
  await navigator.getByRole('button', { name: 'Export Top gCode…' }).click()
  const done = page.getByRole('dialog', { name: 'gCode exported' })
  await expect(done.getByText('Setup Top (2 of 2)')).toBeVisible({ timeout: 30_000 })
  await done.getByRole('button', { name: 'Close' }).click()
  const program = readFileSync(`${dfyom.dataDir}/two-sides-s2.nc`, 'utf8')
  expect(program).toContain('(Work zero G54 X0 Y0: X -20 Y 0 mm from that corner)')
  expect(program).toContain('(Align 1: Top back-right corner at X 120 Y 60)')
  expect(dfyom.rendererErrors).toEqual([])
})
