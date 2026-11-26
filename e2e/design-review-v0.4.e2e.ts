// Design review captures of the v0.4 UI work (v0.4-llm-first L2): each surface of U1–U4, L1, the
// hardening UI DF115–DF120 and W5/W6, rendered in light and dark at the main window's default size
// (1440 × 900, src/main/index.ts) for docs/research/2026-11-26-v0.4-design-review.md. Captures
// only: nothing is asserted beyond what reaching a surface needs, and the spec is skipped unless
// DFYOM_REVIEW_DIR names the folder the PNGs go to, e.g.
//   DFYOM_REVIEW_DIR=design/reviews/2026-11-26-v0.4 npx playwright test e2e/design-review-v0.4.e2e.ts
// The data comes from the bridge, as in the surfaces' own specs (workholding, deviation,
// shape-editor, depth-pick, round-corners, recessed-countersink, slotted-hole,
// construction-surfaces). Windows stay hidden (fixture).
// Docs: docs/conventions/testing.md#app-playwright-for-electron, docs/conventions/ui.md
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, openPartSetup, openReferencePanel, shapeEditorWindow, test } from './app.fixture'

const DIR = process.env['DFYOM_REVIEW_DIR']
const SIZE = { width: 1440, height: 900 }

test.skip(!DIR, 'review captures only: set DFYOM_REVIEW_DIR')

async function bridgeCall<T>(page: Page, name: string, args: object = {}): Promise<T> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

/**
 * `name`-light.png and -dark.png of the window as it is; the theme attribute is set directly (an
 * open menu or pick stays open), `before` runs again per theme.
 */
async function shoot(page: Page, name: string, before?: () => Promise<void>): Promise<void> {
  const dir = resolve(DIR!)
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
    await before?.()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(dir, `${name}-${theme}.png`) })
  }
}

async function firstWindow(app: import('@playwright/test').ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize(SIZE)
  return page
}

const input = (scope: Locator, label: string) =>
  scope.getByLabel(label, { exact: true }).and(scope.locator('input'))

async function inspectorOf(page: Page): Promise<Locator> {
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  return inspector
}

const flat6 = (fluteLength = '20', overallLength = '50') => ({
  values: {
    name: `Flat 6 × ${fluteLength}`,
    type: 'flatEndMill',
    diameter: '6',
    fluteLength,
    overallLength,
    fluteCount: '2',
    toolMaterial: 'carbide',
    presets: [
      {
        name: 'Hardwood',
        materialClass: 'hardwood',
        spindleSpeed: '18000',
        feedRate: '1500',
        plungeRate: '300',
        stepdown: '2',
        stepover: '3',
      },
    ],
  },
})

const router = {
  values: {
    name: 'Router',
    controller: 'grbl',
    travel: { x: '800', y: '800', z: '100' },
    maxFeedRate: { x: '5000', y: '5000', z: '1000' },
    spindle: { control: 'manual', maxSpeed: '30000' },
    programUnits: 'mm',
    toolChanger: 'none',
  },
}

/** workholding.e2e.ts's hardwood stock with a top facing and `extra`, planned. */
async function hardwoodPlan(
  page: Page,
  extra: (partId: string) => Promise<unknown>,
): Promise<{ planId: string; setupId: string }> {
  const stock = await bridgeCall<{ id: string }>(page, 'library.stock.add', {
    values: {
      name: 'Hardwood',
      shape: 'block',
      length: '250',
      width: '100',
      thickness: '40',
      material: { name: 'Oak', class: 'hardwood' },
    },
  })
  await bridgeCall(page, 'library.tool.add', flat6())
  await bridgeCall(page, 'library.tool.add', flat6('45', '80'))
  const machine = await bridgeCall<{ id: string }>(page, 'library.machine.add', router)
  await bridgeCall(page, 'project.create', { name: 'Clamped', unitSystem: 'mm' })
  const { partId } = await bridgeCall<{ partId: string }>(page, 'design.part.add', {
    name: 'Clamped',
    stockLibraryItemId: stock.id,
  })
  await bridgeCall(page, 'design.facing.add', { partId, depth: '0.5' })
  await extra(partId)
  await bridgeCall(page, 'project.apply', {})
  const { planId } = await bridgeCall<{ planId: string }>(page, 'plan.create', {
    partId,
    machineLibraryItemId: machine.id,
  })
  const setupId = (
    await bridgeCall<{ plan: { setups: { id: string }[] } }>(page, 'plan.get', { planId })
  ).plan.setups[0]!.id
  return { planId, setupId }
}

