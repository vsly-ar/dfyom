// Engraved patterns E3 in the built app: Add → Features → Engraved pattern adds the default motif
// (Waves, tiled since E4) on the top face, the Presets dialog picks Sunburst (one card click), the inspector's read-out
// and motif follow, and the owned Line is planned as its own operation in Plan. Windows stay hidden
// (app.fixture.ts). With DFYOM_E3_SHOTS=<dir> it writes dark captures of the inspector and the
// Presets dialog there (the UI review).
// Doc: docs/modes/engraved-patterns.md#implementation-e3
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './app.fixture'

const SHOTS = process.env['DFYOM_E3_SHOTS']

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

/** The dark theme, through Settings (captures only). */
async function dark(page: Page): Promise<void> {
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.getByRole('button', { name: 'Settings' }).click()
  await settings.getByRole('radio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await settings.getByRole('button', { name: 'Done' }).click()
  await expect(settings).toBeHidden()
}

test('engraving: add an engraved pattern, pick a preset, see it in Plan (E3)', async ({
  dfyom,
}) => {
  test.setTimeout(150_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const created = page.getByRole('dialog', { name: 'New project' })
  await created.getByRole('textbox', { name: 'Project name' }).fill('Coaster')
  await created.getByRole('button', { name: 'Create project' }).click()
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()
  if (SHOTS !== undefined) await dark(page)

  // ── Add → Features → Engraved pattern: the Waves, tiled ────────────────────────────────────
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page
    .getByRole('menu')
    .getByRole('group', { name: 'Features' })
    .getByRole('menuitem', { name: 'Engraved pattern' })
    .click()
  await expect(inspector.getByRole('heading', { name: 'Engraved pattern 1' })).toBeVisible()
  await expect(inspector.locator('[data-engraving-preset]')).toHaveText('Waves')
  await expect(inspector.locator('[data-engraving-readout]')).toContainText('tiles')
  await expect(inspector.getByRole('radio', { name: 'Clip' })).toBeChecked()

  // ── Presets…: Sunburst ─────────────────────────────────────────────────────────────────────
  await inspector.getByRole('button', { name: 'Presets…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Engraving presets' })
  await expect(dialog.getByRole('radio')).toHaveCount(13)
  await expect(dialog.getByRole('radio', { name: 'Waves' })).toBeFocused()
  if (SHOTS !== undefined) {
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/e3-presets-dialog-dark.png` })
  }
  await dialog.getByRole('radio', { name: 'Sunburst' }).click()
  await expect(dialog).toBeHidden()
  await expect(inspector.locator('[data-engraving-preset]')).toHaveText('Sunburst')
  await expect(inspector.locator('[data-engraving-readout]')).toContainText('38 lines')
  // the e2e library has no V-bit: the Line's 60° chamfer mill is a note (dfm.toolNotInLibrary,
  // info), listed in the status bar but not counted as a warning (ui.md § Severity)
  const status = page.getByRole('contentinfo', { name: 'Status bar' })
  await status.getByRole('button', { name: /warning/ }).click()
  const findings = page.getByRole('dialog', { name: 'Warnings' })
  await expect(
    findings.getByText(/^Plan needs a 60° chamfer mill .*: add one to the library\.$/),
  ).toBeVisible()
  await expect(status.getByRole('button', { name: '0 warnings' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(findings).toBeHidden()
  // the margin is an ordinary field: one update
  await setField(inspector, 'Margin', '5')
  await expect(
    inspector.getByLabel('Margin', { exact: true }).and(inspector.locator('input')),
  ).toHaveValue(/^5/)
  if (SHOTS !== undefined) {
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/e3-inspector-dark.png` })
  }

  // ── Plan: the owned Line is a plan operation ───────────────────────────────────────────────
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
    .getByRole('button', { name: /Engraved pattern 1/ })
  await expect(planned).toHaveCount(1)
  expect(dfyom.rendererErrors).toEqual([])
})
