// UX audit fixes of DF45 in the built app (hidden like every window), through roles and names:
// the undo toast shows bottom-centre over the 3D view, never over the inspector, and closes by
// itself; the Plan start card's Machine field (an empty library disables "Create plan" with the
// reason, "New machine…" chooses the machine it adds); the Toolpaths panel's primary is the next
// step (Generate while toolpaths are missing, Export says it generates first); the setup
// inspector's "Rotation on the table" field with its hint. With DFYOM_RENDERS=1 it writes the
// review renders df45-{undo-toast,plan-start,toolpaths}-{light,dark}.png.
// Docs: docs/conventions/ui.md#undo-and-redo, #plan-start-df29, #plan-mode-task-37
import { resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

/** Light and dark renders without touching the page (the pointer stays where it is). */
async function render(page: Page, name: string): Promise<void> {
  if (!RENDERS) return
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
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${rendersDir}/${name}-${theme}.png` })
  }
}

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

test('DF45: undo toast over the view, Plan start machine, next-step primary, setup rotation', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const view = page.getByRole('main')

  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Next step')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()

  // ── the undo toast: over the view, clear of the inspector, gone after 6 s ─────────────────
  for (const kind of ['Pocket', 'Pocket'] as const) {
    await navigator.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('menuitem', { name: kind }).click()
  }
  // Delete on the focused row removes it (DF70: rows have no Remove button)
  await navigator.getByRole('button', { name: 'Pocket 2', exact: true }).click()
  await page.keyboard.press('Delete')
  const toast = page.getByRole('region', { name: /^Notifications/ }).getByRole('listitem')
  await expect(toast).toContainText('Removed Pocket 2')
  const t = (await toast.boundingBox())!
  const v = (await view.boundingBox())!
  const i = (await inspector.boundingBox())!
  expect(t.x).toBeGreaterThanOrEqual(v.x)
  expect(t.x + t.width).toBeLessThanOrEqual(v.x + v.width)
  expect(t.y + t.height).toBeLessThanOrEqual(v.y + v.height)
  expect(t.x + t.width).toBeLessThanOrEqual(i.x)
  // bottom-centre of the view
  expect(Math.abs(t.x + t.width / 2 - (v.x + v.width / 2))).toBeLessThan(2)
  await render(page, 'df45-undo-toast')
  // closes by itself (the pointer is not over it)
  await expect(toast).toHaveCount(0, { timeout: 10_000 })

  // ── Plan start: an empty library disables Create plan; New machine… chooses it ────────────
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByRole('radio', { name: 'Plan' })).toBeChecked()
  const start = page.getByRole('dialog', { name: 'Plan the part' })
  const create = start.getByRole('button', { name: 'Create plan' })
  await expect(create).toBeDisabled()
  await expect(create).toHaveAccessibleDescription(/The machine library is empty/)
  await start.getByRole('button', { name: 'New machine…' }).click()
  const newMachine = page.getByRole('dialog', { name: 'New machine' })
  await newMachine.getByRole('textbox', { name: 'Name' }).fill('Router')
  await setField(newMachine, 'Travel Z', '100')
  await newMachine.getByRole('button', { name: 'Add machine' }).click()
  await expect(newMachine).toBeHidden()
  await expect(start.getByRole('combobox', { name: 'Machine' })).toHaveText('Router')
  await expect(create).toBeEnabled()
  await render(page, 'df45-plan-start')
  await create.click()
  await expect(start).toBeHidden()
  await expect(navigator.getByRole('combobox', { name: 'Machine' })).toHaveText('Router')

  // ── Toolpaths: Generate is the primary until all are up to date; Export says so ───────────
  const generate = navigator.getByRole('button', { name: 'Generate toolpaths' })
  const exportButton = navigator.getByRole('button', { name: 'Export gCode…' })
  await expect(navigator.getByText(/of \d+ toolpaths? up to date/)).toBeVisible()
  await expect(generate).toHaveAttribute('data-variant', 'primary')
  await expect(exportButton).toHaveAttribute('data-variant', 'default')
  // the pockets have no library tool yet, so the export may be blocked by the errors instead;
  // the "generates first" hint itself is covered by Plan.test.tsx
  await expect(exportButton).toHaveAccessibleDescription(
    /^(Export generates the .*missing or outdated toolpaths? first|Fix the errors before exporting)\.$/,
  )

  // ── the setup inspector: "Rotation on the table" with its hint ────────────────────────────
  await navigator
    .getByRole('list', { name: 'Setups in machining order' })
    .getByRole('button')
    .first()
    .click()
  const rotation = inspector.getByRole('radiogroup', { name: 'Rotation on the table' })
  await expect(inspector.getByText('Rotation on the table', { exact: true })).toBeVisible()
  await expect(rotation).toHaveAccessibleDescription(/About the spindle axis/)
  await render(page, 'df45-toolpaths')
  expect(dfyom.rendererErrors).toEqual([])
})
