// The v0.4 exit criteria's app flow (task X2), through the UI only (roles and accessible names),
// mirroring the headless golden path of X1 (src/main/cli/exit-criteria.v04.fixture.ts) and the
// lid's constants (src/core/design/enclosure-lid.testing.ts) from a fresh install: X1's three
// tools with plywood presets (Flat 6, Flat 3 and the chamfer mill 90° × Ø 12) drafted and saved in
// the Library window; a project on a 255 × 200 × 6 plywood board (D40); "Import SVG…" of the
// v0.3 drawing, the cavity removed so the outline stays; the outline profiled outside with six
// tabs (two relocate, D42); the countersunk M3 hole through "Add › Features › Bolt hole" with the
// fastener picker and a Make Clones… grid 2 × 2; the Ø 22 cutout as an inside circle profile with
// a standalone chamfer on its edge (Chamfer in its row menu, X2), the counterbored M3 hole 18 mm right of it
// and an arc Clones round it; the vent slot drawn as an obround, its inside profile and an offset
// Clones with instance 4 skipped by clicking its marker; the bolt-circle source M3 → M4 in the
// hole inspector (the Apply button counts 1 change, all six instances follow; undo restores M3 in
// one step). Plan: a machine from "New machine…", one setup, toolpaths, the program byte for byte
// X1's golden (tool by tool, clone position comments); run on the virtual machine at Max; saved,
// the app closed and relaunched, the project opened: features, clone rows, skips and instance
// numbers unchanged, the program exported again equal. Windows stay hidden (app.fixture.ts sets
// DFYOM_HIDE_WINDOWS=1).
// Docs: docs/plans/v0.4.md#exit-criteria, docs/conventions/testing.md#end-to-end
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import {
  BOLT_CIRCLE,
  BOLT_CIRCLE_EDITED,
  CUTOUT,
  LID_PROFILE,
  LID_STOCK,
  LID_TOOLS,
  onBoard,
  SCREWS,
  VENTS,
} from '../src/core/design/enclosure-lid.testing'
import {
  closeDialog,
  expect,
  launchApp,
  openPartSetup,
  shapeEditorWindow,
  test,
  zeroXyz,
  revealField,
} from './app.fixture'
import { withoutAppVersion } from '../src/core/post/plan-export'

const SVG = resolve('src/core/design/__fixtures__/enclosure-sections.svg')
/** X1's golden program: the same lid built through the UI exports the same bytes. */
const GOLDEN = resolve('src/main/cli/__golden__/exit-criteria-lid.nc')

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

/**
 * With DFYOM_RENDERS=1: light and dark review renders of the navigators (DF44: names win, one
 * icon per meaning, counts), the theme attribute set directly and put back after.
 */
