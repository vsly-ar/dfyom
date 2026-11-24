// The setup inspector's "Tool changes" in the real app (hardening DF66, with DF65): a part with a
// bottom facing and two top pockets for two end mills is built and planned through the bridge;
// then, through plan mode's UI only: the top setup starts with the end mill the bottom ended with
// (DF65), its tool runs list in the inspector with their times once toolpaths exist, and a run
// moves as a block with Alt+↓ and back by its drag grip. With DFYOM_RENDERS=1 light and dark
// review renders of the list and of the held drag go to design/features/renders/df66-tool-changes{,-drag}-*.png.
// DF69: with a top facing the later run's "Z from" names the faced floor; its menu chooses the
// surface (renders df69-z-from{,-menu}-*.png); with the run's operation selected the operation
// inspector shows "Z from" and the spot, and the spot drags in the viewport (renders
// df69-z-inspector-*.png, df69-z-spot-*.png mid-drag).
// Windows stay hidden (fixture). Selectors are roles and accessible names.
// Docs: docs/conventions/ui.md#design-and-plan-controls-v02, docs/modes/plan-v0.4.md#tool-changes-per-setup-hardening-df66,
// docs/modes/z-reference.md#ui
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
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

const endMill = (name: string, diameter: string, stepover: string) => ({
  values: {
    name,
    type: 'flatEndMill',
    diameter,
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
        stepover,
      },
    ],
  },
})

/** A bottom facing, a narrow top pocket (Flat 3) and a wide one (Flat 6), and the plan. */
async function twoToolPlan(page: Page, opts: { topFacing?: boolean } = {}): Promise<void> {
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
  await call('library.tool.add', endMill('Flat 6', '6', '2.4'))
  await call('library.tool.add', endMill('Flat 3', '3', '1.2'))
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
  await call('project.create', { name: 'Two tools', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Two tools',
    stockLibraryItemId: stock.id,
  })
  // the narrow pocket first: by design order alone the top would start with Flat 3
  await call('design.pocket.add', {
    partId,
    shape: { kind: 'rectangle', center: ['20', '30'], length: '12', width: '5', cornerRadius: '2' },
    depth: '1',
  })
  await call('design.pocket.add', {
    partId,
    shape: {
      kind: 'rectangle',
      center: ['65', '30'],
      length: '30',
      width: '20',
      cornerRadius: '4',
    },
    depth: '1',
  })
  await call('design.facing.add', { partId, on: 'stock.bottom', depth: '0.5' })
  if (opts.topFacing === true)
    await call('design.facing.add', { partId, on: 'stock.top', depth: '0.5' })
  await call('project.apply', {})
  await call('plan.create', { partId, machineLibraryItemId: machine.id })
}

test('setup inspector: tool changes listed, a run reordered as a block (DF66, DF65)', async ({
  dfyom,
}) => {
  test.setTimeout(90_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  await twoToolPlan(page)

  await page.getByRole('radio', { name: 'Plan' }).click()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const setups = navigator.getByRole('list', { name: 'Setups in machining order' })
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 30_000 })
  await setups.getByRole('button', { name: /^2\. Top/ }).click({ position: { x: 24, y: 12 } })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()

  const list = inspector.getByRole('list', { name: 'Tool runs of Top in machining order' })
  const runs = list.locator(':scope > li')
  const title = inspector.getByRole('heading', { name: /^Tool changes/ })
  // DF65: Flat 6 stays in the spindle from Bottom, so the top starts with it
  await expect(runs).toHaveCount(2)
  await expect(runs.nth(0)).toContainText('Flat 6')
  await expect(runs.nth(0)).toContainText('Stays in the spindle from Bottom')
  await expect(runs.nth(1)).toContainText('Flat 3')
  await expect(title).toContainText('1 tool change')
  await expect(runs.nth(0)).toContainText(/\d+ (min|s)/)
  await render(page, 'df66-tool-changes')

  // Alt+↓: the Flat 6 run after Flat 3; now both tools are changes
  await runs.nth(0).focus()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(runs.nth(0)).toContainText('Flat 3')
  await expect(runs.nth(1)).toBeFocused()
  await expect(title).toContainText('2 tool changes')
  await expect(inspector.getByText('Moved Flat 6 to position 2 of 2.')).toBeAttached()

  // back by the grip (held for the renders)
  await runs.nth(1).hover()
  const grip = (await runs.nth(1).locator('[data-reorder-grip]').boundingBox())!
  const first = (await runs.nth(0).boundingBox())!
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2, first.y + 4, { steps: 8 })
  await expect(runs.nth(0)).toHaveAttribute('data-drop', 'before')
  await render(page, 'df66-tool-changes-drag')
  await page.mouse.up()
  await expect(runs.nth(0)).toContainText('Flat 6')
  await expect(title).toContainText('1 tool change')
  expect(dfyom.rendererErrors).toEqual([])
})

