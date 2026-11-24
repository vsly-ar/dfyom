// Reference model UI in the built app (task R3; the Reference panel since dogfood DF2–DF8), through
// roles and labels: the toolbar's Reference toggle opens the panel in the right sidebar, import the
// real enclosure STL (49 806 triangles, from the user) through the stubbed "Import reference"
// dialog, see the file line, size and ghost (the viewport's text summary says when the mesh is
// drawn), hide and show it (window-only: no unsaved mark), turn it 90°, fit it in Fit mode (scale
// to fit with a preview, Apply), save, close the app, reopen the project and find the reference
// placed as saved, shown again, read from the stored asset. Windows stay hidden (app.fixture.ts).
// With DFYOM_RENDERS=1 it writes the light and dark review renders of the panel and of Fit mode
// to design/reference/renders/. A second test reads levels and a section of the reference and makes
// a shape from it (DF60 P1; render df-reference-tools).
// Docs: docs/conventions/ui.md#reference-panel-hardening-df2df8, docs/modes/reference-model.md#display,
// docs/conventions/ui.md#reference-tools-df60
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import {
  expect,
  fitReference,
  launchApp,
  openPartSetup,
  openReferencePanel,
  test,
} from './app.fixture'

const STL = resolve('src/core/design/__fixtures__/enclosure-wood-base.stl')
const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/reference/renders')

/** Open dialogs: "Import reference" answers the STL, anything else the project; save the project. */
async function stubFileDialogs(app: ElectronApplication, project: string): Promise<void> {
  await app.evaluate(
    ({ dialog }, f) => {
      const title = (args: unknown[]) => (args.at(-1) as { title?: string } | undefined)?.title
      dialog.showOpenDialog = ((...args: unknown[]) =>
        Promise.resolve({
          canceled: false,
          filePaths: [title(args) === 'Import reference' ? f.stl : f.project],
        })) as typeof dialog.showOpenDialog
      dialog.showSaveDialog = (() =>
        Promise.resolve({ canceled: false, filePath: f.project })) as typeof dialog.showSaveDialog
    },
    { stl: STL, project },
  )
}

/**
 * With DFYOM_RENDERS=1: the window in light and dark. The theme changes through Settings, which
 * leaves the panel (and Fit mode) as they are.
 */
