// Engraved patterns E4 in the built app: Add → Features → Engraved pattern tiles the default motif
// (Waves) over the top face, the Presets dialog picks the Crosshatch tile, the Layout group shows
// its lattice and the read-out its tiles, crossings and groove width, the depth legend its one level
// (E4 follow-ups), and Plan generates and exports many grooves (one plunge per line: the tiles'
// lines joined at the seams). Windows stay hidden (app.fixture.ts). With DFYOM_E4_SHOTS=<dir> it
// writes dark captures of the inspector, the 3D view and (rows pitched too close) the thin-wall
// rings there (UI review).
// Doc: docs/modes/engraved-patterns.md#implementation-e4,
// docs/modes/engraved-patterns.md#e4-follow-ups-depth-legend-crossings-split-pieces
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
  // E4 follow-ups: the diagonals cross in every tile; the grooves' width at the deepest
  await expect(readout).toContainText(/grooves ≤ [\d.]+ mm wide · \d+ crossings/)
  // the depth legend: Crosshatch's one level, 0.8 → 0.84 mm between 0.2 and 1 mm
  await expect(inspector.getByRole('img', { name: /^Depth legend/ })).toHaveAccessibleName(
    /Depth in use: 0\.84 mm\.$/,
  )
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
  if (SHOTS !== undefined) {
    // the thin-wall rings: Waves rows pitched 1.2 mm apart, the engraving selected in Design
    await page.keyboard.press('ControlOrMeta+1')
    const partId = await page.evaluate(async () => {
      const api = (globalThis as unknown as { dfyom: PreloadApi }).dfyom
      const r = await api.call('design.part.list', {})
      return r.ok ? (r.value as { parts: { id: string }[] }).parts[0]!.id : ''
    })
    const moved = await page.evaluate(
      ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
      [
        'design.engraving.update',
        {
          partId,
          featureId: 'engraving1',
          motif: { preset: 'waves' },
          layout: { lattice: 'square', spacing: { pitch: ['20', '1.2'] } },
        },
      ] as const,
    )
    expect(moved.ok, JSON.stringify(moved)).toBe(true)
    // selected (a click on the selected row clears the selection)
    const heading = inspector.getByRole('heading', { name: 'Engraved pattern 1' })
    if (!(await heading.isVisible()))
      await navigator.getByRole('button', { name: /^Engraved pattern 1,/ }).click()
    await expect(heading).toBeVisible()
    await page.getByRole('button', { name: 'Fit', exact: true }).click()
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${SHOTS}/e4-merge-rings-dark.png` })
  }
  expect(dfyom.rendererErrors).toEqual([])
})
