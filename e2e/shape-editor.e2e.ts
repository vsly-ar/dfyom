// v0.3 Shape Editor in the built app (task U1), through roles and labels: a shape added from the
// Shapes dialog (D45) opens its flat view and inspector; a dimension edited by dragging its
// handle (one undo step) and by its field (one undo step); undo restores each. Windows stay
// hidden (app.fixture.ts). A path's segment table opens a row's actions by right-click and
// Shift+F10 (DF70), and so does a Shapes dialog row; with DFYOM_RENDERS=1 the light and dark
// renders `df70-{segment,shape}-menu-*.png`.
// Docs: docs/modes/design-v0.3.md#shape-definition, docs/conventions/ui.md#shape-editor
import { resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, openPartSetup, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

/**
 * With DFYOM_RENDERS=1: light and dark renders without touching the page (an open menu stays
 * open); the theme attribute is set directly and put back after.
 */
async function renderOpen(page: Page, name: string): Promise<void> {
  if (!RENDERS) return
  // runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`
  const setTheme = (t: string | null) =>
    page.evaluate((v) => {
      const root = (
        globalThis as unknown as {
          document: {
            documentElement: {
              getAttribute(n: string): string | null
              setAttribute(n: string, v: string): void
              removeAttribute(n: string): void
            }
          }
        }
      ).document.documentElement
      const before = root.getAttribute('data-theme')
      if (v === null) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', v)
      return before
    }, t)
  const before = await setTheme('light')
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(theme)
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${rendersDir}/df70-${name}-${theme}.png` })
  }
  await setTheme(before)
}

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = input(scope, label)
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

const input = (scope: Locator, label: string) =>
  scope.getByLabel(label, { exact: true }).and(scope.locator('input'))

/** A new project with a 100 × 60 × 20 part; the navigator and the inspector. */
async function newPart(page: Page): Promise<{ navigator: Locator; inspector: Locator }> {
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Shapes')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '100')
  await setField(setup, 'Width (Y)', '60')
  await setField(setup, 'Thickness (Z)', '20')
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()
  return { navigator, inspector }
}

test('shape editor: add a shape, drag a handle, edit a field, undo', async ({ dfyom }) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  const { inspector } = await newPart(page)

  // ── add a rectangle from the Shapes dialog (D45): it is selected, the dialog closes ──────
  let shapes = await openPartSetup(page, 'Shapes')
  await shapes.getByRole('button', { name: 'Add shape' }).click()
  await page.getByRole('menuitem', { name: 'Rectangle' }).click()
  await expect(shapes).toBeHidden()
  await expect(inspector.getByRole('heading', { name: 'Shape 1' })).toBeVisible()
  shapes = await openPartSetup(page, 'Shapes')
  await expect(shapes.getByRole('button', { name: /^Shape 1/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // choosing the selected row keeps it selected and closes the dialog
  await shapes.getByRole('button', { name: /^Shape 1/ }).click()
  await expect(shapes).toBeHidden()
  const editor = page.getByRole('region', { name: 'Shape Editor' })
  await expect(editor).toBeVisible()
  await expect(editor.getByText('Shape · Shape frame')).toBeVisible()
  await expect(input(inspector, 'Length')).toHaveValue('40')
  await expect(inspector.getByText('40.00 × 20.00 mm')).toBeVisible()

  // ── drag the length handle: one gesture, one undo step ───────────────────────────────────
  const handle = editor.locator('[data-handle="length"]')
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + i * 10, y)
  await expect(editor.getByTestId('shape-value-chip')).toBeVisible()
  await page.mouse.up()
  await expect(input(inspector, 'Length')).not.toHaveValue('40')
  const dragged = Number(await input(inspector, 'Length').inputValue())
  expect(dragged).toBeGreaterThan(40)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(input(inspector, 'Length')).toHaveValue('40')

  // ── edit the same dimension by its field ─────────────────────────────────────────────────
  await setField(inspector, 'Length', '60')
  await expect(inspector.getByText('60.00 × 20.00 mm')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(input(inspector, 'Length')).toHaveValue('40')
  await expect(inspector.getByText('40.00 × 20.00 mm')).toBeVisible()

  // Escape leaves the editor for the part
  await editor.focus()
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
})

test('shape editor: a segment row opens its actions by right-click and Shift+F10 (DF70)', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  const { inspector } = await newPart(page)
  const shapes = await openPartSetup(page, 'Shapes')
  await shapes.getByRole('button', { name: 'Add shape' }).click()
  await page.getByRole('menuitem', { name: 'Path' }).click()
  const grid = inspector.getByRole('grid', { name: /Segments of Path 1/ })
  await expect(grid).toBeVisible()
  // no button in the row: its actions are the row's context menu
  await expect(grid.getByRole('button', { name: /^Actions for segment/ })).toHaveCount(0)
  // by CSS: the open menu hides the rest from the accessibility tree (modal)
  const row = (n: number) => grid.locator('tbody tr').nth(n - 1)
  const table = inspector.locator('table[role="grid"]')

  // right-click on row 2: its menu at the pointer, the row selected
  await row(2).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Actions for segment 2' })
  await expect(menu).toBeVisible()
  await expect(table.locator('tbody tr').nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(menu.getByRole('menuitem')).toHaveText([
    /^Move segment 2 up/,
    /^Move segment 2 down/,
    /^Remove segment 2/,
  ])
  await renderOpen(page, 'segment-menu')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  // Shift+F10 on a cell of row 3: its menu; Escape brings the focus back to the cell
  const cell = row(3).getByRole('gridcell').first()
  await cell.focus()
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('menu', { name: 'Actions for segment 3' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(cell).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await page.getByRole('menuitem', { name: 'Remove segment 3' }).click()
  await expect(grid.getByRole('row')).toHaveCount(3)
})

test('shapes dialog: a shape row opens its actions by right-click and Shift+F10 (DF70)', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await newPart(page)
  let shapes = await openPartSetup(page, 'Shapes')
  for (const kind of ['Rectangle', 'Circle']) {
    await shapes.getByRole('button', { name: 'Add shape' }).click()
    await page.getByRole('menuitem', { name: kind }).click()
    await expect(shapes).toBeHidden()
    shapes = await openPartSetup(page, 'Shapes')
  }
  const row = (name: string) => shapes.getByRole('button', { name: new RegExp(`^${name}`) })
  // no action button on a row, even hovered: its actions are the row's context menu
  await row('Shape 1').hover()
  await expect(shapes.getByRole('button', { name: /^Remove / })).toHaveCount(0)

  // right-click on a row: its menu at the pointer
  await row('Shape 1').click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Actions for Shape 1' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveText([/^Remove/])
  await renderOpen(page, 'shape-menu')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(shapes).toBeVisible()

  // Shift+F10 on the focused row: the same menu; its Remove keeps the dialog open
  await row('Shape 2').focus()
  await page.keyboard.press('Shift+F10')
  await page
    .getByRole('menu', { name: 'Actions for Shape 2' })
    .getByRole('menuitem', { name: /^Remove/ })
    .click()
  await expect(row('Shape 2')).toHaveCount(0)
  await expect(shapes).toBeVisible()
  await expect(row('Shape 1')).toBeVisible()
})