async function render(page: Page, name: string): Promise<void> {
  if (!RENDERS) return
  const settings = page.getByRole('dialog', { name: 'Settings' })
  for (const theme of ['light', 'dark'] as const) {
    await page.getByRole('button', { name: 'Settings' }).click()
    await settings.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await settings.getByRole('button', { name: 'Done' }).click()
    await expect(settings).toBeHidden()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${rendersDir}/df-${name}-${theme}.png` })
  }
}

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

const input = (scope: Locator, label: string) =>
  scope.getByLabel(label, { exact: true }).and(scope.locator('input'))

test('reference model: the Reference panel imports the enclosure STL, ghost, visibility, turn, fit, save and reopen', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const project = join(dfyom.dataDir, 'enclosure.dfyom')
  await stubFileDialogs(dfyom.app, project)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const viewport = page.getByRole('region', { name: '3D viewport' })
  const status = page.getByRole('contentinfo', { name: 'Status bar' })

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

  // ── the toolbar toggle opens the panel; import through the file dialog ────────────────────
  const panel = await openReferencePanel(page)
  await panel.getByRole('button', { name: 'Import STL…' }).click()
  await expect(panel.getByTitle('enclosure-wood-base')).toBeVisible({ timeout: 30_000 })
  await expect(panel.getByText('STL · 49 806 triangles')).toBeVisible()
  await expect(panel.getByText('249.5 × 177.1 × 39 mm').first()).toBeVisible()
  await expect(panel.getByText(/Unit guess: Read as mm/)).toBeVisible()
  // fitted centre + top: the model's top at the stock top
  await expect(input(panel, 'Position Z')).toHaveValue('-39 mm')
  await expect(panel.getByText('The reference fits inside the stock.')).toBeVisible()
  await expect(panel.getByRole('checkbox', { name: 'See through stock' })).toBeChecked()
  // the ghost is drawn once its triangles arrived from the worker
  await expect(viewport).toHaveAccessibleDescription(
    /Reference enclosure-wood-base shown as a ghost\./,
    { timeout: 30_000 },
  )
  await render(page, 'reference-panel')

  // ── visibility is per window: no command, no undo step ───────────────────────────────────
  await page.keyboard.press('ControlOrMeta+s')
  await expect(status.getByText('Saved', { exact: true })).toBeVisible()
  const eye = panel.getByRole('button', { name: 'Show reference' })
  await expect(eye).toHaveAttribute('aria-pressed', 'true')
  await eye.click()
  await expect(eye).toHaveAttribute('aria-pressed', 'false')
  await expect(panel.getByText('hidden', { exact: true })).toBeVisible()
  await expect(viewport).not.toHaveAccessibleDescription(/Reference enclosure-wood-base/)
  await expect(status.getByText('Saved', { exact: true })).toBeVisible() // still saved
  await eye.click()
  await expect(viewport).toHaveAccessibleDescription(/Reference enclosure-wood-base shown/)

  // ── turn 90° about Z: one undoable command; now it sticks out in Y ────────────────────────
  await panel.getByRole('button', { name: 'Turn +90° about Z' }).click()
  await expect(input(panel, 'Rotation Z')).toHaveValue('90°')
  await expect(panel.getByText(/sticks out of the stock by Y/)).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(input(panel, 'Rotation Z')).toHaveValue('0°')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(input(panel, 'Rotation Z')).toHaveValue('90°')

  // ── Fit mode: scale to fit X and Y (the box is now 177.1 × 249.5), preview, Apply ─────────
  await panel.getByRole('button', { name: 'Fit to stock…' }).click()
  const fit = panel.getByRole('region', { name: 'Fit to stock' })
  // min(260 / 177.1, 190 / 249.5) ≈ 0.7615 → 134.8 × 190 × 29.7
  await expect(fit.getByRole('status')).toHaveText(
    /^Scale 0\.7615\d+ · 134\.\d × 190 × 29\.\d+ mm$/,
  )
  await expect(panel.getByLabel('Position X', { exact: true })).toHaveCount(0)
  await render(page, 'reference-fit')
  await fit.getByRole('button', { name: 'Cancel' }).click()
  await expect(fit).toBeHidden()
  // without scaling: centred in X (177.1 wide), top at the stock top
  await fitReference(panel, { scale: false })
  await expect(input(panel, 'Position X')).toHaveValue('41.4697 mm')
  await expect(input(panel, 'Scale')).toHaveValue('1')

  // hide it, then save: visibility is not saved with the project
  await eye.click()
  await expect(eye).toHaveAttribute('aria-pressed', 'false')
  // another selection closes the panel
  await navigator.getByRole('button', { name: 'Add facing' }).click()
  await expect(
    page.getByRole('toolbar', { name: 'Part setup' }).getByRole('button', { name: 'Reference' }),
  ).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('ControlOrMeta+z')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(status.getByText('Saved', { exact: true })).toBeVisible()
  expect(existsSync(project)).toBe(true)
  expect(dfyom.rendererErrors).toEqual([])

  // ── close the app, reopen the project ────────────────────────────────────────────────────
  await dfyom.app.close()
  const second = await launchApp(dfyom.dataDir)
  try {
    await stubFileDialogs(second.app, project)
    const page2 = await second.app.firstWindow()
    const nav2 = page2.getByRole('navigation', { name: 'Navigator' })
    await nav2.getByRole('button', { name: 'Open project' }).click()
    await expect(page2).toHaveTitle('Enclosure')
    const panel2 = await openReferencePanel(page2)
    await expect(panel2.getByText('STL · 49 806 triangles')).toBeVisible() // shown again
    await expect(panel2.getByRole('button', { name: 'Show reference' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(input(panel2, 'Rotation Z')).toHaveValue('90°')
    await expect(input(panel2, 'Position X')).toHaveValue('41.4697 mm')
    // the mesh comes from the asset stored in the project
    await expect(page2.getByRole('region', { name: '3D viewport' })).toHaveAccessibleDescription(
      /Reference enclosure-wood-base shown as a ghost\./,
      { timeout: 30_000 },
    )
    expect(second.rendererErrors).toEqual([])
  } finally {
    await second.app.close()
  }
})

test('reference tools (DF60): levels from both sides, a level sets the section, Create shape', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  await stubFileDialogs(dfyom.app, join(dfyom.dataDir, 'tools.dfyom'))
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 900 })
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Tools')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '260')
  await setField(setup, 'Width (Y)', '190')
  await setField(setup, 'Thickness (Z)', '40')
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()
  const panel = await openReferencePanel(page)
  await panel.getByRole('button', { name: 'Import STL…' }).click()
  await expect(panel.getByTitle('enclosure-wood-base')).toBeVisible({ timeout: 30_000 })

  // levels from the top (the rim at 0, the cavity floor) and from the bottom, read in the worker
  const levels = panel.getByRole('region', { name: 'Levels' })
  await expect(levels.getByRole('heading', { name: 'From top' })).toBeVisible({ timeout: 30_000 })
  await expect(levels.getByRole('heading', { name: 'From bottom' })).toBeVisible()
  const rim = levels.getByRole('button', { name: /^Depth 0 mm, area/ }).first()
  await expect(rim).toBeVisible()

  // the section at the middle of the model: the outline and the cavity, with corner chips
  const section = panel.getByRole('region', { name: 'Section' })
  await expect(section.getByText(/^Outline /)).toBeVisible({ timeout: 30_000 })
  await expect(section.getByText(/^Cavity /)).toBeVisible()
  await expect(section.getByText(/elements, within/)).toBeVisible()
  await section.scrollIntoViewIfNeeded()
  await render(page, 'reference-tools')

  // a level from the top sets the section just inside it
  const before = await input(section, 'Section depth').inputValue()
  await rim.click()
  await expect(input(section, 'Section depth')).not.toHaveValue(before)
  await setField(section, 'Section depth', '20')
  await expect(section.getByText(/^Cavity /)).toBeVisible({ timeout: 30_000 })

  // Create shape: one undoable import; the Shapes dialog lists it
  await section.getByRole('button', { name: 'Create shape', exact: true }).click()
  await expect(section.getByText('Shape created.')).toBeVisible({ timeout: 30_000 })
  const shapes = await openPartSetup(page, 'Shapes')
  await expect(shapes.getByText('Section 20 mm').first()).toBeVisible()
  expect(dfyom.rendererErrors).toEqual([])
})
