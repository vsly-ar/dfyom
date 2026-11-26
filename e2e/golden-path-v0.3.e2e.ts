// The v0.3 exit criteria's app flow (task X2), through the UI only (roles and accessible names),
// mirroring the headless golden path of X1 (src/main/cli/exit-criteria.v03.fixture.ts) from a fresh
// install: the three tools of X1 with their hardwood presets drafted and saved in the Library
// window; a project on a 255 × 185 × 40 hardwood board; the enclosure STL imported through the
// stubbed "Import STL…" dialog and fitted onto the stock bottom; the X0 drawing imported with
// "Import SVG…" (report: two shapes, Béziers fitted to arcs, the deviation); facing; the cavity
// picked as a named shape on the facing floor, opened face-on in the Shape Editor window (DF94) where the back
// wall is measured (a shape midpoint to a snapped point on the reference section), the corner fix
// offered at the largest fitting radius and the two sharp step corners filleted in the segment
// table (1 / 0.25 mm, as X1); a cable notch built in the Shape Editor from an obround and a
// rectangle and rotated 90° on its pocket; the outline profiled outside with four tabs (count,
// then a marker moved with the keys, then the positions typed) and the library's Flat 12 locked;
// four drillings and an `on` groove along an open path (built in the segment table, picked while
// Outside: the side turns On) on the bottom. Plan: a machine from "New machine…", two
// setups (Bottom, Top), toolpaths, one program per setup, byte for byte X1's goldens; both setups
// run on the virtual machine at Max; saved, the app closed and relaunched, the project opened:
// shapes, placements, tabs, the tool lock and the setups unchanged, the programs exported again
// equal. Windows stay hidden (app.fixture.ts sets DFYOM_HIDE_WINDOWS=1).
// Docs: docs/plans/v0.3.md#exit-criteria, docs/conventions/testing.md#end-to-end
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import {
  closeDialog,
  expect,
  fitReference,
  launchApp,
  openPartSetup,
  openReferencePanel,
  shapeEditorWindow,
  test,
  zeroXyz,
  revealField,
} from './app.fixture'
import { withoutAppVersion } from '../src/core/post/plan-export'

const STL = resolve('src/core/design/__fixtures__/enclosure-wood-base.stl')
const SVG = resolve('src/core/design/__fixtures__/enclosure-sections.svg')
/** X1's golden programs: the same part built through the UI exports the same bytes. */
const GOLDEN = [
  resolve('src/main/cli/__golden__/exit-criteria-shapes-1-bottom.nc'),
  resolve('src/main/cli/__golden__/exit-criteria-shapes-2-top.nc'),
]

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

/** With DFYOM_RENDERS=1, the light and dark review renders (as run-serial.e2e.ts). */
async function render(page: Page, name: string): Promise<void> {
  if (!RENDERS) return
  for (const theme of ['light', 'dark'] as const) {
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

/** The setups in machining order. */
const SETUPS = ['Bottom', 'Top'] as const

/**
 * X1's placements (exit-criteria.v03.fixture.ts): the drawing's page (its STL centre at the
 * middle) centred on the board, so each named shape's anchor (the centre of its box) is moved by
 * the page offset (2.5, 3.5) mm; the user types the numbers X1 computes.
 */
const PLACE = {
  cavity: ['127.505748', '90.881748'],
  outline: ['127.498135', '92.506031'],
  // the notch centred on the cavity's flat back stretch, 8 mm into the cavity
  notch: ['127.5', '172.556'],
  groove: ['127.5', '92.5'],
} as const
/** X1's tab positions: (k + 0.5) × loop length / 4, to 3 decimals (mm from the start point). */
const TAB_POSITIONS = ['87.744', '263.231', '438.718', '614.205']
/** The cavity's sharp step corners (X1): path vertex and the largest radius its neighbours take. */
const FILLETS = [
  { vertex: 72, radius: '1' },
  { vertex: 0, radius: '0.25' },
] as const

/**
 * Native dialogs: "Import reference" opens the STL, "Import SVG" the drawing, any other open the
 * project; "Export gCode" saves under its suggested file name in `dir`, any other save is the
 * project file.
 */
async function stubFileDialogs(
  app: ElectronApplication,
  files: { stl: string; svg: string; project: string; dir: string },
): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    const options = (args: unknown[]) =>
      (args.at(-1) ?? {}) as { title?: string; defaultPath?: string }
    dialog.showOpenDialog = ((...args: unknown[]) => {
      const title = options(args).title
      const file = title === 'Import reference' ? f.stl : title === 'Import SVG' ? f.svg : f.project
      return Promise.resolve({ canceled: false, filePaths: [file] })
    }) as typeof dialog.showOpenDialog
    dialog.showSaveDialog = ((...args: unknown[]) => {
      const o = options(args)
      const name = (o.defaultPath ?? 'out.nc').split(/[\\/]/).at(-1)!
      return Promise.resolve({
        canceled: false,
        filePath: o.title === 'Export gCode' ? `${f.dir}/${name}` : f.project,
      })
    }) as typeof dialog.showSaveDialog
  }, files)
}

const input = (scope: Locator, label: string) =>
  scope.getByLabel(label, { exact: true }).and(scope.locator('input'))

