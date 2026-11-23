// v0.2 operation tool field in the built app (task F5), through roles and labels: a new pocket
// has no tool until Apply; Apply chooses one ("Chosen automatically."); a corner edit committed
// with Tab waits ("Chosen again on Apply.", its checks "May change on Apply"); the Apply button
// swaps the tool and says why; the lock pins it as one undo step. Windows stay hidden
// (app.fixture.ts). Docs: docs/modes/design-v0.2.md#operation-tool,
// docs/conventions/ui.md#design-and-plan-controls-v02
import type { Locator } from '@playwright/test'
import { expect, test } from './app.fixture'

const input = (scope: Locator, label: string) =>
  scope.getByLabel(label, { exact: true }).and(scope.locator('input'))

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = input(scope, label)
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

test('tool field: auto choice on Apply with its reason, chosen again on Apply, lock', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Tools')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '100')
  await setField(setup, 'Width (Y)', '60')
  await setField(setup, 'Thickness (Z)', '20')
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()

  await navigator.getByRole('button', { name: 'Add pocket' }).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()
  const tool = inspector.getByRole('region', { name: 'Tool' })
  const combo = tool.getByRole('combobox', { name: 'Tool' })
  const lock = tool.getByRole('button', { name: 'Lock tool' })
  // added, not applied yet: no tool, the lock has nothing to pin
  await expect(combo).toHaveText('No tool yet')
  await expect(lock).toHaveAttribute('aria-disabled', 'true')

  // Cmd/Ctrl+Enter applies: the largest standard size that fits the 3 mm corner
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(combo).toHaveText('6 mm flat end mill')
  await expect(tool.getByText('Chosen automatically.', { exact: true })).toBeVisible()
  await expect(lock).toHaveAttribute('aria-pressed', 'false')

  // Enter applies: the 2 mm corner needs a smaller tool, and the field says why
  await setField(inspector, 'Corner radius', '2')
  await expect(combo).toHaveText('4 mm flat end mill')
  await expect(
    tool.getByText('Chosen automatically: the 6 mm flat end mill didn’t fit the 2 mm corner.'),
  ).toBeVisible()

  // Tab commits only: the tool is chosen again on Apply, its check may change
  const corner = input(inspector, 'Corner radius')
  await corner.fill('1.5')
  await corner.press('Tab')
  await expect(tool.getByText('Chosen again on Apply.')).toBeVisible()
  await expect(combo).toHaveAttribute('data-muted', 'true')
  await expect(
    tool.getByText(/^Corner radius 1.5 mm is smaller.*May change on Apply/),
  ).toBeVisible()
  await page.getByRole('button', { name: /^Apply \d+ changes?$/ }).click()
  await expect(combo).toHaveText('3 mm flat end mill')
  await expect(
    tool.getByText('Chosen automatically: the 4 mm flat end mill didn’t fit the 1.5 mm corner.'),
  ).toBeVisible()

  // the lock pins the tool (one undo step); the generalized option is listed with its note
  await lock.click()
  await expect(lock).toHaveAttribute('aria-pressed', 'true')
  await expect(tool.getByText('Chosen by you.')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(lock).toHaveAttribute('aria-pressed', 'false')
  await combo.click()
  const list = page.getByRole('listbox')
  // the generalized tool, then "New tool…" (no library tool fits)
  await expect(list.getByRole('group')).toHaveCount(2)
  await expect(list.getByRole('option', { name: /^New tool/ })).toBeVisible()
  await expect(
    list.getByRole('option', { name: '3 mm flat end mill' }),
  ).toHaveAccessibleDescription('Type and size only: Plan uses a matching library tool.')
  await page.keyboard.press('Escape')

  expect(dfyom.rendererErrors).toEqual([])
})
