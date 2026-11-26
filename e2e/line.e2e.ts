// Engraved patterns E1 in the built app: Add → Operations → Line adds a Line on a new wave shape
// (the part has no shape yet), its inspector switches the depth to Start → end, and the Line is
// planned as its own operation in Plan. Windows stay hidden (app.fixture.ts).
// Docs: docs/modes/engraved-patterns.md#implementation-e1, docs/conventions/ui.md
import type { Locator } from '@playwright/test'
import { expect, test } from './app.fixture'

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

test('line: add a Line in Design, see it in Plan', async ({ dfyom }) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Lines')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()

  // ── Add → Operations → Line ────────────────────────────────────────────────────────────────
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page
    .getByRole('menu')
    .getByRole('group', { name: 'Operations' })
    .getByRole('menuitem', { name: 'Line' })
    .click()
  await expect(inspector.getByRole('heading', { name: 'Line 1' })).toBeVisible()
  // the depth: constant 0.5 mm, then Start → end
  await expect(
    inspector.getByLabel('Depth', { exact: true }).and(inspector.locator('input')),
  ).toHaveValue(/^0\.5/)
  await inspector.getByRole('radio', { name: 'Start → end' }).click()
  await setField(inspector, 'At end', '1.2')
  await expect(
    inspector.getByLabel('At end', { exact: true }).and(inspector.locator('input')),
  ).toHaveValue(/^1\.2/)

  // ── Plan: the Line is a plan operation of its own ──────────────────────────────────────────
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByRole('radio', { name: 'Plan' })).toBeChecked()
  const start = page.getByRole('dialog', { name: 'Plan the part' })
  await start.getByRole('button', { name: 'New machine…' }).click()
  const newMachine = page.getByRole('dialog', { name: 'New machine' })
  await newMachine.getByRole('textbox', { name: 'Name' }).fill('Router')
  await setField(newMachine, 'Travel Z', '100')
  await newMachine.getByRole('button', { name: 'Add machine' }).click()
  await expect(newMachine).toBeHidden()
  await start.getByRole('button', { name: 'Create plan' }).click()
  await expect(start).toBeHidden()
  const planned = navigator
    .getByRole('list', { name: 'Setups in machining order' })
    .getByRole('list', { name: 'Plan operations in machining order' })
    .getByRole('button', { name: /^Line 1/ })
  await expect(planned).toHaveCount(1)
  expect(dfyom.rendererErrors).toEqual([])
})
