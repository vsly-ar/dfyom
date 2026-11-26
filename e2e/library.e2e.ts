// The Library window in the built app (task L1, hidden like every window): the toolbar's
// "Library" opens one window (again: the same one), a new tool is drafted ("Unsaved") and saved,
// then edited and saved again, and the design tool field lists it. The context link "Edit in
// library" is not used here (plan mode); the leave prompt and conflicts are covered by component
// tests. Docs: docs/conventions/ui-library-window.md, docs/conventions/testing.md#end-to-end
import { resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import {
  closeApp,
  closeDialog,
  expect,
  openInspectorGroup,
  openInspectorTab,
  revealField,
  test,
} from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

/** With DFYOM_RENDERS=1: the Library window in light and dark (the theme is set in `main`). */
async function render(main: Page, lib: Page, name: string): Promise<void> {
  if (!RENDERS) return
  const settings = main.getByRole('dialog', { name: 'Settings' })
  for (const theme of ['light', 'dark'] as const) {
    await main.getByRole('button', { name: 'Settings' }).click()
    await settings.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark' }).click()
    await settings.getByRole('button', { name: 'Done' }).click()
    await expect(lib.locator('html')).toHaveAttribute('data-theme', theme)
    await lib.waitForTimeout(400)
    await lib.screenshot({ path: `${rendersDir}/${name}-${theme}.png` })
  }
}

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
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()
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

test('library window: a new chamfer mill with its angle, tip and drawing (U4)', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Chamfer mills')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  // no part (B1: the app used to be closed with a part only, see the last test)
  await closeDialog(page.getByRole('dialog', { name: 'Stock' }), 'Cancel')

  const opened = dfyom.app.waitForEvent('window')
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  const lib = await opened
  await lib.waitForLoadState('domcontentloaded')
  if (RENDERS) await lib.setViewportSize({ width: 1100, height: 760 })
  await lib.getByRole('button', { name: 'New tool' }).click()
  const editor = lib.getByRole('region', { name: 'Item editor' })
  const grid = lib.getByRole('grid', { name: 'Tools' })

  // the type is offered for new tools, with "V-bit" in its hint
  await editor.getByRole('combobox', { name: 'Type' }).click()
  const option = lib.getByRole('option', { name: 'Chamfer mill' })
  await expect(option).toContainText('V-bit')
  await option.click()
  await expect(input(editor, 'Tip diameter')).toHaveAttribute('placeholder', '0: pointed')
  await setField(editor, 'Diameter', '12')
  await expect(editor.getByRole('heading', { name: 'Chamfer 90° Ø12' })).toBeVisible()
  // the drawing: the cone with its tip flat, the focused dimension highlighted
  await input(editor, 'Included angle').focus()
  await expect(
    editor.getByRole('img', { name: 'Tool drawing: included angle highlighted' }),
  ).toBeVisible()
  await render(page, lib, 'u4-chamfer-mill')
  // material, coating and notes wait in the collapsed Details group (DF1)
  const details = editor.getByRole('button', { name: /^Details/ })
  await expect(details).toHaveAttribute('aria-expanded', 'false')
  await expect(editor.getByRole('combobox', { name: 'Tool material' })).toHaveCount(0)
  await details.click()
  await expect(details).toHaveAttribute('aria-expanded', 'true')
  await editor.getByRole('textbox', { name: 'Notes' }).scrollIntoViewIfNeeded()
  await expect(editor.getByRole('combobox', { name: 'Tool material' })).toBeVisible()
  await render(page, lib, 'df1-tool-details')
  await editor.getByRole('button', { name: 'Save' }).click()
  // the saved row is listed a moment before the draft row goes: wait for the draft row to go
  await expect(grid.getByRole('row', { name: /Unsaved/ })).toHaveCount(0)
  const row = grid.getByRole('row', { name: /Chamfer 90° Ø12/ })
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await expect(row).toContainText('90°')
  await expect(row).not.toContainText('Unsaved')
  expect(dfyom.rendererErrors).toEqual([])
})

test('library window: a new machine in the tabs Machine / Motion / Spindle (DF110 S6)', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const opened = dfyom.app.waitForEvent('window')
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  const lib = await opened
  await lib.waitForLoadState('domcontentloaded')
  await lib.getByRole('tab', { name: 'Machines' }).click()
  await lib.getByRole('button', { name: 'New machine' }).click()
  const editor = lib.getByRole('region', { name: 'Item editor' })
  const grid = lib.getByRole('grid', { name: 'Machines' })
  await editor.getByRole('textbox', { name: 'Name' }).fill('Shop router')
  // Machine (first): travel; the feeds are on Motion, the spindle on Spindle
  await expect(editor.getByRole('tab', { name: 'Machine', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await setField(editor, 'Travel X', '750')
  await expect(input(editor, 'Max feed rate X')).toBeHidden()
  await openInspectorTab(editor, 'Motion')
  await setField(editor, 'Max feed rate X', '6000')
  await openInspectorTab(editor, 'Spindle')
  await setField(editor, 'Max spindle speed', '24000')
  // a field on another tab is revealed like a message's target (its tab selected)
  await revealField(editor, 'Junction deviation')
  await expect(editor.getByRole('tab', { name: 'Motion' })).toHaveAttribute('aria-selected', 'true')
  await setField(editor, 'Junction deviation', '0.01')
  // notes wait in the closed Notes accordion of the Machine tab
  await openInspectorTab(editor, 'Machine')
  const notes = await openInspectorGroup(editor, 'Notes')
  await notes.getByRole('textbox', { name: 'Notes' }).fill('By the window')
  await editor.getByRole('button', { name: 'Save' }).click()
  await expect(grid.getByRole('row', { name: /Unsaved/ })).toHaveCount(0)
  const row = grid.getByRole('row', { name: /Shop router/ })
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await expect(row).toContainText('750')
  await expect(row).toContainText('24000')
  expect(dfyom.rendererErrors).toEqual([])
})

test('quitting with no part and an unsaved draft asks in the Library window, then quits (B1)', async ({
  dfyom,
}) => {
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page
    .getByRole('navigation', { name: 'Navigator' })
    .getByRole('button', { name: 'New project' })
    .click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('No part')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await closeDialog(page.getByRole('dialog', { name: 'Stock' }), 'Cancel')
  const opened = dfyom.app.waitForEvent('window')
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  const lib = await opened
  await lib.waitForLoadState('domcontentloaded')
  await lib.getByRole('button', { name: 'New tool' }).click()
  await expect(
    lib.getByRole('grid', { name: 'Tools' }).getByRole('row', { name: /Unsaved/ }),
  ).toBeVisible()
  // the quit waits for the draft's Save / Discard / Cancel; Discard lets it finish
  expect(await closeApp(dfyom.app)).toBe(1)
  expect(dfyom.app.windows()).toHaveLength(0)
  expect(dfyom.rendererErrors).toEqual([])
})
