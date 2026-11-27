// Clones mirror M2 (hardening DF126) in the built app: a 10 × 6 pocket at (20, 30) on a
// 100 × 60 part, Make Clones… with its offset row (Step X 15), Add row → Mirror about the stock
// centre in u (+X), Make clones: 4 instances (the source at u 20, its clone at 35, their mirrors
// at 80 and 65), the mirror line and its label in the viewport, the navigator's "mirrored"
// instance rows and the instance inspector's position. With DFYOM_M2_DIR set it also captures
// light and dark renders of the Clones with its mirror row open (review captures, not asserted).
// Windows stay hidden (app.fixture.ts).
// Docs: docs/modes/clones-mirror.md#implementation-m2, docs/conventions/ui.md#clones
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './app.fixture'

const SHOTS = process.env['DFYOM_M2_DIR']

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

/** `name`-light.png and -dark.png of the window (only with DFYOM_M2_DIR). */
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
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(dir, `${name}-${theme}.png`) })
  }
}

test('clones mirror: a linear row, then Mirror about the stock centre in X', async ({ dfyom }) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (SHOTS !== undefined) await page.setViewportSize({ width: 1440, height: 900 })
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  // ── a 100 × 60 × 12 part with a 10 × 6 pocket at (20, 30) ────────────────────────────────
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Mirror')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const stock = page.getByRole('dialog', { name: 'Stock' })
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '100')
  await setField(setup, 'Width (Y)', '60')
  await setField(setup, 'Thickness (Z)', '12')
  await stock.getByRole('button', { name: 'Create part' }).click()
  await expect(stock).toBeHidden()
  await navigator.getByRole('button', { name: 'Add pocket' }).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()
  await setField(inspector, 'Length (X)', '10')
  await setField(inspector, 'Width (Y)', '6')
  await setField(inspector, 'Depth', '3')
  await setField(inspector, 'Position X', '20')
  await setField(inspector, 'Position Y', '30')
  await expect(
    inspector.getByLabel('Position X', { exact: true }).and(inspector.locator('input')),
  ).toHaveValue(/^20( mm)?$/)

  // ── Make Clones…: the offset row by 15 in X, then Add row → Mirror ────────────────────────
  await navigator.getByRole('button', { name: /^Pocket 1/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Make Clones…' }).click()
  await expect(inspector.getByText('New Clones')).toBeVisible()
  const readout = inspector.getByText(/instances? ·/).first()
  await expect(readout).toHaveText('1 + 1 clone = 2 instances · 0 skipped')
  await setField(inspector, 'Step X', '15')
  await inspector.getByRole('button', { name: 'Add row' }).click()
  await page.getByRole('menuitem', { name: 'Mirror' }).click()
  await expect(inspector.getByRole('radio', { name: 'u (+X)' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(inspector.getByRole('combobox', { name: 'About' })).toHaveText(/Stock centre/)
  await expect(readout).toHaveText('1 + 3 clones = 4 instances · 0 on the line · 0 skipped')
  await expect(inspector.getByTestId('mirror-readout')).toHaveText('Mirrors 2')
  await shoot(page, 'm2-draft')
  await inspector.getByRole('button', { name: 'Make clones' }).click()

  const clones = navigator.getByRole('button', { name: /^Clones 1, ×4/ })
  await expect(clones).toHaveAttribute('aria-pressed', 'true')
  await expect(readout).toHaveText('1 + 3 clones = 4 instances · 0 on the line · 0 skipped')
  // the viewport: the mirror line's label and the mirrored instances' markers
  await expect(page.locator('[data-mirror-line]')).toHaveText('Mirror · stock centre')
  await expect(
    page.getByRole('button', { name: /^Clone 3 at u 80\.00 mm, v 30\.00 mm$/ }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: /^Clone 4 at u 65\.00 mm, v 30\.00 mm$/ }),
  ).toBeVisible()
  await inspector.getByRole('button', { name: /^Row 2: Mirror/ }).click()
  await expect(inspector.getByRole('combobox', { name: 'About' })).toBeVisible()
  await shoot(page, 'm2-clones-mirror')

  // the navigator: the mirror copies say so; the instance inspector has their place
  await clones.press('ArrowRight')
  await navigator.getByRole('button', { name: /^\d+ clones?$/ }).click()
  const instances = navigator.getByRole('list', { name: 'Instances of Clones 1' })
  await expect(instances.getByRole('button', { name: /^Clone \d/ })).toHaveCount(3)
  await expect(instances.getByRole('button', { name: 'Clone 3, mirrored' })).toBeVisible()
  await instances.getByRole('button', { name: 'Clone 4, mirrored' }).click()
  await expect(inspector.getByText('Clone 4 of Clones 1')).toBeVisible()
  await expect(inspector.getByText('u 65.00 mm, v 30.00 mm')).toBeVisible()
  await expect(inspector.getByText('In u (+X)')).toBeVisible()
  await shoot(page, 'm2-instance')
})
