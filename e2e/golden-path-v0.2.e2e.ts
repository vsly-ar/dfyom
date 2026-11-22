// The v0.2 exit criteria's app flow (task X2), through the UI only (roles and accessible names),
// mirroring the headless golden path of X1 (src/main/cli/exit-criteria.v02.fixture.ts) from the
// empty library of a fresh install: a project on a 255 × 185 × 40 hardwood board; the user's
// enclosure STL imported through the stubbed "Import STL…" dialog, fitted onto the stock bottom,
// hidden and shown; the enclosure recreated on three faces (top: facing, a cavity on the facing
// floor placed by its front-left corner with the anchor picker, a through profile with tabs;
// right side, picked in the `on` dropdown: two holes; bottom: a recess), applied with Enter and
// with the Apply button; Plan: a tall-Z machine from "New machine…", three setups (Bottom, Right,
// Top), the tools added with "New tool…"; back in Design, the library's Flat 12 locked on the
// profile with the tool field (the other operations keep the auto choice) and applied, so the
// draft plan takes it from the design; the other tools picked per operation in Plan, the design
// settled and the recess deepened for this plan only, a peck cycle on the holes; toolpaths; one
// program per setup from the setup panel; each run on the virtual machine, chained by the
// setup-change dialog ("Start setup n"); save, close the app, reopen: reference, anchor, the tool
// lock, tools and setups unchanged.
// Windows stay hidden (app.fixture.ts sets DFYOM_HIDE_WINDOWS=1).
// Docs: docs/plans/v0.2.md#exit-criteria, docs/conventions/testing.md#end-to-end
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { closeDialog, expect, launchApp, openPartSetup, test } from './app.fixture'

const STL = resolve('src/core/design/__fixtures__/enclosure-wood-base.stl')

/** The setups in machining order (plan-v0.2.md: bottom, sides, top last). */
const SETUPS = ['Bottom', 'Right', 'Top'] as const

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

/** Adds a tool through the plan inspector's "New tool…"; it is assigned to the selected operation. */
async function newTool(page: Page, values: readonly (readonly [string, string])[]): Promise<void> {
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'New tool…' }).click()
  const dialog = page.getByRole('dialog', { name: 'New tool' })
  for (const [label, value] of values) await setField(dialog, label, value)
  await dialog.getByRole('button', { name: 'Add tool' }).click()
  await expect(dialog).toBeHidden()
}

const designRows = (page: Page) =>
  page
    .getByRole('list', { name: 'Operations in design order' })
    .getByRole('button', { name: /^(Facing|Pocket|Drilling|Profile) \d/ })

const setupOps = (page: Page, setup: string) =>
  page
    .getByRole('list', { name: `Plan operations of ${setup} in machining order` })
    .getByRole('button', { name: /^(Facing|Pocket|Drilling|Profile) \d/ })