/** Plan mode with the Top setup selected; its inspector. */
async function topSetup(page: Page): Promise<{ inspector: Locator; navigator: Locator }> {
  await page.getByRole('radio', { name: 'Plan' }).click()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = await inspectorOf(page)
  if (!(await inspector.getByRole('heading', { name: 'Setup', exact: true }).isVisible()))
    await navigator
      .getByRole('list', { name: 'Setups in machining order' })
      .getByRole('button', { name: /^Top G54/ })
      .click({ position: { x: 24, y: 12 } })
  await expect(inspector.getByRole('heading', { name: 'Setup', exact: true })).toBeVisible()
  return { inspector, navigator }
}

async function generate(navigator: Locator): Promise<void> {
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 30_000 })
}

test('U1, L1, W6: workholding Add menu, Arrange automatically, an open clamp', async ({
  dfyom,
}) => {
  test.setTimeout(180_000)
  const page = await firstWindow(dfyom.app)
  await hardwoodPlan(page, async (partId) => {
    await bridgeCall(page, 'design.pocket.add', {
      partId,
      on: 'facing1.floor',
      shape: { kind: 'rectangle', center: ['125', '50'], length: '150', width: '50' },
      depth: '10',
    })
    await bridgeCall(page, 'design.profile.add', {
      partId,
      shape: { kind: 'rectangle', center: ['125', '50'], length: '200', width: '80' },
      tabs: { count: '4', width: '8', thickness: '3' },
    })
  })
  const { inspector, navigator } = await topSetup(page)
  const section = inspector.getByRole('region', { name: /^Workholding/ })

  // L1: the Add menu's icons at 16 px (toe clamp, vise, screw, block, base, surface hold)
  await section.scrollIntoViewIfNeeded()
  await section.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByRole('menuitem', { name: /^Toe clamp/ })).toBeVisible()
  await shoot(page, 'l1-workholding-add-menu')
  await page.keyboard.press('Escape')

  // W6: refused without toolpaths, then four clamps
  const arrange = section.getByRole('button', { name: 'Arrange automatically' })
  await arrange.click()
  await expect(section.getByRole('alert')).toBeVisible()
  await arrange.scrollIntoViewIfNeeded()
  await shoot(page, 'w6-arrange-refused')
  await generate(navigator)
  await topSetup(page)
  await arrange.click()
  await expect(section).toContainText('4 items')
  await generate(navigator)
  await topSetup(page)
  await page.getByRole('button', { name: 'Fit' }).click()
  await arrange.scrollIntoViewIfNeeded()
  await shoot(page, 'w6-arrange')

  // U1: an open clamp item (its fields, the keep-out halo in the 3D view)
  await section.getByRole('button', { name: /^Toe clamp 1/ }).click()
  await expect(section.getByRole('group', { name: 'Item Toe clamp 1' })).toBeVisible()
  await section.getByRole('group', { name: 'Item Toe clamp 1' }).scrollIntoViewIfNeeded()
  await shoot(page, 'u1-clamp-item')
})

