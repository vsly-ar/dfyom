// Patterns P1 in the built app: Add → Features → Pattern adds a pattern feature with the defaults
// on the stock top, the minimal inspector shows the cell read-out, and its Lattice and Cell
// fields update the pattern (one `design.pattern.update` each). P2: a preset, the Polar lattice,
// Clip and Invert. P3: the Chamfer switch and its width. P4: the Through switch. P5: the chamfer's
// Edges (Both shows the bottom V-bit) and the Triangles preset's Flip. DF107: the Presets dialog
// (preview cards, Current, arrow keys, Enter applies; P10: the polar rings and Close). DF108: the
// Roughing switch and its tool.
// Windows stay hidden (app.fixture.ts).
// Docs: docs/modes/patterns.md#implementation-p1, #implementation-p2, #implementation-p3, #implementation-p4,
// #implementation-p5, #implementation-df107df109,
// docs/conventions/ui.md
import type { Locator } from '@playwright/test'
import { expect, revealField, test } from './app.fixture'

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
    .getByRole('menuitem', { name: 'Pattern', exact: true })
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

  // ── P2: the Grille preset (Ø 3, hex, gap 1.5) packs many more cells ────────────────────────
  const large = Number((await readout.textContent())?.split(' ')[0])
  await inspector.getByRole('button', { name: 'Presets…' }).click()
  // DF107: a dialog of preview cards, one radio group; every card draws its lattice
  const presets = page.getByRole('dialog', { name: 'Pattern presets' })
  // H1: the cards' radio group (the group control above it is another)
  const cards = presets.getByRole('radiogroup', { name: 'Pattern presets' }).getByRole('radio')
  await expect(cards).toHaveCount(13)
  for (const card of await cards.all())
    await expect(card.locator('svg path').first()).toBeAttached()
  // the default pattern is no preset: nothing Current, the first card focused
  await expect(presets.getByText('Current')).toHaveCount(0)
  await expect(cards.first()).toBeFocused()
  // arrows move the focus (Down a row of 4), Escape closes without a change
  await page.keyboard.press('ArrowRight')
  await expect(presets.getByRole('radio', { name: 'Honeycomb', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(presets.getByRole('radio', { name: 'Slots', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(presets).toBeHidden()
  await expect(readout).toHaveText(`${large} cells`)
  // Enter applies the focused card and closes (one update)
  await inspector.getByRole('button', { name: 'Presets…' }).click()
  await presets.getByRole('radio', { name: 'Grille', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(presets).toBeHidden()
  await expect(readout).not.toHaveText(`${large} cells`)
  expect(Number((await readout.textContent())?.split(' ')[0])).toBeGreaterThan(large * 3)
  const grilleCells = await readout.textContent()
  // reopened: Grille is Current and has focus
  await inspector.getByRole('button', { name: 'Presets…' }).click()
  const grille = presets.getByRole('radio', { name: 'Grille', exact: true })
  await expect(grille).toHaveAttribute('aria-checked', 'true')
  await expect(grille).toBeFocused()
  await expect(grille.getByText('Current')).toBeVisible()
  // P10: the polar Speaker grille draws its rings; the footer's Close closes without a change
  const speaker = presets.getByRole('radio', { name: 'Speaker grille', exact: true })
  await expect(speaker.locator('circle[data-ring]').first()).toBeAttached()
  await presets.getByRole('button', { name: 'Close' }).click()
  await expect(presets).toBeHidden()
  await expect(readout).toHaveText(grilleCells!)

  // ── DF108: Roughing adds the roughing tool's field; off removes it ─────────────────────────
  // Boundary cells and Invert sit behind More rows, Chamfer in an accordion (DF110 S4), Roughing
  // in its own accordion (DF122 R2, roughing.md#implementation-r2)
  await revealField(inspector, 'Roughing')
  const roughing = inspector.getByRole('switch', { name: 'Roughing' })
  const roughingTool = inspector.locator('[data-feature-field="roughing.tool"]')
  await expect(roughing).not.toBeChecked()
  await expect(roughingTool).toBeHidden()
  await roughing.click()
  await expect(roughing).toBeChecked()
  await expect(roughingTool).toBeVisible()
  await expect(
    inspector.getByLabel('Leave on walls', { exact: true }).and(inspector.locator('input')),
  ).toBeVisible()
  await roughing.click()
  await expect(roughing).not.toBeChecked()
  await expect(roughingTool).toBeHidden()

  // ── Polar rings, cells clipped at the border, then inverted (islands) ──────────────────────
  await inspector.getByRole('radio', { name: 'Polar' }).click()
  await expect(navigator.getByRole('button', { name: /^Pattern 1, polar circle/ })).toBeVisible()
  await revealField(inspector, 'Boundary cells')
  await inspector.getByRole('radio', { name: 'Clip' }).click()
  await expect(inspector.getByRole('radio', { name: 'Clip' })).toBeChecked()
  const invert = inspector.getByRole('switch', { name: 'Invert (cells as islands)' })
  await invert.click()
  await expect(invert).toBeChecked()
  await expect(readout).toHaveText(/^\d+ cells/)

  // ── P3: the chamfer round every island, then narrower ──────────────────────────────────────
  await revealField(inspector, 'Chamfer every cell')
  const chamfer = inspector.getByRole('switch', { name: 'Chamfer every cell' })
  await expect(chamfer).not.toBeChecked()
  await chamfer.click()
  await expect(chamfer).toBeChecked()
  const width = inspector
    .getByLabel('Chamfer width', { exact: true })
    .and(inspector.locator('input'))
  await expect(width).toHaveValue(/0\.5/)
  await setField(inspector, 'Chamfer width', '0.3')
  await expect(width).toHaveValue(/0\.3/)
  await expect(inspector.locator('[data-feature-field="chamfer.tool"]')).toBeVisible()

  // ── P4: through cells (not inverted: islands would come loose); Depth hides meanwhile ───────
  await invert.click()
  await expect(invert).not.toBeChecked()
  const through = inspector.getByRole('switch', { name: 'Through' })
  await expect(through).not.toBeChecked()
  const depth = inspector.locator('[data-feature-field="depth"]')
  await expect(depth).toBeVisible()
  await through.click()
  await expect(through).toBeChecked()
  await expect(depth).toBeHidden()
  await expect(inspector.getByText(/cut through the stock and cleared/)).toBeVisible()

  // ── P5: through cells chamfered on both faces (the bottom from a flipped setup) ────────────
  const side = inspector.locator('[data-feature-field="chamfer.side"]')
  const bottomTool = inspector.locator('[data-feature-field="chamfer.bottomTool"]')
  await expect(bottomTool).toBeHidden()
  await side.getByRole('radio', { name: 'Both' }).click()
  await expect(side.getByRole('radio', { name: 'Both' })).toBeChecked()
  await expect(bottomTool).toBeVisible()
  await expect(inspector.getByText(/cut from a flipped setup/)).toBeVisible()
  await side.getByRole('radio', { name: 'Top' }).click()
  await expect(bottomTool).toBeHidden()
  await through.click()
  await expect(through).not.toBeChecked()
  await expect(depth).toBeVisible()

  // ── P5: the Triangles preset turns every other cell (Flip) ─────────────────────────────────
  await revealField(inspector, 'Flip every other cell')
  const flip = inspector.getByRole('switch', { name: 'Flip every other cell' })
  await expect(flip).not.toBeChecked()
  await inspector.getByRole('button', { name: 'Presets…' }).click()
  await page
    .getByRole('dialog', { name: 'Pattern presets' })
    .getByRole('radio', { name: 'Triangles', exact: true })
    .click()
  await expect(flip).toBeChecked()
  await expect(inspector.getByText(/so triangles nest/)).toBeVisible()
  await flip.click()
  await expect(flip).not.toBeChecked()
})
