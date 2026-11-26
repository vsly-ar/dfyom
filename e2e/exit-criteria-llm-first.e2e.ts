// The v0.4-llm-first exit criteria's app flow (task X2), through the UI only (roles and accessible
// names), mirroring the headless flow of X1 (src/main/cli/exit-criteria.llm-first.fixture.ts) on
// the exit part of X0 (src/core/design/enclosure-exit.testing.ts) from a fresh install: X1's three
// tools with hardwood presets and its router drafted and saved in the Library window; a project
// on the 250 × 200 × 40 hardwood block; the enclosure base STL imported in the Reference panel
// (its default fit); the levels read from both faces, each section in the middle of its band;
// "Create shape" of the outline and the cavity from the top and of the outline from the bottom;
// the cavity pocket and the outline profile with tabs placed at the sections' corners; the bottom
// facing; the two steps as outside profiles of "Offset…" shapes of the bottom outline; the four
// countersunk foot holes as a Bolt hole on the facing's floor with a Make Clones… grid (the
// panel's "Add as Bolt hole" is off for a mouth below the face, as reference-tools.md says);
// plan mode: toolpaths, "Arrange automatically" on both setups (four toe clamps where the
// black-box test put them), toolpaths again, both programs exported and byte for byte X1's
// goldens; "Compare with reference" in the plan inspector shows the deviation: no unexplained
// region. Windows stay hidden (app.fixture.ts sets DFYOM_HIDE_WINDOWS=1); the native file dialogs
// are stubbed in the main process.
// Docs: docs/plans/v0.4-llm-first.md#exit-criteria, docs/conventions/testing.md#end-to-end
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import {
  EXIT_CLAMPS,
  EXIT_HOLES,
  EXIT_LEVELS,
  EXIT_STOCK,
} from '../src/core/design/enclosure-exit.testing'
import { withoutAppVersion } from '../src/core/post/plan-export'
import { expect, openPartSetup, openReferencePanel, revealField, test } from './app.fixture'

const STL = resolve('src/core/design/__fixtures__/enclosure-wood-base.stl')
/** X1's golden programs, in machining order: the same part through the UI exports the same bytes. */
const GOLDENS = [
  resolve('src/main/cli/__golden__/exit-criteria-llm-first-1-bottom.nc'),
  resolve('src/main/cli/__golden__/exit-criteria-llm-first-2-top.nc'),
] as const

/**
 * Native dialogs: "Import reference" opens the STL, any other open the project; "Export gCode"
 * saves under its suggested file name in `dir`, any other save is the project file.
 */
async function stubFileDialogs(
  app: ElectronApplication,
  files: { stl: string; project: string; dir: string },
): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    const options = (args: unknown[]) =>
      (args.at(-1) ?? {}) as { title?: string; defaultPath?: string }
    dialog.showOpenDialog = ((...args: unknown[]) =>
      Promise.resolve({
        canceled: false,
        filePaths: [options(args).title === 'Import reference' ? f.stl : f.project],
      })) as typeof dialog.showOpenDialog
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
async function choose(
  page: Page,
  scope: Locator,
  label: string,
  option: string | RegExp,
): Promise<void> {
  await scope.getByRole('combobox', { name: label, exact: true }).click()
  await page
    .getByRole(
      'option',
      typeof option === 'string' ? { name: option, exact: true } : { name: option },
    )
    .click()
}

/** One library tool: geometry, then one hardwood preset (X1's TOOLS). */
interface ToolSpec {
  readonly type: 'Flat end mill' | 'Chamfer mill'
  readonly name: string
  readonly values: readonly (readonly [string, string])[]
  readonly preset: readonly (readonly [string, string])[]
}

