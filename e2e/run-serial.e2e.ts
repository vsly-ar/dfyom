// A serial connection in the real app (hardening M1) over the loopback port the machine host
// offers with DFYOM_LOOPBACK_SERIAL=1 (a GRBL emulator behind a serial-like stream, no hardware):
// Connect to → Serial port, the port and baud selects, connect, the "Serial · path" chip, the
// settings check warning (the emulator's defaults differ from the library machine), and the
// confirmation before the first Home; then (M2, M3) the alarm panel, hold to jog and the real-machine
// pre-flight. Windows stay hidden (fixture). With DFYOM_RENDERS=1 it also
// writes the light and dark review renders to design/features/renders/.
// Docs: docs/modes/run-machine.md, docs/modes/run.md#safety
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, launchApp, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')
const PORT = '/dev/cu.usbmodem1101'

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

const MACHINE = {
  name: 'Router',
  controller: 'grbl',
  travel: { x: '800', y: '600', z: '100' },
  maxFeedRate: { x: '5000', y: '5000', z: '1000' },
  spindle: { control: 'manual', maxSpeed: '24000' },
  programUnits: 'mm',
  toolChanger: 'none',
  homingCorner: 'backRight',
  pullOff: '1',
  softLimits: true,
}

async function bridgeCall<T>(page: Page, name: string, args: object = {}): Promise<T> {
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

test('serial port (M1): pick the port, connect, settings warning, Home asks first', async () => {
  test.setTimeout(90_000)
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'dfyom-e2e-')))
  // only this launch: the machine host offers the loopback port instead of the OS's ports
  process.env['DFYOM_LOOPBACK_SERIAL'] = '1'
  const { app, rendererErrors } = await launchApp(dataDir).finally(() => {
    delete process.env['DFYOM_LOOPBACK_SERIAL']
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await bridgeCall(page, 'library.machine.add', { values: MACHINE })
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
    await bridgeCall(page, 'project.create', { name: 'Serial', unitSystem: 'mm' })
    await bridgeCall(page, 'design.part.add', { name: 'Part', stockLibraryItemId: stock.id })
    await expect(page.getByRole('dialog', { name: 'Stock' })).toBeHidden()
    await page.getByRole('radio', { name: 'Run' }).click()
    const navigator = page.getByRole('navigation', { name: 'Navigator' })
    const machine = page.getByRole('group', { name: 'Machine' })

    await navigator.getByRole('radio', { name: 'Serial port' }).click()
    await expect(navigator.getByRole('combobox', { name: 'Serial port' })).toHaveText(
      `${PORT} · Arduino (www.arduino.cc)`,
    )
    await expect(navigator.getByRole('combobox', { name: 'Baud' })).toHaveText('115200')
    await expect(navigator.getByRole('combobox', { name: 'Time scale' })).toBeHidden()
    await render(page, 'm1-serial-picker')

    await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(machine.getByText(`Serial · ${PORT}`)).toBeVisible()
    const warning = navigator.getByRole('alert')
    await expect(warning).toContainText("The controller's settings differ from the library machine")
    await expect(warning).toContainText('$110 maxFeedRate.x')
    await expect(warning).toContainText('and 3 more')
    await expect(warning.getByRole('button', { name: 'Review' })).toBeVisible()
    await render(page, 'm1-settings-warning')

    // a real machine not yet homed: Home asks first; cancelling sends nothing
    await navigator.getByRole('button', { name: 'Home' }).click()
    const confirm = page.getByRole('alertdialog', { name: 'Home the machine?' })
    await expect(confirm).toBeVisible()
    await render(page, 'm1-home-confirm')
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirm).toBeHidden()

    await navigator.getByRole('button', { name: 'Disconnect' }).click()
    await expect(navigator.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
    expect(rendererErrors).toEqual([])
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('real machine (M2, M3): alarm panel, home, hold to jog, the real-machine pre-flight', async () => {
  test.setTimeout(120_000)
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'dfyom-e2e-')))
  process.env['DFYOM_LOOPBACK_SERIAL'] = '1'
  const { app, rendererErrors } = await launchApp(dataDir).finally(() => {
    delete process.env['DFYOM_LOOPBACK_SERIAL']
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const machineItem = await bridgeCall<{ id: string }>(page, 'library.machine.add', {
      values: MACHINE,
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
    await bridgeCall(page, 'project.create', { name: 'Serial plan', unitSystem: 'mm' })
    const { partId } = await bridgeCall<{ partId: string }>(page, 'design.part.add', {
      name: 'Part',
      stockLibraryItemId: stock.id,
    })
    await expect(page.getByRole('dialog', { name: 'Stock' })).toBeHidden()
    await bridgeCall(page, 'plan.create', { partId, machineLibraryItemId: machineItem.id })
    await page.getByRole('radio', { name: 'Run' }).click()
    const navigator = page.getByRole('navigation', { name: 'Navigator' })
    const inspector = page.getByRole('complementary', { name: 'Inspector' })
    const machine = page.getByRole('group', { name: 'Machine' })
    const cell = (name: string) =>
      inspector.getByRole('table', { name: 'Position' }).getByRole('cell', { name })

    await navigator.getByRole('radio', { name: 'Serial port' }).click()
    await expect(navigator.getByRole('combobox', { name: 'Serial port' })).toHaveText(
      `${PORT} · Arduino (www.arduino.cc)`,
    )
    await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(machine.getByText(`Serial · ${PORT}`)).toBeVisible()

    // M3: GRBL starts locked ($22=1): the panel says so and what to do, as the next step (DF46)
    const alarm = navigator.getByRole('region', { name: 'Needs homing' })
    await expect(alarm.getByRole('heading', { name: 'Needs homing' })).toBeVisible()
    await expect(alarm.getByText('Home the machine.')).toBeVisible()
    // at the end of the navigator (DF34): scrolled to for the render
    await alarm.scrollIntoViewIfNeeded()
    await render(page, 'm3-alarm-panel')
    await navigator.getByRole('button', { name: 'Home' }).scrollIntoViewIfNeeded()

    await navigator.getByRole('button', { name: 'Home' }).click()
    await page
      .getByRole('alertdialog', { name: 'Home the machine?' })
      .getByRole('button', { name: 'Home' })
      .click()
    await expect(machine.getByText('Idle')).toBeVisible({ timeout: 60_000 })
    await expect(alarm).toBeHidden()
    await expect(cell('Machine position X')).toHaveText('-1.000')

    // M3: hold to jog X−, release: the axis moved and stopped
    await navigator.getByRole('radio', { name: 'Continuous' }).click()
    await expect(navigator.getByText('Hold to jog; release to stop.')).toBeVisible()
    const jogX = navigator.getByRole('button', { name: 'Jog X−' })
    await jogX.hover()
    await page.mouse.down()
    await expect(machine.getByText('Jogging')).toBeVisible()
    await render(page, 'm3-continuous-jog')
    // hold on state, not time: until the reported X has passed −2 mm
    const machineX = async () => parseFloat((await cell('Machine position X').textContent()) ?? '')
    await expect.poll(machineX).toBeLessThan(-2)
    await page.mouse.up()
    await expect(machine.getByText('Idle')).toBeVisible()
    // Idle is reported only once motion has stopped: the jog cancel ended it short of the
    // travel edge (−$130)
    const x = await machineX()
    expect(x).toBeLessThan(-2)
    expect(x).toBeGreaterThan(-150)

    // M2: the real-machine pre-flight names the plan status and the air cut; a draft does not run
    await inspector.getByRole('button', { name: 'Start run' }).click()
    const preflight = page.getByRole('dialog', { name: 'Start run?' })
    await expect(preflight.getByText(`Serial port ${PORT} at 115200 baud`)).toBeVisible()
    await expect(preflight.getByText(/Run it in the air/)).toBeVisible()
    await expect(preflight.getByText('Draft')).toBeVisible()
    await expect(preflight.getByRole('button', { name: 'Start on the machine' })).toBeDisabled()
    await render(page, 'm2-preflight')
    await preflight.getByRole('button', { name: 'Cancel' }).click()

    await navigator.getByRole('button', { name: 'Disconnect' }).click()
    await expect(navigator.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
    expect(rendererErrors).toEqual([])
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('touch plate and overrides (M4, M6): a probe that misses, unlock, a probe that touches', async () => {
  test.setTimeout(120_000)
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'dfyom-e2e-')))
  process.env['DFYOM_LOOPBACK_SERIAL'] = '1'
  // 10× controller clock: a 25 mm probe at 50 mm/min takes 3 s instead of 30 s
  process.env['DFYOM_LOOPBACK_TIMESCALE'] = '10'
  const { app, rendererErrors } = await launchApp(dataDir).finally(() => {
    delete process.env['DFYOM_LOOPBACK_SERIAL']
    delete process.env['DFYOM_LOOPBACK_TIMESCALE']
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const machineItem = await bridgeCall<{ id: string }>(page, 'library.machine.add', {
      values: { ...MACHINE, probePlateThickness: '10' },
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
    await bridgeCall(page, 'project.create', { name: 'Probe', unitSystem: 'mm' })
    const { partId } = await bridgeCall<{ partId: string }>(page, 'design.part.add', {
      name: 'Part',
      stockLibraryItemId: stock.id,
    })
    await expect(page.getByRole('dialog', { name: 'Stock' })).toBeHidden()
    await bridgeCall(page, 'plan.create', { partId, machineLibraryItemId: machineItem.id })
    await page.getByRole('radio', { name: 'Run' }).click()
    const navigator = page.getByRole('navigation', { name: 'Navigator' })
    const inspector = page.getByRole('complementary', { name: 'Inspector' })
    const machine = page.getByRole('group', { name: 'Machine' })
    const cell = (name: string) =>
      inspector.getByRole('table', { name: 'Position' }).getByRole('cell', { name })

    await navigator.getByRole('radio', { name: 'Serial port' }).click()
    await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(machine.getByText(`Serial · ${PORT}`)).toBeVisible()
    await navigator.getByRole('button', { name: 'Home' }).click()
    await page
      .getByRole('alertdialog', { name: 'Home the machine?' })
      .getByRole('button', { name: 'Home' })
      .click()
    await expect(machine.getByText('Idle')).toBeVisible({ timeout: 60_000 })

    // M6: feed +10 % and rapids 50 % in the inspector, as GRBL reports them (Ov)
    const overrides = inspector.getByRole('region', { name: 'Overrides' })
    const feed = overrides.getByRole('group', { name: 'Feed' })
    await feed.getByRole('button', { name: 'Increase feed override by 10 %' }).click()
    await expect(feed.getByText('110 %')).toBeVisible()
    // DF85: the slider, 1 % per arrow key, read back from the controller
    const feedSlider = feed.getByRole('slider', { name: 'Feed override' })
    await feedSlider.focus()
    await feedSlider.press('ArrowRight')
    await feedSlider.press('ArrowRight')
    await expect(feedSlider).toHaveAttribute('aria-valuenow', '112')
    await expect(feed.getByText('112 %')).toBeVisible()
    await expect(
      overrides.getByText('Overrides apply until reset or the program ends.'),
    ).toBeVisible()
    await overrides.getByRole('radio', { name: '50 %' }).click()
    await expect(overrides.getByRole('radio', { name: '50 %' })).toBeChecked()
    await overrides.scrollIntoViewIfNeeded()
    await render(page, 'm6-overrides')
    await feed.getByRole('button', { name: 'Reset feed override to 100 %' }).click()
    await overrides.getByRole('radio', { name: '100 %' }).click()
    await expect(feed.getByText('100 %', { exact: true }).first()).toBeVisible()

    // M4: the plate is 59 mm below the tool: a 25 mm probe misses (ALARM:5)
    await expect(navigator.getByText(/Touch plate 10\.000 mm/)).toBeVisible()
    await navigator.getByRole('button', { name: 'Probe Z' }).click()
    const confirm = page.getByRole('alertdialog', { name: 'Probe Z?' })
    await expect(confirm.getByText(/Plate thickness: 10\.000 mm/)).toBeVisible()
    await render(page, 'm4-probe-confirm')
    await confirm.getByRole('button', { name: 'Probe' }).click()
    const alarm = navigator.getByRole('region', { name: 'Alarm' })
    await expect(alarm.getByRole('heading', { name: 'Alarm 5: probe fail' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(alarm.getByText('Unlock and probe again.')).toBeVisible()
    await alarm.scrollIntoViewIfNeeded()
    await render(page, 'm4-probe-alarm')
    // still homed: a probe miss does not lose the position
    await expect(navigator.getByText('Homed', { exact: true })).toBeVisible()

    await navigator.getByRole('button', { name: 'Unlock' }).click()
    await page
      .getByRole('alertdialog', { name: 'Unlock without homing?' })
      .getByRole('button', { name: 'Unlock' })
      .click()
    await expect(alarm).toBeHidden()
    await expect(machine.getByText('Idle')).toBeVisible()
    await expect(cell('Machine position Z')).toHaveText('-26.000')

    // jog 20 mm down: the plate is now 14 mm below the tool
    await navigator.getByRole('radio', { name: '10 mm' }).click()
    const jogZ = navigator.getByRole('button', { name: 'Jog Z−' })
    await jogZ.click()
    await expect(cell('Machine position Z')).toHaveText('-36.000')
    await jogZ.click()
    await expect(cell('Machine position Z')).toHaveText('-46.000')
    await navigator.getByRole('button', { name: 'Probe Z' }).click()
    await page
      .getByRole('alertdialog', { name: 'Probe Z?' })
      .getByRole('button', { name: 'Probe' })
      .click()
    // contact at MPos Z −60: Z0 is 10 mm (the plate) below, retracted 2 mm above the contact
    await expect(cell('Machine position Z')).toHaveText('-58.000', { timeout: 30_000 })
    await expect(cell('Work position Z')).toHaveText(/^12\.000/)
    await expect(navigator.getByText(/G54 .* · -70\.000 mm/)).toBeVisible()

    await navigator.getByRole('button', { name: 'Disconnect' }).click()
    await expect(navigator.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
    expect(rendererErrors).toEqual([])
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
