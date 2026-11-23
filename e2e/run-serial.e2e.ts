// A serial connection in the real app (hardening M1) over the loopback port the machine host
// offers with DFYOM_LOOPBACK_SERIAL=1 (a GRBL emulator behind a serial-like stream, no hardware):
// Connect to → Serial port, the port and baud selects, connect, the "Serial · path" chip, the
// settings check warning (the emulator's defaults differ from the library machine), and the
// confirmation before the first Home. Windows stay hidden (fixture). With DFYOM_RENDERS=1 it also
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
    await page.screenshot({ path: `${rendersDir}/m1-${name}-${theme}.png` })
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
    await bridgeCall(page, 'library.machine.add', {
      values: {
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
      },
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
    await render(page, 'serial-picker')

    await navigator.getByRole('button', { name: 'Connect to machine' }).click()
    await expect(machine.getByText(`Serial · ${PORT}`)).toBeVisible()
    const warning = navigator.getByRole('alert')
    await expect(warning).toContainText("The controller's settings differ from the library machine")
    await expect(warning).toContainText('$110 maxFeedRate.x')
    await expect(warning).toContainText('and 3 more')
    await expect(warning.getByRole('button', { name: 'Review' })).toBeVisible()
    await render(page, 'settings-warning')

    // a real machine not yet homed: Home asks first; cancelling sends nothing
    await navigator.getByRole('button', { name: 'Home' }).click()
    const confirm = page.getByRole('alertdialog', { name: 'Home the machine?' })
    await expect(confirm).toBeVisible()
    await render(page, 'home-confirm')
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirm).toBeHidden()

    await navigator.getByRole('button', { name: 'Disconnect' }).click()
    await expect(navigator.getByRole('button', { name: 'Connect to machine' })).toBeEnabled()
    expect(rendererErrors).toEqual([])
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
