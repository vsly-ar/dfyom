// Roughing passes R2 (hardening DF122) in the built app: the Pocket inspector's Roughing
// accordion turns roughing on, its roughing pocket nests under the pocket in the navigator,
// Leave on walls changes the pocket's margin, and in Plan the roughing is its own row before the
// pocket (its tool's run) while the pocket's row carries the "rest" chip; the program exports.
// With DFYOM_R2_DIR set it also captures light and dark renders of the open accordion and the
// plan list there (review captures, not asserted). Windows stay hidden (app.fixture.ts).
// Docs: docs/modes/roughing.md#ui, docs/modes/roughing.md#implementation-r2, docs/conventions/ui.md
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const SHOTS = process.env['DFYOM_R2_DIR']

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

/** A carbide flat end mill with an aluminum preset (the new stock's default material). */
const flat = (diameter: number) => ({
  name: `Flat ${diameter}`,
  type: 'flatEndMill',
  diameter: String(diameter),
  fluteLength: '12',
  overallLength: '50',
  fluteCount: '2',
  toolMaterial: 'carbide',
  presets: [
    {
      name: 'Alu',
      materialClass: 'aluminum',
      spindleSpeed: '18000',
      feedRate: String(150 * diameter),
      plungeRate: '200',
      stepdown: String(diameter / 4),
      stepover: String(diameter * 0.4),
    },
  ],
})

/** `name`-light.png and -dark.png of the window (only with DFYOM_R2_DIR). */
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

test('roughing: turn it on for a pocket, see the pass in the Plan list, export', async ({
  dfyom,
}) => {
  test.setTimeout(180_000)
  await dfyom.app.evaluate(({ dialog }, dir) => {
    dialog.showSaveDialog = ((...args: unknown[]) => {
      const o = (args.at(-1) ?? {}) as { defaultPath?: string }
      const name = (o.defaultPath ?? 'out.nc').split(/[\\/]/).at(-1)!
      return Promise.resolve({ canceled: false, filePath: `${dir}/${name}` })
    }) as typeof dialog.showSaveDialog
  }, dfyom.dataDir)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (SHOTS !== undefined) await page.setViewportSize({ width: 1440, height: 900 })
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  // a Ø 3 for the pocket's R 1.5 corners and a Ø 8 for its roughing
  for (const d of [3, 8]) {
    const added = await page.evaluate(
      ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
      ['library.tool.add', { values: flat(d) }] as const,
    )
    expect(added.ok, JSON.stringify(added)).toBe(true)
  }

  // ── a 100 × 72 × 12 part with a 60 × 40 pocket, 6 deep, R 1.5 corners ─────────────────────
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Roughing')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const stock = page.getByRole('dialog', { name: 'Stock' })
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '100')
  await setField(setup, 'Width (Y)', '72')
  await setField(setup, 'Thickness (Z)', '12')
  await stock.getByRole('button', { name: 'Create part' }).click()
  await expect(stock).toBeHidden()
  await navigator.getByRole('button', { name: 'Add pocket' }).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()
  await setField(inspector, 'Length (X)', '60')
  await setField(inspector, 'Width (Y)', '40')
  await setField(inspector, 'Depth', '6')
  await setField(inspector, 'Corner radius', '1.5')

  // ── the Roughing accordion: closed "Off", the switch turns it on ──────────────────────────
  const header = inspector.getByRole('button', { name: /^Roughing/ })
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(header).toContainText('Off')
  await header.click()
  await inspector.getByRole('switch', { name: 'Roughing' }).click()
  await expect(inspector.getByRole('switch', { name: 'Roughing' })).toBeChecked()
  const wall = inspector
    .getByLabel('Leave on walls', { exact: true })
    .and(inspector.locator('input'))
  await expect(wall).toHaveAttribute('placeholder', /^Auto · /)
  await expect(inspector.getByRole('combobox', { name: 'Roughing tool' })).toBeVisible()
  // the pocket's row nests its roughing row (the pair is one row in the list)
  const pocketRow = navigator.getByRole('button', { name: /^Pocket 1, with roughing/ })
  await expect(pocketRow).toBeVisible()
  await pocketRow.getByTitle('Expand Pocket 1').click()
  await expect(
    navigator.getByRole('button', { name: /^Pocket 1 · roughing, edited through Pocket 1/ }),
  ).toBeVisible()
  // Leave on walls: the pocket's margin
  await setField(inspector, 'Leave on walls', '0.5')
  await expect(wall).toHaveValue(/^0\.5/)
  await inspector
    .getByLabel('Leave on floor', { exact: true })
    .and(inspector.locator('input'))
    .scrollIntoViewIfNeeded()
  await shoot(page, 'r2-pocket-roughing')

  // the roughing pocket's short inspector: read-only margins, "Edit in Pocket 1"
  await navigator.getByRole('button', { name: /^Pocket 1 · roughing, edited through/ }).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 1 · roughing' })).toBeVisible()
  await expect(inspector.getByRole('button', { name: 'Edit in Pocket 1' })).toBeVisible()
  await shoot(page, 'r2-roughing-inspector')

  // ── Plan: the roughing is its own row before the pocket, which cuts only the rest ─────────
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
  const list = navigator
    .getByRole('list', { name: 'Setups in machining order' })
    .getByRole('list', { name: 'Plan operations in machining order' })
  const rows = list.getByRole('button', { name: /^Pocket 1/ })
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('Pocket 1 · roughing')
  await expect(rows.nth(1)).toContainText('rest')
  await expect(rows.nth(1).getByTitle('Cuts only what Pocket 1 · roughing left')).toBeVisible()

  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 90_000 })
  await rows.nth(1).click()
  await shoot(page, 'r2-plan-rest')
  await navigator
    .getByRole('button', { name: /^Export (.* )?gCode…$/ })
    .first()
    .click()
  await expect(page.getByRole('dialog', { name: 'gCode exported' })).toBeVisible({
    timeout: 30_000,
  })
  const file = readdirSync(dfyom.dataDir).find((f) => f.endsWith('.nc'))!
  const program = readFileSync(join(dfyom.dataDir, file), 'utf8')
  // the roughing's Ø 8 first, then the pocket's Ø 3 for the rest
  expect(program).toContain('(Tool 1: Flat 8, dia 8 mm)')
  expect(program).toContain('(Tool 2: Flat 3, dia 3 mm)')
  expect(program.indexOf('(Pocket 1 - roughing)')).toBeLessThan(program.indexOf('(Pocket 1)'))
  expect(dfyom.rendererErrors).toEqual([])
})
