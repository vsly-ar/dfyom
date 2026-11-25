// The Stock dialog on one screen in the built app (dogfood DF11–DF13, DF15), hidden like every
// window: a new project's part is named after it, "Save to library" adds the block (nothing is
// added by Create part alone), a changed library stock saves as a variant, the Library window
// lists the variant under its parent, and the sidebar's part row sits above Operations. With
// DFYOM_RENDERS=1 it writes the light and dark review renders to design/features/renders/.
// Docs: docs/conventions/ui.md#stock-dialog-df11df13, docs/conventions/ui-library-window.md#stock-variants-df13
import { resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { closeDialog, expect, openPartSetup, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

/** Sets the theme through Settings (no modal dialog may be open). */
async function theme(page: Page, name: 'light' | 'dark'): Promise<void> {
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.getByRole('button', { name: 'Settings' }).click()
  await settings.getByRole('radio', { name: name === 'light' ? 'Light' : 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', name)
  await settings.getByRole('button', { name: 'Done' }).click()
  await expect(settings).toBeHidden()
}

async function choose(page: Page, scope: Locator, label: string, option: string): Promise<void> {
  await scope.getByRole('combobox', { name: label }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
  await expect(scope.getByRole('combobox', { name: label })).toContainText(option)
}

test('stock dialog: library stock, save as variant, own block, part row above Operations', async ({
  dfyom,
}) => {
  test.setTimeout(180_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  const navigator = page.getByRole('navigation', { name: 'Navigator' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const created = page.getByRole('dialog', { name: 'New project' })
  await created.getByRole('textbox', { name: 'Project name' }).fill('Bracket')
  await created.getByRole('button', { name: 'Create project' }).click()
  let stock = page.getByRole('dialog', { name: 'Stock' })
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await expect(stock).toBeVisible()
  // DF12: the part is named after the project; DF13: no library stock chosen
  await expect(setup.getByRole('textbox', { name: 'Part name' })).toHaveValue('Bracket 1')
  await expect(setup.getByRole('combobox', { name: 'From library' })).toContainText('Not selected')

  // Save to library adds the block and chooses it; its material is locked then
  await setup.getByRole('button', { name: 'Save to library' }).click()
  const from = setup.getByRole('combobox', { name: 'From library' })
  await expect(from).toContainText('Aluminium 6061-T6 100 × 60 × 20')
  await expect(setup.getByRole('textbox', { name: 'Material name' })).toHaveAttribute('readonly')
  await expect(setup.getByRole('button', { name: 'Save to library' })).toBeDisabled()

  // a cut piece of it, saved as a variant
  await setField(setup, 'Length (X)', '50')
  await setup.getByRole('button', { name: 'Save to library' }).click()
  const ask = page.getByRole('dialog', { name: 'Save to library' })
  await ask.getByRole('button', { name: 'Save as variant' }).click()
  await expect(ask).toBeHidden()
  await expect(from).toContainText('Aluminium 6061-T6 100 × 60 × 20 · 50 × 60 × 20')

  if (RENDERS) {
    for (const t of ['light', 'dark'] as const) {
      await closeDialog(stock, 'Cancel')
      await theme(page, t)
      stock = await openPartSetup(page, 'Stock')
      await choose(page, setup, 'From library', 'Aluminium 6061-T6 100 × 60 × 20')
      await setField(setup, 'Length (X)', '80')
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${rendersDir}/df13-stock-${t}.png` })
      await setup.getByRole('button', { name: 'Save to library' }).click()
      await expect(ask).toBeVisible()
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${rendersDir}/df13-save-${t}.png` })
      await closeDialog(ask, 'Cancel')
    }
    await closeDialog(stock, 'Cancel')
    await theme(page, 'light')
  }

  // the variant unchanged: Create part links the part's copy to it
  stock = await openPartSetup(page, 'Stock')
  await choose(page, setup, 'From library', 'Aluminium 6061-T6 100 × 60 × 20 · 50 × 60 × 20')
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()
  await expect(stock).toBeHidden()

  // DF15: the part row heads the sidebar, above the Operations header
  const partRow = navigator.getByRole('region', { name: 'Part' })
  await expect(partRow).toContainText('Bracket 1')
  await expect(partRow).toContainText('Stock: 50 × 60 × 20')
  const rowBox = await partRow.boundingBox()
  const opsBox = await navigator
    .getByRole('heading', { name: /^Operations/ })
    .first()
    .boundingBox()
  expect(rowBox && opsBox && rowBox.y < opsBox.y).toBe(true)
  if (RENDERS)
    for (const t of ['light', 'dark'] as const) {
      await theme(page, t)
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${rendersDir}/df15-sidebar-${t}.png` })
    }

  // DF95: the Stock dialog of the part changes its stock (one undo step)
  stock = await openPartSetup(page, 'Stock')
  const change = page.getByRole('region', { name: 'Change the stock' })
  await expect(change.getByRole('combobox', { name: 'Length (X)' })).toHaveValue('50')
  await setField(change, 'Length (X)', '80')
  if (RENDERS)
    for (const t of ['light', 'dark'] as const) {
      await closeDialog(stock, 'Cancel')
      await theme(page, t)
      stock = await openPartSetup(page, 'Stock')
      await setField(change, 'Length (X)', '80')
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${rendersDir}/df95-stock-change-${t}.png` })
    }
  await stock.getByRole('button', { name: 'Update stock' }).click()
  await expect(stock).toBeHidden()
  await expect(partRow).toContainText('Stock: 80 × 60 × 20')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(partRow).toContainText('Stock: 50 × 60 × 20')

  // the Library window lists the variant under its parent
  const opened = dfyom.app.waitForEvent('window')
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  const lib = await opened
  await lib.waitForLoadState('domcontentloaded')
  if (RENDERS) await lib.setViewportSize({ width: 1100, height: 760 })
  await lib.getByRole('tab', { name: 'Stock' }).click()
  const grid = lib.getByRole('grid', { name: 'Stock' })
  const variant = grid.getByRole('row', {
    name: 'Aluminium 6061-T6 100 × 60 × 20 · 50 × 60 × 20, variant of Aluminium 6061-T6 100 × 60 × 20',
  })
  await variant.click()
  const editor = lib.getByRole('region', { name: 'Item editor' })
  await expect(
    editor.getByRole('button', { name: 'Variant of Aluminium 6061-T6 100 × 60 × 20' }),
  ).toBeVisible()
  if (RENDERS)
    for (const t of ['light', 'dark'] as const) {
      await theme(page, t)
      await expect(lib.locator('html')).toHaveAttribute('data-theme', t)
      await lib.waitForTimeout(400)
      await lib.screenshot({ path: `${rendersDir}/df13-library-variants-${t}.png` })
    }
  expect(dfyom.rendererErrors).toEqual([])
})
