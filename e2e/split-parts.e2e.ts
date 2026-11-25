// Split parts 4a in the real app (windows hidden by the fixture): the library and the enclosure
// (the core split fixture's commands, built from scratch) come through the bridge; then, through
// the UI only, "Split part…" splits it by its mid-height level, the part menu lists the two
// pieces under it, a piece is read-only and "Edit the split" leads back, the editor adds a line
// at X and one at Y (8 pieces), and the Plan start card plans a piece with toolpaths. Then every
// piece of both splits is planned, exported and run on the virtual machine at Max through the
// bridge (DF91 exit). The 4a polish: the viewport's exploded preview, a level dragged in it (one
// undo step, snapped to whole mm, the field follows) and its keyboard path (the field, which
// highlights the level), "Split part…" in the part row's context menu, and the piece name in the
// exported header. 4b-1: Dowels on the level in the editor, the piece's dowel holes, and the
// doweled two-piece split planned and run. 4b-2: Puzzle on the lines in the editor (the clearance
// field and the keys' read-out; the enclosure's cavity leaves no room for a key, so back to Butt).
// 4b-3: "Test fit…" adds a coupon part with the nominal key and shows it (then removed). 4c:
// "Split to fit…" a library board: every chip names it, and the eight pieces run on it. Edge
// chamfers E2: Chamfer from the enclosure outline's row menu, planned, its toolpath generated.
// Selectors are roles and accessible names (the viewport handles by their `data-split-cut`
// anchors).
// Docs: docs/modes/split-parts.md#implementation-4a, docs/modes/split-parts.md#implementation-4b,
// docs/modes/split-parts.md#implementation-4c, docs/modes/edge-chamfers.md#implementation-e2,
// docs/conventions/ui.md#split-part-split-parts-4a
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { ENCLOSURE_STOCK, enclosureCommands } from '../src/core/design/split/split.fixture'
import { expect, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

/** Light and dark renders of the window as it is (DFYOM_RENDERS=1). */
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
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${rendersDir}/df91-${name}-${theme}.png` })
  }
}

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
    // the header names the piece (4a polish)
    expect(gcode).toMatch(/^\(Program: .*\)\n\(Piece \d of \d of Enclosure\)\n/)
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
  // wide: the inspector docks beside the viewport (the drag below needs the viewport clear)
  await page.setViewportSize({ width: 1280, height: 800 })
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

  // ── Split part… from the part row's context menu: the mid-height level, two pieces ────────
  await partRow.getByRole('button', { name: 'Enclosure' }).click({ button: 'right' })
  await page
    .getByRole('menu', { name: 'Actions for Enclosure' })
    .getByRole('menuitem', { name: /^Split part…/ })
    .click()
  await expect(split.getByRole('heading', { name: 'Split · 2 pieces' })).toBeVisible()
  await expect(split.getByRole('img', { name: 'Split preview: Front' })).toBeVisible()
  await expect(split.getByRole('list', { name: '2 pieces' }).getByRole('listitem')).toHaveText([
    '1 · 259.5 × 187 × 40 mm · own blank',
    '2 · 259.5 × 187 × 40 mm · own blank',
  ])

  // ── the viewport's exploded preview: drag the level; one undo step; the field follows ────
  const viewport = page.getByRole('region', { name: '3D viewport' })
  const level = viewport.locator('[data-split-cut="level-0"]')
  await expect(level).toHaveCount(1)
  const levelField = split.getByRole('combobox', { name: 'Level at Z' })
  await expect(levelField).toHaveValue('-40 mm')
  await page.waitForTimeout(500) // the pieces part (--motion-slow)
  await render(page, 'split-exploded')
  const grab = (await level.boundingBox())!
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(grab.x, grab.y - i * 4)
    await page.waitForTimeout(40)
  }
  await expect(level).toContainText(/Level at Z -\d+ mm/)
  await render(page, 'split-drag')
  await page.mouse.up()
  await page.mouse.move(grab.x, 10) // off the plane: no hover highlight
  // snapped to a whole millimetre, above where it was; still two pieces
  await expect(levelField).not.toHaveValue('-40 mm')
  const dragged = Number(/^(-\d+) mm$/.exec(await levelField.inputValue())![1])
  expect(dragged).toBeGreaterThan(-40)
  expect(dragged).toBeLessThan(-10)
  await expect(split.getByRole('heading', { name: 'Split · 2 pieces' })).toBeVisible()
  // the whole drag is one undo step
  await call('history.undo')
  await expect(levelField).toHaveValue('-40 mm')
  // the keyboard path: the field (its focus highlights the level in the viewport)
  await levelField.fill('-35 mm')
  await levelField.press('Enter')
  await expect(level).toContainText('Level at Z -35 mm')
  await levelField.fill('-40 mm')
  await levelField.press('Enter')
  await expect(level).toContainText('Level at Z -40 mm')
  await levelField.press('Tab') // to its Remove button: still the level's row
  await expect(level).toContainText('Level at Z -40 mm')
  await page.keyboard.press('Tab') // out of the row: no highlight
  await expect(levelField).toHaveValue('-40 mm')
  await expect(level).toHaveText('')

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

  // ── 4b-1: dowels on the level, placed by the core; the piece drills them ─────────────────
  const joint = split.getByRole('group', { name: 'Levels joined by' })
  await joint.getByRole('radio', { name: 'Dowels' }).click()
  await expect(split.getByRole('combobox', { name: 'Dowel Ø' })).toHaveValue('6 mm')
  await expect(split.getByText('3 dowels')).toBeVisible()
  menu = await openParts()
  await menu.getByRole('menuitemradio', { name: 'Enclosure · 2' }).click()
  await expect(navigator.getByRole('button', { name: /Dowel hole 1/ })).toBeVisible()
  await inspector.getByRole('button', { name: 'Edit the split' }).click()
  await joint.getByRole('radio', { name: 'Butt' }).click()
  await expect(split.getByRole('combobox', { name: 'Dowel Ø' })).toHaveCount(0)

  // ── the level and two lines: eight pieces ─────────────────────────────────────────────────
  await split.getByRole('button', { name: 'Add line at X' }).click()
  await expect(split.getByRole('heading', { name: 'Split · 4 pieces' })).toBeVisible()
  await split.getByRole('button', { name: 'Add line at Y' }).click()
  await expect(split.getByRole('heading', { name: 'Split · 8 pieces' })).toBeVisible()
  await expect(viewport.locator('[data-split-cut]')).toHaveCount(3)
  // ── 4b-2: keys on the lines; the cavity walls leave no room, the findings say so ──────────
  const lineJoint = split.getByRole('group', { name: 'Lines joined by' })
  await lineJoint.getByRole('radio', { name: 'Puzzle' }).click()
  await expect(split.getByRole('combobox', { name: 'Key clearance' })).toHaveValue('0.15 mm')
  await expect(split.getByText('No key fits yet: see the findings under each line.')).toBeVisible()
  // ── 4b-3: Test fit adds a coupon part of the key (nominal here) and shows it ──────────────
  await split.getByRole('button', { name: 'Test fit…' }).click()
  await page.getByRole('menuitem', { name: 'One coupon at 0.15 mm' }).click()
  const couponName = 'Enclosure · test fit 0.15 mm'
  await expect(partRow.getByRole('button', { name: couponName })).toBeVisible()
  await expect(split.getByRole('heading', { name: 'Split · 2 pieces' })).toBeVisible()
  await expect(split.getByRole('combobox', { name: 'Key clearance' })).toHaveValue('0.15 mm')
  await expect(split.getByText(/^1 key · neck/)).toBeVisible()
  menu = await openParts()
  await menu.getByRole('menuitemradio', { name: 'Enclosure', exact: true }).click()
  // the coupon goes again, so the pieces planned below are the enclosure's
  const coupon = (
    await call<{ parts: { id: string; name: string }[] }>('design.part.list')
  ).parts.find((p) => p.name === couponName)!
  await call('design.part.remove', { partId: coupon.id })
  await lineJoint.getByRole('radio', { name: 'Butt' }).click()
  await expect(split.getByRole('combobox', { name: 'Key clearance' })).toHaveCount(0)
  // ── 4c: Split to fit a library board; every chip names it (the pieces below run on it) ────
  await call('library.stock.add', {
    values: {
      ...ENCLOSURE_STOCK,
      name: 'Block 200 × 100.1 × 40',
      length: '200',
      width: '100.1',
      thickness: '40',
    },
  })
  await split.getByRole('button', { name: 'Split to fit…' }).click()
  await page.getByRole('menuitem', { name: /^Block 200 × 100\.1 × 40 · / }).click()
  await expect(split.getByRole('switch', { name: 'Use library stocks' })).toBeChecked()
  await expect(split.getByRole('list', { name: '8 pieces' }).getByRole('listitem')).toHaveText(
    Array<RegExp>(8).fill(/^\d · 200 × 100\.1 × 40 mm · Block 200 × 100\.1 × 40$/),
  )
  await render(page, 'split-exploded-8')
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
  // the level joined by dowels (4b-1): the upper piece drills them from its bottom
  await call('design.split.set', {
    partId,
    split: { levels: ['-40 mm'], dowels: {} },
    confirm: true,
  })
  for (const p of await pieces()) {
    await planAndRun(page, dfyom.dataDir, p.id, machine, 'level')
    ran++
  }
  expect(ran).toBe(10)
  expect(dfyom.rendererErrors).toEqual([])
})

// Edge chamfers E2 (docs/modes/edge-chamfers.md#implementation-e2): the enclosure's outline (an
// outside profile) gets Chamfer from its row menu, 1.5 × 45°; planned, its toolpath generated.
test('edge chamfer: Chamfer on the enclosure outline from its row menu, planned with a toolpath', async ({
  dfyom,
}) => {
  test.setTimeout(180_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1280, height: 800 })
  const call = <T>(name: string, args: object = {}) => bridgeCall<T>(page, name, args)
  // a 6 mm flat through the 60.5 mm part, a 4 mm flat for the rim holes, a 90° Ø 6 chamfer mill
  await call('library.tool.add', { values: tool('Flat 6 long', '6', '75', '110') })
  await call('library.tool.add', { values: tool('Flat 4', '4', '25', '60') })
  await call('library.tool.add', {
    values: { ...tool('Chamfer 6', '6', '8', '50'), type: 'chamferMill', angle: '90' },
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
  await call('project.create', { name: 'Enclosure chamfer', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Enclosure',
    stock: ENCLOSURE_STOCK,
  })
  for (const [name, args] of enclosureCommands(partId)) await call(name, args)

  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const outline = navigator.getByRole('button', { name: /^Profile 1/ })
  await expect(outline).toBeVisible()
  await outline.click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Chamfer' }).click()
  await expect(inspector.getByRole('heading', { name: 'Chamfer 1' })).toBeVisible()
  await expect(inspector.getByRole('combobox', { name: 'Edge' })).toContainText('Profile 1')
  const width = inspector.getByLabel('Width', { exact: true }).and(inspector.locator('input'))
  await width.fill('1.5')
  await width.press('Enter')
  await width.blur()

  await page.getByRole('radio', { name: 'Plan' }).click()
  const start = page.getByRole('dialog', { name: 'Plan the part' })
  await start.getByRole('button', { name: 'Create plan' }).click()
  await expect(start).toBeHidden()
  const planned = navigator.getByRole('button', { name: /^Chamfer 1\s*Chamfer 6/ })
  await expect(planned).toBeVisible()
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 60_000 })
  // the chamfer's toolpath: its bevel's tip on the faced top (−9.738 − 1.5)
  const { plans } = await call<{ plans: { id: string }[] }>('plan.list')
  const ops = (
    await call<{
      plan: { setups: { operations: { id: string; designOperationIds: string[] }[] }[] }
    }>('plan.get', { planId: plans[0]!.id })
  ).plan.setups.flatMap((s) => s.operations)
  const op = ops.find((o) => o.designOperationIds.includes('chamfer1'))!
  const tp = await call<{ toolpath: { passes: { moves: { kind: string; to: number[] }[] }[] } }>(
    'plan.toolpath.get',
    { planId: plans[0]!.id, planOperationId: op.id },
  )
  const zs = tp.toolpath.passes.flatMap((p) => p.moves.map((m) => m.to[2]!))
  expect(Math.min(...zs)).toBeCloseTo(-11.238, 3)
  expect(dfyom.rendererErrors).toEqual([])
})
