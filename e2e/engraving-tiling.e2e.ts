// Engraved patterns E4 in the built app: Add → Features → Engraved pattern tiles the default motif
// (Waves) over the top face, the Presets dialog picks the Crosshatch tile, the Layout group shows
// its lattice and the read-out its tiles, and Plan generates and exports many grooves (one plunge
// per line: the tiles' lines joined at the seams). Windows stay hidden (app.fixture.ts). With
// DFYOM_E4_SHOTS=<dir> it writes dark captures of the inspector and the 3D view there (UI review).
// Doc: docs/modes/engraved-patterns.md#implementation-e4
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const SHOTS = process.env['DFYOM_E4_SHOTS']

const V_BIT = {
  name: 'V-bit 60 × 6',
  type: 'chamferMill',
  diameter: '6',
  angle: '60',
  fluteLength: '6',
  overallLength: '50',
  fluteCount: '2',
  toolMaterial: 'carbide',
  presets: [
    {
      name: 'Plywood',
      materialClass: 'sheetGood',
      spindleSpeed: '18000',
      feedRate: '1500',
      plungeRate: '400',
      stepdown: '0.5',
    },
  ],
}

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

test('engraving: a tile preset tiles the face, many grooves in Plan (E4)', async ({ dfyom }) => {
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
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  // a 60° V-bit with plywood feeds in the library (the plan picks it for the owned Line)
  const added = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    ['library.tool.add', { values: V_BIT }] as const,
  )
  expect(added.ok, JSON.stringify(added)).toBe(true)

  await navigator.getByRole('button', { name: 'New project' }).click()
  const created = page.getByRole('dialog', { name: 'New project' })
  await created.getByRole('textbox', { name: 'Project name' }).fill('Tiles')
  await created.getByRole('button', { name: 'Create project' }).click()
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()
  if (SHOTS !== undefined) await dark(page)

  // ── Add → Features → Engraved pattern: the Waves, tiled and clipped ───────────────────────
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page
    .getByRole('menu')
    .getByRole('group', { name: 'Features' })
    .getByRole('menuitem', { name: 'Engraved pattern' })
    .click()
  await expect(inspector.getByRole('heading', { name: 'Engraved pattern 1' })).toBeVisible()
  await expect(inspector.locator('[data-engraving-preset]')).toHaveText('Waves')
  await expect(inspector.getByRole('combobox', { name: 'Layout' })).toContainText('Square')
  await expect(inspector.getByRole('radio', { name: 'Clip' })).toBeChecked()
  await expect(inspector.locator('[data-engraving-readout]')).toContainText(/\d+ tiles/)

  // ── Presets…: the Crosshatch tile, 8 mm wide ───────────────────────────────────────────────
  await inspector.getByRole('button', { name: 'Presets…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Engraving presets' })
  await dialog.getByRole('radio', { name: 'Crosshatch' }).click()
  await expect(dialog).toBeHidden()
  await expect(inspector.locator('[data-engraving-preset]')).toHaveText('Crosshatch')
  await setField(inspector, 'Tile width', '8')
  await expect(
    inspector.getByLabel('Tile width', { exact: true }).and(inspector.locator('input')),
  ).toHaveValue(/^8/)
  const readout = inspector.locator('[data-engraving-readout]')
  await expect(readout).toContainText(/\d+ tiles/)
  const tiles = Number(/(\d+) tiles/.exec((await readout.textContent()) ?? '')![1])
  expect(tiles).toBeGreaterThan(50)
  if (SHOTS !== undefined) {
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${SHOTS}/e4-inspector-dark.png` })
  }

  // ── Plan: toolpaths and the program, many grooves ──────────────────────────────────────────
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
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 90_000 })
  if (SHOTS !== undefined) {
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${SHOTS}/e4-plan-3d-dark.png` })
  }
  await navigator
    .getByRole('button', { name: /^Export (.* )?gCode…$/ })
    .first()
    .click()
  await expect(page.getByRole('dialog', { name: 'gCode exported' })).toBeVisible({
    timeout: 30_000,
  })
  const file = readdirSync(dfyom.dataDir).find((f) => f.endsWith('.nc'))!
  const program = readFileSync(join(dfyom.dataDir, file), 'utf8')
  // many grooves: each line of the crosshatch plunged (its lines run on across the tiles' seams)
  const plunges = program.split('\n').filter((l) => /^G1 Z/.test(l)).length
  expect(plunges).toBeGreaterThan(10)
  expect(dfyom.rendererErrors).toEqual([])
})
