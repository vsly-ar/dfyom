// v0.3 snap and measure in the built app (task U3), through roles and labels: a pocket's rectangle
// converted to a named shape opens face-on in the Shape Editor; its length handle dragged next to
// the stock's right edge snaps to it (glyph "Stock edge", the value written exactly), then the
// measure tool (D, Dimension) picks two stock corners (snapped) and shows their distance. Windows stay hidden
// (app.fixture.ts).
// Docs: docs/conventions/ui.md#snap-and-measure, docs/modes/design-v0.3.md#implementation-u3
import type { Locator } from '@playwright/test'
import { expect, test } from './app.fixture'

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = input(scope, label)
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

const input = (scope: Locator, label: string) =>
  scope.getByLabel(label, { exact: true }).and(scope.locator('input'))

test('snap a handle to a stock edge, then measure two points', async ({ dfyom }) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Snap')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '100')
  await setField(setup, 'Width (Y)', '60')
  await setField(setup, 'Thickness (Z)', '20')
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()

  // ── a pocket's rectangle as a named shape, opened face-on ────────────────────────────────
  await navigator.getByRole('button', { name: 'Add pocket' }).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()
  await inspector.getByRole('button', { name: 'Convert to shape' }).click()
  await inspector.getByRole('button', { name: 'Edit shape' }).click()
  const editor = page.getByRole('region', { name: 'Shape Editor' })
  await expect(editor.getByText('Shape · Top face')).toBeVisible()
  const before = await input(inspector, 'Length').inputValue()

  // ── drag the length handle next to the stock's right edge: it snaps ──────────────────────
  const stock = (await editor.getByTestId('shape-stock-face').boundingBox())!
  const handle = (await editor.locator('[data-handle="length"]').boundingBox())!
  const x = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2
  const edge = stock.x + stock.width
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + ((edge + 3 - x) * i) / 10, y)
  const glyph = editor.getByTestId('snap-glyph')
  await expect(glyph).toHaveAttribute('data-kind', 'edge')
  await expect(glyph).toContainText('Stock edge')
  await page.mouse.up()
  await expect(input(inspector, 'Length')).not.toHaveValue(before)
  // an exact snap writes the edge's number in the value's unit (no pixel rounding): the pocket is
  // centred on the 100 mm stock, so its length reaches both edges
  await expect(input(inspector, 'Length')).toHaveValue('100 mm')

  // ── measure along the stock's front edge, corner to corner (the toolbar covers the top) ───
  await editor.focus()
  await page.keyboard.press('d')
  await expect(editor.getByRole('button', { name: /Measure/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  const face = (await editor.getByTestId('shape-stock-face').boundingBox())!
  console.log(JSON.stringify({ stock, face }))
  await page.mouse.click(face.x + 3, face.y + face.height - 2)
  await page.mouse.click(face.x + face.width - 3, face.y + face.height - 4)
  await expect(editor.getByTestId('measure-chip')).toHaveText('100.00 mm')
  await page.keyboard.press('Escape')
  await expect(editor.getByTestId('measure-chip')).toHaveCount(0)
  await expect(editor).toBeVisible()
})
