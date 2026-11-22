// v0.3 Shape Editor in the built app (task U1), through roles and labels: a shape added from the
// navigator's Shapes group opens its flat view and inspector; a dimension edited by dragging its
// handle (one undo step) and by its field (one undo step); undo restores each. Windows stay
// hidden (app.fixture.ts).
// Docs: docs/modes/design-v0.3.md#shape-definition, docs/conventions/ui.md#shape-editor
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

test('shape editor: add a shape, drag a handle, edit a field, undo', async ({ dfyom }) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Shapes')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const setup = navigator.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '100')
  await setField(setup, 'Width (Y)', '60')
  await setField(setup, 'Thickness (Z)', '20')
  await setup.getByRole('button', { name: 'Create part' }).click()

  // ── add a rectangle from the Shapes group ────────────────────────────────────────────────
  const shapes = navigator.getByRole('region', { name: 'Shapes' })
  await shapes.getByRole('button', { name: 'Add shape' }).click()
  await page.getByRole('menuitem', { name: 'Rectangle' }).click()
  await expect(inspector.getByRole('heading', { name: 'Shape 1' })).toBeVisible()
  await expect(shapes.getByRole('button', { name: /^Shape 1/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
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
