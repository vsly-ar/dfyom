// v0.4 feature UI in the built app (task U1), through roles and labels: Add → Features → Add
// hole adds a feature row, the row expands to its owned operations, an owned operation's
// inspector is read-only ("Edited through Bolt hole 1") and its link opens the hole, Make Clones…
// opens the Clones draft (U3: read-out, a 2 x 2 grid row, Make clones, skip clone 3 by clicking its
// marker in the viewport, the instance inspector) with Source and Clones groups under the Clones
// row; the hole inspector (U2) sets type and fastener, draws the section and offers the
// custom-size fix and a stepped countersink (F7). Task U4: Add → Chamfer on a drilling opens the chamfer inspector (Edge,
// Width, Depth, Angle, the read-only Diameter and the section, D45). Windows stay hidden
// (app.fixture.ts). With DFYOM_RENDERS=1 it also writes the light and dark review renders to
// design/features/renders/ (ui.md § Features (v0.4), visuals reviewed in L2).
// Docs: docs/conventions/ui.md#features-v04, docs/modes/features.md
import { resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { closeDialog, expect, openPartSetup, openReferencePanel, test } from './app.fixture'

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

async function render(
  page: Page,
  name: string,
  task: 'u1' | 'u2' | 'u3' | 'u4' | 'd45' = 'u1',
  // run after the Settings dialog closed (it takes focus): refocus a field
  before?: () => Promise<void>,
): Promise<void> {
  if (!RENDERS) return
  const settings = page.getByRole('dialog', { name: 'Settings' })
  for (const theme of ['light', 'dark'] as const) {
    await page.getByRole('button', { name: 'Settings' }).click()
    await settings.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await settings.getByRole('button', { name: 'Done' }).click()
    await expect(settings).toBeHidden()
    await before?.()
    // let the theme and row transitions settle
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${rendersDir}/${task}-${name}-${theme}.png` })
  }
}

/**
 * With DFYOM_RENDERS=1: light and dark renders without touching the page (an open menu stays
 * open); the theme attribute is set directly and put back to the setting's after.
 */
async function renderOpen(page: Page, name: string, task: 'df16' | 'df18'): Promise<void> {
  if (!RENDERS) return
  const setTheme = (t: string | null) =>
    // runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`
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
    await page.screenshot({ path: `${rendersDir}/${task}-${name}-${theme}.png` })
  }
  await setTheme(before)
}

/**
 * With DFYOM_RENDERS=1: a part-setup dialog (D45) in light and dark. The theme is set first: an
 * open modal dialog hides the toolbar's Settings button.
 */
async function renderDialog(
  page: Page,
  name: string,
  open: () => Promise<Locator>,
  close = 'Done',
): Promise<void> {
  if (!RENDERS) return
  const settings = page.getByRole('dialog', { name: 'Settings' })
  for (const theme of ['light', 'dark'] as const) {
    await page.getByRole('button', { name: 'Settings' }).click()
    await settings.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await settings.getByRole('button', { name: 'Done' }).click()
    await expect(settings).toBeHidden()
    const dialog = await open()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${rendersDir}/d45-${name}-${theme}.png` })
    await closeDialog(dialog, close)
  }
}

test('features: add a hole, expand its row, the owned inspector is read-only, Make Clones…', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Features')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  // a new project starts in the Stock dialog (D45)
  const stock = page.getByRole('dialog', { name: 'Stock' })
  await expect(stock).toBeVisible()
  if (RENDERS) {
    await closeDialog(stock, 'Cancel')
    await renderDialog(page, 'stock-setup', () => openPartSetup(page, 'Stock'), 'Cancel')
    await openPartSetup(page, 'Stock')
  }
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '100')
  await setField(setup, 'Width (Y)', '60')
  await setField(setup, 'Thickness (Z)', '20')
  await setup.getByRole('button', { name: 'Create part' }).click()
  await expect(stock).toBeHidden()
  await navigator.getByRole('button', { name: 'Add pocket' }).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()
  await renderDialog(page, 'stock', () => openPartSetup(page, 'Stock'))
  await renderDialog(page, 'shapes', () => openPartSetup(page, 'Shapes'))
  if (RENDERS) {
    // the Reference panel in the right sidebar (DF3; the Reference dialog until then), empty
    await openReferencePanel(page)
    await render(page, 'reference', 'd45')
    await page
      .getByRole('toolbar', { name: 'Part setup' })
      .getByRole('button', { name: 'Reference' })
      .click()
  }

  // ── Add → Features → Bolt hole (DF17; Chamfer and Make Clones… are in the row menu, DF16) ──
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('group', { name: 'Operations' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Chamfer' })).toHaveCount(0)
  // DF18: a hovered item shows its one-line description beside it
  const boltHole = menu
    .getByRole('group', { name: 'Features' })
    .getByRole('menuitem', { name: 'Bolt hole' })
  await boltHole.hover()
  await expect(boltHole.getByRole('tooltip')).toBeVisible()
  await renderOpen(page, 'add-menu', 'df18')
  await boltHole.click()
  const hole = navigator.getByRole('button', { name: /^Bolt hole 1, Ø 6 mm simple, 1 operation/ })
  await expect(hole).toHaveAttribute('aria-pressed', 'true')
  await expect(hole).toHaveAttribute('aria-expanded', 'false')
  await expect(inspector.getByRole('heading', { name: 'Bolt hole 1' })).toBeVisible()

  // ── the row expands to its owned operation ───────────────────────────────────────────────
  await hole.press('ArrowRight')
  await expect(hole).toHaveAttribute('aria-expanded', 'true')
  const drill = navigator.getByRole('button', {
    name: 'Bolt hole 1 · drill, edited through Bolt hole 1',
  })
  await expect(drill).toBeVisible()
  await render(page, 'hole-row')

  // ── the owned operation's inspector is read-only ─────────────────────────────────────────
  await drill.click()
  await expect(inspector.getByRole('heading', { name: 'Bolt hole 1 · drill' })).toBeVisible()
  await expect(inspector.getByText(/^Edited through/)).toBeVisible()
  const diameter = inspector.getByLabel('Diameter', { exact: true }).and(inspector.locator('input'))
  await expect(diameter).toHaveAttribute('readonly', '')
  await expect(diameter).toHaveAccessibleDescription(
    /Part of Bolt hole 1: change it in the bolt hole\./,
  )
  await render(page, 'owned-inspector')
  // its link opens the hole
  await inspector
    .getByText(/^Edited through/)
    .getByRole('button', { name: 'Bolt hole 1' })
    .click()
  await expect(inspector.getByRole('heading', { name: 'Bolt hole 1' })).toBeVisible()
  // the hole inspector (U2) focused the field behind the drill's first one
  await expect(
    inspector.getByLabel('Center X', { exact: true }).and(inspector.locator('input')),
  ).toBeFocused()

  // ── the hole inspector: type, fastener, section, sizes (U2) ────────────────────────────
  await inspector.getByRole('radio', { name: 'Counterbore' }).click()
  await expect(inspector.getByRole('radio', { name: 'Counterbore' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await inspector.getByRole('combobox', { name: 'Size' }).click()
  await page.getByRole('listbox').getByRole('option', { name: 'M3', exact: true }).click()
  const section = inspector.getByRole('img', { name: /^Section:/ })
  await expect(section).toHaveAccessibleName(
    'Section: Ø 3.4 mm through; counterbore Ø 6.5 mm, 3.2 mm deep; M3 head 0.2 mm below the face.',
  )
  await expect(inspector.getByRole('radio', { name: 'Tap drill' })).toBeDisabled()
  const tools = inspector.getByRole('region', { name: 'Tools' })
  await expect(tools.getByRole('combobox', { name: 'Counterbore' })).toBeVisible()
  await expect(tools.getByRole('combobox', { name: 'Drill' })).toBeVisible()
  await expect(
    navigator.getByRole('button', { name: /^Bolt hole 1, M3 counterbore/ }),
  ).toBeVisible()
  await render(page, 'hole-inspector', 'u2')
  // the focused field's part of the section is amber with its value chip
  await inspector
    .getByLabel('Counterbore depth', { exact: true })
    .and(inspector.locator('input'))
    .focus()
  await expect(section.locator('[data-part="cbDepth"]')).toHaveAttribute('data-state', 'active')
  await render(page, 'section-focus', 'u2', () =>
    inspector
      .getByLabel('Counterbore depth', { exact: true })
      .and(inspector.locator('input'))
      .focus(),
  )
  // a hand-entered size: the custom note with its fix; a countersink
  await setField(inspector, 'Counterbore Ø', '7')
  await expect(inspector.getByRole('button', { name: 'Use 6.5 mm' })).toBeVisible()
  await render(page, 'custom-size', 'u2')
  await inspector.getByRole('button', { name: 'Use 6.5 mm' }).click()
  await expect(inspector.getByRole('button', { name: 'Use 6.5 mm' })).toBeHidden()
  await inspector.getByRole('radio', { name: 'Countersink' }).click()
  await expect(section).toHaveAccessibleName(/countersink Ø 7\.12 mm, 90°/)
  await expect(tools.getByRole('combobox', { name: 'Countersink' })).toBeVisible()
  await inspector
    .getByLabel('Countersink angle', { exact: true })
    .and(inspector.locator('input'))
    .focus()
  await render(page, 'countersink', 'u2', () =>
    inspector
      .getByLabel('Countersink angle', { exact: true })
      .and(inspector.locator('input'))
      .focus(),
  )
  // the focused field's adjust panel covers the controls under it (DF9): Escape closes it
  await page.keyboard.press('Escape')
  // stepped (F7): terraces by the hole's end mill, the stepdown field, the shared tool
  await inspector.getByRole('radio', { name: 'Stepped' }).click()
  await expect(section).toHaveAccessibleName(/stepped in 2 steps of 0\.93 mm/)
  await expect(tools.getByText(/no tool change/)).toBeVisible()
  const stepdown = inspector.getByLabel('Stepdown', { exact: true }).and(inspector.locator('input'))
  await stepdown.focus()
  await expect(section.locator('[data-part="csStepdown"]')).toHaveAttribute('data-state', 'active')
  await render(page, 'stepped', 'u2', () => stepdown.focus())

  // ── Make Clones… from the hole row's menu (DF16: right-click; U3: the draft, a grid, skip) ─
  await navigator.getByRole('button', { name: /^Bolt hole 1,/ }).click({ button: 'right' })
  await expect(page.getByRole('menu', { name: 'Actions for Bolt hole 1' })).toBeVisible()
  await renderOpen(page, 'row-menu', 'df16')
  await page.getByRole('menuitem', { name: 'Make Clones…' }).click()
  await expect(inspector.getByText('New Clones')).toBeVisible()
  const readout = inspector.getByText(/instances? ·/)
  await expect(readout).toHaveText('1 + 1 clone = 2 instances · 0 skipped')
  await render(page, 'draft', 'u3')
  // a 2 × 2 grid instead of the first offset row
  await inspector.getByRole('button', { name: 'Add row' }).click()
  await page.getByRole('menuitem', { name: 'Grid' }).click()
  await inspector.getByRole('button', { name: 'Remove row 1' }).click()
  await expect(inspector.getByRole('button', { name: /^Row 1: Grid/ })).toBeVisible()
  await expect(readout).toHaveText('1 + 3 clones = 4 instances · 0 skipped')
  await render(page, 'draft-grid', 'u3')
  await inspector.getByRole('button', { name: 'Make clones' }).click()
  const clones = navigator.getByRole('button', { name: /^Clones 1, ×4/ })
  await expect(clones).toHaveAttribute('aria-pressed', 'true')
  await expect(readout).toHaveText('1 + 3 clones = 4 instances · 0 skipped')
  // the clone path: click clone 3's marker to skip it (only while the Clones is selected)
  const marker = page.getByRole('button', { name: /^Clone 3 at / })
  await expect(marker).toBeVisible()
  await marker.click()
  await expect(readout).toHaveText('1 + 2 clones = 3 instances · 1 skipped')
  await expect(page.getByRole('button', { name: /^Clone 3 at .*skipped$/ })).toBeVisible()
  await render(page, 'clones', 'u3')
  await navigator.getByRole('button', { name: /^Clones 1, ×3/ }).press('ArrowRight')
  await expect(navigator.getByRole('list', { name: 'Source of Clones 1' })).toContainText(
    'Bolt hole 1',
  )
  await navigator.getByRole('button', { name: /^Clones\s*\d+$/ }).click()
  await expect(navigator.getByRole('list', { name: 'Instances of Clones 1' })).toContainText(
    'Clone 2',
  )
  await navigator.getByRole('button', { name: 'Clone 2', exact: true }).click()
  await expect(inspector.getByText('Clone 2 of Clones 1')).toBeVisible()
  await render(page, 'instance', 'u3')

  expect(dfyom.rendererErrors).toEqual([])
})

test('chamfer: add a drilling, add a chamfer from Add, edit it in its inspector', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Chamfers')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setup.getByRole('button', { name: 'Create part' }).click()

  await navigator.getByRole('button', { name: 'Add drilling' }).click()
  await expect(inspector.getByRole('heading', { name: 'Drilling 1' })).toBeVisible()

  // ── the drilling row's menu → Chamfer (DF16: Shift+F10 on the focused row) ───────────────
  await navigator.getByRole('button', { name: /^Drilling 1/ }).focus()
  await page.keyboard.press('Shift+F10')
  const item = page
    .getByRole('menu', { name: 'Actions for Drilling 1' })
    .getByRole('menuitem', { name: 'Chamfer' })
  await item.click()
  await expect(inspector.getByRole('heading', { name: 'Chamfer 1' })).toBeVisible()
  await expect(inspector.getByRole('combobox', { name: 'Edge' })).toContainText('Drilling 1 · Ø')
  await expect(inspector.getByRole('img', { name: /^Section: chamfer 0\.5 mm wide/ })).toBeVisible()
  const field = (label: string) =>
    inspector.getByLabel(label, { exact: true }).and(inspector.locator('input'))
  const depth = field('Depth')
  // D45: sized by width; depth is the alternative input, the diameter read-only
  await expect(field('Diameter')).toHaveAttribute('readonly', '')
  await expect(depth).not.toHaveAttribute('readonly', '')
  await setField(inspector, 'Depth', '0.8')
  await expect(field('Width')).toHaveValue(/^0\.8/)
  const before = await depth.inputValue()

  // a new angle: one update, the width stays and the depth follows
  await setField(inspector, 'Angle', '60')
  await expect(depth).not.toHaveValue(before)
  await expect(field('Width')).toHaveValue(/^0\.8/)
  await expect(inspector.getByRole('img', { name: /at 60°/ })).toBeVisible()
  // the focused field's part is amber in the section (the review render); the deep bore fades out
  await expect(page.locator('[data-fade]')).toHaveCount(1)
  const focusWidth = async () => {
    await field('Width').focus()
    await expect(page.locator('[data-part="width"]')).toHaveAttribute('data-state', 'active')
  }
  await focusWidth()
  await render(page, 'chamfer-inspector', 'u4', focusWidth)

  expect(dfyom.rendererErrors).toEqual([])
})
