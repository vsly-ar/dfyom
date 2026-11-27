// Cut state C1 (hardening DF135, TG #442 / TG #447) in the built app: a pocket is planned and
// exported (the real cut), then marked "already cut" from its Design row menu; a new pocket in it
// is added in Design, and the plan (a draft, following the design) shows the cut pocket muted with
// a check and exports only the new pocket. With DFYOM_C1_DIR set it captures light and dark
// renders of the plan with the cut row (df135-cut-{light,dark}.png; review captures, not asserted).
// Q199 (a new blank): with Pocket 2 marked too, the part menu's Clear cut marks clears both (Undo
// brings them back); Run's pre-flight on the setup cut in full offers Clear marks, and the draft
// plan then has a program again. C3: the inspector's Already cut switch marks Pocket 1 again.
// C4: a run's mark on Pocket 1 (the command Run sends), Pocket 1 deepened 6 → 8 in Design: its
// marker reads Changed ("plans cut only the difference"), and the export cuts it from 6 to 8 only.
// C5: Plan (with its switch) and Run draw the in-process stock (Pocket 1 cut out of the blank);
// with DFYOM_C5_DIR, c5-{plan,run}-{light,dark}.png.
// Windows stay hidden (app.fixture.ts).
// Docs: docs/modes/cut-state.md#implementation-c1, docs/conventions/ui.md
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { PreloadApi } from '../src/shared/preload-api'
import { closeDialog, expect, test } from './app.fixture'

const SHOTS = process.env['DFYOM_C1_DIR']
const C5_SHOTS = process.env['DFYOM_C5_DIR']

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

/** `name`-light.png and -dark.png of the window (only with DFYOM_C1_DIR, or `into`). */
async function shoot(page: Page, name: string, into = SHOTS): Promise<void> {
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
    await page.screenshot({ path: join(dir, `${name}-${theme}.png`) })
  }
}