test('W5: held pieces, tape and a screw in the part', async ({ dfyom }) => {
  test.setTimeout(120_000)
  const page = await firstWindow(dfyom.app)
  const { planId, setupId } = await hardwoodPlan(page, (partId) =>
    bridgeCall(page, 'design.profile.add', {
      partId,
      shape: { kind: 'rectangle', center: ['125', '50'], length: '200', width: '70' },
      slotWidth: '6',
      tabs: { count: '0' },
    }),
  )
  await bridgeCall(page, 'plan.workholding.set', {
    planId,
    setupId,
    items: [{ kind: 'toeClamp', edge: 'vMin', grip: '5' }],
  })
  const { inspector } = await topSetup(page)
  const checks = inspector.getByRole('region', { name: 'Setup checks' })
  await expect(checks).toContainText('cuts the part free in Top without tabs')
  await checks.scrollIntoViewIfNeeded()
  await shoot(page, 'w5-part-loose')

  const section = inspector.getByRole('region', { name: /^Workholding/ })
  await section.getByRole('button', { name: 'Add' }).click()
  await page.getByRole('menuitem', { name: /^Tape/ }).click()
  await expect(section.getByRole('group', { name: 'Item Tape' })).toBeVisible()
  await shoot(page, 'w5-surface-hold')

  await bridgeCall(page, 'plan.workholding.set', {
    planId,
    setupId,
    items: [
      { id: 'wh1', kind: 'toeClamp' },
      { id: 'wh2', kind: 'surface' },
      { kind: 'screw', center: ['60', '50'] },
    ],
  })
  await section.getByRole('button', { name: /^Screw 1/ }).click()
  await expect(section.getByRole('group', { name: 'Item Screw 1' })).toContainText(
    'goes through the part',
  )
  await page.getByRole('button', { name: 'Fit' }).click()
  await shoot(page, 'w5-screw-in-part')
})

