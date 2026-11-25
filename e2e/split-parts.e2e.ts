// Split parts 4a in the real app (windows hidden by the fixture): the library and the enclosure
// (the core split fixture's commands, built from scratch) come through the bridge; then, through
// the UI only, "Split part…" splits it by its mid-height level, the part menu lists the two
// pieces under it, a piece is read-only and "Edit the split" leads back, the editor adds a line
// at X and one at Y (8 pieces), and the Plan start card plans a piece with toolpaths. Then every
// piece of both splits is planned, exported and run on the virtual machine at Max through the
// bridge (DF91 exit). Selectors are roles and accessible names.
// Docs: docs/modes/split-parts.md#implementation-4a, docs/conventions/ui.md#split-part-split-parts-4a
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { ENCLOSURE_STOCK, enclosureCommands } from '../src/core/design/split/split.fixture'
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

const tool = (name: string, diameter: string, fluteLength: string, overallLength: string) => ({
  name,
  type: 'flatEndMill',
  diameter,
  fluteLength,
  overallLength,
  fluteCount: '2',
  toolMaterial: 'carbide',
  presets: [],
})

interface RunStatus {
  state: string
  mpos: [number, number, number]
  workZero: [number, number, number]
  job?: { phase: string; toolChange?: { n: number }; pause?: unknown }
}

