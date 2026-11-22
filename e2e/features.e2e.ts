// v0.4 feature UI in the built app (task U1), through roles and labels: Add → Features → Add
// hole adds a feature row, the row expands to its owned operations, an owned operation's
// inspector is read-only ("Edited through Hole 1") and its link opens the hole, Make Clones…
// clones the hole with Source and Clones groups under the Clones row. Windows stay hidden
// (app.fixture.ts). With DFYOM_RENDERS=1 it also writes the light and dark review renders to
// design/features/renders/ (ui.md § Features (v0.4), visuals reviewed in L2).
// Docs: docs/conventions/ui.md#features-v04, docs/modes/features.md
import { resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './app.fixture'

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

async function render(page: Page, name: string): Promise<void> {
  if (!RENDERS) return
  const settings = page.getByRole('dialog', { name: 'Settings' })
  for (const theme of ['light', 'dark'] as const) {
    await page.getByRole('button', { name: 'Settings' }).click()
    await settings.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await settings.getByRole('button', { name: 'Done' }).click()
    await expect(settings).toBeHidden()
    // let the theme and row transitions settle
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${rendersDir}/u1-${name}-${theme}.png` })
  }
}

test('features: add a hole, expand its row, the owned inspector is read-only, Make Clones…', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Features')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const setup = navigator.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '100')
  await setField(setup, 'Width (Y)', '60')
  await setField(setup, 'Thickness (Z)', '20')
  await setup.getByRole('button', { name: 'Create part' }).click()
  await navigator.getByRole('button', { name: 'Add pocket' }).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()

  // ── Add → Features → Add hole ────────────────────────────────────────────────────────────
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('group', { name: 'Operations' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Add chamfer' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await menu
    .getByRole('group', { name: 'Features' })
    .getByRole('menuitem', { name: 'Add hole' })
    .click()
  const hole = navigator.getByRole('button', { name: /^Hole 1, Ø 6 mm simple, 1 operation/ })
  await expect(hole).toHaveAttribute('aria-pressed', 'true')
  await expect(hole).toHaveAttribute('aria-expanded', 'false')
  await expect(inspector.getByRole('heading', { name: 'Hole 1' })).toBeVisible()

  // ── the row expands to its owned operation ───────────────────────────────────────────────
  await hole.press('ArrowRight')
  await expect(hole).toHaveAttribute('aria-expanded', 'true')
  const drill = navigator.getByRole('button', { name: 'Hole 1 · drill, edited through Hole 1' })
  await expect(drill).toBeVisible()
  await render(page, 'hole-row')

  // ── the owned operation's inspector is read-only ─────────────────────────────────────────
  await drill.click()
  await expect(inspector.getByRole('heading', { name: 'Hole 1 · drill' })).toBeVisible()
  await expect(inspector.getByText(/^Edited through/)).toBeVisible()
  const diameter = inspector.getByLabel('Diameter', { exact: true }).and(inspector.locator('input'))
  await expect(diameter).toHaveAttribute('readonly', '')
  await expect(diameter).toHaveAccessibleDescription(/Part of Hole 1: change it in the hole\./)
  await render(page, 'owned-inspector')
  // its link opens the hole
  await inspector
    .getByText(/^Edited through/)
    .getByRole('button', { name: 'Hole 1' })
    .click()
  await expect(inspector.getByRole('heading', { name: 'Hole 1' })).toBeVisible()

  // ── Make Clones… of the selected hole ───────────────────────────────────────────────────
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Make Clones…' }).click()
  const clones = navigator.getByRole('button', { name: /^Clones 1, ×2/ })
  await expect(clones).toHaveAttribute('aria-pressed', 'true')
  await clones.press('ArrowRight')
  await expect(navigator.getByRole('list', { name: 'Source of Clones 1' })).toContainText('Hole 1')
  await navigator.getByRole('button', { name: /^Clones\s*1$/ }).click()
  await expect(navigator.getByRole('list', { name: 'Instances of Clones 1' })).toContainText(
    'Clone 2',
  )
  await render(page, 'clones-row')

  expect(dfyom.rendererErrors).toEqual([])
})
