// The setup's workholding in the Run scene (hardening DF133 RW1) in the real app on the virtual
// machine (the GRBL emulator, no hardware): a 250 × 100 × 40 stock with a facing, two toe clamps
// and a screw, a machine with an ER11 holder. Connected but not homed the Position panel says the
// clamps are outlined; homed with G54 never set they are hidden; with the work zero set they are
// solid and the holder ghost stands at the tool marker with its chip. Windows stay hidden
// (fixture). With DFYOM_RENDERS=1: df133-rw1-outlined and df133-rw1-solid (light and dark) in
// design/features/renders/, or in DFYOM_RENDERS_DIR. RW3: a held X+ beside the front clamp stops
// at the margin with the notice, a further step is not sent, "Jog past once" lets one step
// through, the Jog menu switches the guard off. RW4: a Go to down onto the
// front clamp is refused with the finding and a red target, then "Go anyway" goes
// (df133-rw4-goto-blocked). RW5: the live clearance chip, red at the stop by the front clamp. RW6:
// the guard's e2e (run-workholding.md § Testing): the held jog's stop renders
// df133-run-workholding, 1 mm back from the stop the chip and the clamp are amber
// (df133-rw6-amber), and the guard switched off (df133-rw6-guard-off).
// Docs: docs/modes/run-workholding.md#implementation-rw1, #implementation-rw3, #implementation-rw4,
// #implementation-rw5, #implementation-rw6,
// docs/conventions/ui.md#workholding
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir =
  process.env['DFYOM_RENDERS_DIR'] ?? resolve(__dirname, '../design/features/renders')

async function call<T>(page: Page, name: string, args: object = {}): Promise<T> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