/** Plans, exports and runs every setup of `partId` on the virtual machine (bridge only). */
async function planAndRun(page: Page, dir: string, partId: string, machine: string, label: string) {
  const call = <T>(name: string, args: object = {}) => bridgeCall<T>(page, name, args)
  const { planId } = await call<{ planId: string }>('plan.create', {
    partId,
    machineLibraryItemId: machine,
  })
  const errors = (
    await call<{ warnings: { severity: string; message: string }[] }>('plan.warning.list', {
      planId,
    })
  ).warnings.filter((w) => w.severity === 'error')
  expect(errors).toEqual([])
  const plan = (await call<{ plan: { setups: { id: string }[] } }>('plan.get', { planId })).plan
  await call('run.connection.open', { target: 'virtual', planId, timeScale: 'max', prepare: true })
  for (const [n, setup] of plan.setups.entries()) {
    const target = join(dir, `${label}-${partId}-${n + 1}.nc`)
    await call('plan.export', { planId, setupId: setup.id, target })
    const gcode = readFileSync(target, 'utf8')
    const stock = /\(Stock X ([\d.]+) Y ([\d.]+) Z/.exec(gcode)!
    const floorZero = new Map(
      [...gcode.matchAll(/\(Z0 for tool (\d+): .*?, ([\d.]+) below the stock top\)/g)].map((x) => [
        Number(x[1]),
        Number(x[2]),
      ]),
    )
    if (n > 0) {
      // the next setup's stock zeroed at the same machine place (centred, as prepare)
      const s = await call<RunStatus>('run.status.get')
      const g54 = [-400 - Number(stock[1]) / 2, -400 - Number(stock[2]) / 2, s.workZero[2]]
      await call('run.workZero.set', {
        axes: ['x', 'y', 'z'],
        values: s.mpos.map((m, i) => m - g54[i]!),
      })
    }
    const topZero = (await call<RunStatus>('run.status.get')).workZero[2]
    const { jobId } = await call<{ jobId: string }>('run.job.start', { planId, setupId: setup.id })
    for (;;) {
      const job = await call<{ state: string; outcome?: { ok: boolean } }>('job.wait', {
        jobId,
        timeoutSeconds: 1,
      })
      if (job.state === 'finished') {
        expect(job.outcome, JSON.stringify(job.outcome)).toMatchObject({ ok: true })
        break
      }
      const s = await call<RunStatus>('run.status.get')
      if (s.job?.phase === 'toolChange') {
        const below = floorZero.get(s.job.toolChange!.n) ?? 0
        await call('run.workZero.set', {
          axes: ['z'],
          values: [0, 0, s.mpos[2] - (topZero - below)],
        })
        await call('run.job.continue', { jobId, toolChange: s.job.toolChange!.n })
      } else if (s.job?.phase === 'programPause')
        await call('run.job.continue', { jobId, pause: s.job.pause })
    }
  }
  await call('run.connection.close')
}

test('split parts: split the enclosure in the UI; every piece plans and runs', async ({
  dfyom,
}) => {
  test.setTimeout(300_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const call = <T>(name: string, args: object = {}) => bridgeCall<T>(page, name, args)
  await call('library.tool.add', { values: tool('Flat 6 long', '6', '45', '90') })
  await call('library.tool.add', { values: tool('Flat 4', '4', '25', '60') })
  const machine = (
    await call<{ id: string }>('library.machine.add', {
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
  ).id
  await call('project.create', { name: 'Enclosure split', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Enclosure',
    stock: ENCLOSURE_STOCK,
  })
  for (const [name, args] of enclosureCommands(partId)) await call(name, args)

  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const partRow = navigator.getByRole('region', { name: 'Part' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const split = inspector.getByRole('region', { name: 'Split' })
  const openParts = async () => {
    await partRow.getByRole('button', { name: /^Parts/ }).click()
    return page.getByRole('menu', { name: /^Parts/ })
  }
  await expect(partRow.getByRole('button', { name: 'Enclosure' })).toBeVisible()
  await partRow.getByRole('button', { name: 'Enclosure' }).click()

  // ── Split part…: the mid-height level, two pieces in the preview ─────────────────────────
  await split.getByRole('button', { name: 'Split part…' }).click()
  await expect(split.getByRole('heading', { name: 'Split · 2 pieces' })).toBeVisible()
  await expect(split.getByRole('img', { name: 'Split preview: Front' })).toBeVisible()
  await expect(split.getByRole('listitem')).toHaveText([
    '1 · 259.5 × 187 × 40 mm · own blank',
    '2 · 259.5 × 187 × 40 mm · own blank',
  ])

  // ── the part menu lists the pieces under the source; a piece is read-only ────────────────
  let menu = await openParts()
  await expect(menu.getByRole('menuitemradio')).toHaveText([
    'Enclosure',
    'Enclosure · 1',
    'Enclosure · 2',
  ])
  await menu.getByRole('menuitemradio', { name: 'Enclosure · 2' }).click()
  await expect(navigator.getByText('Read-only: this piece follows Enclosure.')).toBeVisible()
  await expect(inspector.getByText('Piece 2 of 2 of Enclosure')).toBeVisible()
  await inspector.getByRole('button', { name: 'Edit the split' }).click()
  await expect(partRow.getByRole('button', { name: 'Enclosure' })).toBeVisible()

  // ── the level and two lines: eight pieces ─────────────────────────────────────────────────
  await split.getByRole('button', { name: 'Add line at X' }).click()
  await expect(split.getByRole('heading', { name: 'Split · 4 pieces' })).toBeVisible()
  await split.getByRole('button', { name: 'Add line at Y' }).click()
  await expect(split.getByRole('heading', { name: 'Split · 8 pieces' })).toBeVisible()
  menu = await openParts()
  await expect(menu.getByRole('menuitemradio')).toHaveCount(9)
  await menu.getByRole('menuitemradio', { name: 'Enclosure · 1' }).click()

  // ── Plan: the start card plans the shown piece; toolpaths generate ───────────────────────
  await page.getByRole('radio', { name: 'Plan' }).click()
  const start = page.getByRole('dialog', { name: 'Plan the part' })
  await expect(start.getByRole('combobox', { name: 'Part' })).toHaveText('Enclosure · 1')
  await start.getByRole('button', { name: 'Create plan' }).click()
  await expect(start).toBeHidden()
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 60_000 })

  // ── every piece of both splits plans, exports and runs on the virtual machine ─────────────
  const pieces = async () =>
    Object.values(
      (await call<{ parts: { id: string; derivedFrom?: { index: number } }[] }>('design.part.list'))
        .parts,
    ).filter((p) => p.derivedFrom !== undefined)
  let ran = 0
  for (const p of await pieces()) {
    await planAndRun(page, dfyom.dataDir, p.id, machine, 'lines')
    ran++
  }
  expect(ran).toBe(8)
  await call('design.split.set', {
    partId,
    split: { levels: ['-40 mm'] },
    confirm: true,
  })
  for (const p of await pieces()) {
    await planAndRun(page, dfyom.dataDir, p.id, machine, 'level')
    ran++
  }
  expect(ran).toBe(10)
  expect(dfyom.rendererErrors).toEqual([])
})
