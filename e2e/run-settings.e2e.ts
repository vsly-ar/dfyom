// Run's "Machine settings" (v0.5 RV2) in the real app on the virtual machine (no hardware): the
// collapsed group edits the library machine (Save), and the controller's $$ shows read-only with
// names, units and a line to copy where the machine differs. Windows stay hidden (fixture). With
// DFYOM_SHOTS=<dir>: rv2-settings-light.png there. Doc: docs/conventions/ui.md#run-settings-v05-rv2
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const SHOTS = process.env['DFYOM_SHOTS']

// the virtual machine reports GRBL's defaults with this machine's travel and rates ($110 = 5000);
// X travel 790 here differs from the controller's 800
const ROUTER = {
  name: 'Router',
  controller: 'grbl',
  travel: { x: '800', y: '600', z: '100' },
  maxFeedRate: { x: '5000', y: '5000', z: '1000' },
  spindle: { control: 'gcode', minSpeed: '6200', maxSpeed: '24000' },
  programUnits: 'mm',
  toolChanger: 'none',
  homingCorner: 'backRight',
  pullOff: '1',
  softLimits: true,
  probePlateThickness: '10',
}

async function call(page: Page, name: string, args: object = {}): Promise<CallReply> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  return page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
}

test('RV2: Machine settings saves the library machine and shows the controller $$', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (SHOTS !== undefined) await page.setViewportSize({ width: 1280, height: 1100 })
  const added = await call(page, 'library.machine.add', { values: ROUTER })
  expect(added.ok, JSON.stringify(added)).toBe(true)
  const id = (added as { value: { id: string } }).value.id

  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await navigator.getByRole('button', { name: 'Go to Run' }).click()
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Machine' })).toBeVisible()

  // collapsed until opened
  const toggle = inspector.getByRole('button', { name: 'Machine settings' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  const group = inspector.getByRole('region', { name: 'Machine settings' })
  // an edit is a draft until saved: the library machine gets it
  const travelX = group.getByRole('combobox', { name: 'Travel X' })
  await travelX.fill('790')
  await travelX.press('Enter')
  await expect(group.getByText('Unsaved')).toBeVisible()
  await group.getByRole('button', { name: 'Save' }).click()
  await expect(group.getByText('Unsaved')).toHaveCount(0)
  const got = (await call(page, 'library.machine.get', { id })) as {
    ok: boolean
    value: { travel: { x: { source: string } } }
  }
  expect(got.ok).toBe(true)
  expect(got.value.travel.x.source).toBe('790')

  // the controller's $$: names, units, the difference and its line to copy
  const table = group.getByRole('table', { name: 'Controller settings' })
  await expect(table.getByRole('rowheader', { name: /\$110 X max rate/ })).toBeVisible()
  await expect(table.getByRole('rowheader', { name: /\$22 Homing cycle enable/ })).toBeVisible()
  const x = table.getByRole('row', { name: /\$130/ })
  await expect(x).toHaveAttribute('data-differs', '')
  await expect(x.getByRole('button', { name: 'Copy $130=790' })).toBeVisible()
  await expect(table.getByRole('row', { name: /\$110/ })).not.toHaveAttribute('data-differs', '')

  if (SHOTS !== undefined) {
    await page.evaluate(() => {
      ;(
        globalThis as unknown as {
          document: { documentElement: { dataset: Record<string, string> } }
        }
      ).document.documentElement.dataset['theme'] = 'light'
    })
    await x.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/rv2-settings-light.png` })
    await group.getByRole('heading', { name: 'Probe' }).scrollIntoViewIfNeeded()
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${SHOTS}/rv2-settings-fields-light.png` })
  }

  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  expect(dfyom.rendererErrors).toEqual([])
})