async function render(page: Page, name: string): Promise<void> {
  if (!RENDERS) return
  // runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`
  const setTheme = (t: string | null) =>
    page.evaluate((v) => {
      const root = (
        globalThis as unknown as {
          document: {
            documentElement: {
              getAttribute(n: string): string | null
              setAttribute(n: string, v: string): void
              removeAttribute(n: string): void
            }
          }
        }
      ).document.documentElement
      const before = root.getAttribute('data-theme')
      if (v === null) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', v)
      return before
    }, t)
  const before = await setTheme('light')
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(theme)
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${rendersDir}/df44-${name}-${theme}.png` })
  }
  await setTheme(before)
}

/** A layout point (from the board's centre) as typed face coordinates. */
const at = (p: readonly [number, number]): [string, string] =>
  onBoard([p[0], p[1]]).map((c) => `${c}`) as [string, string]

/**
 * X1's placement of the outline (exit-criteria.v04.fixture.ts): the drawing's page centred on the
 * board, so the outline's anchor (the centre of its box) moves by the page offset; the user types
 * the numbers X1 computes (v0.3's, 7.5 mm further along Y on the 15 mm wider board).
 */
const OUTLINE_AT = ['127.498135', '100.006031'] as const

/**
 * Native dialogs: "Import SVG" opens the drawing, any other open the project; "Export gCode" saves
 * under its suggested file name in `dir`, any other save is the project file.
 */
async function stubFileDialogs(
  app: ElectronApplication,
  files: { svg: string; project: string; dir: string },
): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    const options = (args: unknown[]) =>
      (args.at(-1) ?? {}) as { title?: string; defaultPath?: string }
    dialog.showOpenDialog = ((...args: unknown[]) => {
      const file = options(args).title === 'Import SVG' ? f.svg : f.project
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

/** Picks an option of a select (combobox) in `scope`; its list opens in `page`. */
async function choose(page: Page, scope: Locator, label: string, option: string): Promise<void> {
  await scope.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

/** Opens the navigator's Add menu and picks `item` (operations, Bolt hole). */
async function addFromMenu(page: Page, item: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Navigator' })
    .getByRole('button', { name: 'Add', exact: true })
    .click()
  await page.getByRole('menu').getByRole('menuitem', { name: item }).click()
}

/** Right-clicks the navigator row named `row` and picks `item` from its menu (DF16). */
async function fromRowMenu(page: Page, row: RegExp, item: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Navigator' })
    .getByRole('button', { name: row })
    .click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: item }).click()
}

/** One library tool: geometry, then one plywood preset (X1's TOOLS). */
interface ToolSpec {
  readonly type: 'Flat end mill' | 'Chamfer mill'
  readonly name: string
  readonly values: readonly (readonly [string, string])[]
  readonly preset: readonly (readonly [string, string])[]
}

const TOOLS: readonly ToolSpec[] = [
  {
    type: 'Flat end mill',
    name: LID_TOOLS.profile.name,
    values: [
      ['Diameter', `${LID_TOOLS.profile.diameter}`],
      ['Flute length', '22'],
      ['Overall length', '60'],
    ],
    preset: [
      ['Spindle speed', '18000'],
      ['Feed rate', '4800'],
      ['Plunge rate', '800'],
      ['Stepdown', '3'],
      ['Stepover', '3'],
    ],
  },
  {
    type: 'Flat end mill',
    name: LID_TOOLS.mill.name,
    values: [
      ['Diameter', `${LID_TOOLS.mill.diameter}`],
      ['Flute length', '12'],
      ['Overall length', '38'],
    ],
    preset: [
      ['Spindle speed', '18000'],
      ['Feed rate', '3600'],
      ['Plunge rate', '300'],
      ['Stepdown', '1.5'],
      ['Stepover', '1.2'],
    ],
  },
  {
    type: 'Chamfer mill',
    name: LID_TOOLS.chamfer.name,
    values: [
      ['Diameter', `${LID_TOOLS.chamfer.diameter}`],
      ['Included angle', `${LID_TOOLS.chamfer.angle}`],
      ['Flute length', '8'],
      ['Overall length', '50'],
    ],
    preset: [
      ['Spindle speed', '12000'],
      ['Feed rate', '3800'],
      ['Plunge rate', '600'],
    ],
  },
]

/** Drafts and saves one tool with its plywood (sheet good) preset in the Library window (L1). */
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
  await choose(lib, editor, 'Material of Preset 1', 'Sheet good')
  for (const [column, value] of tool.preset) {
    const cell = editor.getByRole('textbox', { name: `${column} of Preset 1`, exact: true })
    await cell.fill(value)
    await cell.press('Enter')
  }
  await editor.getByRole('button', { name: 'Save' }).click()
  await expect(grid.getByRole('row', { name: new RegExp(tool.name) })).not.toContainText('Unsaved')
  await expect(grid.getByRole('row', { name: /Unsaved/ })).toHaveCount(0)
}

/** The program's section comments in order, clone positions left out. */
const sections = (gcode: string) =>
  [...gcode.matchAll(/^\(((?:Bolt hole|Profile|Chamfer)[^)]*)\)$/gm)].map((m) => m[1])

test('v0.4 golden path through the UI: holes, fastener picker, Clones, chamfers, one setup, reopen', async ({
  dfyom,
}) => {
  // a long multi-step UI flow: library, design with features, plan, export and run, a relaunch
  test.setTimeout(300_000)
  const files = {
    svg: SVG,
    project: join(dfyom.dataDir, 'Enclosure lid.dfyom'),
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
  const heading = (name: string) => inspector.getByRole('heading', { name, exact: true })
  const readout = inspector.getByText(/instances? ·/)
  /** The hole inspector's type (a choice: commits once the radio shows it). */
  const pickType = async (type: 'Countersink' | 'Counterbore') => {
    const radio = inspector.getByRole('radio', { name: type, exact: true })
    await radio.click()
    await expect(radio).toHaveAttribute('aria-checked', 'true')
  }

  // ── Library window: X1's three tools with their plywood presets ──────────────────────────
  const opened = dfyom.app.waitForEvent('window')
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  const lib = await opened
  await lib.waitForLoadState('domcontentloaded')
  await expect(lib.getByRole('tab', { name: 'Tools' })).toHaveAttribute('aria-selected', 'true')
  for (const tool of TOOLS) await libraryTool(lib, tool)
  await lib.close()

  // ── New project on a 255 × 200 × 6 plywood board ─────────────────────────────────────────
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Enclosure lid')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page).toHaveTitle('Enclosure lid')
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', `${LID_STOCK.length}`)
  await setField(setup, 'Width (Y)', `${LID_STOCK.width}`)
  await setField(setup, 'Thickness (Z)', `${LID_STOCK.thickness}`)
  await setup.getByRole('textbox', { name: 'Material name' }).fill('Birch plywood')
  await setup.getByRole('combobox', { name: 'Material class' }).click()
  await page.getByRole('option', { name: 'Sheet good' }).click()
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()
  await expect(navigator.getByText(/^Stock: 255 × 200 × 6/)).toBeVisible()

  // ── Import SVG…: two shapes; the cavity removed, the outline kept ────────────────────────
  // in the Shapes dialog (D45); the import's dialogs stack over it
  let shapes = await openPartSetup(page, 'Shapes')
  await shapes.getByRole('button', { name: 'Import SVG…' }).click()
  await page
    .getByRole('dialog', { name: 'Import SVG' })
    .getByRole('button', { name: 'Import' })
    .click()
  const report = page.getByRole('dialog', { name: 'Imported 2 shapes' })
  await expect(report).toBeVisible({ timeout: 30_000 })
  await report.getByRole('button', { name: 'Close' }).first().click()
  await expect(report).toHaveCount(0)
  // a row's actions are its context menu (DF70, ui.md decision 27); Remove keeps the dialog open
  await shapes.getByRole('button', { name: /^cavity/ }).click({ button: 'right' })
  await page
    .getByRole('menu', { name: 'Actions for cavity' })
    .getByRole('menuitem', { name: /^Remove/ })
    .click()
  const shapeRows = shapes.getByRole('list').getByRole('button', { name: /^(outline|cavity)/ })
  await expect(shapeRows).toHaveText([/^outline/])
  await closeDialog(shapes)

  // ── the outline as an outside profile with six tabs; two relocate (D42, TB1) ─────────────
  await addFromMenu(page, 'Profile')
  await expect(heading('Profile 1')).toBeVisible()
  const picker = inspector.getByRole('combobox', { name: 'Shape', exact: true })
  await picker.click()
  await page
    .getByRole('listbox')
    .getByRole('option', { name: /^outline/ })
    .click()
  await expect(picker).toContainText('outline')
  await setField(inspector, 'Position X', OUTLINE_AT[0])
  await setField(inspector, 'Position Y', OUTLINE_AT[1])
  await inspector
    .getByRole('radiogroup', { name: 'Side' })
    .getByRole('radio', { name: 'Outside' })
    .click()
  await revealField(inspector, 'Slot width')
  await setField(inspector, 'Slot width', `${LID_PROFILE.slotWidth}`)
  await setField(inspector, 'Tab count', `${LID_PROFILE.tabs.count}`)
  await setField(inspector, 'Tab width', `${LID_PROFILE.tabs.width}`)
  await setField(inspector, 'Tab thickness', `${LID_PROFILE.tabs.thickness}`)
  await expect(
    inspector.getByText(
      '2 of 6 tabs moved off sides where the slot leaves no stock beyond the cut.',
    ),
  ).toBeVisible()

  // ── the countersunk M3 hole: Add › Features › Bolt hole, the fastener picker ──────────────
  await addFromMenu(page, 'Bolt hole')
  await expect(heading('Bolt hole 1')).toBeVisible()
  const [sx, sy] = at(SCREWS.source)
  await setField(inspector, 'Centre X', sx)
  await setField(inspector, 'Centre Y', sy)
  await pickType('Countersink')
  await inspector.getByRole('combobox', { name: 'Size' }).click()
  await page
    .getByRole('listbox')
    .getByRole('option', { name: SCREWS.fastener, exact: true })
    .click()
  await expect(inspector.getByRole('img', { name: /^Section:/ })).toHaveAccessibleName(
    /^Section: Ø 3\.4 mm through; countersink Ø 7\.12 mm, 90°/,
  )
  await expect(
    navigator.getByRole('button', { name: /^Bolt hole 1, M3 countersink/ }),
  ).toBeVisible()

  // ── Make Clones… grid 2 × 2 of the hole (its row menu) ───────────────────────────────────
  await fromRowMenu(page, /^Bolt hole 1,/, 'Make Clones…')
  await expect(inspector.getByText('New Clones')).toBeVisible()
  await inspector.getByRole('button', { name: 'Add row' }).click()
  await page.getByRole('menuitem', { name: 'Grid' }).click()
  await inspector.getByRole('button', { name: 'Remove row 1' }).click()
  await expect(inspector.getByRole('button', { name: /^Row 1: Grid/ })).toBeVisible()
  await setField(inspector, 'Columns', `${SCREWS.grid.columns}`)
  await setField(inspector, 'Rows', `${SCREWS.grid.rows}`)
  await setField(inspector, 'Column spacing (X)', `${SCREWS.grid.spacing[0]}`)
  await setField(inspector, 'Row spacing (Y)', `${SCREWS.grid.spacing[1]}`)
  await expect(readout).toHaveText('1 + 3 clones = 4 instances · 0 skipped')
  await inspector.getByRole('button', { name: 'Make clones' }).click()
  await expect(navigator.getByRole('button', { name: /^Clones 1, ×4/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // ── the Ø 22 cutout: an inside circle profile (a through opening, cleared like a pocket) ─
  await addFromMenu(page, 'Profile')
  await expect(heading('Profile 2')).toBeVisible()
  await picker.click()
  await page.getByRole('listbox').getByRole('option', { name: 'Circle', exact: true }).click()
  const [cx, cy] = at(CUTOUT.centre)
  await setField(inspector, 'Position X', cx)
  await setField(inspector, 'Position Y', cy)
  await setField(inspector, 'Diameter', `${CUTOUT.diameter}`)
  await inspector
    .getByRole('radiogroup', { name: 'Side' })
    .getByRole('radio', { name: 'Inside' })
    .click()
  await revealField(inspector, 'Slot width')
  await setField(inspector, 'Slot width', `${CUTOUT.diameter / 2}`)
  await setField(inspector, 'Tab count', '0')

  // ── a standalone chamfer on the cutout's edge: Chamfer in the profile row's menu ─────────
  await fromRowMenu(page, /^Profile 2/, 'Chamfer')
  await expect(heading('Chamfer 1')).toBeVisible()
  await expect(inspector.getByRole('combobox', { name: 'Edge' })).toContainText('Profile 2 · Ø 22')
  // 1.5 mm × 45° (sized by width, D45): the default 0.5 mm is too shallow for the mill's plywood
  // feed (X1); the diameter at the face follows, read-only
  await setField(inspector, 'Width', `${CUTOUT.chamferWidth}`)
  await expect(input(inspector, 'Depth')).toHaveValue(/^1\.5/)
  await expect(input(inspector, 'Diameter')).toHaveValue(`Ø ${CUTOUT.chamfer} mm`)

  // ── the counterbored M3 hole 18 mm right of the cutout and its arc Clones ────────────────
  await addFromMenu(page, 'Bolt hole')
  await expect(heading('Bolt hole 2')).toBeVisible()
  const [bx, by] = at(BOLT_CIRCLE.source)
  await setField(inspector, 'Centre X', bx)
  await setField(inspector, 'Centre Y', by)
  await pickType('Counterbore')
  await inspector.getByRole('combobox', { name: 'Size' }).click()
  await page
    .getByRole('listbox')
    .getByRole('option', { name: BOLT_CIRCLE.fastener, exact: true })
    .click()
  await expect(
    navigator.getByRole('button', { name: /^Bolt hole 2, M3 counterbore/ }),
  ).toBeVisible()
  await fromRowMenu(page, /^Bolt hole 2,/, 'Make Clones…')
  await expect(inspector.getByText('New Clones')).toBeVisible()
  await inspector.getByRole('button', { name: 'Add row' }).click()
  await page.getByRole('menuitem', { name: 'Arc' }).click()
  await inspector.getByRole('button', { name: 'Remove row 1' }).click()
  await expect(inspector.getByRole('button', { name: /^Row 1: Arc/ })).toBeVisible()
  await setField(inspector, 'Radius', `${BOLT_CIRCLE.arc.radius}`)
  await setField(inspector, 'Centre angle', `${BOLT_CIRCLE.arc.angle}`)
  await setField(inspector, 'Sweep', `${BOLT_CIRCLE.arc.sweep}`)
  await setField(inspector, 'Step angle', `${BOLT_CIRCLE.arc.step}`)
  // a full circle closes on the source: 6 instances, not 7
  await expect(readout).toHaveText('1 + 5 clones = 6 instances · 0 skipped')
  await inspector.getByRole('button', { name: 'Make clones' }).click()
  await expect(navigator.getByRole('button', { name: /^Clones 2, ×6/ })).toBeVisible()

  // ── the vent slot: an obround shape, its inside profile, an offset Clones, 4 skipped ─────
  shapes = await openPartSetup(page, 'Shapes')
  await shapes.getByRole('button', { name: 'Add shape' }).click()
  await page.getByRole('menuitem', { name: 'Obround' }).click()
  // the shape is edited in the Shape Editor window (DF94)
  const { inspector: shapeInspector } = await shapeEditorWindow(dfyom.app)
  await expect(shapeInspector.getByRole('heading', { name: /^Shape \d$/ })).toBeVisible()
  const nameField = shapeInspector.getByRole('textbox', { name: 'Name', exact: true })
  await nameField.fill('Vent slot')
  await nameField.press('Enter')
  await expect(
    shapeInspector.getByRole('heading', { name: 'Vent slot', exact: true }),
  ).toBeVisible()
  await setField(shapeInspector, 'Centre X', '0')
  await setField(shapeInspector, 'Centre Y', '0')
  await setField(shapeInspector, 'Length', `${VENTS.length}`)
  await setField(shapeInspector, 'Width', `${VENTS.width}`)

  await addFromMenu(page, 'Profile')
  await expect(heading('Profile 3')).toBeVisible()
  await picker.click()
  await page
    .getByRole('listbox')
    .getByRole('option', { name: /^Vent slot/ })
    .click()
  await expect(picker).toContainText('Vent slot')
  const [vx, vy] = at(VENTS.source)
  await setField(inspector, 'Position X', vx)
  await setField(inspector, 'Position Y', vy)
  await inspector
    .getByRole('radiogroup', { name: 'Side' })
    .getByRole('radio', { name: 'Inside' })
    .click()
  // covers the slot (≥ half its width) and takes the Ø 3 mill
  await revealField(inspector, 'Slot width')
  await setField(inspector, 'Slot width', `${LID_TOOLS.mill.diameter}`)
  await setField(inspector, 'Tab count', '0')
  await fromRowMenu(page, /^Profile 3/, 'Make Clones…')
  await expect(inspector.getByText('New Clones')).toBeVisible()
  await expect(inspector.getByRole('button', { name: /^Row 1: Offset/ })).toBeVisible()
  await setField(inspector, 'Count', `${VENTS.offset.count}`)
  await setField(inspector, 'Step X', `${VENTS.offset.step[0]}`)
  await setField(inspector, 'Step Y', `${VENTS.offset.step[1]}`)
  await expect(readout).toHaveText('1 + 6 clones = 7 instances · 0 skipped')
  await inspector.getByRole('button', { name: 'Make clones' }).click()
  await expect(navigator.getByRole('button', { name: /^Clones 3, ×7/ })).toBeVisible()
  // skip instance 4 (a label area) by clicking its marker on the clone path
  await page.getByRole('button', { name: /^Clone 4 at / }).click()
  await expect(readout).toHaveText('1 + 5 clones = 6 instances · 1 skipped')
  await expect(page.getByRole('button', { name: /^Clone 4 at .*skipped$/ })).toBeVisible()
  if (await applyButton.isVisible()) await applyButton.click()
  await expect(applyButton).toHaveCount(0)

  // ── the bolt-circle source M3 → M4: one pending change, every instance follows ───────────
  // the hole is the source of Clones 2: its row opens to the Source group
  await navigator.getByRole('button', { name: /^Clones 2, ×6/ }).press('ArrowRight')
  await navigator
    .getByRole('list', { name: 'Source of Clones 2' })
    .getByRole('button', { name: /^Bolt hole 2, M3 counterbore/ })
    .click()
  await expect(heading('Bolt hole 2')).toBeVisible()
  await inspector.getByRole('combobox', { name: 'Size' }).click()
  await page
    .getByRole('listbox')
    .getByRole('option', { name: BOLT_CIRCLE_EDITED, exact: true })
    .click()
  // a choice commits only: the Apply button counts the one change (apply.md)
  await expect(page.getByRole('button', { name: 'Apply 1 change' })).toBeVisible()
  await page.getByRole('button', { name: 'Apply 1 change' }).click()
  await expect(applyButton).toHaveCount(0)
  await expect(
    navigator.getByRole('button', { name: /^Bolt hole 2, M4 counterbore/ }),
  ).toBeVisible()
  await expect(inspector.getByRole('img', { name: /^Section:/ })).toHaveAccessibleName(
    /^Section: Ø 4\.5 mm through; counterbore Ø /,
  )
  // undo restores M3 on the source and its instances in one step; redo brings M4 back
  await page.keyboard.press('ControlOrMeta+z')
  await expect(
    navigator.getByRole('button', { name: /^Bolt hole 2, M3 counterbore/ }),
  ).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(
    navigator.getByRole('button', { name: /^Bolt hole 2, M4 counterbore/ }),
  ).toBeVisible()
  if (await applyButton.isVisible()) await applyButton.click()
  await expect(applyButton).toHaveCount(0)

  await expect(status.getByText('Part up to date')).toBeAttached({ timeout: 60_000 })
  // the outline, each hole's 2 operations and their clones' 6 + 10, the cutout, its chamfer, 6 vents
  await expect(viewport).toHaveAccessibleDescription(/Part with 29 operations/)
  if (RENDERS) {
    // the bolt circle's Clones open, its source hole selected (DF44 review render)
    await navigator.getByRole('button', { name: /^Clones 2,/ }).press('ArrowRight')
    await navigator.getByRole('button', { name: /^5 clones$/ }).click()
    await navigator.getByRole('button', { name: /^Bolt hole 2,/ }).click()
    await render(page, 'design-list')
  }

  // ── Plan: a machine from "New machine…", one setup ───────────────────────────────────────
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
    ['Travel Z', '100'],
    ['Max feed rate X', '5000'],
    ['Max feed rate Y', '5000'],
    ['Max feed rate Z', '1000'],
    ['Max spindle speed', '24000'],
  ] as const)
    await setField(newMachine, label, value)
  await newMachine.getByRole('button', { name: 'Add machine' }).click()
  await expect(newMachine).toBeHidden()
  await planStart.getByRole('button', { name: 'Create plan' }).click()
  const setups = navigator.getByRole('list', { name: 'Setups in machining order' })
  await expect(setups.getByRole('button', { name: /^Top G54/ })).toBeVisible()
  // one setup (its row's actions are its context menu, DF67)
  await expect(setups.locator(':scope > li')).toHaveCount(1)
  // tool by tool (plan order v2), as X1 plans it: equal holes and equal countersinks share one
  // plan operation, and so does each clone source operation with its instances (DF146), the
  // outline last
  const planned = setups
    .getByRole('list', { name: 'Plan operations in machining order' })
    .getByRole('button', { name: /^(Bolt hole|Profile|Chamfer) \d/ })
  await expect(planned).toHaveText([
    /^Bolt hole 1 · drill × 4\s*Flat 3/,
    /^Bolt hole 2 · counterbore × 6\s*Flat 3/,
    /^Bolt hole 2 · drill × 6\s*Flat 3/,
    /^Profile 3 × 6\s*Flat 3/,
    /^Profile 2\s*Flat 6/,
    /^Bolt hole 1 · countersink × 4\s*Chamfer 90 × 12/,
    /^Chamfer 1\s*Chamfer 90 × 12/,
    /^Profile 1\s*Flat 6/,
  ])
  await render(page, 'plan-list')

  // ── Toolpaths; the program byte for byte X1's golden ─────────────────────────────────────
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 90_000 })
  const exportTop = async (p: Page) => {
    await p
      .getByRole('navigation', { name: 'Navigator' })
      .getByRole('button', { name: 'Export gCode…' })
      .click()
    const done = p.getByRole('dialog', { name: 'gCode exported' })
    await expect(done.getByText('No machine warnings.')).toBeVisible({ timeout: 30_000 })
    const file = join(dfyom.dataDir, 'enclosure-lid.nc')
    expect(existsSync(file)).toBe(true)
    const gcode = readFileSync(file, 'utf8')
    await expect(done.getByText(`${gcode.trimEnd().split('\n').length} lines`)).toBeVisible()
    await done.getByRole('button', { name: 'Close' }).click()
    await expect(done).toBeHidden()
    return gcode
  }
  const program = await exportTop(page)
  // tool by tool (plan order v2): Flat 3, Flat 6 for the cutout, the chamfer mill, the outline
  expect([...new Set(sections(program))]).toEqual([
    'Bolt hole 1 - drill x 4',
    'Bolt hole 2 - counterbore x 6',
    'Bolt hole 2 - drill x 6',
    'Profile 3 x 6',
    'Profile 2',
    'Bolt hole 1 - countersink x 4',
    'Chamfer 1',
    'Profile 1',
  ])
  expect(program.match(/^\(DFYOM TOOL CHANGE \d+: .*\)$/gm)).toEqual([
    '(DFYOM TOOL CHANGE 1: Flat 3, 3 mm flat, min stickout 11.5 mm)',
    '(DFYOM TOOL CHANGE 2: Flat 6, 6 mm flat, min stickout 11.5 mm)',
    '(DFYOM TOOL CHANGE 3: Chamfer 90 x 12, 12 mm chamfer)',
    '(DFYOM TOOL CHANGE 2: Flat 6, 6 mm flat, min stickout 11.5 mm)',
  ])
  expect(program).toContain('(Clones 3 #7)')
  expect(program).not.toContain('(Clones 3 #4)')
  // the same lid as X1's headless flow: the same program
  expect(withoutAppVersion(program)).toBe(readFileSync(GOLDEN, 'utf8'))
  expect(program).toMatch(/^\(Generator: DFYOM \d+\.\d+\.\d+[^)]*\)$/m) // app version
  const lineCount = program.trimEnd().split('\n').length

  // ── Run on the virtual machine at Max ────────────────────────────────────────────────────
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
  await expect(preflight.getByText('Router')).toBeVisible()
  await preflight.getByRole('button', { name: 'Start run' }).click()
  // the run waits at each tool change; it ends complete with every line of the program
  const complete = page.getByText(new RegExp(`^Run complete: ${lineCount} lines in`))
  let waits = 0
  for (;;) {
    const wait = page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
    await expect(wait.or(complete)).toBeVisible({ timeout: 90_000 })
    if (await complete.isVisible()) break
    const title = (await wait.getByRole('heading').first().textContent()) ?? ''
    await wait.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('dialog', { name: title })).toBeHidden()
    waits++
  }
  expect(waits).toBeGreaterThanOrEqual(3)
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
    await expect(page2).toHaveTitle('Enclosure lid')
    // the features, their sizes and clone counts
    for (const row of [
      /^Bolt hole 1, M3 countersink/,
      /^Clones 1, ×4/,
      /^Bolt hole 2, M4 counterbore/,
      /^Clones 2, ×6/,
      /^Clones 3, ×6/,
    ])
      await expect(nav2.getByRole('button', { name: row })).toBeVisible()
    // the vents' rows: instance 4 still skipped, the numbers stable
    await nav2.getByRole('button', { name: /^Clones 3, ×6/ }).click()
    const readout2 = inspector2.getByText(/instances? ·/)
    await expect(readout2).toHaveText('1 + 5 clones = 6 instances · 1 skipped')
    await expect(inspector2.getByRole('button', { name: /^Row 1: Offset/ })).toBeVisible()
    await expect(page2.getByRole('button', { name: /^Clone 4 at .*skipped$/ })).toBeVisible()
    await expect(page2.getByRole('button', { name: /^Clone 7 at / })).toBeVisible()
    await expect(
      page2.getByRole('contentinfo', { name: 'Status bar' }).getByText('Part up to date'),
    ).toBeAttached({ timeout: 60_000 })
    // the plan: one setup; the program exported again is the same
    await page2.keyboard.press('ControlOrMeta+2')
    await expect(
      nav2.getByRole('list', { name: 'Setups in machining order' }).getByRole('button', {
        name: /^Top G54/,
      }),
    ).toBeVisible()
    expect(await exportTop(page2)).toBe(program)
    expect(second.rendererErrors).toEqual([])
  } finally {
    await second.app.close()
  }
})
