// Manual machine control without a plan in the real app (hardening DF31–DF35): a project with no
// plan, Run mode's "No plan (manual control)" with a library machine homing top right (GRBL's
// default, $23=0) → home → jog +X step by step up to the travel's end (0) and the next step
// refused in words → zero → the position read-out; Stop disabled with its reason while idle. A
// second machine homing front left ($23=3) homes to the other corner. Windows stay hidden
// (fixture). Selectors are roles and accessible names.
// Docs: docs/modes/run.md#machine-frame-and-manual-control-hardening-df31df35,
// docs/conventions/testing.md#end-to-end
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

const machineValues = (name: string, homingCorner: string) => ({
  name,
  controller: 'grbl',
  travel: { x: '800', y: '600', z: '100' },
  maxFeedRate: { x: '5000', y: '5000', z: '1000' },
  spindle: { control: 'manual', maxSpeed: '24000' },
  programUnits: 'mm',
  toolChanger: 'none',
  homingCorner,
  pullOff: '1',
  softLimits: true,
})

test('manual control without a plan: home top right, jog to the travel end, zero (DF31–DF35)', async ({
  dfyom,
}) => {
  test.setTimeout(90_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await bridgeCall(page, 'library.machine.add', { values: machineValues('Top right', 'backRight') })
  await bridgeCall(page, 'library.machine.add', {
    values: machineValues('Front left', 'frontLeft'),
  })
  const stock = await bridgeCall<{ id: string }>(page, 'library.stock.add', {
    values: {
      name: 'Block',
      shape: 'block',
      length: '100',
      width: '60',
      thickness: '20',
      material: { name: '6061-T6', class: 'aluminum' },
    },
  })
  // a part but no plan
  await bridgeCall(page, 'project.create', { name: 'No plan', unitSystem: 'mm' })
  await bridgeCall(page, 'design.part.add', { name: 'Part', stockLibraryItemId: stock.id })

  await expect(page.getByRole('dialog', { name: 'Stock' })).toBeHidden()
  await page.getByRole('radio', { name: 'Run' }).click()
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const machine = page.getByRole('group', { name: 'Machine' })
  const dro = inspector.getByRole('table', { name: 'Position' })
  const cell = (name: string) => dro.getByRole('cell', { name })

  // no plan in the project: manual control, with the library's machines to choose from
  await expect(navigator.getByRole('combobox', { name: 'Plan' })).toHaveText(
    'No plan (manual control)',
  )
  await navigator.getByRole('combobox', { name: 'Machine' }).click()
  await page.getByRole('option', { name: 'Top right' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: 'Max' }).click()
  await navigator.getByRole('button', { name: 'Connect to virtual machine' }).click()
  await expect(machine.getByText('Virtual machine · Max')).toBeVisible()

  // DF35: nothing moves yet, so Stop is disabled and says why
  const stop = machine.getByRole('button', { name: 'Stop' })
  await expect(stop).toHaveAttribute('aria-disabled', 'true')
  await expect(stop).toHaveAccessibleDescription('Nothing to stop: the machine is not moving.')

  // DF31/DF33: homing top right leaves the machine at −pull-off on X, Y and Z
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  for (const axis of ['X', 'Y', 'Z'])
    await expect(cell(`Machine position ${axis}`)).toHaveText('-1.000')
  await expect(navigator.getByText(/The work zero is at machine 0/)).toBeVisible()

  // DF34: +X in 0.1 mm steps, queued; neither the moving state nor a message moves the jog pad
  await navigator.getByRole('radio', { name: '0.1 mm' }).click()
  const jogX = navigator.getByRole('button', { name: 'Jog X+' })
  const box = await jogX.boundingBox()
  for (let i = 0; i < 10; i++) await jogX.click()
  await expect(cell('Machine position X')).toHaveText('0.000')
  await expect(machine.getByText('Idle')).toBeVisible()
  // DF33: one more step would leave the travel, said in words, after the controls
  await jogX.click()
  await expect(
    navigator.getByText('X would leave the travel: max 0.000 mm, the jog would end at 0.100 mm.'),
  ).toBeVisible()
  expect(await jogX.boundingBox()).toEqual(box)

  // into the travel, then zero all axes there
  await navigator.getByRole('radio', { name: '10 mm' }).click()
  for (const name of ['Jog X−', 'Jog Y−', 'Jog Z−']) {
    await navigator.getByRole('button', { name }).click()
    await expect(machine.getByText('Idle')).toBeVisible()
  }
  await expect(cell('Machine position X')).toHaveText('-10.000')
  await navigator.getByRole('button', { name: 'Zero X Y Z' }).click()
  for (const axis of ['X', 'Y', 'Z'])
    await expect(cell(`Work position ${axis}`)).toHaveText(/^0\.000/)
  await expect(cell('Machine position Y')).toHaveText('-11.000')

  // a front-left machine homes to the other corner: X and Y at −travel + pull-off
  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  await expect(navigator.getByRole('button', { name: 'Connect to virtual machine' })).toBeEnabled()
  await navigator.getByRole('combobox', { name: 'Machine' }).click()
  await page.getByRole('option', { name: 'Front left' }).click()
  await navigator.getByRole('button', { name: 'Connect to virtual machine' }).click()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  await expect(cell('Machine position X')).toHaveText('-799.000')
  await expect(cell('Machine position Y')).toHaveText('-599.000')
  await expect(cell('Machine position Z')).toHaveText('-1.000')
  // the − end is the limit here
  await navigator.getByRole('radio', { name: '10 mm' }).click()
  await navigator.getByRole('button', { name: 'Jog X−' }).click()
  await expect(
    navigator.getByText(
      'X would leave the travel: min -800.000 mm, the jog would end at -809.000 mm.',
    ),
  ).toBeVisible()
  expect(dfyom.rendererErrors).toEqual([])
})
