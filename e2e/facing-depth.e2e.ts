// The facing depth down to the reference model (DF4) in the built app: the enclosure STL is placed
// 0.5 mm under the stock top, Add facing takes 0.5 mm as its depth, and after another depth the
// Depth field's adjust panel (opened by focusing the field, DF9) offers "Use 0.5 mm" again. Windows stay hidden (app.fixture.ts). With
// DFYOM_RENDERS=1 it writes the light and dark review renders df4-facing-depth-{light,dark}.png.
// Docs: docs/modes/reference-model.md#facing-depth-from-the-reference-df4
import { join, resolve } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect, openReferencePanel, test } from './app.fixture'

const STL = resolve('src/core/design/__fixtures__/enclosure-wood-base.stl')
const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

/** "Import reference" answers the STL fixture (a copy of the user's file), anything else the project. */
async function stubFileDialogs(app: ElectronApplication, project: string): Promise<void> {
  await app.evaluate(
    ({ dialog }, f) => {
      const title = (args: unknown[]) => (args.at(-1) as { title?: string } | undefined)?.title
      dialog.showOpenDialog = ((...args: unknown[]) =>
        Promise.resolve({
          canceled: false,
          filePaths: [title(args) === 'Import reference' ? f.stl : f.project],
        })) as typeof dialog.showOpenDialog
    },
    { stl: STL, project },
  )
}

const input = (scope: Locator, label: string) =>
  scope.getByLabel(label, { exact: true }).and(scope.locator('input'))

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = input(scope, label)
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

/** With DFYOM_RENDERS=1: light and dark; `before` reopens what the Settings dialog closed. */
async function render(page: Page, name: string, before: () => Promise<void>): Promise<void> {
  if (!RENDERS) return
  const settings = page.getByRole('dialog', { name: 'Settings' })
  for (const theme of ['light', 'dark'] as const) {
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Settings' }).click()
    await settings.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await settings.getByRole('button', { name: 'Done' }).click()
    await expect(settings).toBeHidden()
    await before()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${rendersDir}/${name}-${theme}.png` })
  }
}

test('facing depth from the reference: Add facing and the Depth field suggest it (DF4)', async ({
  dfyom,
}) => {
  // the renders switch the theme twice around a loaded 50 K triangle ghost
  test.setTimeout(RENDERS ? 240_000 : 120_000)
  await stubFileDialogs(dfyom.app, join(dfyom.dataDir, 'enclosure.dfyom'))
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Enclosure')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  // the enclosure base is 249.5 × 177.1 × 39 mm
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '260')
  await setField(setup, 'Width (Y)', '190')
  await setField(setup, 'Thickness (Z)', '40')
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()

  // import in the Reference panel (fitted to the top), then lower it 0.5 mm into the stock
  const panel = await openReferencePanel(page)
  await panel.getByRole('button', { name: 'Import STL…' }).click()
  await expect(panel.getByTitle('enclosure-wood-base')).toBeVisible({ timeout: 30_000 })
  await expect(input(panel, 'Position Z')).toHaveValue('-39 mm')
  await setField(panel, 'Position Z', '-39.5 mm')
  await expect(input(panel, 'Position Z')).toHaveValue('-39.5 mm')

  // a new facing faces down to the reference's top
  await navigator.getByRole('button', { name: 'Add facing' }).click()
  await expect(inspector.getByRole('heading', { name: 'Facing 1' })).toBeVisible()
  const depth = input(inspector, 'Depth')
  await expect(depth).toHaveValue('0.5 mm')

  // another depth: the adjust panel (opened by focusing the field) offers the reference's again
  await setField(inspector, 'Depth', '1')
  await expect(depth).toHaveValue('1')
  const popover = page.getByRole('dialog', { name: 'Adjust Depth' })
  await depth.click()
  await expect(popover.getByText(/0\.5 mm, down to enclosure-wood-base/)).toBeVisible()
  await render(page, 'df4-facing-depth', async () => {
    await depth.click()
    await expect(popover).toBeVisible()
  })
  await popover.getByRole('button', { name: 'Use 0.5 mm' }).click()
  await expect(depth).toHaveValue('0.5 mm')
  expect(dfyom.rendererErrors).toEqual([])
})
