// Patterns P1 in the built app: Add → Features → Pattern adds a pattern feature with the defaults
// on the stock top, the minimal inspector shows the cell read-out, and its Lattice and Cell
// fields update the pattern (one `design.pattern.update` each). Windows stay hidden
// (app.fixture.ts). Docs: docs/modes/patterns.md#implementation-p1, docs/conventions/ui.md
import type { Locator } from '@playwright/test'
import { expect, test } from './app.fixture'

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

test('patterns: add a pattern, change its lattice and cell', async ({ dfyom }) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Patterns')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const stock = page.getByRole('dialog', { name: 'Stock' })
  await expect(stock).toBeVisible()
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '100')
  await setField(setup, 'Width (Y)', '72')
  await setField(setup, 'Thickness (Z)', '12')
  await stock.getByRole('button', { name: 'Create part' }).click()
  await expect(stock).toBeHidden()
  await navigator.getByRole('button', { name: 'Add pocket' }).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()

  // ── Add → Features → Pattern ───────────────────────────────────────────────────────────────
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page
    .getByRole('menu')
    .getByRole('group', { name: 'Features' })
    .getByRole('menuitem', { name: 'Pattern' })
    .click()
  await expect(inspector.getByRole('heading', { name: 'Pattern 1' })).toBeVisible()
  const readout = inspector.locator('[data-pattern-readout]')
  await expect(readout).toHaveText(/^\d+ cells$/)
  const staggered = Number((await readout.textContent())?.split(' ')[0])
  expect(staggered).toBeGreaterThan(10)
  await expect(
    navigator.getByRole('button', { name: /^Pattern 1, staggered circle/ }),
  ).toBeVisible()

  // ── Layout: Hex packs more circles than staggered rows at the same gap ─────────────────────
  await inspector.getByRole('radio', { name: 'Hex' }).click()
  await expect(navigator.getByRole('button', { name: /^Pattern 1, hex circle/ })).toBeVisible()
  await expect(readout).not.toHaveText(`${staggered} cells`)
  expect(Number((await readout.textContent())?.split(' ')[0])).toBeGreaterThan(staggered)

  // ── Cell: a larger diameter leaves fewer cells ─────────────────────────────────────────────
  const hex = Number((await readout.textContent())?.split(' ')[0])
  await setField(inspector, 'Diameter', '12')
  await expect(readout).not.toHaveText(`${hex} cells`)
  expect(Number((await readout.textContent())?.split(' ')[0])).toBeLessThan(hex)
})