/** Types a value and commits it with Enter (commit + Apply, apply.md#ui), then leaves the field. */
async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = input(scope, label)
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

async function addOperation(page: Page, label: string, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Navigator' })
    .getByRole('button', { name: 'Add', exact: true })
    .click()
  await page.getByRole('menuitem', { name: label }).click()
  await expect(
    page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name }),
  ).toBeVisible()
}

/** Picks the selected operation's surface in the `on` dropdown (grouped by direction, F1). */
async function pickOn(page: Page, option: RegExp): Promise<void> {
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await inspector.getByRole('combobox', { name: 'On', exact: true }).click()
  await page.getByRole('listbox').getByRole('option', { name: option }).click()
  await expect(inspector.getByRole('combobox', { name: 'On', exact: true })).toHaveText(option)
}

/** Picks a named shape in the selected operation's shape picker (U2). */
async function pickShape(page: Page, name: string): Promise<void> {
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const picker = inspector.getByRole('combobox', { name: 'Shape', exact: true })
  await picker.click()
  await page
    .getByRole('listbox')
    .getByRole('option', { name: new RegExp(`^${name}`) })
    .click()
  await expect(picker).toContainText(name)
  await expect(inspector.getByRole('button', { name: 'Edit shape' })).toBeVisible()
}

/** Picks an option of a select (combobox) in `scope`; its list opens in `page`. */
async function choose(page: Page, scope: Locator, label: string, option: string): Promise<void> {
  await scope.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

/** One library tool: geometry, then one hardwood preset (X1's TOOLS). */
interface ToolSpec {
  readonly type: 'Flat end mill' | 'Drill'
  readonly name: string
  readonly values: readonly (readonly [string, string])[]
  readonly preset: readonly (readonly [string, string])[]
}

const TOOLS: readonly ToolSpec[] = [
  {
    type: 'Flat end mill',
    name: 'Flat 12',
    values: [
      ['Diameter', '12'],
      ['Flute length', '50'],
      ['Overall length', '100'],
    ],
    preset: [
      ['Spindle speed', '12000'],
      ['Feed rate', '3600'],
      ['Plunge rate', '800'],
      ['Stepdown', '6'],
      ['Stepover', '6'],
    ],
  },
  {
    type: 'Flat end mill',
    name: 'Flat 6',
    values: [
      ['Diameter', '6'],
      ['Flute length', '25'],
      ['Overall length', '60'],
    ],
    preset: [
      ['Spindle speed', '16000'],
      ['Feed rate', '3000'],
      ['Plunge rate', '600'],
      ['Stepdown', '3'],
      ['Stepover', '3'],
    ],
  },
  {
    type: 'Drill',
    name: 'Drill 3',
    values: [
      ['Diameter', '3'],
      ['Flute length', '20'],
      ['Overall length', '50'],
    ],
    preset: [
      ['Spindle speed', '5000'],
      ['Feed rate', '250'],
      ['Plunge rate', '250'],
    ],
  },
]

/** Drafts and saves one tool with its hardwood preset in the Library window (L1). */
async function libraryTool(lib: Page, tool: ToolSpec): Promise<void> {
  await lib.getByRole('button', { name: 'New tool' }).click()
  const editor = lib.getByRole('region', { name: 'Item editor' })
  const grid = lib.getByRole('grid', { name: 'Tools' })
  await expect(grid.getByRole('row', { name: /Unsaved/ })).toBeVisible()
  await choose(lib, editor, 'Type', tool.type)
  await editor.getByRole('textbox', { name: 'Name' }).fill(tool.name)
  // the overall length waits in the collapsed Details group (DF26; kept open across items)
  const details = editor.getByRole('button', { name: /^Details/ })
  if ((await details.getAttribute('aria-expanded')) === 'false') await details.click()
  for (const [label, value] of tool.values) await setField(editor, label, value)
  await editor.getByRole('button', { name: 'Add preset' }).click()
  await choose(lib, editor, 'Material of Preset 1', 'Hardwood')
  for (const [column, value] of tool.preset) {
    const cell = editor.getByRole('textbox', { name: `${column} of Preset 1`, exact: true })
    await cell.fill(value)
    await cell.press('Enter')
  }
  await editor.getByRole('button', { name: 'Save' }).click()
  await expect(grid.getByRole('row', { name: new RegExp(tool.name) })).not.toContainText('Unsaved')
  await expect(grid.getByRole('row', { name: /Unsaved/ })).toHaveCount(0)
}

const designRows = (page: Page) =>
  page
    .getByRole('list', { name: 'Operations in design order' })
    .getByRole('button', { name: /^(Facing|Pocket|Drilling|Profile) \d/ })

const setupOps = (page: Page, setup: string) =>
  page
    .getByRole('list', { name: `Plan operations of ${setup} in machining order` })
    .getByRole('button', { name: /^(Facing|Pocket|Profile|Drilling) \d/ })

/** The operation names of each program's sections, in order. */
const sections = (gcode: string) =>
  [...gcode.matchAll(/^\(((?:Facing|Pocket|Profile|Drilling)[^)]*)\)$/gm)].map((m) => m[1])