/** With DFYOM_RENDERS=1: `name`-light.png and -dark.png (the theme set as Settings does). */
async function render(page: Page, name: string): Promise<void> {
  if (!RENDERS) return
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => {
      ;(
        globalThis as unknown as {
          document: { documentElement: { dataset: Record<string, string> } }
        }
      ).document.documentElement.dataset['theme'] = t
    }, theme)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${rendersDir}/${name}-${theme}.png` })
  }
}

test('run scene workholding (DF133 RW1–RW6): trust states, guarded jogs and Go to, the chip, the switch', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 860 })
  const stock = await call<{ id: string }>(page, 'library.stock.add', {
    values: {
      name: 'Hardwood',
      shape: 'block',
      length: '250',
      width: '100',
      thickness: '40',
      material: { name: 'Oak', class: 'hardwood' },
    },
  })
  await call(page, 'library.tool.add', {
    values: {
      name: 'Flat 6',
      type: 'flatEndMill',
      diameter: '6',
      fluteLength: '20',
      overallLength: '50',
      stickout: '30',
      fluteCount: '2',
      toolMaterial: 'carbide',
    },
  })
  const machine = await call<{ id: string }>(page, 'library.machine.add', {
    values: {
      name: 'Router',
      controller: 'grbl',
      travel: { x: '320', y: '220', z: '90' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'manual', maxSpeed: '24000' },
      programUnits: 'mm',
      toolChanger: 'none',
      homingCorner: 'backRight',
      pullOff: '1',
      softLimits: true,
      holder: { preset: 'er11' },
    },
  })
  await call(page, 'project.create', { name: 'Clamped', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>(page, 'design.part.add', {
    name: 'Clamped',
    stockLibraryItemId: stock.id,
  })
  await call(page, 'design.facing.add', { partId, depth: '0.5' })
  await call(page, 'project.apply', {})
  const { planId } = await call<{ planId: string }>(page, 'plan.create', {
    partId,
    machineLibraryItemId: machine.id,
  })
  const setupId = (await call<{ plan: { setups: { id: string }[] } }>(page, 'plan.get', { planId }))
    .plan.setups[0]!.id
  await call(page, 'plan.workholding.set', {
    planId,
    setupId,
    items: [
      { kind: 'toeClamp', edge: 'vMin', at: '60', top: '22' },
      { kind: 'toeClamp', edge: 'vMax', at: '190', top: '22' },
      { kind: 'screw', center: ['230', '50'], top: '2' },
    ],
  })

  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector', includeHidden: true })
  const machineGroup = page.getByRole('group', { name: 'Machine', includeHidden: true })
  const dro = inspector.getByRole('table', { name: 'Position', includeHidden: true })
  const cell = (name: string) => dro.getByRole('cell', { name, includeHidden: true })
  const at = async (name: string) => parseFloat((await cell(name).textContent()) ?? '')
  const line = inspector.locator('[data-workholding-trust]')

  await page.getByRole('radio', { name: 'Run' }).click()
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: '10×' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(line).toHaveText('Home the machine to check jogs against the workholding.')
  await page.getByRole('button', { name: 'Fit' }).click()
  await render(page, 'df133-rw1-outlined')

  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machineGroup.getByText('Idle')).toBeVisible()
  await expect(line).toHaveText('Set the work zero to check jogs against the workholding.')

  // the work zero at machine (−290, −160, −75), then the tool beside the front clamp, above it
  await call(page, 'run.machine.jog', { to: [-290, -160, -75], feed: 5000 })
  await expect.poll(() => at('Machine position Z')).toBeCloseTo(-75, 3)
  await expect(machineGroup.getByText('Idle')).toBeVisible()
  for (const axis of ['X', 'Y', 'Z'])
    await dro.getByRole('button', { name: `Set ${axis} zero` }).click()
  await expect(line).toHaveText('Checks the clamps as placed in Plan, at the work zero.')
  await call(page, 'run.machine.jog', { to: [-205, -150, -50], feed: 5000 })
  await expect.poll(() => at('Work position Z')).toBeCloseTo(25, 3)
  await expect(machineGroup.getByText('Idle')).toBeVisible()
  const chip = page.locator('[data-holder-ghost]')
  await expect(chip).toHaveText('T1 Ø6 mm · stickout 30 mm · ER11')
  await page.getByRole('button', { name: 'Fit' }).click()
  await render(page, 'df133-rw1-solid')

  await expect(inspector.locator('[data-clearance]')).toHaveText(/^Clear: [\d.]+ mm to /)

  // RW3: beside the front clamp (X 45–75: its grip onto the stock and its 50 mm reach in front
  // of it), below its top; a held X+ stops at the margin, not at the travel edge. (RW6: until RW5
  // this started in front of the stock, which is inside the clamp's reach: the chip read 0 mm.)
  await call(page, 'run.machine.jog', { to: [-270, -180, -65], feed: 5000 })
  await expect.poll(() => at('Work position X')).toBeCloseTo(20, 3)
  await expect.poll(() => at('Work position Y')).toBeCloseTo(-20, 3)
  await expect(machineGroup.getByText('Idle')).toBeVisible()
  const clearance = inspector.locator('[data-clearance]')
  await expect(clearance).toHaveText(/^Clear: 22(\.0)? mm to Toe clamp 1 \(tool\)$/)
  const xPlus = navigator.getByRole('button', { name: 'Jog X+' })
  const box = (await xPlus.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  const notice = navigator.locator('[data-guard-notice] [role="status"]')
  await expect(notice).toHaveText(/^Stopped 2(\.0)? mm from Toe clamp 1 \(tool\)\.$/)
  await page.mouse.up()
  await expect(machineGroup.getByText('Idle')).toBeVisible()
  const x = await at('Work position X')
  expect(x).toBeGreaterThan(39.9)
  expect(x).toBeLessThan(40)
  // RW5: the live clearance chip names the front clamp, red at the stop point (the margin)
  await expect(clearance).toHaveText(/^Within the margin: 2(\.0)? mm to Toe clamp 1 \(tool\)$/)
  await expect(clearance).toHaveAttribute('data-clearance', 'inside')
  await page.getByRole('button', { name: 'Fit' }).click()
  await render(page, 'df133-run-workholding')
  // further in: not moved
  await xPlus.click()
  await expect(notice).toHaveText(/^Not moved: the tool would come within the margin/)
  expect(await at('Work position X')).toBe(x)
  // Jog past once: armed, then used by the next step (1 mm, today's command)
  await navigator.getByRole('button', { name: 'Jog past once' }).click()
  await expect(notice).toHaveText('Next jog unguarded.')
  await navigator.getByRole('radio', { name: '1 mm', exact: true }).click()
  await xPlus.click()
  await expect.poll(() => at('Work position X')).toBeCloseTo(x + 1, 3)
  await expect(notice).toHaveText('')
  await expect(clearance).toHaveText(/^Within the margin: 1(\.0)? mm to Toe clamp 1 \(tool\)$/)
  // RW6: 1 mm back from the stop point the clearance is 3 mm, under 2 × the 2 mm margin: amber
  await call(page, 'run.machine.jog', { to: [x - 1 - 290, -180, -65], feed: 5000 })
  await expect.poll(() => at('Work position X')).toBeCloseTo(x - 1, 3)
  await expect(machineGroup.getByText('Idle')).toBeVisible()
  await expect(clearance).toHaveText(/^Close: 3(\.0)? mm to Toe clamp 1 \(tool\)$/)
  await expect(clearance).toHaveAttribute('data-clearance', 'close')
  await render(page, 'df133-rw6-amber')

  // RW4: above the front clamp's X, in front of it; Go to down onto it is refused, then Go anyway
  await call(page, 'run.machine.jog', { to: [-230, -200, -40], feed: 5000 })
  await expect.poll(() => at('Work position Z')).toBeCloseTo(35, 3)
  await expect(machineGroup.getByText('Idle')).toBeVisible()
  await dro.getByRole('button', { name: /^Go to: X .* work$/ }).click()
  const goTo = page.getByRole('dialog', { name: 'Go to' })
  for (const [axis, v] of [
    ['X', '60'],
    ['Y', '0'],
    ['Z', '5'],
  ] as const)
    await goTo.getByRole('textbox', { name: axis }).fill(v)
  const finding = goTo.locator('[data-guard-finding]')
  await expect(finding).toContainText(
    /Step \d \(down to Z 5\.000\) hits Toe clamp 1: the tool stops/,
  )
  const go = goTo.getByRole('button', { name: 'Go', exact: true })
  await expect(go).toBeDisabled()
  await expect(page.locator('[data-goto-target][data-hit]')).toHaveCount(1)
  await render(page, 'df133-rw4-goto-blocked')
  const anyway = goTo.getByRole('checkbox', { name: /^Go anyway/ })
  await anyway.click()
  await expect(go).toBeEnabled()
  await go.click()
  await expect(goTo).toHaveCount(0)
  await expect.poll(() => at('Work position Z')).toBeCloseTo(5, 3)
  expect(await at('Work position Y')).toBeCloseTo(0, 3)
  await call(page, 'run.machine.jog', { to: [-230, -200, -40], feed: 5000 })
  await expect.poll(() => at('Work position Z')).toBeCloseTo(35, 3)
  await expect(machineGroup.getByText('Idle')).toBeVisible()

  // the Jog menu's switch: off, the status line warns
  await navigator.getByRole('button', { name: 'Jog options' }).click()
  await page.getByRole('menuitemradio', { name: /Workholding guard/ }).click()
  await expect(line).toHaveText('Workholding guard off.')
  await expect(line).toHaveAttribute('data-tone', 'warning')
  await render(page, 'df133-rw6-guard-off')

  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  await expect(machineGroup).toHaveCount(0)
  expect(dfyom.rendererErrors).toEqual([])
})