test('v0.2 golden path through the UI: reference, faces, setups, export and run per setup, reopen', async ({
  dfyom,
}) => {
  // a long multi-step UI flow: design, plan, three exports and three runs, a relaunch
  test.setTimeout(180_000)
  const files = { stl: STL, project: join(dfyom.dataDir, 'Enclosure.dfyom'), dir: dfyom.dataDir }
  await stubFileDialogs(dfyom.app, files)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const viewport = page.getByRole('region', { name: '3D viewport' })
  const status = page.getByRole('contentinfo', { name: 'Status bar' })

  // ── New project on a hardwood board ──────────────────────────────────────────────────────
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Enclosure')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page).toHaveTitle('Enclosure')
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '255')
  await setField(setup, 'Width (Y)', '185')
  await setField(setup, 'Thickness (Z)', '40')
  await setup.getByRole('textbox', { name: 'Material name' }).fill('Walnut')
  await setup.getByRole('combobox', { name: 'Material class' }).click()
  await page.getByRole('option', { name: 'Hardwood' }).click()
  await setup.getByRole('button', { name: 'Create part' }).click()
  await expect(navigator.getByText(/^Stock: 255 × 185 × 40/)).toBeVisible()

  // ── Import the STL reference (read as mm, fitted centre + top), onto the bottom ──────────
  // the Stock dialog closed with Create part; Import STL… is in the Reference dialog (D45), which
  // closes when the import has selected the new reference
  let references = await openPartSetup(page, 'Reference')
  await references.getByRole('button', { name: 'Import STL…' }).click()
  await expect(references).toBeHidden({ timeout: 30_000 })
  await expect(inspector.getByText(/Unit guess: Read as mm/)).toBeVisible()
  await expect(input(inspector, 'Position Z')).toHaveValue('-39 mm')
  // the board is faced by 1 mm: the reference sits on the stock bottom, its top on the faced top
  await inspector
    .getByRole('radiogroup', { name: 'Height' })
    .getByRole('radio', { name: 'Bottom' })
    .click()
  await inspector.getByRole('button', { name: 'Fit to stock' }).click()
  await expect(input(inspector, 'Position Z')).toHaveValue('-40 mm')
  await expect(inspector.getByText('The reference fits inside the stock.')).toBeVisible()
  await expect(viewport).toHaveAccessibleDescription(
    /Reference enclosure-wood-base shown as a ghost\./,
    { timeout: 30_000 },
  )
  // hide and show it (view state of this window: no command)
  references = await openPartSetup(page, 'Reference')
  const refRow = references.getByRole('button', { name: /^enclosure-wood-base/ })
  await expect(refRow).toContainText('49 806 triangles')
  const eye = references.getByRole('button', { name: 'Show reference' })
  await eye.click()
  await expect(eye).toHaveAttribute('aria-pressed', 'false')
  await expect(refRow).toContainText('hidden')
  await closeDialog(references)
  await expect(viewport).not.toHaveAccessibleDescription(/Reference enclosure-wood-base/)
  references = await openPartSetup(page, 'Reference')
  await references.getByRole('button', { name: 'Show reference' }).click()
  await expect(references.getByRole('button', { name: 'Show reference' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await closeDialog(references)
  await expect(viewport).toHaveAccessibleDescription(/Reference enclosure-wood-base shown/)

  // ── Top: facing, the cavity by its front-left corner on the facing floor, the profile ────
  await navigator.getByRole('button', { name: 'Add facing' }).click()
  await expect(inspector.getByRole('heading', { name: 'Facing 1' })).toBeVisible()
  await setField(inspector, 'Depth', '1')

  await addOperation(page, 'Add pocket', 'Pocket 1')
  await pickOn(page, /^Facing 1 floor/)
  const anchor = inspector.getByRole('radiogroup', { name: 'Anchor' })
  await anchor.getByRole('radio', { name: 'Front left' }).click()
  await expect(anchor.getByRole('radio', { name: 'Front left' })).toBeChecked()
  await setField(inspector, 'Position X', '10')
  await setField(inspector, 'Position Y', '13')
  // a size edit keeps the anchor point
  await setField(inspector, 'Length (X)', '235')
  await setField(inspector, 'Width (Y)', '159')
  await expect(input(inspector, 'Position X')).toHaveValue('10')
  await setField(inspector, 'Corner radius', '8')
  await setField(inspector, 'Depth', '34.8')

  await addOperation(page, 'Add profile', 'Profile 1')
  await setField(inspector, 'Position X', '127.5')
  await setField(inspector, 'Position Y', '92.5')
  await setField(inspector, 'Length (X)', '249.5')
  await setField(inspector, 'Width (Y)', '177')
  await setField(inspector, 'Corner radius', '6')
  await setField(inspector, 'Slot width', '12')
  await setField(inspector, 'Tab count', '4')
  await setField(inspector, 'Tab width', '12')
  // Tab commits only: the change waits for the toolbar's Apply button (apply.md#apply-button)
  const tabThickness = input(inspector, 'Tab thickness')
  await tabThickness.fill('4')
  await tabThickness.press('Tab')
  const apply = page.getByRole('button', { name: 'Apply 1 change', exact: true })
  await expect(apply).toBeVisible()
  await apply.click()
  await expect(page.getByRole('button', { name: /^Apply \d+ change/ })).toHaveCount(0)

  // ── Right side (+x, u = part Y, v = up from the bottom): two holes, 20 mm up ─────────────
  for (const [name, u] of [
    ['Drilling 1', '72.5'],
    ['Drilling 2', '112.5'],
  ] as const) {
    await addOperation(page, 'Add drilling', name)
    await pickOn(page, /^Stock right side/)
    await setField(inspector, 'Center u', u)
    await setField(inspector, 'Center v', '20')
    await setField(inspector, 'Diameter', '6')
    await inspector.getByRole('combobox', { name: 'Bottom' }).click()
    await page.getByRole('option', { name: 'Drill point' }).click()
    await setField(inspector, 'Depth', '14')
  }

  // ── Bottom (u = part X, v = part −Y): a label recess, centred ────────────────────────────
  await addOperation(page, 'Add pocket', 'Pocket 2')
  await pickOn(page, /^Stock bottom/)
  await setField(inspector, 'Position u', '127.5')
  await setField(inspector, 'Position v', '92.5')
  await setField(inspector, 'Length (u)', '80')
  await setField(inspector, 'Width (v)', '40')
  await setField(inspector, 'Corner radius', '4')
  await setField(inspector, 'Depth', '1.5')

  await expect(designRows(page)).toHaveText([
    /^Facing 1/,
    /^Pocket 1/,
    /^Profile 1/,
    /^Drilling 1/,
    /^Drilling 2/,
    /^Pocket 2/,
  ])
  await expect(page.getByRole('button', { name: /^Apply \d+ change/ })).toHaveCount(0)
  await expect(status.getByText('Part up to date')).toBeAttached({ timeout: 30_000 })
  await expect(viewport).toHaveAccessibleDescription(/Part with 6 operations/)

  // ── Plan: a tall-Z machine (the right setup stands the board on its end), three setups ───
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByRole('radio', { name: 'Plan' })).toBeChecked()
  await navigator.getByRole('button', { name: 'New machine…' }).click()
  const newMachine = page.getByRole('dialog', { name: 'New machine' })
  await newMachine.getByRole('textbox', { name: 'Name' }).fill('Router, tall Z')
  for (const [label, value] of [
    ['Travel X', '800'],
    ['Travel Y', '800'],
    ['Travel Z', '300'],
    ['Max feed rate X', '5000'],
    ['Max feed rate Y', '5000'],
    ['Max feed rate Z', '1000'],
    ['Max spindle speed', '30000'],
  ] as const)
    await setField(newMachine, label, value)
  await newMachine.getByRole('button', { name: 'Add machine' }).click()
  await expect(newMachine).toBeHidden()
  await navigator.getByRole('button', { name: 'Create plan' }).click()
  const setups = navigator.getByRole('list', { name: 'Setups in machining order' })
  const setupRow = (i: number) =>
    setups.getByRole('button', { name: new RegExp(`^${i + 1}\\. ${SETUPS[i]}`) })
  /** Clicks a setup row at its start (with focus, its move and menu buttons overlay its end). */
  const pickSetup = (i: number) => setupRow(i).click({ position: { x: 24, y: 12 } })
  for (const i of [0, 1, 2]) await expect(setupRow(i)).toBeVisible()
  await expect(setupOps(page, 'Bottom')).toHaveText([/^Pocket 2/])
  await expect(setupOps(page, 'Right')).toHaveText([/^Drilling 1, Drilling 2/])
  await expect(setupOps(page, 'Top')).toHaveText([/^Facing 1/, /^Pocket 1/, /^Profile 1/])

  // the tools: an empty library, so each is added with "New tool…" or picked once it exists
  const pickTool = async (row: Locator, heading: string, tool: RegExp) => {
    await row.click()
    await expect(inspector.getByRole('heading', { name: heading, level: 2 })).toBeVisible()
    await inspector.getByRole('combobox', { name: 'Tool' }).click()
    await page.getByRole('option', { name: tool }).click()
    await expect(row).toHaveText(tool)
  }
  await setupOps(page, 'Top').nth(0).click()
  await expect(inspector.getByRole('heading', { name: 'Facing 1' })).toBeVisible()
  await newTool(page, [
    ['Diameter', '12'],
    ['Flute length', '50'],
    ['Overall length', '100'],
  ])
  await expect(setupOps(page, 'Top').nth(0)).toHaveText(/Flat 12/)
  // the recess's 4 mm corners need a smaller end mill
  await setupOps(page, 'Bottom').nth(0).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 2', level: 2 })).toBeVisible()
  await newTool(page, [
    ['Diameter', '6'],
    ['Flute length', '25'],
    ['Overall length', '60'],
  ])
  await expect(setupOps(page, 'Bottom').nth(0)).toHaveText(/Flat 6/)

  // ── Design: lock the library's Flat 12 on the profile; the others keep the auto choice ───
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByRole('radio', { name: 'Design' })).toBeChecked()
  await designRows(page).nth(2).click()
  await expect(inspector.getByRole('heading', { name: 'Profile 1' })).toBeVisible()
  const toolField = inspector.getByRole('region', { name: 'Tool' })
  const toolCombo = toolField.getByRole('combobox', { name: 'Tool' })
  await toolCombo.click()
  await page
    .getByRole('listbox')
    .getByRole('option', { name: /^Flat 12 · Ø 12/ })
    .click()
  // picking locks (one command, commit only); Apply lets the draft plan follow the design
  await expect(toolCombo).toHaveText(/^Flat 12 · Ø 12/)
  await expect(toolField.getByRole('button', { name: 'Lock tool' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(toolField.getByText('Chosen by you.')).toBeVisible()
  await page.getByRole('button', { name: /^Apply \d+ changes?$/ }).click()
  await expect(page.getByRole('button', { name: /^Apply \d+ change/ })).toHaveCount(0)

  // ── Plan: the profile takes the design's tool; the cavity's tool is picked here ──────────
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByRole('radio', { name: 'Plan' })).toBeChecked()
  const profileRow = setupOps(page, 'Top').nth(2)
  await expect(profileRow).toHaveText(/Flat 12/)
  await profileRow.click()
  await expect(inspector.getByRole('heading', { name: 'Profile 1', level: 2 })).toBeVisible()
  await expect(inspector.getByText('From the design’s tool field.')).toBeVisible()
  await pickTool(setupOps(page, 'Top').nth(1), 'Pocket 1', /Flat 12/)
  await expect(inspector.getByText('Chosen in this plan.')).toBeVisible()
  // the holes: a drill (the form suggests one for a drilling)
  const drilling = setupOps(page, 'Right').nth(0)
  await drilling.click()
  await expect(
    inspector.getByRole('heading', { name: 'Drilling 1, Drilling 2', level: 2 }),
  ).toBeVisible()
  await newTool(page, [
    ['Diameter', '6'],
    ['Flute length', '30'],
    ['Overall length', '66'],
    ['Point angle', '118'],
  ])
  await expect(drilling).toHaveText(/Drill 6/)
  // the design's auto choice (a generalized drill, the library was empty) matches the new drill
  await expect(inspector.getByRole('list', { name: 'Why this tool' })).toContainText(
    "Matches the design's 6 mm drill.",
  )
  // no calculator data for drills: the feeds by hand
  await setField(inspector, 'Spindle speed', '3000')
  await setField(inspector, 'Feed rate', '300')
  await setField(inspector, 'Plunge rate', '300')
  await expect(input(inspector, 'Plunge rate')).toHaveValue(/^300/)

  // ── Settle the design; deepen the recess for this plan only; a peck cycle ────────────────
  await navigator.getByRole('combobox', { name: 'Plan status' }).click()
  await page.getByRole('option', { name: 'Settled design' }).click()
  await expect(navigator.getByRole('combobox', { name: 'Plan status' })).toHaveText(
    /Settled design/,
  )
  await setupOps(page, 'Bottom').nth(0).click()
  const planCopy = inspector.getByRole('region', { name: 'Part (plan copy)' })
  await setField(planCopy, 'Depth', '2')
  await expect(planCopy.getByText('Edited in plan')).toBeVisible()
  await expect(setupOps(page, 'Bottom').nth(0)).toContainText('Edited in plan')

  await drilling.click()
  await inspector.getByRole('combobox', { name: 'Cycle' }).click()
  await page.getByRole('option', { name: /Peck/ }).click()
  await setField(inspector, 'Peck depth', '4')
  await expect(input(inspector, 'Peck depth')).toHaveValue(/^4/)

  // ── Toolpaths; one program per setup from the setup panel ────────────────────────────────
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 60_000 })
  const exported = page.getByRole('dialog', { name: 'gCode exported' })
  const lineCounts: number[] = []
  const programs: string[] = []
  for (const [i, name] of SETUPS.entries()) {
    await pickSetup(i)
    await navigator.getByRole('button', { name: `Export ${name} gCode…` }).click()
    await expect(exported.getByText(`Setup ${name} (${i + 1} of 3)`)).toBeVisible({
      timeout: 30_000,
    })
    await expect(exported.getByText('No machine warnings.')).toBeVisible()
    const file = join(dfyom.dataDir, `Plan 1 ${name}.nc`)
    expect(existsSync(file)).toBe(true)
    const gcode = readFileSync(file, 'utf8')
    expect(gcode).toContain(`(Setup: ${name})`)
    expect(gcode.trimEnd().endsWith('M30')).toBe(true)
    const lines = gcode.trimEnd().split('\n').length
    await expect(exported.getByText(`${lines} lines`)).toBeVisible()
    lineCounts.push(lines)
    programs.push(gcode)
    await exported.getByRole('button', { name: 'Close' }).click()
    await expect(exported).toBeHidden()
  }

  // each setup's program holds only its own operations
  expect(
    programs.map((g) =>
      [...g.matchAll(/^\(((?:Facing|Pocket|Profile|Drilling)[^)]*)\)$/gm)].map((m) => m[1]),
    ),
  ).toEqual([['Pocket 2'], ['Drilling 1, Drilling 2'], ['Facing 1', 'Pocket 1', 'Profile 1']])

  // ── Run every setup on the virtual machine, with the setup-change prompt between ─────────
  await page.keyboard.press('ControlOrMeta+3')
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  const machine = page.getByRole('group', { name: 'Machine' })
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: 'Max' }).click()
  await navigator.getByRole('button', { name: 'Connect to virtual machine' }).click()
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
  await navigator.getByRole('button', { name: 'Zero X Y Z' }).click()
  const dro = inspector.getByRole('table', { name: 'Position' })
  await expect(dro.getByRole('cell', { name: 'Work position Z' })).toHaveText(/^0\.000/)

  await inspector.getByRole('button', { name: 'Start run' }).click()
  const preflight = page.getByRole('dialog', { name: 'Start run?' })
  await expect(preflight.getByText('Bottom (1 of 3)')).toBeVisible()
  await expect(preflight.getByText('Router, tall Z')).toBeVisible()
  await preflight.getByRole('button', { name: 'Start run' }).click()
  for (const i of SETUPS.keys()) {
    // each run waits at its tool changes; it ends complete with every line of its program
    const complete = page.getByText(new RegExp(`^Run complete: ${lineCounts[i]} lines in`))
    for (;;) {
      const wait = page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
      await expect(wait.or(complete)).toBeVisible({ timeout: 60_000 })
      if (await complete.isVisible()) break
      const title = (await wait.getByRole('heading').first().textContent()) ?? ''
      await wait.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('dialog', { name: title })).toBeHidden()
    }
    const next = SETUPS[i + 1]
    if (next === undefined) break
    // the setup change: the next setup's picture and steps; it never starts by itself
    const change = page.getByRole('dialog', { name: `Setup change: setup ${i + 2}, ${next}` })
    await expect(change).toBeVisible()
    await expect(machine.getByText('Setup change')).toBeAttached()
    await expect(change.getByRole('img', { name: /^The stock on the machine:/ })).toBeVisible()
    await change.getByRole('button', { name: `Start setup ${i + 2}` }).click()
    await expect(change).toBeHidden()
  }
  await expect(page.getByRole('dialog', { name: /^Setup change/ })).toHaveCount(0)
  await expect(machine.getByText('Idle')).toBeVisible()
  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  await expect(machine).toHaveCount(0)

  // ── Save, close and reopen ───────────────────────────────────────────────────────────────
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
    await expect(page2).toHaveTitle('Enclosure')
    // the reference, placed as saved
    const refRow2 = (await openPartSetup(page2, 'Reference')).getByRole('button', {
      name: /^enclosure-wood-base/,
    })
    await expect(refRow2).toContainText('49 806 triangles')
    // choosing the row selects it and closes the dialog
    await refRow2.click()
    await expect(input(inspector2, 'Position Z')).toHaveValue('-40 mm')
    // the operations and the cavity's anchor
    await expect(designRows(page2)).toHaveCount(6)
    await designRows(page2).nth(1).click()
    await expect(
      inspector2.getByRole('radiogroup', { name: 'Anchor' }).getByRole('radio', {
        name: 'Front left',
      }),
    ).toBeChecked()
    await expect(input(inspector2, 'Position X')).toHaveValue('10')
    // the profile's locked library tool
    await designRows(page2).nth(2).click()
    const toolField2 = inspector2.getByRole('region', { name: 'Tool' })
    await expect(toolField2.getByRole('combobox', { name: 'Tool' })).toHaveText(/^Flat 12/)
    await expect(toolField2.getByRole('button', { name: 'Lock tool' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(
      page2.getByRole('contentinfo', { name: 'Status bar' }).getByText('Part up to date'),
    ).toBeAttached({ timeout: 30_000 })
    // the plan: its setups, tools and the plan-only edit
    await page2.keyboard.press('ControlOrMeta+2')
    const setups2 = nav2.getByRole('list', { name: 'Setups in machining order' })
    for (const [i, name] of SETUPS.entries())
      await expect(
        setups2.getByRole('button', { name: new RegExp(`^${i + 1}\\. ${name}`) }),
      ).toBeVisible()
    await expect(setupOps(page2, 'Top')).toHaveText([/Flat 12/, /Flat 12/, /Flat 12/])
    await expect(setupOps(page2, 'Right')).toHaveText([/Drill 6/])
    await expect(setupOps(page2, 'Bottom')).toHaveText([
      /Flat 6.*Edited in plan|Edited in plan.*Flat 6/,
    ])
    expect(second.rendererErrors).toEqual([])
  } finally {
    await second.app.close()
  }
})
