// DF120 R2 (user TG #369) in the built app: a pocket's length typed below twice its corner radius
// turns Round on (the switch, the read-only derived radius, the undo toast) and the 3D view follows
// the new outline. Windows stay hidden (fixture). With DFYOM_RENDERS=1 it writes
// round-corners-{light,dark}.png to DFYOM_RENDERS_DIR (default design/features/renders).
// Docs: docs/modes/hole-slots-and-round-corners.md#implementation-r2
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir =
  process.env['DFYOM_RENDERS_DIR'] ?? resolve(__dirname, '../design/features/renders')

async function render(page: Page, name: string, before: () => Promise<void>): Promise<void> {
  if (!RENDERS) return
  const settings = page.getByRole('dialog', { name: 'Settings' })
  for (const theme of ['light', 'dark'] as const) {
    await page.getByRole('button', { name: 'Settings' }).click()
    await settings.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await settings.getByRole('button', { name: 'Done' }).click()
    await expect(settings).toBeHidden()
    await before()
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

test('Round corners: a length below twice the radius turns Round on and the 3D view follows (DF120)', async ({
  dfyom,
}) => {
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
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
  await bridgeCall(page, 'project.create', { name: 'clamps_40', unitSystem: 'mm' })
  const { partId } = await bridgeCall<{ partId: string }>(page, 'design.part.add', {
    name: 'Clamp',
    stockLibraryItemId: stock.id,
  })
  await bridgeCall(page, 'design.pocket.add', {
    partId,
    name: 'M5 long hole',
    shape: {
      kind: 'rectangle',
      center: ['40', '20'],
      length: '25',
      width: '25',
      cornerRadius: '3',
    },
    depth: '4',
  })
  const viewport = page.getByRole('region', { name: '3D viewport' })
  await expect(viewport).toHaveAccessibleDescription(/Part with 1 operation/)
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  await page
    .getByRole('navigation', { name: 'Navigator' })
    .getByRole('button', { name: /^M5 long hole/ })
    .click()
  await expect(inspector.getByRole('heading', { name: 'M5 long hole' })).toBeVisible()
  const round = inspector.getByRole('switch', { name: 'Round' })
  await expect(round).not.toBeChecked()
  // let the part settle, then remember the view
  await page.waitForTimeout(500)
  const before = await viewport.screenshot()

  // the user's case: a 5.5 mm slot with R 3
  const input = (label: string) =>
    inspector.getByLabel(label, { exact: true }).and(inspector.locator('input'))
  const length = input('Length (X)')
  await length.fill('5.5')
  await length.press('Enter')
  await expect(round).toBeChecked()
  const radius = input('Corner radius')
  await expect(radius).toHaveValue('2.75 mm')
  await expect(radius).toHaveAttribute('readonly', '')
  await expect(
    page
      .getByTestId('viewport')
      .getByText('R 3 mm does not fit the new length (half is 2.75 mm): set to Round.'),
  ).toBeVisible()
  const { operations } = await bridgeCall<{
    operations: { shape: { round?: boolean; cornerRadius: { source: string } } }[]
  }>(page, 'design.operation.list', { partId })
  expect(operations[0]!.shape).toMatchObject({ round: true, cornerRadius: { source: '2.75 mm' } })
  if (RENDERS) {
    // the toast and the Corners group right after the edit (the theme the app opened in)
    await radius.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${rendersDir}/round-corners-toast.png` })
    // and in dark: the edit again from 25 (undo through the toast, then type it again)
    await page.getByRole('button', { name: 'Undo', exact: true }).last().click()
    await expect(round).not.toBeChecked()
    await page.getByRole('button', { name: 'Settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('radio', { name: 'Dark' }).click()
    await settings.getByRole('button', { name: 'Done' }).click()
    await length.fill('5.5')
    await length.press('Enter')
    await expect(round).toBeChecked()
    await radius.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${rendersDir}/round-corners-toast-dark.png` })
  }
  // the 3D view follows the narrowed pocket
  await expect(async () => {
    expect((await viewport.screenshot()).equals(before)).toBe(false)
  }).toPass({ timeout: 10_000 })
  await render(page, 'round-corners', async () => {
    await expect(round).toBeChecked()
    await radius.scrollIntoViewIfNeeded()
    await page.mouse.move(5, 5)
  })
})