/** deviation.e2e.ts's box STL from the origin (mm). */
function boxStl(x: number, y: number, z: number): string {
  const v = (i: number) => [i & 1 ? x : 0, i & 2 ? y : 0, i & 4 ? z : 0]
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

test('U4, U2: deviation panel, reference levels', async ({ dfyom }) => {
  test.setTimeout(180_000)
  const page = await firstWindow(dfyom.app)
  const stl = join(dfyom.dataDir, 'block.stl')
  writeFileSync(stl, boxStl(100, 60, 20))
  const stock = await bridgeCall<{ id: string }>(page, 'library.stock.add', {
    values: {
      name: 'Block',
      shape: 'block',
      length: '100',
      width: '60',
      thickness: '20',
      material: { name: 'Oak', class: 'hardwood' },
    },
  })
  await bridgeCall(page, 'library.tool.add', flat6())
  const machine = await bridgeCall<{ id: string }>(page, 'library.machine.add', router)
  await bridgeCall(page, 'project.create', { name: 'Deviation', unitSystem: 'mm' })
  const { partId } = await bridgeCall<{ partId: string }>(page, 'design.part.add', {
    name: 'Deviation',
    stockLibraryItemId: stock.id,
  })
  await bridgeCall(page, 'design.facing.add', { partId, on: 'stock.top', depth: '0.5' })
  for (const x of ['25', '75'])
    await bridgeCall(page, 'design.pocket.add', {
      partId,
      on: 'facing1.floor',
      shape: { kind: 'circle', center: [x, '30'], diameter: '16' },
      depth: '2',
    })
  await bridgeCall(page, 'design.reference.import', { partId, path: stl })
  await bridgeCall(page, 'project.apply', {})
  await bridgeCall(page, 'plan.create', { partId, machineLibraryItemId: machine.id })

  // U2: the Reference panel's levels and section (design mode)
  const panelRef = await openReferencePanel(page)
  const levels = panelRef.getByRole('region', { name: 'Levels' })
  await expect(levels.getByRole('heading', { name: 'From top' })).toBeVisible({ timeout: 30_000 })
  await levels.scrollIntoViewIfNeeded()
  await shoot(page, 'u2-reference-levels')
  await openReferencePanel(page)
  const toggle = page
    .getByRole('toolbar', { name: 'Part setup' })
    .getByRole('button', { name: 'Reference' })
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()

  // U4: the Plan inspector's "Compare with reference"
  await page.getByRole('radio', { name: 'Plan' }).click()
  const inspector = await inspectorOf(page)
  const panel = inspector.getByRole('region', { name: 'Compare with reference' })
  await panel.scrollIntoViewIfNeeded()
  await panel.getByRole('button', { name: 'Compare' }).click()
  await expect(panel.getByRole('status')).toHaveText(/^\d+ regions? over 0\.1 mm/, {
    timeout: 90_000,
  })
  await panel.scrollIntoViewIfNeeded()
  await shoot(page, 'u4-deviation-panel')
})

test('U3: Offset dialog, adjust panel after a click in the dialog, offset item, pocket scale', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await firstWindow(dfyom.app)
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Shapes')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const setup = page.getByRole('region', { name: 'Set up the part' })
  for (const [label, value] of [
    ['Length (X)', '100'],
    ['Width (Y)', '60'],
    ['Thickness (Z)', '20'],
  ] as const) {
    const f = input(setup, label)
    await f.fill(value)
    await f.press('Enter')
    await f.blur()
  }
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()
  let shapes = await openPartSetup(page, 'Shapes')
  await shapes.getByRole('button', { name: 'Add shape' }).click()
  await page.getByRole('menuitem', { name: 'Rectangle' }).click()
  await expect(shapes).toBeHidden()

  shapes = await openPartSetup(page, 'Shapes')
  await shapes.getByRole('button', { name: /^Shape 1/ }).click({ button: 'right' })
  await shoot(page, 'u3-shape-row-menu')
  await page
    .getByRole('menu', { name: 'Actions for Shape 1' })
    .getByRole('menuitem', { name: /^Offset…/ })
    .click()
  const offset = page.getByRole('dialog', { name: 'Offset Shape 1' })
  await expect(offset).toBeVisible()
  const distance = input(offset, 'Distance')
  await distance.fill('3')
  await distance.press('Enter')
  // R20 (fixed): a click elsewhere in the modal dialog blurs the field; a focus trap's return
  // does not open the adjust panel again
  await offset.getByText(/^A new shape at this distance/).click()
  await shoot(page, 'u3-offset-dialog-blur')
  await distance.press('Tab')
  await offset.getByRole('radio', { name: 'Inward' }).click()
  await shoot(page, 'u3-offset-dialog')
  await offset.getByRole('button', { name: 'Create offset' }).click()
  await expect(offset).toBeHidden()

  const { page: win, inspector: shapeInspector } = await shapeEditorWindow(dfyom.app)
  await win.setViewportSize({ width: 1180, height: 760 })
  await expect(shapeInspector.getByRole('heading', { name: 'Shape 1 offset' })).toBeVisible()
  await shoot(win, 'u3-offset-item')

  await navigator.getByRole('button', { name: 'Add pocket' }).click()
  const inspector = await inspectorOf(page)
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()
  await inspector.getByRole('combobox', { name: 'Shape' }).click()
  await page
    .getByRole('listbox')
    .getByRole('option', { name: /^Shape 1 offset/ })
    .click()
  const scale = input(inspector, 'Scale')
  await scale.fill('1.5')
  await scale.press('Enter')
  await scale.blur()
  await expect(scale).toHaveValue('1.5')
  await scale.scrollIntoViewIfNeeded()
  await shoot(page, 'u3-pocket-scale')
})

