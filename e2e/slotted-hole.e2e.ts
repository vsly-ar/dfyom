// H3 (DF119, user TG #369: "a long, recessed, countersunk hole for an M5 screw") in the built app:
// Add → Bolt hole, Size M5, Type → Recessed, Slotted on, Slot length 10; the Sizes group shows
// Slot length, Rotation and the read-only Overall, the section is drawn along the slot, Tools has
// a Slot row, and after Apply the plan lists the recess and the slot (pockets) and the countersink
// (chamfer mill) and generates their toolpaths. While the hole is selected the Design viewport draws
// its centre line and travel dimension (the chip reads the travel, the summary says it). Windows
// stay hidden (fixture). With DFYOM_RENDERS=1 it writes
// h3-slotted-{inspector,sizes,plan}-dark.png and h3-slot-dimension-dark.png to DFYOM_RENDERS_DIR
// (default design/features/renders).
// Docs: docs/modes/hole-slots-and-round-corners.md#implementation-h3,
// docs/modes/hole-slots-and-round-corners.md#viewport-slot-dimension, docs/conventions/ui.md#hole-inspector
import { resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir =
  process.env['DFYOM_RENDERS_DIR'] ?? resolve(__dirname, '../design/features/renders')

async function render(page: Page, name: string): Promise<void> {
  if (!RENDERS) return
  // dark only (the UI vision's reference theme)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.getByRole('button', { name: 'Settings' }).click()
  await settings.getByRole('radio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await settings.getByRole('button', { name: 'Done' }).click()
  await expect(settings).toBeHidden()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${rendersDir}/${name}-dark.png` })
}

async function bridgeCall<T>(page: Page, name: string, args: object = {}): Promise<T> {
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

const input = (scope: Locator, label: string) =>
  scope.getByLabel(label, { exact: true }).and(scope.locator('input'))

test('slotted hole: Add Bolt hole, M5, Recessed, Slotted 10, then the plan (H3)', async ({
  dfyom,
}) => {
  test.setTimeout(90_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 860 })
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
  const machine = await bridgeCall<{ id: string }>(page, 'library.machine.add', {
    values: {
      name: 'Router',
      controller: 'grbl',
      travel: { x: '800', y: '800', z: '100' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'manual', maxSpeed: '24000' },
      programUnits: 'mm',
      toolChanger: 'none',
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
  const { partId } = await bridgeCall<{ partId: string }>(page, 'design.part.add', {
    name: 'Clamp',
    stockLibraryItemId: stock.id,
  })

  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await navigator.getByRole('button', { name: 'Add', exact: true }).click()
  await page
    .getByRole('menu')
    .getByRole('group', { name: 'Features' })
    .getByRole('menuitem', { name: 'Bolt hole' })
    .click()
  await expect(inspector.getByRole('heading', { name: 'Bolt hole 1' })).toBeVisible()

  await inspector.getByRole('combobox', { name: 'Size' }).click()
  await page.getByRole('listbox').getByRole('option', { name: 'M5', exact: true }).click()
  const type = inspector.getByRole('radio', { name: 'Recessed countersink' })
  await type.click()
  await expect(type).toHaveAttribute('aria-checked', 'true')
  const slotted = inspector
    .getByRole('region', { name: 'Type' })
    .getByRole('switch', { name: 'Slotted' })
  await slotted.click()
  await expect(slotted).toBeChecked()
  const sizes = inspector.getByRole('region', { name: 'Sizes' })
  const length = input(sizes, 'Slot length')
  await length.fill('10')
  await length.press('Enter')
  await expect(length).toHaveValue('10')
  await expect(input(sizes, 'Rotation')).toHaveValue('0°')
  await expect(input(sizes, 'Overall')).toHaveValue('15.5 mm')
  await expect(
    inspector.getByRole('img', { name: /^Section along the slot:/ }),
  ).toHaveAccessibleName(
    'Section along the slot: Ø 5.5 mm through, slotted: 10 mm travel, 15.5 mm overall; recess Ø 12.6 mm, 2 mm deep; countersink Ø 11.6 mm, 90°; M5 head 2.2 mm below the face.',
  )
  await expect(
    navigator.getByRole('button', { name: /^Bolt hole 1, M5 recessed countersink, slot 10/ }),
  ).toBeVisible()

  // Apply: the owned operations get their tools; the Tools group names the recess and the slot
  await page.keyboard.press('ControlOrMeta+Enter')
  const tools = inspector.getByRole('region', { name: 'Tools' })
  await expect(tools.getByRole('combobox', { name: 'Recess' })).toBeVisible()
  await expect(tools.getByRole('combobox', { name: 'Slot' })).toBeVisible()
  await expect(tools.getByRole('combobox', { name: 'Slot' })).not.toHaveText('No tool yet')
  await expect(tools.getByRole('combobox', { name: 'Countersink' })).toBeVisible()
  // the viewport: the slot's centre line and travel dimension while the hole is selected
  const viewport = page.getByRole('region', { name: '3D viewport' })
  await expect(viewport).toHaveAccessibleDescription(/Slot travel 10 mm\./)
  await expect(viewport.getByTestId('slot-dimension-chip')).toHaveText('10 mm')
  if (RENDERS) {
    await viewport.focus()
    await page.keyboard.press('1')
    await render(page, 'h3-slot-dimension')
    await page.keyboard.press('4')
  }
  await inspector.getByRole('region', { name: 'Type' }).scrollIntoViewIfNeeded()
  await render(page, 'h3-slotted-inspector')
  if (RENDERS) {
    await sizes.scrollIntoViewIfNeeded()
    await render(page, 'h3-slotted-sizes')
  }

  // the plan: recess and slot by the end mill, the countersink by the chamfer mill
  await bridgeCall(page, 'plan.create', { partId, machineLibraryItemId: machine.id })
  await page.getByRole('radio', { name: 'Plan' }).click()
  const ops = navigator.getByRole('list', { name: 'Plan operations in machining order' })
  await expect(ops.getByRole('button', { name: /^Bolt hole 1 · counterbore Flat 3/ })).toBeVisible()
  await expect(ops.getByRole('button', { name: /^Bolt hole 1 · drill Flat 3/ })).toBeVisible()
  await expect(
    ops.getByRole('button', { name: /^Bolt hole 1 · countersink Chamfer 90 × 12/ }),
  ).toBeVisible()
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 30_000 })
  await render(page, 'h3-slotted-plan')
  expect(dfyom.rendererErrors).toEqual([])
})