test('v0.3 golden path through the UI: shapes, Shape Editor, snap and measure, tabs, two setups, reopen', async ({
  dfyom,
}) => {
  // a long multi-step UI flow: library, design with shapes, plan, two exports and runs, a relaunch
  test.setTimeout(300_000)
  const files = {
    stl: STL,
    svg: SVG,
    project: join(dfyom.dataDir, 'Enclosure shapes.dfyom'),
    dir: dfyom.dataDir,
  }
  await stubFileDialogs(dfyom.app, files)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const viewport = page.getByRole('region', { name: '3D viewport' })
  const status = page.getByRole('contentinfo', { name: 'Status bar' })
  const applyButton = page.getByRole('button', { name: /^Apply \d+ changes?$/ })

  // ── Library window: X1's three tools with their hardwood presets ─────────────────────────
  const opened = dfyom.app.waitForEvent('window')
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  const lib = await opened
  await lib.waitForLoadState('domcontentloaded')
  await expect(lib.getByRole('tab', { name: 'Tools' })).toHaveAttribute('aria-selected', 'true')
  for (const tool of TOOLS) await libraryTool(lib, tool)
  await lib.close()

  // ── New project on a 255 × 185 × 40 hardwood board ───────────────────────────────────────
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Enclosure shapes')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page).toHaveTitle('Enclosure shapes')
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '255')
  await setField(setup, 'Width (Y)', '185')
  await setField(setup, 'Thickness (Z)', '40')
  await setup.getByRole('textbox', { name: 'Material name' }).fill('Walnut')
  await setup.getByRole('combobox', { name: 'Material class' }).click()
  await page.getByRole('option', { name: 'Hardwood' }).click()
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()
  await expect(navigator.getByText(/^Stock: 255 × 185 × 40/)).toBeVisible()

  // ── Import the STL reference, fitted onto the stock bottom ───────────────────────────────
  // in the Reference panel (DF3); Fit mode without scaling, height Bottom (DF5)
  const references = await openReferencePanel(page)
  await references.getByRole('button', { name: 'Import STL…' }).click()
  await expect(references.getByTitle('enclosure-wood-base')).toBeVisible({ timeout: 30_000 })
  await fitReference(references, { scale: false, height: 'Bottom' })
  await expect(input(inspector, 'Position Z')).toHaveValue('-40 mm')
  await expect(inspector.getByText('The reference fits inside the stock.')).toBeVisible()
  await expect(viewport).toHaveAccessibleDescription(
    /Reference enclosure-wood-base shown as a ghost\./,
    { timeout: 30_000 },
  )

  // ── Import SVG…: two shapes, Béziers fitted to arcs, the deviation ───────────────────────
  // in the Shapes dialog (D45); the import's dialogs stack over it
  let shapes = await openPartSetup(page, 'Shapes')
  await shapes.getByRole('button', { name: 'Import SVG…' }).click()
  await page
    .getByRole('dialog', { name: 'Import SVG' })
    .getByRole('button', { name: 'Import' })
    .click()
  const report = page.getByRole('dialog', { name: 'Imported 2 shapes' })
  await expect(report).toBeVisible({ timeout: 30_000 })
  await expect(report.getByText('250.00 × 178.00 mm')).toBeVisible()
  await expect(report.getByText('2 shapes, 2 loops')).toBeVisible()
  // 22 cubic Béziers, each fitted within 0.01 mm
  await expect(report.getByText(/^22, ≤ 0\.0(0\d|10) mm$/)).toBeVisible()
  await report.getByRole('button', { name: 'Close' }).first().click()
  await expect(report).toHaveCount(0)
  const shapeRows = shapes.getByRole('list').getByRole('button', { name: /^(outline|cavity)/ })
  await expect(shapeRows).toHaveCount(2)
  await closeDialog(shapes)

  // ── Top: facing; the cavity as a named shape on the facing floor ─────────────────────────
  await navigator.getByRole('button', { name: 'Add facing' }).click()
  await expect(inspector.getByRole('heading', { name: 'Facing 1' })).toBeVisible()
  await setField(inspector, 'Depth', '1')

  await addOperation(page, 'Pocket', 'Pocket 1')
  await pickOn(page, /^Facing 1 floor/)
  await pickShape(page, 'cavity')
  await setField(inspector, 'Position X', PLACE.cavity[0])
  await setField(inspector, 'Position Y', PLACE.cavity[1])
  await setField(inspector, 'Depth', '34.8')
  // X0: two sharp corners at the back wall's step (one shown, "1 more"); the picker offers the
  // 6 mm tool's radius
  const shapeGroup = inspector.getByRole('region', { name: 'Shape' })
  await expect(
    shapeGroup.getByText('A sharp inside corner cannot be cut by a round tool.').first(),
  ).toBeVisible()
  await expect(shapeGroup.getByRole('button', { name: '1 more' })).toBeVisible()
  // the tool radius does not fit between the fitted wall's segments: the fix offers the largest
  // radius the corner takes and says the warning stays (X2 finding). Not applied here: the step
  // corners are filleted in the segment table below, as X1 does
  await expect(
    shapeGroup.getByRole('button', { name: /^Round corners to .+ \(largest that fits\)$/ }),
  ).toBeVisible()
  await expect(
    shapeGroup.getByText(/less than the tool radius 3 mm: the warning stays\.$/).first(),
  ).toBeVisible()

  // ── Shape Editor face-on: measure the back wall, snapped to the reference section ────────
  await shapeGroup.getByRole('button', { name: 'Edit shape' }).click()
  // it opens the project's Shape Editor window (DF94): the shape work happens there
  const shapeWin = await shapeEditorWindow(dfyom.app)
  const se = shapeWin.page
  const shapeInspector = shapeWin.inspector
  const editor = shapeWin.editor
  await expect(editor.getByText(/^Shape · /)).toBeVisible()
  await expect(shapeInspector.getByRole('heading', { name: 'cavity' })).toBeVisible()
  await expect(editor.getByTestId('shape-section')).toBeAttached({ timeout: 30_000 })
  const face = editor.getByTestId('shape-stock-face')
  /** A face-frame point (mm, X right and Y up on the top face) in page pixels. */
  const at = async (x: number, y: number) => {
    const b = (await face.boundingBox())!
    return [b.x + (x / 255) * b.width, b.y + b.height - (y / 185) * b.height] as const
  }
  // zoom to the back wall (Ctrl + wheel zooms to the cursor), so the points are a few px apart
  const [zx, zy] = await at(127.5, 175)
  await se.mouse.move(zx, zy)
  await se.keyboard.down('Control')
  for (let i = 0; i < 4; i++) await se.mouse.wheel(0, -120)
  await se.keyboard.up('Control')
  await editor.focus()
  await se.keyboard.press('d')
  await expect(editor.getByRole('button', { name: /Measure/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  const glyph = editor.getByTestId('snap-glyph')
  // the cavity's flat back stretch: its midpoint (x 127.5) at y 168.556 on the board
  const [ax, ay] = await at(127.5, 168.556)
  await se.mouse.move(ax - 2, ay + 1)
  await se.mouse.move(ax, ay)
  await expect(glyph).toHaveAttribute('data-kind', 'midpoint')
  await se.mouse.click(ax, ay)
  // the reference's outer wall straight behind it (the STL section at mid-wall height)
  const [bx, by] = await at(127.5, 181.07)
  await se.mouse.move(bx + 1, by + 2)
  await se.mouse.move(bx, by)
  await expect(glyph).toHaveAttribute('data-kind', 'reference')
  await expect(glyph).toContainText('Reference')
  await se.mouse.click(bx, by)
  // X0: the back wall is ≈ 12.5 mm where the notch crosses it
  const chip = editor.getByTestId('measure-chip')
  await expect(chip).toHaveText(/^12\.[45]\d mm$/)
  await se.keyboard.press('Escape')
  await expect(chip).toHaveCount(0)

  // ── the two step corners filleted in the segment table (X1: vertex 72 → 1, vertex 0 → 0.25) ─
  const segmentsGrid = shapeInspector.getByRole('grid', { name: 'Segments of Path 1' })
  await expect(segmentsGrid).toBeVisible()
  const rows = await segmentsGrid.getByRole('row').count()
  const segmentCount = rows - 1
  for (const f of FILLETS) {
    // a vertex is the end of the segment before it; vertex 0 of the closed path ends the last one
    const label =
      f.vertex === 0
        ? (await input(shapeInspector, 'Fillet at start').count()) > 0
          ? 'Fillet at start'
          : `Segment ${segmentCount} Fillet`
        : `Segment ${f.vertex} Fillet`
    await setField(shapeInspector, label, f.radius)
    await expect(input(shapeInspector, label)).toHaveValue(new RegExp(`^${f.radius}`))
  }
  await expect(shapeInspector.getByText('This shape does not resolve')).toHaveCount(0)
  // what the cavity still says: corners below every end mill's radius, none sharp (the project
  // window still shows Pocket 1: the shape was edited in its own window, DF94)
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()
  await expect(
    shapeGroup.getByText('A sharp inside corner cannot be cut by a round tool.'),
  ).toHaveCount(0)

  // ── Shape Editor: a cable notch from an obround and a rectangle (a boolean) ──────────────
  // adding a shape selects it and closes the Shapes dialog (D45)
  shapes = await openPartSetup(page, 'Shapes')
  await shapes.getByRole('button', { name: 'Add shape' }).click()
  await page.getByRole('menuitem', { name: 'Obround' }).click()
  await expect(shapeInspector.getByRole('heading', { name: 'Shape 3' })).toBeVisible()
  const nameField = shapeInspector.getByRole('textbox', { name: 'Name', exact: true })
  await nameField.fill('Cable notch')
  await nameField.press('Enter')
  await expect(shapeInspector.getByRole('heading', { name: 'Cable notch' })).toBeVisible()
  await setField(shapeInspector, 'Length', '24')
  await setField(shapeInspector, 'Width', '10')
  const items = shapeInspector.getByRole('region', { name: 'Items' })
  await items.getByRole('button', { name: 'Add item' }).click()
  await se.getByRole('menuitem', { name: 'Rectangle' }).click()
  const itemRows = (scope: Locator) =>
    scope
      .getByRole('list', { name: 'Items in order' })
      .getByRole('button', { name: /^(Obround|Rectangle|Path) \d: / })
  await expect(itemRows(shapeInspector)).toHaveText([/Obround 24 × 10/, /Rectangle 40 × 20/])
  await expect(shapeInspector.getByRole('heading', { name: 'Rectangle 2' })).toBeVisible()
  await setField(shapeInspector, 'Centre X', '6')
  await setField(shapeInspector, 'Length', '12')
  await setField(shapeInspector, 'Width', '10')
  await setField(shapeInspector, 'Corner radius', '3')
  // one round end (in the cavity), one square end with the 6 mm tool's radius: one loop, 24 × 10
  const summary = shapeInspector.getByRole('region', { name: 'Shape', exact: true })
  await expect(summary.getByText('24.00 × 10.00 mm')).toBeVisible()
  await expect(summary.getByText(/· 1 loop$/)).toBeVisible()

  // its pocket across the back wall, rotated 90°
  await addOperation(page, 'Pocket', 'Pocket 2')
  await pickOn(page, /^Facing 1 floor/)
  await pickShape(page, 'Cable notch')
  await setField(inspector, 'Position X', PLACE.notch[0])
  await setField(inspector, 'Position Y', PLACE.notch[1])
  await revealField(inspector, 'Rotation')
  await setField(inspector, 'Rotation', '90')
  await expect(input(inspector, 'Rotation')).toHaveValue(/^90/)
  await setField(inspector, 'Depth', '10')

  // ── the outline as an outside profile: four tabs along the loop, the library's Flat 12 locked
  await addOperation(page, 'Profile', 'Profile 1')
  await pickShape(page, 'outline')
  await setField(inspector, 'Position X', PLACE.outline[0])
  await setField(inspector, 'Position Y', PLACE.outline[1])
  await inspector
    .getByRole('radiogroup', { name: 'Side' })
    .getByRole('radio', { name: 'Outside' })
    .click()
  await revealField(inspector, 'Slot width')
  await setField(inspector, 'Slot width', '12')
  await setField(inspector, 'Tab count', '4')
  await setField(inspector, 'Tab width', '12')
  await setField(inspector, 'Tab thickness', '4')
  // count-spaced: the markers sit at (k + 0.5) × length / 4 (X1's positions)
  const marker = viewport.locator('[data-tab-marker="0"]')
  await expect(marker).toHaveAttribute('aria-label', /^Tab 1, 87\.74 mm from the start/)
  // the keyboard path: a focused marker moves 1 mm per arrow key, one run one gesture; the count
  // becomes entered positions
  await marker.focus()
  // (pressed quickly: the run outlives the replies of its own steps, fixed in X2)
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
  await expect(inspector.getByText('Positions entered by you.')).toBeVisible()
  await expect(marker).toHaveAttribute('aria-label', /^Tab 1, 90\.74 mm from the start/)
  await expect(inspector.getByRole('button', { name: 'Space evenly' })).toBeVisible()
  // the run's last step has landed (its field shows it) before the positions are typed
  await expect(input(inspector, 'Tab 1')).toHaveValue(/^90\.74/)
  // the positions typed as X1 places them
  for (const [i, p] of TAB_POSITIONS.entries()) await setField(inspector, `Tab ${i + 1}`, p)
  for (const [i, p] of TAB_POSITIONS.entries())
    await expect(input(inspector, `Tab ${i + 1}`)).toHaveValue(new RegExp(`^${p}`))
  const toolField = inspector.getByRole('region', { name: 'Tool' })
  const toolCombo = toolField.getByRole('combobox', { name: 'Tool' })
  // the 12 mm slot's Apply already took the library's Flat 12 over a generalized tool (DF54)
  await expect(toolCombo).toHaveText(/^Flat 12 · Ø 12/)
  const toolLock = toolField.getByRole('button', { name: 'Lock tool' })
  await toolLock.click()
  await expect(toolLock).toHaveAttribute('aria-pressed', 'true')
  // locking pins it (one command, commit only); Apply runs the tool choice of the others
  await applyButton.click()
  await expect(applyButton).toHaveCount(0)

  // ── Bottom (u = part X, v = part −Y): four drillings, Ø 3 × 3.9 mm, drill point ──────────
  const holes = [
    ['39', '48.2'],
    ['39', '136.8'],
    ['216', '48.2'],
    ['216', '136.8'],
  ] as const
  for (const [i, [u, v]] of holes.entries()) {
    await addOperation(page, 'Drilling', `Drilling ${i + 1}`)
    await pickOn(page, /^Stock bottom/)
    await setField(inspector, 'Centre u', u)
    await setField(inspector, 'Centre v', v)
    await setField(inspector, 'Diameter', '3')
    await inspector.getByRole('combobox', { name: 'Bottom' }).click()
    await page.getByRole('option', { name: 'Drill point' }).click()
    await setField(inspector, 'Depth', '3.9')
  }

  // ── an `on` groove along an open path: a line and a tangent arc, built in the segment table
  shapes = await openPartSetup(page, 'Shapes')
  await shapes.getByRole('button', { name: 'Add shape' }).click()
  await page.getByRole('menuitem', { name: 'Path' }).click()
  await expect(shapeInspector.getByRole('heading', { name: 'Shape 4' })).toBeVisible()
  await nameField.fill('Label groove')
  await nameField.press('Enter')
  await expect(shapeInspector.getByRole('heading', { name: 'Label groove' })).toBeVisible()
  await shapeInspector.getByRole('switch', { name: 'Closed' }).click()
  await expect(shapeInspector.getByRole('switch', { name: 'Closed' })).not.toBeChecked()
  // segment 1 stays the line to (40, 0); segment 2 becomes a tangent arc to (60, 20)
  await choose(se, shapeInspector, 'Segment 2 Type', 'Tangent arc')
  await setField(shapeInspector, 'Segment 2 End X', '60')
  await setField(shapeInspector, 'Segment 2 End Y', '20')
  // the row's actions are its context menu (DF70): right-click anywhere on the row
  await shapeInspector
    .getByRole('row')
    .filter({ has: se.getByLabel('Segment 3 End X') })
    .click({ button: 'right' })
  await se
    .getByRole('menu', { name: 'Actions for segment 3' })
    .getByRole('menuitem', { name: 'Remove segment 3' })
    .click()
  await expect(
    shapeInspector.getByRole('list', { name: 'Items in order' }).getByRole('button', {
      name: /Open path · 2 segments/,
    }),
  ).toBeVisible()

  await addOperation(page, 'Profile', 'Profile 2')
  await pickOn(page, /^Stock bottom/)
  // an open path is cut on the line only: picked while the side is Outside, the side turns On
  // in the same step, with a notice (X2 finding: it was refused at the picker before)
  const picker = inspector.getByRole('combobox', { name: 'Shape', exact: true })
  await picker.click()
  await page
    .getByRole('listbox')
    .getByRole('option', { name: /^Label groove/ })
    .click()
  await expect(picker).toContainText('Label groove')
  await expect(
    inspector.getByRole('radiogroup', { name: 'Side' }).getByRole('radio', { name: 'On line' }),
  ).toBeChecked()
  // the toast shows over the 3D view since DF45, not over the navigator
  await expect(
    page
      .getByRole('region', { name: /^Notifications/ })
      .getByText('Side set to On line: an open path is cut on the line.'),
  ).toBeVisible()
  // a blind 1 mm groove
  await setField(inspector, 'Position u', PLACE.groove[0])
  await setField(inspector, 'Position v', PLACE.groove[1])
  await revealField(inspector, 'Slot width')
  await setField(inspector, 'Slot width', '6')
  await setField(inspector, 'Depth', '1')

  await expect(designRows(page)).toHaveText([
    /^Facing 1/,
    /^Pocket 1/,
    /^Pocket 2/,
    /^Profile 1/,
    /^Drilling 1/,
    /^Drilling 2/,
    /^Drilling 3/,
    /^Drilling 4/,
    /^Profile 2/,
  ])
  shapes = await openPartSetup(page, 'Shapes')
  await expect(
    shapes
      .getByRole('list')
      .getByRole('button', { name: /^(outline|cavity|Cable notch|Label groove)/ }),
  ).toHaveCount(4)
  await closeDialog(shapes)
  await expect(applyButton).toHaveCount(0)
  await expect(status.getByText('Part up to date')).toBeAttached({ timeout: 60_000 })
  await expect(viewport).toHaveAccessibleDescription(/Part with 9 operations/)

  // ── Plan: a machine from "New machine…", two setups (Bottom, Top) ────────────────────────
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByRole('radio', { name: 'Plan' })).toBeChecked()
  // no plan yet: "Plan the part" is a card over the view (DF29)
  const planStart = page.getByRole('dialog', { name: 'Plan the part' })
  await planStart.getByRole('button', { name: 'New machine…' }).click()
  const newMachine = page.getByRole('dialog', { name: 'New machine' })
  await newMachine.getByRole('textbox', { name: 'Name' }).fill('Router')
  for (const [label, value] of [
    ['Travel X', '800'],
    ['Travel Y', '800'],
    ['Travel Z', '150'],
    ['Max feed rate X', '5000'],
    ['Max feed rate Y', '5000'],
    ['Max feed rate Z', '1000'],
    ['Max spindle speed', '30000'],
  ] as const)
    await setField(newMachine, label, value)
  await newMachine.getByRole('button', { name: 'Add machine' }).click()
  await expect(newMachine).toBeHidden()
  await planStart.getByRole('button', { name: 'Create plan' }).click()
  const setups = navigator.getByRole('list', { name: 'Setups in machining order' })
  const setupRow = (i: number) =>
    setups.getByRole('button', { name: new RegExp(`^${i + 1}\\. ${SETUPS[i]}`) })
  /** Clicks a setup row at its start (with focus, its move and menu buttons overlay its end). */
  const pickSetup = (i: number) => setupRow(i).click({ position: { x: 24, y: 12 } })
  for (const i of [0, 1]) await expect(setupRow(i)).toBeVisible()
  // the tools the design chose from the library (X1: the cavity's 12, the notch's and groove's 6)
  await expect(setupOps(page, 'Bottom')).toHaveText([
    /^Drilling 1, Drilling 2, Drilling 3, Drilling 4.*Drill 3/,
    /^Profile 2.*Flat 6/,
  ])
  await expect(setupOps(page, 'Top')).toHaveText([
    /^Facing 1.*Flat 12/,
    /^Pocket 1.*Flat 12/,
    /^Pocket 2.*Flat 6/,
    /^Profile 1.*Flat 12/,
  ])

  // ── Toolpaths; one program per setup, byte for byte X1's goldens ─────────────────────────
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 90_000 })
  const exportSetup = async (p: Page, i: number) => {
    const name = SETUPS[i]!
    await p
      .getByRole('navigation', { name: 'Navigator' })
      .getByRole('button', { name: `Export ${name} gCode…` })
      .click()
    const done = p.getByRole('dialog', { name: 'gCode exported' })
    await expect(done.getByText(`Setup ${name} (${i + 1} of 2)`)).toBeVisible({ timeout: 30_000 })
    await expect(done.getByText('No machine warnings.')).toBeVisible()
    const file = join(dfyom.dataDir, `enclosure-shapes-s${i + 1}.nc`)
    expect(existsSync(file)).toBe(true)
    const gcode = readFileSync(file, 'utf8')
    await expect(done.getByText(`${gcode.trimEnd().split('\n').length} lines`)).toBeVisible()
    await done.getByRole('button', { name: 'Close' }).click()
    await expect(done).toBeHidden()
    return gcode
  }
  const programs: string[] = []
  for (const i of SETUPS.keys()) {
    await pickSetup(i)
    programs.push(await exportSetup(page, i))
  }
  expect(programs.map(sections)).toEqual([
    ['Drilling 1, Drilling 2, Drilling 3, Drilling 4', 'Profile 2'],
    ['Facing 1', 'Pocket 1', 'Pocket 2', 'Profile 1'],
  ])
  // the top program follows the oval with arcs
  expect(programs[1]!.match(/^G[23] /gm)?.length ?? 0).toBeGreaterThan(100)
  // the same part as X1's headless flow: the same programs
  for (const [i, gcode] of programs.entries())
    expect(withoutAppVersion(gcode)).toBe(readFileSync(GOLDEN[i]!, 'utf8'))
  const lineCounts = programs.map((g) => g.trimEnd().split('\n').length)

  // ── Run both setups on the virtual machine at Max, the setup change between ──────────────
  await page.keyboard.press('ControlOrMeta+3')
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  const machine = page.getByRole('group', { name: 'Machine' })
  // a serial port is the default connection (DF101): choose the virtual machine
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: 'Max' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(machine.getByText('Virtual machine · Max')).toBeVisible()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  // jog to the middle of the table and 50 mm down, then set the work zero there
  await navigator.getByRole('radio', { name: '100 mm' }).click()
  for (const name of ['Jog X−', 'Jog Y−'])
    for (let i = 0; i < 4; i++) {
      await navigator.getByRole('button', { name }).click()
      await expect(machine.getByText('Idle')).toBeVisible()
    }
  await navigator.getByRole('radio', { name: '10 mm' }).click()
  for (let i = 0; i < 5; i++) {
    await navigator.getByRole('button', { name: 'Jog Z−' }).click()
    await expect(machine.getByText('Idle')).toBeVisible()
  }
  await zeroXyz(page)
  const dro = inspector.getByRole('table', { name: 'Position' })
  await expect(dro.getByRole('cell', { name: 'Work position Z' })).toHaveText(/^0\.000/)

  await inspector.getByRole('button', { name: 'Start run' }).click()
  const preflight = page.getByRole('dialog', { name: 'Start run?' })
  await expect(preflight.getByText('Bottom (1 of 2)')).toBeVisible()
  await expect(preflight.getByText('Router')).toBeVisible()
  await preflight.getByRole('button', { name: 'Start run' }).click()
  // M7: the inspector names the running plan and setup; on screen even when the run's first
  // wait (at Max, often before this check) already hides the inspector from the a11y tree
  // behind its modal (P9)
  await expect(
    page
      .getByRole('complementary', { name: 'Inspector', includeHidden: true })
      .getByText(/ · setup 1 of 2: Bottom$/),
  ).toBeVisible()
  // M5: stopped at its first wait, the run resumes at that operation's start ("Resume from…")
  const firstWait = page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
  await expect(firstWait).toBeVisible({ timeout: 90_000 })
  await firstWait.getByRole('button', { name: 'Stop' }).click()
  await expect(firstWait).toBeHidden()
  await expect(machine.getByText('Idle')).toBeVisible()
  await inspector.getByRole('button', { name: 'Resume from…' }).click()
  const resume = page.getByRole('dialog', { name: 'Resume run?' })
  await expect(resume.getByRole('combobox', { name: 'Resume at' })).toHaveText(
    /^Drilling 1, .+ · tool 1: Drill 3 \(stopped here\)$/,
  )
  await render(page, 'm5-resume-preflight')
  // the first operation: the whole program, but waiting at the first tool too
  await resume.getByRole('button', { name: 'Resume run' }).click()
  await expect(page.getByRole('dialog', { name: 'Tool change 1' })).toBeVisible()
  for (const i of SETUPS.keys()) {
    // each run waits at its tool changes; it ends complete with every line of its program (the
    // resumed bottom run: a few more, its first tool change)
    const lines = i === 0 ? String.raw`\d+` : String(lineCounts[i])
    const complete = page.getByText(new RegExp(`^Run complete: ${lines} lines in`))
    for (;;) {
      const wait = page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
      await expect(wait.or(complete)).toBeVisible({ timeout: 90_000 })
      if (await complete.isVisible()) break
      const title = (await wait.getByRole('heading').first().textContent()) ?? ''
      await wait.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('dialog', { name: title })).toBeHidden()
    }
    const next = SETUPS[i + 1]
    if (next === undefined) break
    const change = page.getByRole('dialog', { name: `Setup change: setup ${i + 2}, ${next}` })
    await expect(change).toBeVisible()
    await expect(change.getByRole('img', { name: /^The stock on the machine:/ })).toBeVisible()
    // M7: the zero to set and the part corner it is
    await expect(
      change.getByText(/^X0 Y0 at the front-left corner of the top.* corner\.$/),
    ).toBeVisible()
    await render(page, 'm7-setup-change')
    await change.getByRole('button', { name: `Start setup ${i + 2}` }).click()
    await expect(change).toBeHidden()
  }
  await expect(page.getByRole('dialog', { name: /^Setup change/ })).toHaveCount(0)
  await expect(machine.getByText('Idle')).toBeVisible()
  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  await expect(machine).toHaveCount(0)

  // ── Save as, close the app, relaunch, open ───────────────────────────────────────────────
  await page.keyboard.press('ControlOrMeta+s')
  await expect(status.getByText('Saved', { exact: true })).toBeVisible()
  expect(existsSync(files.project)).toBe(true)
  expect(dfyom.rendererErrors).toEqual([])

  await dfyom.app.close()
  const second = await launchApp(dfyom.dataDir)
  try {
    await stubFileDialogs(second.app, files)
    const page2 = await second.app.firstWindow()
    const nav2 = page2.getByRole('navigation', { name: 'Navigator' })
    const inspector2 = page2.getByRole('complementary', { name: 'Inspector' })
    await nav2.getByRole('button', { name: 'Open project' }).click()
    await expect(page2).toHaveTitle('Enclosure shapes')
    const references2 = await openReferencePanel(page2)
    await expect(references2.getByTitle('enclosure-wood-base')).toBeVisible()
    await expect(references2.getByText('STL · 49 806 triangles')).toBeVisible()
    // the shapes: the cavity's fillets, the notch's two items, the groove's open path; choosing
    // a row selects it and closes the dialog
    const shapes2 = await openPartSetup(page2, 'Shapes')
    for (const name of ['outline', 'cavity', 'Cable notch', 'Label groove'])
      await expect(shapes2.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()
    await shapes2.getByRole('button', { name: /^cavity/ }).click()
    // in the Shape Editor window (DF94); its list switches shapes there
    const shapeWin2 = await shapeEditorWindow(second.app)
    await expect(shapeWin2.inspector.getByRole('heading', { name: 'cavity' })).toBeVisible()
    await expect(input(shapeWin2.inspector, `Segment ${FILLETS[0].vertex} Fillet`)).toHaveValue(
      /^1/,
    )
    await shapeWin2.list.getByRole('button', { name: /^Cable notch/ }).click()
    await expect(itemRows(shapeWin2.inspector)).toHaveText([/Obround 24 × 10/, /Rectangle 12 × 10/])
    // the placements, the notch's rotation, the tab positions and the tool lock
    await expect(designRows(page2)).toHaveCount(9)
    await designRows(page2).nth(1).click()
    await expect(input(inspector2, 'Position X')).toHaveValue(PLACE.cavity[0])
    await designRows(page2).nth(2).click()
    await revealField(inspector2, 'Rotation')
    await expect(input(inspector2, 'Rotation')).toHaveValue(/^90/)
    await expect(input(inspector2, 'Position Y')).toHaveValue(PLACE.notch[1])
    await designRows(page2).nth(3).click()
    for (const [i, p] of TAB_POSITIONS.entries())
      await expect(input(inspector2, `Tab ${i + 1}`)).toHaveValue(new RegExp(`^${p}`))
    const toolField2 = inspector2.getByRole('region', { name: 'Tool' })
    await expect(toolField2.getByRole('combobox', { name: 'Tool' })).toHaveText(/^Flat 12/)
    await expect(toolField2.getByRole('button', { name: 'Lock tool' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(
      page2.getByRole('contentinfo', { name: 'Status bar' }).getByText('Part up to date'),
    ).toBeAttached({ timeout: 60_000 })
    // the plan: its setups and tools; the programs exported again are the same
    await page2.keyboard.press('ControlOrMeta+2')
    const setups2 = nav2.getByRole('list', { name: 'Setups in machining order' })
    for (const [i, name] of SETUPS.entries())
      await expect(
        setups2.getByRole('button', { name: new RegExp(`^${i + 1}\\. ${name}`) }),
      ).toBeVisible()
    await expect(setupOps(page2, 'Top')).toHaveText([/Flat 12/, /Flat 12/, /Flat 6/, /Flat 12/])
    await expect(setupOps(page2, 'Bottom')).toHaveText([/Drill 3/, /Flat 6/])
    for (const i of SETUPS.keys()) {
      await setups2
        .getByRole('button', { name: new RegExp(`^${i + 1}\\. ${SETUPS[i]}`) })
        .click({ position: { x: 24, y: 12 } })
      expect(await exportSetup(page2, i)).toBe(programs[i])
    }
    expect(second.rendererErrors).toEqual([])
  } finally {
    await second.app.close()
  }
})
