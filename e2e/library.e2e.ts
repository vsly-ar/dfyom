// The Library window in the built app (task L1, hidden like every window): the toolbar's
// "Library" opens one window (again: the same one), a new tool is drafted ("Unsaved") and saved,
// then edited and saved again, and the design tool field lists it. The context link "Edit in
// library" is not used here (plan mode); the leave prompt and conflicts are covered by component
// tests. Docs: docs/conventions/ui-library-window.md, docs/conventions/testing.md#end-to-end
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

test('library window: add and edit a tool, see it in the design tool field', async ({ dfyom }) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Shop')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const setup = navigator.getByRole('region', { name: 'Set up the part' })
  await setup.getByRole('button', { name: 'Create part' }).click()
  await navigator.getByRole('button', { name: 'Add pocket' }).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Enter')
  const tool = inspector.getByRole('region', { name: 'Tool' })
  const combo = tool.getByRole('combobox', { name: 'Tool' })
  await expect(combo).toHaveText('6 mm flat end mill')

  // the toolbar's Library button opens the one Library window
  const opened = dfyom.app.waitForEvent('window')
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  const lib = await opened
  await lib.waitForLoadState('domcontentloaded')
  await expect(lib).toHaveTitle(/Library/)
  await expect(lib.getByRole('tab', { name: 'Tools' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await expect.poll(() => dfyom.app.windows().length).toBe(2)

  // a new tool: drafted ("Unsaved"), then saved
  await lib.getByRole('button', { name: 'New tool' }).click()
  const editor = lib.getByRole('region', { name: 'Item editor' })
  const grid = lib.getByRole('grid', { name: 'Tools' })
  await expect(grid.getByRole('row', { name: /Unsaved/ })).toBeVisible()
  await editor.getByRole('textbox', { name: 'Name' }).fill('Shop flat 6')
  await setField(editor, 'Flute length', '18')
  await editor.getByRole('button', { name: 'Save' }).click()
  const row = grid.getByRole('row', { name: /Shop flat 6/ })
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await expect(grid.getByRole('row', { name: /Unsaved/ })).toHaveCount(0)

  // edit it: the focused dimension is highlighted in the drawing; Ctrl/Cmd+S saves
  const lcf = input(editor, 'Flute length')
  await lcf.focus()
  await expect(editor.getByRole('img', { name: 'Tool drawing: LCF highlighted' })).toBeVisible()
  await editor.getByRole('textbox', { name: 'Name' }).fill('Shop flat 6 long')
  await expect(row).toContainText('Unsaved')
  await lib.keyboard.press('ControlOrMeta+s')
  await expect(grid.getByRole('row', { name: /Shop flat 6 long/ })).not.toContainText('Unsaved')

  // the design tool field lists it (it fits the pocket's 3 mm corner)
  await combo.click()
  const listbox = page.getByRole('listbox')
  await expect(listbox.getByRole('option', { name: /^Shop flat 6 long · Ø 6 mm/ })).toBeVisible()
  await listbox.getByRole('option', { name: /^Shop flat 6 long/ }).click()
  await expect(combo).toHaveText(/Shop flat 6 long/)
  expect(dfyom.rendererErrors).toEqual([])
})
