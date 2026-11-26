// Workholding in the real app (docs/modes/workholding.md): the user's case, a 250 × 100 × 40
// hardwood stock with a top facing, planned through the bridge; then through plan mode's UI: the
// setup inspector's "Workholding" adds a toe clamp from its Add menu, edits it to the left edge
// (28 wide, grip 10, reach 18, top 12), a second clamp on the right comes from the agent API; the
// clearance height follows them ("From Toe clamp 1 + 2 mm."), the facing clears around them and
// the setup checks report the uncut area. With DFYOM_RENDERS=1 light and dark review renders go to
// design/features/renders/workholding-*.png.
// Windows stay hidden (fixture). Selectors are roles and accessible names.
// Docs: docs/conventions/ui.md#workholding, docs/modes/workholding.md#ui-summary
import { resolve } from 'node:path'
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
const rendersDir =
  process.env['DFYOM_RENDERS_DIR'] ?? resolve(__dirname, '../design/features/renders')

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

/** The user's stock with a top facing (a 6 mm flat) and `extra` design operations, planned. */
async function hardwoodPlan(
  page: Page,
  extra: (partId: string) => Promise<unknown> = async () => undefined,
): Promise<{ planId: string }> {
  const call = <T>(name: string, args: object = {}) => bridgeCall<T>(page, name, args)
  const stock = await call<{ id: string }>('library.stock.add', {
    values: {
      name: 'Hardwood',
      shape: 'block',
      length: '250',
      width: '100',
      thickness: '40',
      material: { name: 'Oak', class: 'hardwood' },
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
  const machine = await call<{ id: string }>('library.machine.add', {
    values: {
      name: 'Router',
      controller: 'grbl',
      travel: { x: '800', y: '800', z: '100' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'manual', maxSpeed: '30000' },
      programUnits: 'mm',
      toolChanger: 'none',
    },
  })
  await call('project.create', { name: 'Clamped', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Clamped',
    stockLibraryItemId: stock.id,
  })
  await call('design.facing.add', { partId, depth: '0.5' })
  await extra(partId)
  await call('project.apply', {})
  return call<{ planId: string }>('plan.create', { partId, machineLibraryItemId: machine.id })
}

test('setup inspector: toe clamps added and edited, the facing clears around them', async ({
  dfyom,
}) => {
  test.setTimeout(90_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  const { planId } = await hardwoodPlan(page)

  await page.getByRole('radio', { name: 'Plan' }).click()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const setups = navigator.getByRole('list', { name: 'Setups in machining order' })
  await setups.getByRole('button', { name: /^Top G54/ }).click({ position: { x: 24, y: 12 } })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()

  const section = inspector.getByRole('region', { name: /^Workholding/ })
  await expect(section).toContainText('Nothing holds the stock yet')
  await section.getByRole('button', { name: 'Add' }).click()
  await page.getByRole('menuitem', { name: /^Toe clamp/ }).click()
  const fields = section.getByRole('group', { name: 'Item Toe clamp 1' })
  await expect(fields).toBeVisible()

  // to the left edge, the user's clamp: 28 wide, grip 10, reach 18, top 12
  await fields.getByRole('combobox').click()
  await page.getByRole('option', { name: 'Left' }).click()
  await expect(section.getByRole('button', { name: /^Toe clamp 1/ })).toContainText('left Y50')
  const set = async (label: string, value: string) => {
    const input = fields.getByLabel(label, { exact: true })
    await input.fill(value)
    await input.press('Enter')
  }
  await set('Width', '28')
  await set('Grip on the stock', '10')
  await set('Reach past the edge', '18')
  await set('Top above Z0', '12')
  await expect(section.getByRole('button', { name: /^Toe clamp 1/ })).toContainText(
    'left Y50 grip 10 top Z12',
  )

  // the second clamp from the agent API: the whole list, the first kept by its id
  const setupId = (
    await bridgeCall<{ plan: { setups: { id: string }[] } }>(page, 'plan.get', { planId })
  ).plan.setups[0]!.id
  await bridgeCall(page, 'plan.workholding.set', {
    planId,
    setupId,
    items: [
      { id: 'wh1', kind: 'toeClamp' },
      { kind: 'toeClamp', edge: 'uMax', width: '28', grip: '10', reach: '18', top: '12' },
    ],
  })
  await expect(section).toContainText('2 items')

  const clearance = inspector.getByLabel('Clearance height', { exact: true })
  await expect(clearance).toHaveValue('14 mm')
  await expect(inspector.getByText('From Toe clamp 1 + 2 mm.')).toBeVisible()

  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 30_000 })
  // generating keeps the setup selected; select it again only if it is not
  if (!(await inspector.getByRole('heading', { name: 'Setup', exact: true }).isVisible()))
    await setups.getByRole('button', { name: /^Top G54/ }).click({ position: { x: 24, y: 12 } })
  const checks = inspector.getByRole('region', { name: 'Setup checks' })
  await expect(checks).toContainText('uncut under Toe clamp 1')
  await expect(checks).toContainText('uncut under Toe clamp 2')
  // the item stays open (its keep-out halo in the viewport)
  await expect(fields).toBeVisible()
  await page.getByRole('button', { name: 'Fit' }).click()
  await render(page, 'workholding-inspector')
  expect(dfyom.rendererErrors).toEqual([])
})

test('held pieces (W5): an outline without tabs comes loose under clamps, tape holds it, a screw in the part warns', async ({
  dfyom,
}) => {
  test.setTimeout(90_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  const { planId } = await hardwoodPlan(page, (partId) =>
    bridgeCall(page, 'design.profile.add', {
      partId,
      shape: { kind: 'rectangle', center: ['125', '50'], length: '200', width: '70' },
      slotWidth: '6',
      tabs: { count: '0' },
    }),
  )
  const setupId = (
    await bridgeCall<{ plan: { setups: { id: string }[] } }>(page, 'plan.get', { planId })
  ).plan.setups[0]!.id
  await bridgeCall(page, 'plan.workholding.set', {
    planId,
    setupId,
    items: [{ kind: 'toeClamp', edge: 'vMin', grip: '5' }],
  })

  await page.getByRole('radio', { name: 'Plan' }).click()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const setups = navigator.getByRole('list', { name: 'Setups in machining order' })
  await setups.getByRole('button', { name: /^Top G54/ }).click({ position: { x: 24, y: 12 } })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  const section = inspector.getByRole('region', { name: /^Workholding/ })
  const checks = inspector.getByRole('region', { name: 'Setup checks' })
  await expect(checks).toContainText('cuts the part free in Top without tabs')

  // tape from the Add menu: the part stays held, the open item's Type says so in its (i) (R11)
  await section.getByRole('button', { name: 'Add' }).click()
  await page.getByRole('menuitem', { name: /^Tape/ }).click()
  const tape = section.getByRole('group', { name: 'Item Tape' })
  await expect(tape.getByRole('combobox', { name: 'Type' })).toHaveAccessibleDescription(
    /pieces cut free stay held/,
  )
  await expect(inspector.getByText('cuts the part free in Top without tabs')).toHaveCount(0)
  await render(page, 'w5-surface-hold')

  // a screw inside the part from the agent API: its warning under the open screw's centre
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
  const screw = section.getByRole('group', { name: 'Item Screw 1' })
  await expect(screw).toContainText('goes through the part')
  await expect(checks).toContainText('goes through the part')
  await page.getByRole('button', { name: 'Fit' }).click()
  await render(page, 'w5-held-pieces')
  expect(dfyom.rendererErrors).toEqual([])
})

test('arrange automatically (W6): four toe clamps in the waste, clear of the toolpaths', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  // the user's case: a pocket and an outline 200 × 80 with tabs, a 6 mm flat long enough
  await hardwoodPlan(page, async (partId) => {
    await bridgeCall(page, 'library.tool.add', {
      values: {
        name: 'Long flat 6',
        type: 'flatEndMill',
        diameter: '6',
        fluteLength: '45',
        overallLength: '80',
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

  await page.getByRole('radio', { name: 'Plan' }).click()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const setups = navigator.getByRole('list', { name: 'Setups in machining order' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const selectTop = async () => {
    if (!(await inspector.getByRole('heading', { name: 'Setup', exact: true }).isVisible()))
      await setups.getByRole('button', { name: /^Top G54/ }).click({ position: { x: 24, y: 12 } })
  }
  await setups.getByRole('button', { name: /^Top G54/ }).click({ position: { x: 24, y: 12 } })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  const section = inspector.getByRole('region', { name: /^Workholding/ })
  const arrange = section.getByRole('button', { name: 'Arrange automatically' })

  // without toolpaths the core says what to do first
  await arrange.click()
  await expect(section.getByRole('alert')).toContainText('Generate the toolpaths of Top first')
  await arrange.scrollIntoViewIfNeeded()
  await render(page, 'w6-arrange-refused')

  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 30_000 })
  await selectTop()
  await arrange.click()
  await expect(section).toContainText('4 items')
  await expect(section.getByRole('alert')).toHaveCount(0)
  const rows = [
    [1, 'left Y25 grip 10 top Z25'],
    [2, 'left Y75 grip 10 top Z25'],
    [3, 'right Y25 grip 10 top Z25'],
    [4, 'right Y75 grip 10 top Z25'],
  ] as const
  for (const [n, summary] of rows)
    await expect(
      section.getByRole('button', { name: new RegExp(`^Toe clamp ${n}`) }),
    ).toContainText(summary)
  await expect(inspector.getByLabel('Clearance height', { exact: true })).toHaveValue('27 mm')

  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 30_000 })
  await selectTop()
  const checks = inspector.getByRole('region', { name: 'Setup checks' })
  await expect(checks).not.toContainText('hits Toe clamp')
  await page.getByRole('button', { name: 'Fit' }).click()
  await arrange.scrollIntoViewIfNeeded()
  await render(page, 'w6-arrange')
  expect(dfyom.rendererErrors).toEqual([])
})
