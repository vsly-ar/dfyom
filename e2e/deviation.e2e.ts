// The deviation panel in the real app (v0.4-llm-first U4): a faced block with two pockets for one
// end mill and a plain box STL of the stock as its reference are built and planned through the
// bridge; then, through plan mode's UI only: the Plan inspector's "Compare with reference" runs
// the simulated cut against the reference (the facing and the pockets come back as over-cut
// regions), the statistics show, and a region selects its plan operation. With DFYOM_RENDERS=1
// light and dark review renders of the panel go to design/features/renders/u4-deviation-panel-*.png.
// Windows stay hidden (fixture). Selectors are roles and accessible names.
// Docs: docs/conventions/ui.md#deviation-panel, docs/modes/deviation.md#implementation-u4
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
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

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

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

/** An ASCII STL of an axis-aligned box from the origin (mm). */
function boxStl(x: number, y: number, z: number): string {
  const v = (i: number) => [i & 1 ? x : 0, i & 2 ? y : 0, i & 4 ? z : 0]
  // two triangles per face, outward winding
  const faces = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ]
  const tri = (a: number, b: number, c: number) =>
    `facet normal 0 0 0\n outer loop\n${[a, b, c].map((i) => `  vertex ${v(i).join(' ')}`).join('\n')}\n endloop\nendfacet`
  const body = faces.flatMap(([a, b, c, d]) => [tri(a!, b!, c!), tri(a!, c!, d!)]).join('\n')
  return `solid box\n${body}\nendsolid box\n`
}

/** A 100 × 60 × 20 block: a top facing and two pockets, all for Flat 6; the block as reference. */
async function plannedBlock(page: Page, stl: string): Promise<void> {
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
      fluteLength: '20',
      overallLength: '50',
      fluteCount: '2',
      toolMaterial: 'carbide',
      presets: [
        {
          name: 'Alu',
          materialClass: 'aluminum',
          spindleSpeed: '18000',
          feedRate: '600',
          plungeRate: '150',
          stepdown: '0.5',
          stepover: '2.4',
        },
      ],
    },
  })
  const machine = await call<{ id: string }>('library.machine.add', {
    values: {
      name: 'Router',
      controller: 'grbl',
      travel: { x: '800', y: '800', z: '100' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'gcode', maxSpeed: '24000' },
      programUnits: 'mm',
      toolChanger: 'none',
    },
  })
  await call('project.create', { name: 'Deviation', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Deviation',
    stockLibraryItemId: stock.id,
  })
  await call('design.facing.add', { partId, on: 'stock.top', depth: '0.5' })
  for (const x of ['25', '75'])
    await call('design.pocket.add', {
      partId,
      on: 'facing1.floor',
      shape: { kind: 'circle', center: [x, '30'], diameter: '16' },
      depth: '2',
    })
  await call('design.reference.import', { partId, path: stl })
  await call('project.apply', {})
  await call('plan.create', { partId, machineLibraryItemId: machine.id })
}

test('deviation panel (U4): compare the plan with the reference, regions, a region selects its operation', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 900 })
  const stl = join(dfyom.dataDir, 'block.stl')
  writeFileSync(stl, boxStl(100, 60, 20))
  await plannedBlock(page, stl)

  await page.getByRole('radio', { name: 'Plan' }).click()
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  const panel = inspector.getByRole('region', { name: 'Compare with reference' })
  await panel.scrollIntoViewIfNeeded()
  await panel.getByRole('button', { name: 'Compare' }).click()

  // the facing takes 0.5 mm off the reference's top, the pockets 2.5 mm: over-cut regions
  await expect(panel.getByRole('status')).toHaveText(/^\d+ regions? over 0\.1 mm/, {
    timeout: 60_000,
  })
  // R7: the regions first, the statistics in a closed accordion after them
  const statistics = panel.getByRole('region', { name: 'Statistics' })
  await expect(statistics.getByText('Worst over-cut')).toBeHidden()
  await statistics.getByRole('button', { name: /^Statistics/ }).click()
  await expect(statistics.getByText('Worst over-cut')).toBeVisible()
  const rows = panel.getByRole('list', { name: 'Regions' }).getByRole('button')
  await expect(rows.first()).toHaveAccessibleName(/^Over-cut .* mm · .+, top, .* mm², /)
  await panel.scrollIntoViewIfNeeded()
  await render(page, 'u4-deviation-panel')

  // a region selects its plan operation: the inspector shows it
  const name = (await rows.first().getAttribute('aria-label'))!
  const op = /· ([^,]+),/.exec(name)![1]!
  await rows.first().click()
  await expect(panel).toBeHidden()
  await expect(inspector.getByRole('heading', { name: op })).toBeVisible()
  expect(dfyom.rendererErrors).toEqual([])
})
