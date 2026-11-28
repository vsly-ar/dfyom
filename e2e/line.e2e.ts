// Engraved patterns E1 in the built app: Add → Operations → Line adds a Line (DF147: Straight across
// the face), its inspector switches the depth to Start → end, and the Line is
// planned as its own operation in Plan. E2: an SVG whose line fades by data-level imported through
// the stubbed "Import SVG…" dialog, the Line set to From SVG levels, and the program exported from
// Plan cutting at many depths between Shallowest and Deepest. DF147: Add → Line is Straight (two
// points, planned), Shape mode and the Path picker's New shape…. Windows stay hidden (app.fixture.ts).
// Docs: docs/modes/engraved-patterns.md#implementation-e1, #implementation-e2, docs/conventions/ui.md
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { PreloadApi } from '../src/shared/preload-api'
import { closeDialog, expect, openPartSetup, test } from './app.fixture'

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

/** The Line panel light and dark as `name`-light/-dark.png (only with DFYOM_SL_DIR). */
async function shootPanel(page: Page, panel: Locator, name: string): Promise<void> {
  const into = process.env['DFYOM_SL_DIR']
  if (into === undefined) return
  const dir = resolve(into)
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
    await panel.screenshot({ path: join(dir, `${name}-${theme}.png`) })
  }
}

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

/** New project "Lines" with the default stock and its part. */
async function newProject(page: Page): Promise<void> {
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Lines')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()
}

/** Plan mode with a new machine "Router" and a plan. */
async function planWithMachine(page: Page): Promise<void> {
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
}

test('line: add a Line in Design, see it in Plan', async ({ dfyom }) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  await newProject(page)

  // ── Add → Operations → Line ────────────────────────────────────────────────────────────────
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page
    .getByRole('menu')
    .getByRole('group', { name: 'Operations' })
    .getByRole('menuitem', { name: 'Line' })
    .click()
  await expect(inspector.getByRole('heading', { name: 'Line 1' })).toBeVisible()
  // the depth: constant 0.5 mm, then Start → end
  await expect(
    inspector.getByLabel('Depth', { exact: true }).and(inspector.locator('input')),
  ).toHaveValue(/^0\.5/)
  await inspector.getByRole('radio', { name: 'Start → end' }).click()
  await setField(inspector, 'At end', '1.2')
  await expect(
    inspector.getByLabel('At end', { exact: true }).and(inspector.locator('input')),
  ).toHaveValue(/^1\.2/)

  // ── Plan: the Line is a plan operation of its own ──────────────────────────────────────────
  await planWithMachine(page)
  const planned = navigator
    .getByRole('list', { name: 'Setups in machining order' })
    .getByRole('list', { name: 'Plan operations in machining order' })
    .getByRole('button', { name: /^Line 1/ })
  await expect(planned).toHaveCount(1)
  expect(dfyom.rendererErrors).toEqual([])
})

test('line: a Straight line by two points cut in Plan; New shape… from the Path picker (DF147)', async ({
  dfyom,
}) => {
  test.setTimeout(150_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const added = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    ['library.tool.add', { values: V_BIT }] as const,
  )
  expect(added.ok, JSON.stringify(added)).toBe(true)
  await newProject(page)

  // ── Add → Line: Straight; two points 22 mm from the front edge ────────────────────────────
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page
    .getByRole('menu')
    .getByRole('group', { name: 'Operations' })
    .getByRole('menuitem', { name: 'Line' })
    .click()
  await expect(inspector.getByRole('heading', { name: 'Line 1' })).toBeVisible()
  await expect(inspector.getByRole('radio', { name: 'Straight' })).toBeChecked()
  await setField(inspector, 'Start u', '10')
  await setField(inspector, 'Start v', '22')
  await setField(inspector, 'End u', '90')
  await setField(inspector, 'End v', '22')
  await expect(inspector.getByText('Length 80 mm')).toBeVisible()
  await shootPanel(page, inspector, 'line-straight')
  // Arc keeps the ends; back to Straight drops the through point
  await inspector.getByRole('radio', { name: 'Arc' }).click()
  await expect(inspector.getByText(/^Radius .*, sweep .*°$/)).toBeVisible()
  await shootPanel(page, inspector, 'line-arc')
  await inspector.getByRole('radio', { name: 'Straight' }).click()
  await expect(inspector.getByText('Length 80 mm')).toBeVisible()

  // ── Plan: the Line's toolpath is generated ─────────────────────────────────────────────────
  await planWithMachine(page)
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 90_000 })

  // ── Design: Shape mode, then New shape… opens the Shape Editor with the new shape picked ──
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByRole('radio', { name: 'Design' })).toBeChecked()
  // the Line stays selected across the mode switch (a click would deselect it)
  const row = navigator
    .getByRole('list', { name: 'Operations in design order' })
    .getByRole('button', { name: 'Line 1' })
  await expect(row).toBeVisible()
  if ((await row.getAttribute('aria-pressed')) !== 'true') await row.click()
  await expect(inspector.getByRole('heading', { name: 'Line 1' })).toBeVisible()
  await inspector.getByRole('radio', { name: 'Shape' }).click()
  const picker = inspector.getByRole('combobox', { name: 'Path 1' })
  await expect(picker).toBeVisible()
  await picker.click()
  await page.getByRole('option', { name: 'New shape…' }).click()
  await expect.poll(() => dfyom.app.windows().length).toBe(2)
  await expect(picker).toHaveText(/Shape 2/)
  await expect(inspector.getByRole('heading', { name: 'Line 1' })).toBeVisible()
  expect(dfyom.rendererErrors).toEqual([])
})

