// Drag to reorder (D45) in the built app: operation rows move by their dotted grip (real pointer
// events), a drop the move command would refuse turns the indicator red and says why, and Alt+↑/↓
// still moves a row. Windows stay hidden (app.fixture.ts). With DFYOM_RENDERS=1 it also writes
// the light and dark review renders of a refused drag to design/features/renders/.
// Doc: docs/conventions/ui.md#reordering-lists-d45
import { resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './app.fixture'

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
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
    await page.screenshot({ path: `${rendersDir}/d45-${name}-${theme}.png` })
  }
}

test('reorder (D45): drag operation rows by their grip; a refused drop says why', async ({
  dfyom,
}) => {
  test.setTimeout(90_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  const navigator = page.getByRole('navigation', { name: 'Navigator' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Reorder')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '100')
  await setField(setup, 'Width (Y)', '60')
  await setField(setup, 'Thickness (Z)', '20')
  await setup.getByRole('button', { name: 'Create part' }).click()
  await navigator.getByRole('button', { name: 'Add facing' }).click()
  // the pocket's default `on` is the facing's floor: it can't go before the facing
  for (const kind of ['Pocket', 'Profile']) {
    await navigator.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('menuitem', { name: kind }).click()
  }
  const ops = navigator.getByRole('list', { name: 'Operations in design order' })
  const rows = ops.locator(':scope > li')
  await expect(rows).toHaveCount(3)
  const rowOf = (name: RegExp) => rows.filter({ has: page.getByRole('button', { name }) })
  // no move buttons any more
  await expect(ops.getByRole('button', { name: /^Move / })).toHaveCount(0)

  /** Presses a row's grip and moves the pointer to `y` in steps; releases unless `hold`. */
  const drag = async (row: Locator, y: number, hold = false) => {
    await row.hover()
    const box = (await row.locator('[data-reorder-grip]').boundingBox())!
    const x = box.x + box.width / 2
    await page.mouse.move(x, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, y, { steps: 8 })
    if (!hold) await page.mouse.up()
  }
  /** The row's top once it stopped moving (rows animate into place after a drop). */
  const topOf = async (row: Locator) => {
    let last = Number.NaN
    for (;;) {
      const y = (await row.boundingBox())!.y
      if (y === last) return y
      last = y
      await page.waitForTimeout(50)
    }
  }

  // the profile to the top
  await drag(rowOf(/^Profile 1/), (await topOf(rows.first())) + 3)
  await expect(rows.nth(0)).toContainText('Profile 1')
  await expect(rows.nth(1)).toContainText('Facing 1')
  await expect(rows.nth(2)).toContainText('Pocket 1')

  // the pocket over the gap above the facing: the indicator turns red and says why
  await drag(rowOf(/^Pocket 1/), (await topOf(rowOf(/^Facing 1/))) + 3, true)
  const why = 'Not moved: Pocket 1 uses facing1.floor, which has to come before it.'
  await expect(navigator.locator('span', { hasText: why })).toBeVisible()
  await expect(rowOf(/^Facing 1/)).toHaveAttribute('data-drop-refused', '')
  await render(page, 'drag-refused')
  await page.mouse.up()
  await expect(rows.nth(2)).toContainText('Pocket 1')
  await expect(navigator.locator('span', { hasText: why })).toBeVisible()

  // Alt+↓ still moves a row: the profile back below the facing
  await rowOf(/^Profile 1/)
    .getByRole('button', { name: /^Profile 1/ })
    .press('Alt+ArrowDown')
  await expect(rows.nth(1)).toContainText('Profile 1')
  expect(dfyom.rendererErrors).toEqual([])
})
