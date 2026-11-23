// v0.3 operation inspector for shapes in the built app (task U2), through roles and labels: import
// the enclosure drawing through the stubbed open dialog ("Import SVG…" → options → report), place
// one of its named shapes on a pocket with the shape picker, then drag a profile's tab marker in
// the viewport (one gesture: the count becomes entered positions) and undo it; and DF49: "Import
// SVG…" from a Profile's shape field uses the first imported shape, one undo step. Windows stay
// hidden (app.fixture.ts). With DFYOM_RENDERS=1 the DF49 test writes the light and dark review
// renders `df49-{shapes-empty,picker,report}-*.png` to design/features/renders/.
// Docs: docs/conventions/ui.md#shape-in-the-operation-inspector, #tab-markers, #import-report,
// #import-svg-where-it-is-looked-for-df49
import { resolve } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { closeDialog, expect, openPartSetup, test } from './app.fixture'

const SVG = resolve('src/core/design/__fixtures__/enclosure-sections.svg')
const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

/** With DFYOM_RENDERS=1: light and dark renders without touching the page. */
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
    await page.screenshot({ path: `${rendersDir}/df49-${name}-${theme}.png` })
  }
}

/** A new project with a 120 × 80 × 20 part. */
async function newPart(page: Page): Promise<void> {
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Enclosure')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '120')
  await setField(setup, 'Width (Y)', '80')
  await setField(setup, 'Thickness (Z)', '20')
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()
}

/** Every open dialog answers the enclosure drawing. */
async function stubOpenDialog(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
  }, SVG)
}

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = input(scope, label)
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

const input = (scope: Locator, label: string) =>
  scope.getByLabel(label, { exact: true }).and(scope.locator('input'))

test('shapes on operations: import SVG, pick a named shape, drag a tab, undo', async ({
  dfyom,
}) => {
  test.setTimeout(150_000)
  await stubOpenDialog(dfyom.app)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await newPart(page)

  // ── Import SVG… from the Shapes dialog (D45) ─────────────────────────────────────────────
  const shapes = await openPartSetup(page, 'Shapes')
  await shapes.getByRole('button', { name: 'Import SVG…' }).click()
  const options = page.getByRole('dialog', { name: 'Import SVG' })
  await options.getByRole('button', { name: 'Import' }).click()
  const report = page.getByRole('dialog', { name: /^Imported/ })
  await expect(report).toBeVisible({ timeout: 30_000 })
  await report.getByRole('button', { name: 'Close' }).first().click()
  await expect(report).toHaveCount(0)
  await expect(shapes.getByRole('list')).toBeVisible()
  await closeDialog(shapes)

  // ── a pocket on a named shape ────────────────────────────────────────────────────────────
  await navigator.getByRole('button', { name: 'Add pocket' }).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()
  await inspector.getByRole('combobox', { name: 'Shape' }).click()
  const list = page.getByRole('listbox')
  const named = list.getByRole('group').nth(1).getByRole('option')
  const first = named.first()
  const name = (await first.innerText()).split('\n')[0]!.trim()
  await first.click()
  await expect(inspector.getByRole('combobox', { name: 'Shape' })).toContainText(name)
  await expect(inspector.getByRole('button', { name: 'Edit shape' })).toBeVisible()
  await setField(inspector, 'Position X', '60')
  await setField(inspector, 'Position Y', '40')

  // ── a profile's tab marker dragged along the loop ────────────────────────────────────────
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Profile' }).click()
  await expect(inspector.getByRole('heading', { name: 'Profile 1' })).toBeVisible()
  await setField(inspector, 'Tab count', '2')
  const viewport = page.getByRole('region', { name: '3D viewport' })
  const marker = viewport.locator('[data-tab-marker="0"]')
  await expect(marker).toHaveCount(1)
  const box = (await marker.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + i * 6, y + i * 2)
  await page.mouse.up()
  await expect(inspector.getByText('Positions entered by you.')).toBeVisible()
  await expect(input(inspector, 'Tab 1')).toBeVisible()
  // one drag is one undo step: back to the count
  await page.keyboard.press('ControlOrMeta+z')
  await expect(inspector.getByText('Positions entered by you.')).toHaveCount(0)
  await expect(input(inspector, 'Tab count')).toHaveValue('2')
})

test("DF49: Import SVG… from a profile's shape field uses the first shape, one undo", async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  await stubOpenDialog(dfyom.app)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await newPart(page)

  // the Shapes dialog's empty state offers the import beside Add shape
  const shapes = await openPartSetup(page, 'Shapes')
  await expect(shapes.getByText(/import an SVG drawing/)).toBeVisible()
  await expect(shapes.getByRole('button', { name: 'Import SVG…' })).toBeVisible()
  await render(page, 'shapes-empty')
  await closeDialog(shapes)

  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Profile' }).click()
  await expect(inspector.getByRole('heading', { name: 'Profile 1' })).toBeVisible()
  const field = inspector.getByRole('combobox', { name: 'Shape' })
  await field.click()
  const entry = page.getByRole('listbox').getByRole('option', { name: 'Import SVG…' })
  await expect(entry).toBeVisible()
  await render(page, 'picker')
  await entry.click()
  await page
    .getByRole('dialog', { name: 'Import SVG' })
    .getByRole('button', { name: 'Import' })
    .click()
  const report = page.getByRole('dialog', { name: 'Imported 2 shapes' })
  await expect(report).toBeVisible({ timeout: 30_000 })
  await expect(report.getByText('Profile 1 now cuts outline.')).toBeVisible()
  await render(page, 'report')
  await report.getByRole('button', { name: 'Close' }).first().click()
  await expect(report).toHaveCount(0)
  await expect(field).toContainText('outline')
  await expect(inspector.getByRole('button', { name: 'Edit shape' })).toBeVisible()

  // one undo removes the use and the import
  await page.keyboard.press('ControlOrMeta+z')
  await expect(field).toContainText('Rectangle')
  const again = await openPartSetup(page, 'Shapes')
  await expect(again.getByText(/import an SVG drawing/)).toBeVisible()
  await closeDialog(again)
})