test('line: depth from SVG levels, varying depth in the Plan program (E2)', async ({ dfyom }) => {
  test.setTimeout(150_000)
  const svg = join(dfyom.dataDir, 'fade.svg')
  writeFileSync(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="60mm" height="20mm" viewBox="0 0 60 20">' +
      '<path id="fade" d="M 0 10 C 15 0, 45 20, 60 10" stroke="#000" data-level="0.2 1 0.2"/></svg>',
  )
  await dfyom.app.evaluate(
    ({ dialog }, f) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [f.svg] })) as typeof dialog.showOpenDialog
      dialog.showSaveDialog = ((...args: unknown[]) => {
        const o = (args.at(-1) ?? {}) as { defaultPath?: string }
        const name = (o.defaultPath ?? 'out.nc').split(/[\\/]/).at(-1)!
        return Promise.resolve({ canceled: false, filePath: `${f.dir}/${name}` })
      }) as typeof dialog.showSaveDialog
    },
    { svg, dir: dfyom.dataDir },
  )
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  // a 60° V-bit with plywood feeds in the library (the plan picks it for the Line)
  const added = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    ['library.tool.add', { values: V_BIT }] as const,
  )
  expect(added.ok, JSON.stringify(added)).toBe(true)
  await newProject(page)

  // ── Import SVG…: one open path with levels ─────────────────────────────────────────────────
  const shapes = await openPartSetup(page, 'Shapes')
  await shapes.getByRole('button', { name: 'Import SVG…' }).click()
  await page
    .getByRole('dialog', { name: 'Import SVG' })
    .getByRole('button', { name: 'Import' })
    .click()
  const report = page.getByRole('dialog', { name: 'Imported fade' })
  await expect(report).toBeVisible({ timeout: 30_000 })
  await report.getByRole('button', { name: 'Close' }).first().click()
  await closeDialog(shapes)

  // ── a Line on it (the first shape), From SVG levels 0.2–1 mm ─────────────────────────────
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page
    .getByRole('menu')
    .getByRole('group', { name: 'Operations' })
    .getByRole('menuitem', { name: 'Line' })
    .click()
  await expect(inspector.getByRole('heading', { name: 'Line 1' })).toBeVisible()
  // DF147 SL2: a new Line is Straight; Shape converts it, then Path 1 takes the drawing
  await inspector.getByRole('radio', { name: 'Shape' }).click()
  await inspector.getByRole('combobox', { name: 'Path 1' }).click()
  await page.getByRole('option', { name: 'fade' }).click()
  await expect(inspector.getByRole('combobox', { name: 'Path 1' })).toHaveText(/fade/)
  await inspector.getByRole('radio', { name: 'From SVG levels' }).click()
  const field = (label: string) =>
    inspector.getByLabel(label, { exact: true }).and(inspector.locator('input'))
  // the constant depth becomes the deepest, the shallowest its default
  await expect(field('Deepest')).toHaveValue(/^0\.5/)
  await expect(field('Shallowest')).toHaveValue(/^0\.2/)
  await setField(inspector, 'Deepest', '1')
  await expect(field('Deepest')).toHaveValue(/^1/)

  // ── Plan: toolpaths and the program at many depths between 0.2 and 1 mm ──────────────────
  await planWithMachine(page)
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 90_000 })
  await navigator
    .getByRole('button', { name: /^Export (.* )?gCode…$/ })
    .first()
    .click()
  const done = page.getByRole('dialog', { name: 'gCode exported' })
  await expect(done).toBeVisible({ timeout: 30_000 })
  const file = readdirSync(dfyom.dataDir).find((f) => f.endsWith('.nc'))!
  const zs = [
    ...readFileSync(join(dfyom.dataDir, file), 'utf8').matchAll(/Z(-\d+(?:\.\d+)?)/g),
  ].map((m) => Number(m[1]))
  expect(Math.min(...zs)).toBeCloseTo(-1, 3)
  expect(zs.some((z) => z > -0.4)).toBe(true)
  expect(new Set(zs.map((z) => z.toFixed(2))).size).toBeGreaterThan(5)
  expect(dfyom.rendererErrors).toEqual([])
})

const FLAT = {
  name: 'Flat 6',
  type: 'flatEndMill',
  diameter: '6',
  fluteLength: '32',
  overallLength: '60',
  fluteCount: '2',
  toolMaterial: 'carbide',
  presets: [
    {
      name: 'Plywood',
      materialClass: 'sheetGood',
      spindleSpeed: '18000',
      feedRate: '1500',
      plungeRate: '400',
      stepdown: '2',
    },
  ],
}

test('line: Depth → Through cuts the part off in Plan, with the cut-off warning (DF147 SL3)', async ({
  dfyom,
}) => {
  test.setTimeout(150_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const added = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    ['library.tool.add', { values: FLAT }] as const,
  )
  expect(added.ok, JSON.stringify(added)).toBe(true)
  await newProject(page)

  // ── Add → Line: Straight across the face, 22 mm from the front edge, Through ───────────────
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page
    .getByRole('menu')
    .getByRole('group', { name: 'Operations' })
    .getByRole('menuitem', { name: 'Line' })
    .click()
  await expect(inspector.getByRole('heading', { name: 'Line 1' })).toBeVisible()
  await setField(inspector, 'Start v', '22')
  await setField(inspector, 'End v', '22')
  await inspector.getByRole('radio', { name: 'Through' }).click()
  await expect(inspector.getByText(/^Cuts through the stock/)).toBeVisible()
  await shootPanel(page, inspector, 'line-through')

  // ── Plan: generated; the cut-off warns that both sides come loose ──────────────────────────
  await planWithMachine(page)
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText(/cuts the stock in two/).first()).toBeVisible()
  expect(dfyom.rendererErrors).toEqual([])
})