/** construction-surfaces.e2e.ts's clamp (user TG #369): facings, the recess, the long hole, chamfer, spot. */
async function clamp(page: Page): Promise<string> {
  const stock = await bridgeCall<{ id: string }>(page, 'library.stock.add', {
    values: {
      name: 'Aluminium',
      shape: 'block',
      length: '80',
      width: '40.35',
      thickness: '10.11',
      material: { name: '6061-T6', class: 'aluminum' },
    },
  })
  await bridgeCall(page, 'project.create', { name: 'clamps_40', unitSystem: 'mm' })
  const { partId } = await bridgeCall<{ partId: string }>(page, 'design.part.add', {
    name: 'Clamp',
    stockLibraryItemId: stock.id,
  })
  await bridgeCall(page, 'design.facing.add', { partId, name: 'Facing top', depth: '0.3' })
  await bridgeCall(page, 'design.facing.add', {
    partId,
    name: 'Facing bottom',
    on: 'stock.bottom',
    depth: '0.3',
  })
  const rect = (length: string, width: string, cornerRadius: string) => ({
    kind: 'rectangle',
    center: ['40', '20.175'],
    length,
    width,
    cornerRadius,
  })
  await bridgeCall(page, 'design.pocket.add', {
    partId,
    name: 'Pocket for M5',
    on: 'facing2.floor',
    shape: rect('11.3', '31', '5.6'),
    depth: '2',
  })
  await bridgeCall(page, 'design.pocket.add', {
    partId,
    name: 'M5 long hole',
    on: 'pocket1.floor',
    shape: rect('5.5', '25', '2.5'),
    depth: '7.8',
  })
  await bridgeCall(page, 'design.chamfer.add', {
    partId,
    edgeOf: 'pocket2',
    on: 'pocket1.floor',
    width: '3.2',
    angle: '90',
  })
  await bridgeCall(page, 'design.pocket.add', {
    partId,
    name: 'Corner pocket',
    on: 'facing1.floor',
    shape: {
      kind: 'rectangle',
      center: ['12', '10'],
      length: '14',
      width: '12',
      cornerRadius: '3',
    },
    depth: '2',
  })
  return partId
}

test('DF115–DF118, DF120: construction note, depth pick, Through, refused value, Round', async ({
  dfyom,
}) => {
  test.setTimeout(150_000)
  const page = await firstWindow(dfyom.app)
  await clamp(page)
  const viewport = page.getByRole('region', { name: '3D viewport' })
  await expect(viewport).toHaveAccessibleDescription(/Part with 6 operations/)
  const inspector = await inspectorOf(page)
  const select = async (name: string) => {
    await page
      .getByRole('navigation', { name: 'Navigator' })
      .getByRole('button', { name: new RegExp(`^${name}`) })
      .click()
    await expect(inspector.getByRole('heading', { name })).toBeVisible()
  }

  // DF118: the note at On, the outline in the 3D view (from below)
  await select('M5 long hole')
  await expect(inspector.getByText(/Cut away by Chamfer 1/)).toBeVisible()
  await viewport.focus()
  await page.keyboard.press('Shift+Digit1')
  await expect(viewport).toHaveAccessibleDescription(/View: Bottom\./)
  await page.mouse.move(5, 5)
  await shoot(page, 'df118-construction-note')

  // DF115: the depth pick's banner and the eligible surfaces
  const depth = input(inspector, 'Depth')
  await depth.click()
  await page.getByRole('button', { name: 'Pick Depth in the viewport' }).click()
  await expect(viewport.getByRole('status')).toContainText('Pick a surface for Depth')
  await shoot(page, 'df115-depth-pick')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  // DF116: the Through switch replaces the depth
  const through = inspector.getByRole('switch', { name: 'Through' })
  await through.click()
  await expect(through).toBeChecked()
  await through.scrollIntoViewIfNeeded()
  await page.mouse.move(5, 5)
  await shoot(page, 'df116-through')

  // DF117: a refused value stays in its field with its error (the field's own check)
  await select('Corner pocket')
  await viewport.focus()
  await page.keyboard.press('Digit0')
  const cornerDepth = input(inspector, 'Depth')
  await cornerDepth.fill('0')
  await cornerDepth.press('Enter')
  await expect(inspector.getByText('Must be greater than 0')).toBeVisible()
  await cornerDepth.scrollIntoViewIfNeeded()
  await shoot(page, 'df117-refused-value')
  await cornerDepth.fill('2')
  await cornerDepth.press('Enter')
  await cornerDepth.blur()

  // DF120: a length below twice the radius turns Round on, with the toast
  const length = input(inspector, 'Length (X)')
  await length.fill('5')
  await length.press('Enter')
  const round = inspector.getByRole('switch', { name: 'Round' })
  await expect(round).toBeChecked()
  await input(inspector, 'Corner radius').scrollIntoViewIfNeeded()
  await page.mouse.move(5, 5)
  await shoot(page, 'df120-round')
})