test('cut state: mark a pocket already cut in Design, add a pocket in it, export only that', async ({
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
  if (SHOTS !== undefined || C5_SHOTS !== undefined)
    await page.setViewportSize({ width: 1440, height: 900 })
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

  // ── a 100 × 72 × 12 part with a 60 × 40 pocket, 6 deep ───────────────────────────────────
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Cut state')
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

  // ── Plan: the first program (the real cut) ─────────────────────────────────────────────────
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
  const exportProgram = async (): Promise<string> => {
    await navigator
      .getByRole('button', { name: /^Export (.* )?gCode…$/ })
      .first()
      .click()
    const done = page.getByRole('dialog', { name: 'gCode exported' })
    await expect(done).toBeVisible({ timeout: 60_000 })
    await closeDialog(done, 'Close')
    const file = readdirSync(dfyom.dataDir).find((f) => f.endsWith('.nc'))!
    return readFileSync(join(dfyom.dataDir, file), 'utf8')
  }
  expect(await exportProgram()).toContain('(Pocket 1)')

  // ── Design: Pocket 1 is already cut; a pocket in it, below its floor ───────────────────────
  await page.keyboard.press('ControlOrMeta+1')
  const pocket1 = navigator.getByRole('button', { name: /^Pocket 1/ })
  await pocket1.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Actions for Pocket 1' })
  await menu.getByRole('menuitem', { name: 'Mark as already cut' }).click()
  await expect(pocket1).toContainText('Cut')
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Pocket' }).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 2' })).toBeVisible()
  await setField(inspector, 'Length (X)', '20')
  await setField(inspector, 'Width (Y)', '10')
  await setField(inspector, 'Depth', '9')
  await setField(inspector, 'Corner radius', '1.5')

  // ── Plan: Pocket 1 muted with a check, the export holds only Pocket 2 ───────────────────────
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByRole('radio', { name: 'Plan' })).toBeChecked()
  const list = navigator
    .getByRole('list', { name: 'Setups in machining order' })
    .getByRole('list', { name: 'Plan operations in machining order' })
  const cutRow = list.getByRole('button', { name: /^Pocket 1/ })
  await expect(cutRow).toContainText('Cut', { timeout: 30_000 })
  await expect(list.getByRole('button', { name: /^Pocket 2/ })).toBeVisible()
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 90_000 })
  await expect(navigator.getByRole('switch', { name: 'Show cut toolpaths' })).not.toBeChecked()
  await shoot(page, 'df135-cut')
  // C5: the in-process stock (Pocket 1 cut out of the blank) around the part, on by default
  const view = page.getByRole('region', { name: '3D viewport' })
  const showStock = navigator.getByRole('switch', { name: 'Show in-process stock' })
  await expect(showStock).toBeChecked()
  await expect(view).toHaveAttribute('data-in-process-stock', '1', { timeout: 30_000 })
  await shoot(page, 'c5-plan', C5_SHOTS)
  await showStock.click()
  await expect(view).not.toHaveAttribute('data-in-process-stock')
  await showStock.click()
  await expect(view).toHaveAttribute('data-in-process-stock', '1')
  const program = await exportProgram()
  expect(program).toContain('(Pocket 2)')
  expect(program).not.toContain('(Pocket 1)')
  // ... and Run draws it too, under the program still to run
  await page.keyboard.press('ControlOrMeta+3')
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  await expect(view).toHaveAttribute('data-in-process-stock', '1', { timeout: 30_000 })
  await expect(view).toHaveAttribute('data-toolpath-segments', /^[1-9]/)
  await shoot(page, 'c5-run', C5_SHOTS)

  // ── Q199: everything cut; Clear cut marks in Design (and Undo) ─────────────────────────────
  await page.keyboard.press('ControlOrMeta+1')
  const pocket2 = navigator.getByRole('button', { name: /^Pocket 2/ })
  await pocket2.click({ button: 'right' })
  await page
    .getByRole('menu', { name: 'Actions for Pocket 2' })
    .getByRole('menuitem', { name: 'Mark as already cut' })
    .click()
  await expect(pocket2).toContainText('Cut')
  await navigator.getByRole('button', { name: /^Parts/ }).click()
  await page.getByRole('menuitem', { name: /^Clear cut marks/ }).click()
  await expect(pocket1).not.toContainText('Cut')
  await expect(pocket2).not.toContainText('Cut')
  await page.getByRole('button', { name: 'Undo', exact: true }).last().click()
  await expect(pocket1).toContainText('Cut')
  await expect(pocket2).toContainText('Cut')

  // ── Q199: Run's pre-flight on the setup cut in full offers Clear marks ─────────────────────
  await page.keyboard.press('ControlOrMeta+3')
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  const machine = page.getByRole('group', { name: 'Machine' })
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: '10×' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(machine.getByText('Virtual machine · 10×')).toBeVisible()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  await inspector.getByRole('button', { name: 'Start run' }).click()
  const preflight = page.getByRole('dialog', { name: 'Start run?' })
  const offer = preflight.getByRole('group', { name: 'Already cut' })
  await expect(offer).toContainText('is marked already cut. Cutting a new blank?', {
    timeout: 30_000,
  })
  await expect(preflight.getByRole('button', { name: 'Start run' })).toBeDisabled()
  await offer.getByRole('button', { name: 'Clear marks' }).click()
  // the draft plan follows: a program again, checked against the travel
  await expect(offer).toBeHidden({ timeout: 30_000 })
  await expect(
    preflight.getByText(/^(Inside the travel|X leaves|Y leaves|Z leaves)/).first(),
  ).toBeVisible({
    timeout: 60_000,
  })
  await closeDialog(preflight, 'Cancel')
  await page.keyboard.press('ControlOrMeta+1')
  await expect(pocket1).not.toContainText('Cut')
  await expect(pocket2).not.toContainText('Cut')

  // ── C3: the inspector's Already cut switch marks Pocket 1 again ─────────────────────────────
  await pocket1.click()
  const cutSwitch = inspector.getByRole('switch', { name: 'Already cut' })
  await expect(cutSwitch).not.toBeChecked()
  await cutSwitch.click()
  await expect(pocket1).toContainText('Cut')
  await expect(cutSwitch).toBeChecked()

  // ── C4: a run's mark on Pocket 1 (as Run sends it), then Pocket 1 deepened 6 → 8 ───────────
  const call = async <T>(name: string, args: object): Promise<T> => {
    const r = await page.evaluate(
      ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
      [name, args] as const,
    )
    expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
    return (r as { ok: true; value: T }).value
  }
  const { plans } = await call<{ plans: { id: string; partId: string }[] }>('plan.list', {})
  const { id: planId, partId } = plans[0]!
  await call('design.part.update', { partId, alreadyCut: [] })
  await call('design.part.update', { partId, alreadyCut: ['pocket1'], cutByRun: planId })
  await expect(page.locator('[data-cut-marker="run"]')).toHaveCount(1)
  // (a click on the selected row clears the selection)
  if (!(await inspector.getByRole('heading', { name: 'Pocket 1' }).isVisible()))
    await pocket1.click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()
  await setField(inspector, 'Depth', '8')
  const changed = page.locator('[data-cut-marker="run"][data-tone="warning"]')
  await expect(changed).toContainText('Changed')
  await expect(changed).toHaveAttribute('title', /plans cut only the difference/)
  // Plan: Pocket 1 is in the program again, from its old floor down only
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByRole('radio', { name: 'Plan' })).toBeChecked()
  await expect(cutRow).not.toContainText('Cut', { timeout: 30_000 })
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 90_000 })
  const recut = await exportProgram()
  expect(recut).toContain('(Pocket 1)')
  const section = recut.slice(recut.indexOf('(Pocket 1)'), recut.indexOf('(Pocket 2)'))
  const depths = [...section.matchAll(/Z(-[\d.]+)/g)].map((m) => Number(m[1]))
  expect(Math.min(...depths)).toBeCloseTo(-8, 6)
  // no level between the top and the floor the run cut (6 mm)
  expect(depths.filter((z) => z > -6 + 1e-6)).toEqual([])
  expect(dfyom.rendererErrors).toEqual([])
})
