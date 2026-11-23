// Face selection and the 3D measure in the real app (dogfood DF19–DF22): the canvas only takes
// clicks in the built app. A part is created through the bridge, the view set to Top; a click on
// the stock top selects that face ("Face: Stock top"), and "Add drilling here" creates the drilling
// on it. Then the main toolbar's Measure: two clicks measure, a third only clears, Escape clears
// the points before it ends the tool. Windows stay hidden (fixture). With DFYOM_RENDERS=1 it writes
// the review renders df22-face-{light,dark}.png (the selected face, the translucent view cube with
// its toolbar to the right, Measure in the main toolbar) and df20-measure-axis-{light,dark}.png.
// Docs: docs/conventions/ui.md#selection-and-picking, #snap-and-measure
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

/** With DFYOM_RENDERS=1: light and dark; `before` restores what the Settings dialog changed. */
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

test('face selection: a click on the stock top selects it, Add puts a drilling there', async ({
  dfyom,
}) => {
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
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
  await bridgeCall(page, 'project.create', { name: 'Faces', unitSystem: 'mm' })
  const { partId } = await bridgeCall<{ partId: string }>(page, 'design.part.add', {
    name: 'Faces',
    stockLibraryItemId: stock.id,
  })

  const viewport = page.getByRole('region', { name: '3D viewport' })
  await expect(viewport).toHaveAccessibleDescription(/Part with/)
  await viewport.focus()
  await page.keyboard.press('1')
  await expect(viewport).toHaveAccessibleDescription(/View: Top\./)
  const box = (await viewport.boundingBox())!
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  // the camera settles before the click lands on the top
  await expect(async () => {
    await page.mouse.click(centre.x, centre.y)
    await expect(viewport).toHaveAccessibleDescription(/Selected face: Stock top/, {
      timeout: 1000,
    })
  }).toPass({ timeout: 10_000 })

  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  await expect(inspector.getByRole('heading', { name: 'Face: Stock top' })).toBeVisible()
  await expect(inspector.getByText(/Facing up \(\+Z\)/)).toBeVisible()
  await render(page, 'df22-face', async () => {
    await page.mouse.click(centre.x, centre.y)
    await expect(inspector.getByRole('heading', { name: 'Face: Stock top' })).toBeVisible()
    await page.mouse.move(box.x + 20, box.y + box.height - 20)
  })
  await inspector.getByRole('button', { name: 'Add drilling here' }).click()
  await expect(inspector.getByRole('heading', { name: 'Drilling 1' })).toBeVisible()
  const { operations } = await bridgeCall<{ operations: { on?: string }[] }>(
    page,
    'design.operation.list',
    { partId },
  )
  expect(operations.at(-1)?.on).toBe('stock.top')

  // Measure from the main toolbar (DF19): two points, a third click only clears (DF21)
  const measure = page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', {
    name: /Measure/,
  })
  await measure.click()
  await expect(measure).toHaveAttribute('aria-pressed', 'true')
  const status = viewport.getByRole('status')
  await expect(status).toHaveText(/Click two points/)
  await page.mouse.click(centre.x - 40, centre.y)
  await expect(status).toHaveText(/Click the second point/)
  await page.mouse.click(centre.x + 40, centre.y)
  await expect(page.getByTestId('measure-chip')).toBeVisible()
  await expect(status).toHaveText(/Click or press Esc to clear/)
  await page.mouse.click(centre.x, centre.y + 10)
  await expect(page.getByTestId('measure-chip')).toHaveCount(0)
  await expect(status).toHaveText(/Click two points/)
  // Escape: clears the point first, then ends the tool
  await page.mouse.click(centre.x - 40, centre.y)
  await expect(status).toHaveText(/Click the second point/)
  await page.keyboard.press('Escape')
  await expect(status).toHaveText(/Click two points/)
  await page.keyboard.press('Escape')
  await expect(measure).toHaveAttribute('aria-pressed', 'false')

  // the axis lock (DF20): Shift after the first point, the dashed guide along X
  await render(page, 'df20-measure-axis', async () => {
    await page.keyboard.up('Shift')
    if ((await measure.getAttribute('aria-pressed')) !== 'true') await measure.click()
    await page.mouse.click(centre.x - 40, centre.y)
    await page.mouse.move(centre.x + 30, centre.y + 6)
    await page.keyboard.down('Shift')
    await page.mouse.move(centre.x + 40, centre.y + 8)
    await expect(status).toHaveText(/Along X/)
  })
  await page.keyboard.up('Shift')
})