/** X1's TOOLS (exit-criteria.llm-first.fixture.ts) as the Library window's fields. */
const TOOLS: readonly ToolSpec[] = [
  {
    type: 'Flat end mill',
    name: 'Long flat 6',
    values: [
      ['Diameter', '6'],
      ['Flute length', '45'],
      ['Overall length', '80'],
    ],
    preset: [
      ['Spindle speed', '18000'],
      ['Feed rate', '3200'],
      ['Plunge rate', '600'],
      ['Stepdown', '4'],
      ['Stepover', '3'],
    ],
  },
  {
    type: 'Flat end mill',
    name: 'Flat 2',
    values: [
      ['Diameter', '2'],
      ['Flute length', '8'],
      ['Overall length', '50'],
    ],
    preset: [
      ['Spindle speed', '20000'],
      ['Feed rate', '2100'],
      ['Plunge rate', '300'],
      ['Stepdown', '0.5'],
      ['Stepover', '0.8'],
    ],
  },
  {
    type: 'Chamfer mill',
    name: 'Chamfer 82',
    values: [
      ['Diameter', '12'],
      ['Included angle', '82'],
      ['Flute length', '8'],
      ['Overall length', '50'],
    ],
    preset: [
      ['Spindle speed', '12000'],
      ['Feed rate', '2000'],
      ['Plunge rate', '400'],
    ],
  },
]

