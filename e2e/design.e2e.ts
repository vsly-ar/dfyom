// The design half of the exit criteria through the UI (task 3.6, part of 3.11's UI flow): create
// a project with a rectangular stock, add facing, pocket (inside corner radius, floor fillet),
// drilling and profile with tabs, see the part evaluate, save, close the app, reopen it and open
// the project again. The native file dialogs are stubbed in the main process; everything else is
// driven by roles and labels. Doc: docs/conventions/testing.md#end-to-end, docs/modes/design.md
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect, launchApp, test } from './app.fixture'

/** The OS dialogs answer `file` (they cannot be driven by Playwright). */
async function stubFileDialogs(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
  }, file)
}

/** Types a value into an inspector field and commits it (Enter = one command). */
async function setField(inspector: Locator, label: string, value: string): Promise<void> {
  // the input only: a parameter group may share its label ("Depth")
  const field = inspector.getByLabel(label, { exact: true }).and(inspector.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  // leave the field: its echo collapses on blur, which would move the next click's target
  await field.blur()
}

async function addFromMenu(page: Page, label: string): Promise<void> {
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  await navigator.getByRole('button', { name: 'Add operation' }).click()
  await page.getByRole('menuitem', { name: label }).click()
}

const operationRows = (page: Page) =>
  page
    .getByRole('list', { name: 'Operations in design order' })
    .getByRole('button', { name: /^(Facing|Pocket|Drilling|Profile) \d/ })

test('design a part through the UI, save, close and reopen it', async ({ dfyom }) => {
  const file = join(dfyom.dataDir, 'Bracket.dfyom')
  const page = await dfyom.app.firstWindow()
  await stubFileDialogs(dfyom.app, file)
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const status = page.getByRole('contentinfo', { name: 'Status bar' })

  // New project
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Bracket')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page).toHaveTitle('Bracket')

  // Rectangular stock: a new block 100 × 60 × 20 mm
  const setup = navigator.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '100')
  await setField(setup, 'Width (Y)', '60')
  await setField(setup, 'Thickness (Z)', '20')
  await setup.getByRole('button', { name: 'Create part' }).click()
  await expect(navigator.getByText(/^Stock: 100 × 60 × 20/)).toBeVisible()

  // Facing
  await navigator.getByRole('button', { name: 'Add facing' }).click()
  await expect(inspector.getByRole('heading', { name: 'Facing 1' })).toBeVisible()
  await setField(inspector, 'Depth', '0.5')

  // Pocket with an inside corner radius and a floor fillet
  await addFromMenu(page, 'Add pocket')
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()
  await setField(inspector, 'Depth', '6')
  await setField(inspector, 'Corner radius', '4')
  await setField(inspector, 'Floor fillet radius', '1')
  await expect(inspector.getByLabel('Floor fillet radius', { exact: true })).toHaveValue('1')

  // Drilling
  await addFromMenu(page, 'Add drilling')
  await expect(inspector.getByRole('heading', { name: 'Drilling 1' })).toBeVisible()
  await setField(inspector, 'Diameter', '5')

  // Profile with tabs
  await addFromMenu(page, 'Add profile')
  await expect(inspector.getByRole('heading', { name: 'Profile 1' })).toBeVisible()
  await setField(inspector, 'Tab count', '4')
  await setField(inspector, 'Tab thickness', '3')

  await expect(operationRows(page)).toHaveCount(4)
  // the part evaluates (geometry worker), and the viewport describes it
  await expect(status.getByText('Part up to date')).toBeAttached({ timeout: 30_000 })
  await expect(page.getByRole('region', { name: '3D viewport' })).toHaveAccessibleDescription(
    /Part with 4 operations/,
  )

  // Save (untitled → the save dialog)
  await page.keyboard.press('ControlOrMeta+s')
  await expect(status.getByText('Saved', { exact: true })).toBeVisible()
  expect(existsSync(file)).toBe(true)
  expect(dfyom.rendererErrors).toEqual([])

  // Close the app, start it again on the same data, open the file
  await dfyom.app.close()
  const second = await launchApp(dfyom.dataDir)
  try {
    const page2 = await second.app.firstWindow()
    await stubFileDialogs(second.app, file)
    await page2
      .getByRole('navigation', { name: 'Navigator' })
      .getByRole('button', { name: 'Open project' })
      .click()
    await expect(page2).toHaveTitle('Bracket')
    await expect(operationRows(page2)).toHaveText([
      /^Facing 1/,
      /^Pocket 1/,
      /^Drilling 1/,
      /^Profile 1/,
    ])
    await operationRows(page2).nth(1).click()
    const inspector2 = page2.getByRole('complementary', { name: 'Inspector' })
    await expect(inspector2.getByLabel('Corner radius', { exact: true })).toHaveValue('4')
    await expect(
      page2.getByRole('contentinfo', { name: 'Status bar' }).getByText('Part up to date'),
    ).toBeAttached({ timeout: 30_000 })
    expect(second.rendererErrors).toEqual([])
  } finally {
    await second.app.close()
  }
})
