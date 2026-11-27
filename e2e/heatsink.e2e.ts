// Heatsink presets H1 (pattern-presets.md, TG #445) in the built app: the user's heatsink through
// the dialog. A 40 × 40 × 14 part, Add → Pattern, Presets… → Heatsink → Straight fins opens the
// parameter step (fins 1.5, slots 2, 10 high, wall 1.5, the library's Ø 2 picked as the slot
// tool); Apply fills the pattern and sets the tool in one undo step, and the inspector reads it
// as a heatsink: "11 slots · 12 fins 1.5 mm · 10 mm high (1:6.7) · base 4 mm". With
// DFYOM_H1_DIR set it captures light and dark renders of the step and the part (review captures).
// Windows stay hidden (app.fixture.ts).
// Docs: docs/modes/pattern-presets.md#implementation-h1, docs/conventions/ui.md
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const SHOTS = process.env['DFYOM_H1_DIR']

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

/** `name`-light.png and -dark.png of the window (only with DFYOM_H1_DIR). */
async function shoot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return
  const dir = resolve(SHOTS)
  mkdirSync(dir, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    // runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`
    await page.evaluate((t) => {
      const doc = (
        globalThis as unknown as {
          document: { documentElement: { setAttribute(n: string, v: string): void } }
        }
      ).document
      doc.documentElement.setAttribute('data-theme', t)
    }, theme)
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(dir, `${name}-${theme}.png`) })
  }
}

test('heatsink: straight fins through the Presets dialog', async ({ dfyom }) => {
  test.setTimeout(150_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (SHOTS !== undefined) await page.setViewportSize({ width: 1440, height: 900 })
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const call = (name: string, args: object) =>
    page.evaluate(([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a), [
      name,
      args,
    ] as const)
  // the slot tool (12 mm flutes) and a Ø 3 that does not fit the 2 mm slot
  for (const [name, diameter] of [
    ['Flat 2 x 12', '2'],
    ['Flat 3', '3'],
  ] as const) {
    const added = await call('library.tool.add', {
      values: {
        name,
        type: 'flatEndMill',
        diameter,
        fluteLength: '12',
        overallLength: '50',
        fluteCount: '2',
        toolMaterial: 'carbide',
        presets: [],
      },
    })
    expect(added.ok, JSON.stringify(added)).toBe(true)
  }

  // ── a 40 × 40 × 14 part with a pattern on its top ──────────────────────────────────────────
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Heatsink')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const stock = page.getByRole('dialog', { name: 'Stock' })
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '40')
  await setField(setup, 'Width (Y)', '40')
  await setField(setup, 'Thickness (Z)', '14')
  await stock.getByRole('button', { name: 'Create part' }).click()
  await expect(stock).toBeHidden()
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page
    .getByRole('menu')
    .getByRole('group', { name: 'Features' })
    .getByRole('menuitem', { name: 'Pattern', exact: true })
    .click()
  await expect(inspector.getByRole('heading', { name: 'Pattern 1' })).toBeVisible()
  const readout = inspector.locator('[data-pattern-readout]')
  await expect(readout).toHaveText(/^\d+ cells/)

  // ── Presets… → Heatsink → Straight fins: the parameter step ───────────────────────────────
  await inspector.getByRole('button', { name: 'Presets…' }).click()
  const presets = page.getByRole('dialog', { name: 'Pattern presets' })
  await presets.getByRole('radio', { name: 'Heatsink' }).click()
  await presets.getByRole('radio', { name: 'Straight fins' }).click()
  const step = presets.locator('[data-heatsink-step]')
  await expect(step).toBeVisible()
  await expect(presets.locator('[data-heatsink-readout]')).toHaveText(
    '11 slots · 12 fins 1.5 mm · 10 mm high (1:6.7) · base 4 mm · walls 1.5 mm',
  )
  await expect(presets.getByRole('combobox', { name: 'Tool' })).toHaveText(/Flat 2 x 12/)
  await expect(step).toContainText('Slot = tool: one pass per level.')
  await shoot(page, 'h1-step')
  // Escape goes back to the cards, the card again to the step
  await page.keyboard.press('Escape')
  await expect(step).toBeHidden()
  await presets.getByRole('radio', { name: 'Straight fins' }).click()
  await presets.getByRole('button', { name: 'Apply' }).click()
  await expect(presets).toBeHidden()

  // ── the pattern reads as the heatsink; the pocket's tool is the Ø 2 ───────────────────────
  await expect(readout).toHaveText('11 slots · 12 fins 1.5 mm · 10 mm high (1:6.7) · base 4 mm')
  await expect(inspector.locator('[data-feature-field="margin.0"] input')).toHaveValue(/1\.5/)
  await expect(inspector.locator('[data-feature-field="margin.1"] input')).toHaveValue(/^0/)
  await expect(inspector.getByText('Flat 2 x 12').first()).toBeVisible()
  // the slot rule cuts the slots whole: no rest material, no finding
  await expect(page.getByText('0 warnings')).toBeVisible()
  await shoot(page, 'h1-part')
  // one undo step takes back the fields and the tool
  await page.keyboard.press('ControlOrMeta+z')
  await expect(readout).toHaveText(/^\d+ cells/)
  await expect(inspector.getByText('Flat 2 x 12')).toHaveCount(0)
})
