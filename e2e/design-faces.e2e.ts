// v0.2 face picking and placement anchors in the built app (tasks F1, F2), through roles and
// labels: the `on` dropdown grouped by direction and pick mode over every face, a pocket moved to
// the right side (its fields then read u and v, the viewport shows its face frame), re-anchoring
// with the 3 × 3 picker without moving the feature, and the default-anchor setting placing a new
// pocket. Windows stay hidden (app.fixture.ts).
// Docs: docs/modes/design-v0.2.md, docs/conventions/ui.md#design-and-plan-controls-v02
import type { Locator } from '@playwright/test'
import { expect, test } from './app.fixture'

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

const input = (scope: Locator, label: string) =>
  scope.getByLabel(label, { exact: true }).and(scope.locator('input'))

test('face picking and anchors: on by direction, side-face fields, anchor picker, default anchor', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const viewport = page.getByRole('region', { name: '3D viewport' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Faces')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '100')
  await setField(setup, 'Width (Y)', '60')
  await setField(setup, 'Thickness (Z)', '20')
  await setup.getByRole('button', { name: 'Create part' }).click()

  // ── F1: the `on` dropdown groups the face targets by direction ───────────────────────────
  await navigator.getByRole('button', { name: 'Add pocket' }).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()
  await expect(input(inspector, 'Position X')).toHaveValue('50 mm')
  await inspector.getByRole('combobox', { name: 'On', exact: true }).click()
  const list = page.getByRole('listbox')
  await expect(list.getByRole('group')).toHaveCount(6)
  await expect(list.getByRole('group').nth(3)).toContainText('Right side')
  await list.getByRole('option', { name: /Stock right side/ }).click()
  // the right side's face frame: the fields read u and v, the viewport says what it shows
  await expect(input(inspector, 'Position u')).toBeVisible()
  await expect(input(inspector, 'Length (u)')).toBeVisible()
  await expect(viewport).toHaveAccessibleDescription(
    /Selected: Pocket 1 on Stock right side, face axes u and v shown, anchor Centre\./,
  )
  // the face-frame axis labels are drawn at the axis tips (drei Html overlays in the canvas)
  await expect(viewport.locator('[class*="axisLabel"]')).toHaveCount(2)
  // the right side is 60 × 20: keep the pocket on it
  await setField(inspector, 'Position u', '30')
  await setField(inspector, 'Position v', '10')
  await setField(inspector, 'Length (u)', '20')
  await setField(inspector, 'Width (v)', '8')
  await setField(inspector, 'Depth', '5')

  // pick mode over every face target, cancelled with Escape
  await inspector.getByRole('button', { name: 'Pick the surface in the viewport' }).click()
  await expect(viewport.getByRole('status')).toHaveText('Pick a surface for On · Esc to cancel')
  await page.keyboard.press('Escape')
  await expect(viewport.getByRole('status')).toHaveCount(0)
  await expect(viewport.getByText('Pick cancelled.')).toBeAttached()
  // the pick button is a toggle: a second press cancels (DF10)
  const pickOn = inspector.getByRole('button', { name: 'Pick the surface in the viewport' })
  await pickOn.click()
  await expect(pickOn).toHaveAttribute('aria-pressed', 'true')
  await expect(viewport.getByRole('status')).toBeVisible()
  await pickOn.click()
  await expect(pickOn).toHaveAttribute('aria-pressed', 'false')
  await expect(viewport.getByRole('status')).toHaveCount(0)
  // a value field's pick toggle sits in its adjust panel, opened by focusing the field (DF9)
  const depthField = inspector.getByLabel('Depth', { exact: true }).and(inspector.locator('input'))
  await depthField.click()
  const pickDepth = page.getByRole('button', { name: 'Pick Depth in the viewport' })
  await pickDepth.click()
  await expect(pickDepth).toHaveAttribute('aria-pressed', 'true')
  await expect(depthField).toBeFocused()
  await pickDepth.click()
  await expect(viewport.getByRole('status')).toHaveCount(0)
  await expect(depthField).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Adjust Depth' })).toHaveCount(0)

  // ── F2: re-anchor without moving the feature ─────────────────────────────────────────────
  const anchor = inspector.getByRole('radiogroup', { name: 'Anchor' })
  await expect(anchor.getByRole('radio', { name: 'Centre', exact: true })).toBeChecked()
  await anchor.getByRole('radio', { name: 'Bottom left' }).click()
  await expect(anchor.getByRole('radio', { name: 'Bottom left' })).toBeChecked()
  // centre (30, 10), 20 × 8: the bottom-left corner is (20, 6)
  await expect(input(inspector, 'Position u')).toHaveValue('20')
  await expect(input(inspector, 'Position v')).toHaveValue('6')
  await expect(viewport).toHaveAccessibleDescription(/anchor Bottom left\./)
  // a size edit keeps the anchor point
  await setField(inspector, 'Length (u)', '24')
  await expect(input(inspector, 'Position u')).toHaveValue('20')
  // one undo step restores the size, a second the anchor
  await page.keyboard.press('ControlOrMeta+z')
  await expect(input(inspector, 'Length (u)')).toHaveValue('20')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(anchor.getByRole('radio', { name: 'Centre', exact: true })).toBeChecked()
  await expect(input(inspector, 'Position u')).toHaveValue('30')

  // ── F2: the default anchor places new pockets ────────────────────────────────────────────
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('radiogroup', { name: 'Default anchor' })
    .getByRole('radio', { name: 'Front left' })
    .click()
  await settings.getByRole('button', { name: 'Done' }).click()
  await expect(settings).toBeHidden()
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add pocket' }).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 2' })).toBeVisible()
  await expect(
    inspector
      .getByRole('radiogroup', { name: 'Anchor' })
      .getByRole('radio', { name: 'Front left' }),
  ).toBeChecked()
  // still centred at (50, 30), 33 × 20: the position is its front-left corner
  await expect(input(inspector, 'Position X')).toHaveValue('33.5 mm')
  await expect(input(inspector, 'Position Y')).toHaveValue('20 mm')

  expect(dfyom.rendererErrors).toEqual([])
})
