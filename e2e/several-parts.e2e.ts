// Several parts per project in the real app (split parts S0; windows hidden by the fixture): the
// library and a first part with a facing come through the bridge; then, through the UI only, the
// part menu's New part… makes a second part, a pocket is added to it, the menu switches between
// the parts (each shows its own operations), Plan's start card plans the shown part, and the
// exported program holds that part's operations only. Selectors are roles and accessible names.
// Docs: docs/modes/split-parts.md#prerequisite-several-parts-per-project,
// docs/conventions/ui.md#part-menu-split-parts-s0
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

async function bridgeCall<T>(page: Page, name: string, args: object = {}): Promise<T> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

/** The export dialog answers the suggested file name in `dir`. */
async function stubExportDialog(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, folder) => {
    dialog.showSaveDialog = ((...args: unknown[]) => {
      const options = args.at(-1) as { defaultPath?: string }
      const name = (options.defaultPath ?? 'out.nc').split(/[\\/]/).at(-1)!
      return Promise.resolve({ canceled: false, filePath: `${folder}/${name}` })
    }) as typeof dialog.showSaveDialog
  }, dir)
}

/** A tool and a machine in the library, a project "Two parts" with one faced part. */
async function firstPart(page: Page): Promise<void> {
  const call = <T>(name: string, args: object = {}) => bridgeCall<T>(page, name, args)
  const stock = await call<{ id: string }>('library.stock.add', {
    values: {
      name: 'Block',
      shape: 'block',
      length: '100',
      width: '60',
      thickness: '20',
      material: { name: '6061-T6', class: 'aluminum' },
    },
  })
  await call('library.tool.add', {
    values: {
      name: 'Flat 6',
      type: 'flatEndMill',
      diameter: '6',
      fluteLength: '25',
      overallLength: '60',
      fluteCount: '2',
      toolMaterial: 'carbide',
      presets: [
        {
          name: 'Alu finish',
          materialClass: 'aluminum',
          spindleSpeed: '18000',
          feedRate: '800',
          plungeRate: '200',
          stepdown: '1',
          stepover: '3',
        },
      ],
    },
  })
  await call('library.machine.add', {
    values: {
      name: 'Shapeoko',
      controller: 'grbl',
      travel: { x: '800', y: '800', z: '100' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'manual', maxSpeed: '30000' },
      programUnits: 'mm',
      toolChanger: 'none',
    },
  })
  await call('project.create', { name: 'Two parts', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Base',
    stockLibraryItemId: stock.id,
  })
  await call('design.facing.add', { partId, depth: '0.5' })
}

test('several parts: New part…, switch parts, plan the second part and export it', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await stubExportDialog(dfyom.app, dfyom.dataDir)
  await firstPart(page)

  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const partRow = navigator.getByRole('region', { name: 'Part' })
  const ops = navigator.getByRole('list', { name: 'Operations in design order' })
  const openParts = async () => {
    await partRow.getByRole('button', { name: /^Parts/ }).click()
    return page.getByRole('menu', { name: /^Parts/ })
  }
  await expect(partRow.getByRole('button', { name: 'Base' })).toBeVisible()
  await expect(ops.getByRole('button', { name: /^Facing 1/ })).toBeVisible()

  // ── New part…: the Stock dialog for another part, named after the project ─────────────────
  await (await openParts()).getByRole('menuitem', { name: 'New part…' }).click()
  const dialog = page.getByRole('dialog', { name: 'New part' })
  await expect(dialog.getByRole('textbox', { name: 'Part name' })).toHaveValue('Two parts 2')
  await dialog.getByRole('textbox', { name: 'Part name' }).fill('Lid')
  await dialog.getByRole('button', { name: 'Create part' }).click()
  await expect(dialog).toBeHidden()
  // the new part is shown, empty
  await expect(partRow.getByRole('button', { name: 'Lid' })).toBeVisible()
  await expect(navigator.getByRole('heading', { name: 'No operations yet' })).toBeVisible()
  await navigator.getByRole('button', { name: 'Add pocket' }).click()
  await expect(ops.getByRole('button', { name: /^Pocket 1/ })).toBeVisible()

  // ── switch: each part shows its own operations; undo/redo stay per document ──────────────
  let menu = await openParts()
  await expect(menu.getByRole('menuitemradio', { name: 'Lid' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await menu.getByRole('menuitemradio', { name: 'Base' }).click()
  await expect(partRow.getByRole('button', { name: 'Base' })).toBeVisible()
  await expect(ops.getByRole('button', { name: /^Facing 1/ })).toBeVisible()
  await expect(ops.getByRole('button', { name: /^Pocket 1/ })).toHaveCount(0)
  menu = await openParts()
  await menu.getByRole('menuitemradio', { name: 'Lid' }).click()
  await expect(ops.getByRole('button', { name: /^Pocket 1/ })).toBeVisible()

  // ── Plan: the start card plans the shown part; the picker names the plan's part ───────────
  await page.getByRole('radio', { name: 'Plan' }).click()
  const start = page.getByRole('dialog', { name: 'Plan the part' })
  await expect(start.getByRole('combobox', { name: 'Part' })).toHaveText('Lid')
  await expect(start.getByRole('combobox', { name: 'Machine' })).toHaveText('Shapeoko')
  await start.getByRole('button', { name: 'Create plan' }).click()
  await expect(start).toBeHidden()
  await expect(navigator.getByRole('combobox', { name: 'Plan', exact: true })).toHaveText(
    'Plan 1 · Lid',
  )

  // ── export: the program holds the Lid's pocket, not the Base's facing ────────────────────
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 60_000 })
  await navigator.getByRole('button', { name: 'Export gCode…' }).click()
  const done = page.getByRole('dialog', { name: 'gCode exported' })
  await expect(done).toBeVisible({ timeout: 30_000 })
  await done.getByRole('button', { name: 'Close' }).click()
  const written = readdirSync(dfyom.dataDir).filter((f) => f.endsWith('.nc'))
  expect(written).toHaveLength(1)
  const program = readFileSync(join(dfyom.dataDir, written[0]!), 'utf8')
  expect(program).toContain('Pocket 1')
  expect(program).not.toContain('Facing 1')
})