/** Drafts and saves one tool with its hardwood preset in the Library window. */
async function libraryTool(lib: Page, tool: ToolSpec): Promise<void> {
  await lib.getByRole('button', { name: 'New tool' }).click()
  const editor = lib.getByRole('region', { name: 'Item editor' })
  const grid = lib.getByRole('grid', { name: 'Tools' })
  await expect(grid.getByRole('row', { name: /Unsaved/ })).toBeVisible()
  await choose(lib, editor, 'Type', tool.type)
  await editor.getByRole('textbox', { name: 'Name' }).fill(tool.name)
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

/**
 * Values X1 reads from the reference tools at 0.001 mm that the app's panels do not show (X2
 * finding, plans/v0.4-llm-first.md § Known issues): the section shapes' min corners (`placeAt`
 * of `design.shape.import { from }`; the operations default to the stock centre), the two steps'
 * insets from the outline (X1: the mean gap of their sections' bounds) and their offsets' corners,
 * and the countersink's diameter and angle as the `holes` suggestion gives them. The user types
 * them as X1 sent them.
 */
const X1_VALUES = {
  cavityAt: ['7.487', '18.713'],
  outlineAt: ['0.252', '11.474'],
  steps: [
    { inset: '4.821', at: ['5.077', '16.292'] },
    { inset: '0.796', at: ['1.052', '12.267'] },
  ],
  csDiameter: '4.861',
  csAngle: '82',
  grid: ['177.062', '88.531'],
} as const

/** The middle of a band between two levels, as X1 computes it (mm, 0.001). */
const mid = (a: number, b: number) => Math.round(((a + b) / 2) * 1000) / 1000

test('v0.4-llm-first exit criteria through the UI: the enclosure base from its STL, toe clamps, X1’s programs', async ({
  dfyom,
}) => {
  // a long UI flow: library, reference, sections, five operations and a hole grid, two setups
  test.setTimeout(600_000)
  const files = {
    stl: STL,
    project: join(dfyom.dataDir, 'Enclosure base.dfyom'),
    dir: dfyom.dataDir,
  }
  await stubFileDialogs(dfyom.app, files)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const heading = (name: string) => inspector.getByRole('heading', { name, exact: true })

  // ── Library window: X1's three tools with hardwood presets, and its router ───────────────
  const opened = dfyom.app.waitForEvent('window')
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  const lib = await opened
  await lib.waitForLoadState('domcontentloaded')
  for (const tool of TOOLS) await libraryTool(lib, tool)
  await lib.getByRole('tab', { name: 'Machines' }).click()
  await lib.getByRole('button', { name: 'New machine' }).click()
  const editor = lib.getByRole('region', { name: 'Item editor' })
  await editor.getByRole('textbox', { name: 'Name' }).fill('Router')
  for (const [label, value] of [
    ['Travel X', '800'],
    ['Travel Y', '800'],
    ['Travel Z', '200'],
    ['Spindle nose to table', '215'],
    ['Spoilboard thickness', '15'],
    ['Max feed rate X', '5000'],
    ['Max feed rate Y', '5000'],
    ['Max feed rate Z', '1000'],
    ['Max spindle speed', '24000'],
  ] as const) {
    await revealField(editor, label)
    await setField(editor, label, value)
  }
  await revealField(editor, 'Spindle control')
  await editor.getByRole('radio', { name: 'Manual dial' }).click()
  await editor.getByRole('button', { name: 'Save' }).click()
  await expect(
    lib.getByRole('grid', { name: 'Machines' }).getByRole('row', { name: /Unsaved/ }),
  ).toHaveCount(0)
  await lib.close()

  // ── New project on the 250 × 200 × 40 hardwood block ─────────────────────────────────────
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Enclosure base')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page).toHaveTitle('Enclosure base')
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', EXIT_STOCK.length)
  await setField(setup, 'Width (Y)', EXIT_STOCK.width)
  await setField(setup, 'Thickness (Z)', EXIT_STOCK.thickness)
  await setup.getByRole('textbox', { name: 'Material name' }).fill(EXIT_STOCK.material.name)
  await setup.getByRole('combobox', { name: 'Material class' }).click()
  await page.getByRole('option', { name: 'Hardwood' }).click()
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()
  await expect(navigator.getByText(/^Stock: 250 × 200 × 40/)).toBeVisible()

  // ── The STL in the Reference panel, its default fit (X0's placement) ─────────────────────
  let panel = await openReferencePanel(page)
  await panel.getByRole('button', { name: 'Import STL…' }).click()
  await expect(panel.getByTitle('enclosure-wood-base')).toBeVisible({ timeout: 30_000 })
  await expect(input(panel, 'Position Z')).toHaveValue('-39 mm')

  // ── Levels from both faces: the bands' middles are where the sections go ─────────────────
  const levels = panel.getByRole('region', { name: 'Levels' })
  const fromTop = EXIT_LEVELS.filter((l) => l.facing === 'face')
  const fromBottom = EXIT_LEVELS.filter((l) => l.facing === 'opposite')
  // the panel shows them to 0.01 mm (X1 reads 0.001 from the tool): the user types X0's values,
  // a known issue of the plan (X2 finding)
  for (const l of EXIT_LEVELS) {
    const shown = l.facing === 'face' ? l.depth : l.depthFromOpposite!
    const near = [Math.floor(shown * 100) / 100, Math.ceil(shown * 100) / 100]
      .map((v) => String(v).replace('.', '\\.'))
      .join('|')
    await expect(
      levels.getByRole('button', { name: new RegExp(`^Depth (${near}) mm, area`) }).first(),
    ).toBeVisible({ timeout: 30_000 })
  }
  const cavityFloor = Math.max(...fromTop.map((l) => l.depth))
  const rimUnderside = Math.max(...fromBottom.map((l) => l.depthFromOpposite!))
  const thickness = Number(EXIT_STOCK.thickness)
  const topBand = mid(0, cavityFloor)
  const wallBand = mid(rimUnderside, thickness)

  // ── Section → shape: the outline and the cavity from the top ─────────────────────────────
  const section = panel.getByRole('region', { name: 'Section' })
  const loops = section.getByRole('radiogroup', { name: 'Loops' })
  const createShape = async (depth: number, kind: 'Outlines' | 'Cavities') => {
    await setField(section, 'Section depth', String(depth))
    await loops.getByRole('radio', { name: kind }).click()
    await expect(section.getByText(kind === 'Outlines' ? /^Outline / : /^Cavity /)).toBeVisible({
      timeout: 30_000,
    })
    await section.getByRole('button', { name: 'Create shape', exact: true }).click()
    await expect(section.getByText('Shape created.')).toBeVisible({ timeout: 30_000 })
  }
  await createShape(topBand, 'Outlines')
  await createShape(topBand, 'Cavities')
  // ── … and the outline from the bottom, in the wall band ──────────────────────────────────
  await choose(page, panel, 'Read from', 'Bottom')
  await createShape(wallBand, 'Outlines')

  // ── Top: the cavity pocket and the outline profile with tabs, at the sections' corners ───
  /** Picks shape `name` (the `nth` of that name: the steps' offsets share theirs). */
  const pickShape = async (name: string, nth = 0) => {
    const picker = inspector.getByRole('combobox', { name: 'Shape', exact: true })
    await picker.click()
    await page.getByRole('listbox').getByRole('option', { name, exact: true }).nth(nth).click()
    await expect(picker).toContainText(name)
  }
  const anchorAt = async (point: string, x: string, y: string) => {
    await revealField(inspector, 'Anchor')
    const anchor = inspector.getByRole('radiogroup', { name: 'Anchor' })
    await anchor.getByRole('radio', { name: point }).click()
    await expect(anchor.getByRole('radio', { name: point })).toBeChecked()
    // the face frame's axes: X/Y on the top, u/v on the bottom
    const [u, v] = point.startsWith('Back') ? ['u', 'v'] : ['X', 'Y']
    await setField(inspector, `Position ${u}`, x)
    await setField(inspector, `Position ${v}`, y)
  }
  const pickOn = async (option: RegExp) => {
    await inspector.getByRole('combobox', { name: 'On', exact: true }).click()
    await page.getByRole('listbox').getByRole('option', { name: option }).click()
    await expect(inspector.getByRole('combobox', { name: 'On', exact: true })).toHaveText(option)
  }
  const addFromMenu = async (item: string) => {
    await navigator.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('menu').getByRole('menuitem', { name: item }).click()
  }
  // the loop kind names the section's shape (X2-4: the outline and the cavity read apart)
  const topName = `Section ${topBand} mm`
  const bottomName = `Section ${wallBand} mm outline`

  await addFromMenu('Pocket')
  await expect(heading('Pocket 1')).toBeVisible()
  await pickShape(`${topName} cavity`)
  await anchorAt('Front left', ...X1_VALUES.cavityAt)
  await setField(inspector, 'Depth', String(cavityFloor))

  await addFromMenu('Profile')
  await expect(heading('Profile 1')).toBeVisible()
  await pickShape(`${topName} outline`)
  await anchorAt('Front left', ...X1_VALUES.outlineAt)
  await inspector
    .getByRole('radiogroup', { name: 'Side' })
    .getByRole('radio', { name: 'Outside' })
    .click()
  await setField(inspector, 'Tab count', '4')
  await setField(inspector, 'Tab width', '8')
  await setField(inspector, 'Tab thickness', '8')

  // ── Bottom: the facing, then the two steps as outside profiles of offset outlines ────────
  await addFromMenu('Facing')
  await expect(heading('Facing 1')).toBeVisible()
  await pickOn(/^Stock bottom/)
  const facingDepth = Math.min(...fromBottom.map((l) => l.depthFromOpposite!))
  await setField(inspector, 'Depth', String(facingDepth))

  // the steps' depths: the levels from the bottom but the facing and the holes' ends
  const stepDepths = fromBottom
    .map((l) => l.depthFromOpposite!)
    .filter((d) => d !== facingDepth && d !== EXIT_HOLES.bottom.group.size.depth)
    .sort((a, b) => a - b)
  for (const [k, step] of X1_VALUES.steps.entries()) {
    const shapes = await openPartSetup(page, 'Shapes')
    await shapes
      .getByRole('button', { name: new RegExp(`^${bottomName}(?! offset)`) })
      .click({ button: 'right' })
    await page
      .getByRole('menu', { name: `Actions for ${bottomName}` })
      .getByRole('menuitem', { name: /^Offset…/ })
      .click()
    const offset = page.getByRole('dialog', { name: `Offset ${bottomName}` })
    const distance = input(offset, 'Distance')
    await distance.fill(step.inset)
    await distance.press('Enter')
    await offset.getByRole('radio', { name: 'Inward' }).click()
    await offset.getByRole('button', { name: 'Create offset' }).click()
    await expect(offset).toBeHidden()
    await expect(shapes).toBeHidden()

    await addFromMenu('Profile')
    await expect(heading(`Profile ${k + 2}`)).toBeVisible()
    await pickOn(/^Stock bottom/)
    await pickShape(`${bottomName} offset`, k)
    await anchorAt('Back left', step.at[0], step.at[1])
    await inspector
      .getByRole('radiogroup', { name: 'Side' })
      .getByRole('radio', { name: 'Outside' })
      .click()
    // a partial-depth profile: Through off, then its depth
    const through = inspector.getByRole('switch', { name: 'Through' })
    await through.click()
    await expect(through).not.toBeChecked()
    await setField(inspector, 'Depth', String(stepDepths[k]))
  }

  // ── The foot holes: a countersunk Bolt hole on the facing's floor, a 2 × 2 grid ──────────
  panel = await openReferencePanel(page)
  await choose(page, panel, 'Read from', 'Bottom')
  const holes = panel.getByRole('region', { name: 'Holes' })
  // to 0.01 mm, without the centres or the grid's pitch: the user types X0's values (X2 finding)
  await expect(
    holes.getByText('4 × Ø 2.45 mm countersunk Ø 4.86 mm 83°, 3.94 mm deep, grid 2 × 2'),
  ).toBeVisible({ timeout: 30_000 })
  // a mouth below the face: the panel says to add a Bolt hole on the facing's floor by hand
  await expect(holes.getByRole('button', { name: /^Add as Bolt hole/ })).toBeDisabled()

  const hole = EXIT_HOLES.bottom.group
  await addFromMenu('Bolt hole')
  await expect(heading('Bolt hole 1')).toBeVisible()
  await pickOn(/^Facing 1 floor/)
  await setField(inspector, 'Centre u', String(hole.holes[0][0]))
  await setField(inspector, 'Centre v', String(hole.holes[0][1]))
  const type = inspector.getByRole('radio', { name: 'Countersink', exact: true })
  await type.click()
  await expect(type).toHaveAttribute('aria-checked', 'true')
  await setField(inspector, 'Diameter', String(hole.size.diameter))
  await choose(page, inspector, 'Bottom', 'Flat')
  await expect(inspector.getByRole('combobox', { name: 'Bottom' })).toHaveText('Flat')
  await setField(inspector, 'Countersink Ø', X1_VALUES.csDiameter)
  await setField(inspector, 'Countersink angle', X1_VALUES.csAngle)
  // the depth from the mouth, which is the facing's floor
  const holeDepth = String(Math.round((hole.size.depth - hole.size.top) * 1000) / 1000)
  await setField(inspector, 'Depth', holeDepth)
  await expect(input(inspector, 'Depth')).toHaveValue(new RegExp(`^${holeDepth}`))
  await expect(input(inspector, 'Diameter')).toHaveValue(/^2\.447/)

  await navigator.getByRole('button', { name: /^Bolt hole 1,/ }).click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Make Clones…' }).click()
  await expect(inspector.getByText('New Clones')).toBeVisible()
  await inspector.getByRole('button', { name: 'Add row' }).click()
  await page.getByRole('menuitem', { name: 'Grid' }).click()
  await inspector.getByRole('button', { name: 'Remove row 1' }).click()
  await setField(inspector, 'Columns', '2')
  await setField(inspector, 'Rows', '2')
  await setField(inspector, 'Column spacing (u)', X1_VALUES.grid[0])
  await setField(inspector, 'Row spacing (v)', X1_VALUES.grid[1])
  await inspector.getByRole('button', { name: 'Make clones' }).click()
  await expect(navigator.getByRole('button', { name: /^Clones 1, ×4/ })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.getByRole('button', { name: /^Apply \d+ change/ })).toHaveCount(0)

  // ── Plan: two setups, toolpaths, the clamps arranged on both, toolpaths again ────────────
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByRole('radio', { name: 'Plan' })).toBeChecked()
  const planStart = page.getByRole('dialog', { name: 'Plan the part' })
  await planStart.getByRole('button', { name: 'Create plan' }).click()
  await expect(planStart).toBeHidden()
  const setups = navigator.getByRole('list', { name: 'Setups in machining order' })
  const names = ['Bottom', 'Top'] as const
  const setupRow = (i: number) =>
    setups.getByRole('button', { name: new RegExp(`^${i + 1}\\. ${names[i]}`) })
  const pickSetup = (i: number) => setupRow(i).click({ position: { x: 24, y: 12 } })
  for (const i of [0, 1]) await expect(setupRow(i)).toBeVisible()

  const generate = async () => {
    await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
    await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({
      timeout: 180_000,
    })
  }
  await generate()
  const summaries = EXIT_CLAMPS.map(
    (c) => `${c.edge === 'vMin' ? 'front' : 'back'} X${c.at} grip ${c.grip} top Z${c.top}`,
  )
  for (const i of [0, 1]) {
    await pickSetup(i)
    const holding = inspector.getByRole('region', { name: /^Workholding/ })
    await holding.getByRole('button', { name: 'Arrange automatically' }).click()
    await expect(holding).toContainText('4 items')
    if (i === 1) {
      // no "copy from another setup" in the UI (X1 sends `copyFrom`), and Top's own arrangement
      // keeps clear of Top's toolpaths only (front X42, …): the clamps are moved to Bottom's
      // positions by hand (X2 finding)
      for (const [n, c] of EXIT_CLAMPS.entries()) {
        const row = holding.getByRole('button', { name: new RegExp(`^Toe clamp ${n + 1}`) })
        await row.click()
        await expect(row).toHaveAttribute('aria-expanded', 'true')
        await setField(holding, 'Position along the edge', c.at)
        await row.click()
        await expect(row).toHaveAttribute('aria-expanded', 'false')
      }
    }
    for (const [n, summary] of summaries.entries())
      await expect(
        holding.getByRole('button', { name: new RegExp(`^Toe clamp ${n + 1}`) }),
      ).toContainText(summary)
    await expect(input(inspector, 'Clearance height')).toHaveValue('27 mm')
  }
  await generate()

  // ── A deliberately low clearance height: below the clamps, Export is blocked ──────────
  await pickSetup(0)
  await setField(inspector, 'Clearance height', '20')
  await expect(inspector.getByRole('region', { name: 'Setup checks' })).toContainText(
    'The clearance height of Bottom (20 mm) is below Toe clamp 1 (top 25 mm + margin 2 mm)',
  )
  await expect(navigator.getByRole('button', { name: 'Export Bottom gCode…' })).toBeDisabled()
  await expect(navigator.getByText('Fix the errors before exporting.')).toBeVisible()
  // fixed by undoing it: the height follows the clamps again, the toolpaths are still current
  await page.keyboard.press('ControlOrMeta+z')
  await expect(input(inspector, 'Clearance height')).toHaveValue('27 mm')
  await expect(inspector.getByText('From Toe clamp 1 + 2 mm.')).toBeVisible()
  await expect(navigator.getByRole('button', { name: 'Export Bottom gCode…' })).toBeEnabled()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible()

  // ── Export both setups: X1's goldens, byte for byte ──────────────────────────────────────
  const exported = page.getByRole('dialog', { name: 'gCode exported' })
  for (const [i, name] of names.entries()) {
    const before = new Set(readdirSync(dfyom.dataDir))
    await pickSetup(i)
    await navigator.getByRole('button', { name: `Export ${name} gCode…` }).click()
    await expect(exported.getByText(`Setup ${name} (${i + 1} of 2)`)).toBeVisible({
      timeout: 60_000,
    })
    await expect(exported.getByText('No machine warnings.')).toBeVisible()
    const file = readdirSync(dfyom.dataDir).find((f) => f.endsWith('.nc') && !before.has(f))
    expect(file, 'the export wrote a new program').toBeDefined()
    const program = readFileSync(join(dfyom.dataDir, file!), 'utf8')
    await expect(exported.getByText(`${program.trimEnd().split('\n').length} lines`)).toBeVisible()
    expect(withoutAppVersion(program)).toBe(readFileSync(GOLDENS[i]!, 'utf8'))
    await exported.getByRole('button', { name: 'Close' }).click()
    await expect(exported).toBeHidden()
  }

  // ── Compare with reference (the plan's inspector): every region has a cause ──────────────
  // a second click on the selected setup clears the selection: the inspector shows the plan
  await pickSetup(1)
  const deviation = inspector.getByRole('region', { name: 'Compare with reference' })
  await deviation.scrollIntoViewIfNeeded()
  await deviation.getByRole('button', { name: 'Compare' }).click()
  // X1's numbers: 10 regions over 0.1 mm, the outline's tabs from both faces and the cavity's two
  // sharp corners; none without a known cause, no over-cut
  await expect(deviation.getByRole('status')).toHaveText('10 regions over 0.1 mm', {
    timeout: 120_000,
  })
  const regions = deviation.getByRole('list', { name: 'Regions' }).getByRole('button')
  await expect(regions).toHaveCount(10)
  for (const name of await regions.evaluateAll((rows) =>
    rows.map((r) => r.getAttribute('aria-label') ?? ''),
  ))
    expect(name).toMatch(/^Under-cut .*, (tab|tool radius)$/)
  expect(dfyom.rendererErrors).toEqual([])
})
