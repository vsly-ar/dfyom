// Multi-select in the Design navigator (hardening DF135) in the built app: two pockets selected
// (click, Cmd/Ctrl-click), the bulk row menu's Mark 2 as already cut; Plan (a draft, following the
// design) shows both muted as cut; one Undo in Design restores both, and the plan follows. With
// DFYOM_MS_DIR set it captures light and dark renders of the multi-selection with its menu open
// (ms-menu-{light,dark}.png; review captures, not asserted). Windows stay hidden (app.fixture.ts).
// Doc: docs/conventions/ui.md#multi-select-in-the-design-navigator-df135
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const SHOTS = process.env['DFYOM_MS_DIR']

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

async function theme(page: Page, t: 'light' | 'dark'): Promise<void> {
  // runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`
  await page.evaluate((x) => {
    const doc = (
      globalThis as unknown as {
        document: { documentElement: { setAttribute(n: string, v: string): void } }
      }
    ).document
    doc.documentElement.setAttribute('data-theme', x)
  }, t)
}

test('multi-select: two pockets marked already cut at once, the plan skips both, one Undo restores', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (SHOTS !== undefined) await page.setViewportSize({ width: 1440, height: 900 })
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const added = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [
      'library.tool.add',
      {
        values: {
          name: 'Flat 3',
          type: 'flatEndMill',
          diameter: '3',
          fluteLength: '12',
          overallLength: '50',
          fluteCount: '2',
          toolMaterial: 'carbide',
          presets: [
            {
              name: 'Alu',
              materialClass: 'aluminum',
              spindleSpeed: '18000',
              feedRate: '450',
              plungeRate: '200',
              stepdown: '0.75',
              stepover: '1.2',
            },
          ],
        },
      },
    ] as const,
  )
  expect(added.ok, JSON.stringify(added)).toBe(true)

  // ── a part with three pockets ──────────────────────────────────────────────────────────────
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Multi-select')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const stock = page.getByRole('dialog', { name: 'Stock' })
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '120')
  await setField(setup, 'Width (Y)', '60')
  await setField(setup, 'Thickness (Z)', '12')
  await stock.getByRole('button', { name: 'Create part' }).click()
  await expect(stock).toBeHidden()
  for (const [n, x] of [
    [1, '25'],
    [2, '60'],
    [3, '95'],
  ] as const) {
    if (n === 1) await navigator.getByRole('button', { name: 'Add pocket' }).click()
    else {
      await navigator.getByRole('button', { name: 'Add', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Pocket' }).click()
    }
    await expect(inspector.getByRole('heading', { name: `Pocket ${n}` })).toBeVisible()
    await setField(inspector, 'Length (X)', '20')
    await setField(inspector, 'Width (Y)', '16')
    await setField(inspector, 'Position X', x)
    await setField(inspector, 'Depth', '4')
    await setField(inspector, 'Corner radius', '1.5')
  }

  // ── Plan: a draft plan of all three ────────────────────────────────────────────────────────
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
  const planList = navigator
    .getByRole('list', { name: 'Setups in machining order' })
    .getByRole('list', { name: 'Plan operations in machining order' })
  const planRow = (n: number) => planList.getByRole('button', { name: new RegExp(`^Pocket ${n}`) })
  await expect(planRow(1)).toBeVisible({ timeout: 30_000 })
  await expect(planRow(1)).not.toContainText('Cut')

  // ── Design: Pocket 1 and Pocket 3 selected, Mark 2 as already cut ──────────────────────────
  await page.keyboard.press('ControlOrMeta+1')
  const row = (n: number) => navigator.getByRole('button', { name: new RegExp(`^Pocket ${n}`) })
  await row(1).click()
  if ((await row(1).getAttribute('aria-pressed')) !== 'true') await row(1).click()
  await row(3).click({ modifiers: ['ControlOrMeta'] })
  await expect(row(1)).toHaveAttribute('aria-pressed', 'true')
  await expect(row(2)).toHaveAttribute('aria-pressed', 'false')
  await expect(row(3)).toHaveAttribute('aria-pressed', 'true')
  await expect(inspector.getByRole('heading', { name: '2 items selected' })).toBeVisible()
  const view = page.getByRole('region', { name: '3D viewport' })
  await expect(view).toBeVisible()
  await row(3).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Actions for 2 items' })
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Mark 2 as already cut',
    'Disable 2',
    'Remove 2 items',
  ])
  if (SHOTS !== undefined) {
    const dir = resolve(SHOTS)
    mkdirSync(dir, { recursive: true })
    for (const t of ['light', 'dark'] as const) {
      await theme(page, t)
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(dir, `ms-menu-${t}.png`) })
    }
    await theme(page, 'light')
  }
  await menu.getByRole('menuitem', { name: 'Mark 2 as already cut' }).click()
  await expect(row(1)).toContainText('Cut')
  await expect(row(3)).toContainText('Cut')
  await expect(row(2)).not.toContainText('Cut')
  // the selection stays, the inspector offers the opposite
  await expect(inspector.getByRole('button', { name: 'Mark 2 as not cut' })).toBeVisible()

  // ── Plan skips both ────────────────────────────────────────────────────────────────────────
  await page.keyboard.press('ControlOrMeta+2')
  await expect(planRow(1)).toContainText('Cut', { timeout: 30_000 })
  await expect(planRow(3)).toContainText('Cut')
  await expect(planRow(2)).not.toContainText('Cut')

  // ── one Undo restores both ─────────────────────────────────────────────────────────────────
  await page.keyboard.press('ControlOrMeta+1')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(row(1)).not.toContainText('Cut')
  await expect(row(3)).not.toContainText('Cut')
  await page.keyboard.press('ControlOrMeta+2')
  await expect(planRow(1)).not.toContainText('Cut', { timeout: 30_000 })
  await expect(planRow(3)).not.toContainText('Cut')
  expect(dfyom.rendererErrors).toEqual([])
})