test('DF119: recessed countersink and slotted bolt holes', async ({ dfyom }) => {
  test.setTimeout(120_000)
  const page = await firstWindow(dfyom.app)
  const stock = await bridgeCall<{ id: string }>(page, 'library.stock.add', {
    values: {
      name: 'Aluminium',
      shape: 'block',
      length: '80',
      width: '40',
      thickness: '10',
      material: { name: '6061-T6', class: 'aluminum' },
    },
  })
  const alu = (values: Record<string, string>) => [
    { name: 'Alu', materialClass: 'aluminum', spindleSpeed: '18000', ...values },
  ]
  await bridgeCall(page, 'library.tool.add', {
    values: {
      name: 'Flat 3',
      type: 'flatEndMill',
      diameter: '3',
      fluteLength: '12',
      overallLength: '38',
      fluteCount: '2',
      toolMaterial: 'carbide',
      presets: alu({ feedRate: '600', plungeRate: '150', stepdown: '0.5', stepover: '1.2' }),
    },
  })
  await bridgeCall(page, 'library.tool.add', {
    values: {
      name: 'Chamfer 90 × 12',
      type: 'chamferMill',
      diameter: '12',
      angle: '90',
      fluteLength: '8',
      overallLength: '50',
      fluteCount: '2',
      toolMaterial: 'carbide',
      presets: alu({ feedRate: '400', plungeRate: '150' }),
    },
  })
  await bridgeCall(page, 'project.create', { name: 'Clamp', unitSystem: 'mm' })
  await bridgeCall(page, 'design.part.add', { name: 'Clamp', stockLibraryItemId: stock.id })

  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = await inspectorOf(page)
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page
    .getByRole('menu')
    .getByRole('group', { name: 'Features' })
    .getByRole('menuitem', { name: 'Bolt hole' })
    .click()
  await expect(inspector.getByRole('heading', { name: 'Bolt hole 1' })).toBeVisible()
  await inspector.getByRole('combobox', { name: 'Size' }).click()
  await page.getByRole('listbox').getByRole('option', { name: 'M5', exact: true }).click()
  await inspector.getByRole('radio', { name: 'Recessed countersink' }).click()
  await page.keyboard.press('ControlOrMeta+Enter')
  const sizes = inspector.getByRole('region', { name: 'Sizes' })
  await expect(input(sizes, 'Recess Ø')).toHaveValue('12.6 mm')
  await inspector.getByRole('region', { name: 'Type' }).scrollIntoViewIfNeeded()
  await shoot(page, 'df119-recessed-type')
  await sizes.scrollIntoViewIfNeeded()
  await shoot(page, 'df119-recessed-sizes')

  const slotted = inspector
    .getByRole('region', { name: 'Type' })
    .getByRole('switch', { name: 'Slotted' })
  await slotted.click()
  const slot = input(sizes, 'Slot length')
  await slot.fill('10')
  await slot.press('Enter')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(input(sizes, 'Overall')).toHaveValue('15.5 mm')
  await sizes.scrollIntoViewIfNeeded()
  await page.mouse.move(5, 5)
  await shoot(page, 'df119-slotted-sizes')
})
