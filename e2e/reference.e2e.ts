// v0.2 reference model UI in the built app (task R3), through roles and labels: import the real
// enclosure STL (49 806 triangles, from the user) through the stubbed "Import reference" dialog,
// see its navigator row, inspector and ghost (the viewport's text summary says when the mesh is
// drawn), hide and show it (window-only: no unsaved mark), turn it 90°, save, close the app,
// reopen the project and find the reference placed as saved, shown again, read from the stored
// asset. Windows stay hidden (app.fixture.ts).
// Docs: docs/modes/reference-model.md#display, docs/conventions/ui.md#reference-ghost-v02
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Locator } from '@playwright/test'
import { closeDialog, expect, launchApp, openPartSetup, test } from './app.fixture'

const STL = resolve('src/core/design/__fixtures__/enclosure-wood-base.stl')

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

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

const input = (scope: Locator, label: string) =>
  scope.getByLabel(label, { exact: true }).and(scope.locator('input'))

test('reference model: import the enclosure STL, ghost, visibility, 90° turn, save and reopen', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const project = join(dfyom.dataDir, 'enclosure.dfyom')
  await stubFileDialogs(dfyom.app, project)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
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
  await setup.getByRole('button', { name: 'Create part' }).click()

  // ── import through the file dialog ───────────────────────────────────────────────────────
  // the Reference dialog (D45) closes when the import has selected the new reference
  let group = await openPartSetup(page, 'Reference')
  await group.getByRole('button', { name: 'Import STL…' }).click()
  await expect(group).toBeHidden({ timeout: 30_000 })
  await expect(inspector.getByRole('heading', { name: 'enclosure-wood-base' })).toBeVisible()
  await expect(inspector.getByText(/STL · 49 806 triangles · 249.5 × 177.1 × 39/)).toBeVisible()
  await expect(inspector.getByText(/Unit guess: Read as mm/)).toBeVisible()
  // fitted centre + top: the model's top at the stock top
  await expect(input(inspector, 'Position Z')).toHaveValue('-39 mm')
  await expect(inspector.getByText('The reference fits inside the stock.')).toBeVisible()
  // the ghost is drawn once its triangles arrived from the worker
  await expect(viewport).toHaveAccessibleDescription(
    /Reference enclosure-wood-base shown as a ghost\./,
    { timeout: 30_000 },
  )

  // ── visibility is per window: no command, no undo step ───────────────────────────────────
  await page.keyboard.press('ControlOrMeta+s')
  await expect(status.getByText('Saved', { exact: true })).toBeVisible()
  group = await openPartSetup(page, 'Reference')
  const row = group.getByRole('button', { name: /^enclosure-wood-base/ })
  await expect(row).toContainText('49 806 triangles')
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  const eye = group.getByRole('button', { name: 'Show reference' })
  await eye.click()
  await expect(eye).toHaveAttribute('aria-pressed', 'false')
  await expect(row).toContainText('hidden')
  await closeDialog(group)
  await expect(viewport).not.toHaveAccessibleDescription(/Reference enclosure-wood-base/)
  await expect(status.getByText('Saved', { exact: true })).toBeVisible() // still saved
  group = await openPartSetup(page, 'Reference')
  await group.getByRole('button', { name: 'Show reference' }).click()
  await closeDialog(group)
  await expect(viewport).toHaveAccessibleDescription(/Reference enclosure-wood-base shown/)

  // ── turn 90° about Z: one undoable command; now it sticks out in Y ────────────────────────
  await inspector.getByRole('button', { name: 'Turn +90° about Z' }).click()
  await expect(input(inspector, 'Rotation Z')).toHaveValue('90°')
  await expect(inspector.getByText(/sticks out of the stock by Y/)).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(input(inspector, 'Rotation Z')).toHaveValue('0°')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(input(inspector, 'Rotation Z')).toHaveValue('90°')
  // fit again: centred in X (the box is now 177.1 wide), top at the stock top
  await inspector.getByRole('button', { name: 'Fit to stock' }).click()
  await expect(input(inspector, 'Position X')).toHaveValue('41.4697 mm')

  // hide it, then save: visibility is not saved with the project
  group = await openPartSetup(page, 'Reference')
  await group.getByRole('button', { name: 'Show reference' }).click()
  await expect(group.getByRole('button', { name: 'Show reference' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await closeDialog(group)
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
    const inspector2 = page2.getByRole('complementary', { name: 'Inspector' })
    await nav2.getByRole('button', { name: 'Open project' }).click()
    await expect(page2).toHaveTitle('Enclosure')
    const group2 = await openPartSetup(page2, 'Reference')
    const row2 = group2.getByRole('button', { name: /^enclosure-wood-base/ })
    await expect(row2).toContainText('49 806 triangles') // shown again in a new window
    await expect(group2.getByRole('button', { name: 'Show reference' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await row2.click() // selects it and closes the dialog
    await expect(input(inspector2, 'Rotation Z')).toHaveValue('90°')
    await expect(input(inspector2, 'Position X')).toHaveValue('41.4697 mm')
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
