// H1 (DF119, user TG #369) in the built app: Add → Bolt hole, Type → Recessed countersink, Size M5;
// the Sizes group names the recess fields "Recess Ø" / "Recess depth", the section draws the cone on
// the recess floor, Tools has a Recess row, and after Apply the plan lists the recess, the bore and
// the countersink. Windows stay hidden (fixture). With DFYOM_RENDERS=1 it writes
// h1-recessed-inspector-{light,dark}.png to DFYOM_RENDERS_DIR (default design/features/renders).
// Docs: docs/modes/hole-slots-and-round-corners.md#implementation-h1, docs/conventions/ui.md#hole-inspector
import { resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir =
  process.env['DFYOM_RENDERS_DIR'] ?? resolve(__dirname, '../design/features/renders')

async function render(page: Page, name: string): Promise<void> {
  if (!RENDERS) return
  const settings = page.getByRole('dialog', { name: 'Settings' })
  for (const theme of ['light', 'dark'] as const) {
    await page.getByRole('button', { name: 'Settings' }).click()
    await settings.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await settings.getByRole('button', { name: 'Done' }).click()
    await expect(settings).toBeHidden()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${rendersDir}/${name}-${theme}.png` })
  }
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

test('recessed countersink: Add Bolt hole, Recessed countersink, M5, then the plan (H1)', async ({
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
  const sizes = inspector.getByRole('region', { name: 'Sizes' })
  await expect(input(sizes, 'Recess Ø')).toHaveValue('12.6 mm')
  await expect(input(sizes, 'Recess depth')).toHaveValue('2 mm')
  await expect(input(sizes, 'Countersink Ø')).toHaveValue('11.6 mm')
  await expect(sizes.getByLabel('Counterbore Ø', { exact: true })).toHaveCount(0)
  await expect(inspector.getByRole('img', { name: /^Section:/ })).toHaveAccessibleName(
    'Section: Ø 5.5 mm through; recess Ø 12.6 mm, 2 mm deep; countersink Ø 11.6 mm, 90°; M5 head 2.2 mm below the face.',
  )
  await expect(
    navigator.getByRole('button', { name: /^Bolt hole 1, M5 recessed countersink, 3 operations/ }),
  ).toBeVisible()

  // Apply: the owned operations get their tools; the Tools group names the recess
  await page.keyboard.press('ControlOrMeta+Enter')
  const tools = inspector.getByRole('region', { name: 'Tools' })
  await expect(tools.getByRole('combobox', { name: 'Recess' })).toBeVisible()
  await expect(tools.getByRole('combobox', { name: 'Countersink' })).toBeVisible()
  await expect(tools.getByRole('combobox', { name: 'Recess' })).not.toHaveText('No tool yet')
  await inspector.getByRole('region', { name: 'Type' }).scrollIntoViewIfNeeded()
  await render(page, 'h1-recessed-inspector')
  if (RENDERS) {
    await sizes.scrollIntoViewIfNeeded()
    await render(page, 'h1-recessed-sizes')
  }

  // the plan: recess, bore, countersink
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
  await render(page, 'h1-recessed-plan')
  expect(dfyom.rendererErrors).toEqual([])
})