test('setup inspector: a later run touches off on the faced floor, chosen in its menu (DF69)', async ({
  dfyom,
}) => {
  test.setTimeout(90_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  await twoToolPlan(page, { topFacing: true })

  await page.getByRole('radio', { name: 'Plan' }).click()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const setups = navigator.getByRole('list', { name: 'Setups in machining order' })
  await setups.getByRole('button', { name: /^2\. Top/ }).click({ position: { x: 24, y: 12 } })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()

  const list = inspector.getByRole('list', { name: 'Tool runs of Top in machining order' })
  const runs = list.locator(':scope > li')
  await expect(runs).toHaveCount(2)
  // the facing (Flat 6) touches off on the top face, Flat 3 on the faced floor by default
  await expect(runs.nth(0)).toContainText('Z fromTop face · 0 mm')
  const zFrom = runs.nth(1).getByRole('button', { name: /^Z from for Flat 3: Facing 2 floor/ })
  await expect(zFrom).toHaveAccessibleName(/\(default\)/)
  await render(page, 'df69-z-from')

  await zFrom.click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: /^Default/ })).toBeVisible()
  await render(page, 'df69-z-from-menu')
  await menu.getByRole('menuitem', { name: /^Facing 2 floor/ }).click()
  await expect(
    runs.nth(1).getByRole('button', { name: /^Z from for Flat 3: Facing 2 floor/ }),
  ).not.toHaveAccessibleName(/\(default\)/)
  expect(dfyom.rendererErrors).toEqual([])
})

test('plan viewport: the run touches off on the faced floor; its spot drags, the inspector follows (DF69)', async ({
  dfyom,
}) => {
  test.setTimeout(90_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  await twoToolPlan(page, { topFacing: true })

  await page.getByRole('radio', { name: 'Plan' }).click()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  // Pocket 1 is the Flat 3 run's first operation
  await navigator
    .getByRole('list', { name: 'Plan operations of Top in machining order' })
    .getByRole('button', { name: /^Pocket 1/ })
    .click()
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  await expect(
    inspector.getByRole('button', { name: /^Z from for Flat 3: Facing 2 floor .*\(default\)/ }),
  ).toBeVisible()
  const x = inspector.getByLabel('Touch-off X', { exact: true })
  const y = inspector.getByLabel('Touch-off Y', { exact: true })
  await expect(x).toHaveValue(/ mm$/)
  const before = [await x.inputValue(), await y.inputValue()]
  await render(page, 'df69-z-inspector')

  // the spot in the viewport: hover shows its coordinates, a drag moves it on the faced floor
  const spot = page.locator('[data-zref-spot]')
  await expect(spot).toBeAttached()
  const at = (await spot.boundingBox())!
  await page.mouse.move(at.x, at.y)
  await expect(spot).toContainText(`X ${before[0]}`)
  await page.mouse.down()
  await page.mouse.move(at.x + 30, at.y + 12, { steps: 8 })
  await expect(spot).not.toContainText(`X ${before[0]}  Y ${before[1]}`)
  await render(page, 'df69-z-spot')
  await page.mouse.up()
  await expect(inspector.getByText('Moved by you.')).toBeVisible()
  await expect.poll(async () => [await x.inputValue(), await y.inputValue()]).not.toEqual(before)
  // the default spot back, from the inspector
  await inspector.getByRole('button', { name: 'Use default spot' }).click()
  await expect.poll(async () => [await x.inputValue(), await y.inputValue()]).toEqual(before)
  expect(dfyom.rendererErrors).toEqual([])
})
