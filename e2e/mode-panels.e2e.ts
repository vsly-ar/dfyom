// Mode switching in the built app (hidden like every window): side panels remembered per mode
// (DF30: the navigator closed in design stays open in plan and is closed again back in design),
// the Plan start card over the view without a plan (DF29: non-modal, the view around it still
// takes the pointer) and the "Auto-apply after" setting (DF28). With DFYOM_RENDERS=1 it writes
// the review renders df29-plan-start-{light,dark}.png and df28-settings-{light,dark}.png.
// Docs: docs/conventions/ui.md#mode-switching, #plan-start-df29, docs/architecture/apply.md#auto-apply-df28
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

/** With DFYOM_RENDERS=1: light and dark; `before` reopens what the Settings dialog closed. */
async function render(page: Page, name: string, before?: () => Promise<void>): Promise<void> {
  if (!RENDERS) return
  const settings = page.getByRole('dialog', { name: 'Settings' })
  for (const theme of ['light', 'dark'] as const) {
    if (!(await settings.isVisible())) await page.getByRole('button', { name: 'Settings' }).click()
    await settings.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    if (before === undefined) {
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${rendersDir}/${name}-${theme}.png` })
      continue
    }
    await settings.getByRole('button', { name: 'Done' }).click()
    await expect(settings).toBeHidden()
    await before()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${rendersDir}/${name}-${theme}.png` })
  }
}

test('mode switch: side panels per mode, the Plan start card, the auto-apply setting', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1280, height: 800 })
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Panels')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await page
    .getByRole('region', { name: 'Set up the part' })
    .getByRole('button', { name: 'Create part' })
    .click()

  // DF30: close the navigator in design; plan was never toggled, so it shows both panels
  const toggle = page.getByRole('button', { name: 'Navigator', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByRole('radio', { name: 'Plan' })).toBeChecked()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(navigator.getByText('No plan yet: create one in the view.')).toBeVisible()

  // DF29: the card over the view, non-modal; the view around it still takes the pointer
  const start = page.getByRole('dialog', { name: 'Plan the part' })
  await expect(start).toBeVisible()
  await expect(start).toHaveAttribute('aria-modal', 'false')
  await expect(start.getByRole('button', { name: 'Create plan' })).toBeVisible()
  const view = page.getByRole('region', { name: '3D viewport' })
  const box = (await view.boundingBox())!
  // a point near the view's bottom-left corner hits the canvas, not the card's layer
  const [x, y] = [box.x + 12, box.y + box.height - 12]
  const free = await page.evaluate<boolean>(
    `(() => { const e = document.elementFromPoint(${x}, ${y}); return e !== null && e.closest('[role="dialog"]') === null && getComputedStyle(e).pointerEvents !== 'none' })()`,
  )
  expect(free).toBe(true)
  await render(page, 'df29-plan-start', async () => {
    await expect(start).toBeVisible()
  })
  await page.keyboard.press('Escape')
  await expect(start).toBeVisible()

  // back in design: its navigator is closed again
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByRole('radio', { name: 'Design' })).toBeChecked()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  // DF28: the auto-apply setting, 10 s by default
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('combobox', { name: 'Auto-apply after' })).toHaveText(/10 s/)
  await render(page, 'df28-settings')
  await settings.getByRole('button', { name: 'Done' }).click()
  expect(dfyom.rendererErrors).toEqual([])
})
