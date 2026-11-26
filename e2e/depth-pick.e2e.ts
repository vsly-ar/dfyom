// DF115 (user TG #369) in the built app: a Depth pick in the viewport takes the surface the cut
// goes down to. A pocket on the top facing picks, from the Top view, the floor of a deeper pocket
// in the middle of the stock: the field's value is replaced by the formula from its own `on`
// ("facing1.floor.z - pocket1.floor.z", not "5 mmpocket1.floor.z"), and Enter applies 3 mm.
// Windows stay hidden (fixture).
// Docs: docs/conventions/ui.md#depth-pick-df115, #selection-and-picking
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

async function bridgeCall<T>(page: Page, name: string, args: object = {}): Promise<T> {
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

test('depth pick: the picked floor becomes a depth formula that replaces the value (DF115)', async ({
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
  await bridgeCall(page, 'project.create', { name: 'Depth pick', unitSystem: 'mm' })
  const { partId } = await bridgeCall<{ partId: string }>(page, 'design.part.add', {
    name: 'Depth pick',
    stockLibraryItemId: stock.id,
  })
  await bridgeCall(page, 'design.facing.add', { partId, depth: '0.5' })
  const square = (x: string, y: string, size: string) => ({
    kind: 'rectangle',
    center: [x, y],
    length: size,
    width: size,
  })
  // the deeper pocket fills the middle of the Top view; the edited one sits in a corner
  await bridgeCall(page, 'design.pocket.add', {
    partId,
    on: 'facing1.floor',
    shape: square('50', '30', '40'),
    depth: '3',
  })
  await bridgeCall(page, 'design.pocket.add', {
    partId,
    on: 'facing1.floor',
    shape: square('10', '10', '8'),
    depth: '5',
  })

  const viewport = page.getByRole('region', { name: '3D viewport' })
  await expect(viewport).toHaveAccessibleDescription(/Part with/)
  await page
    .getByRole('navigation', { name: 'Navigator' })
    .getByRole('button', { name: /^Pocket 2/ })
    .click()
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 2' })).toBeVisible()

  await viewport.focus()
  await page.keyboard.press('1')
  await expect(viewport).toHaveAccessibleDescription(/View: Top\./)

  const depth = inspector.getByLabel('Depth', { exact: true }).and(inspector.locator('input'))
  await depth.click()
  await page.getByRole('button', { name: 'Pick Depth in the viewport' }).click()
  await expect(viewport.getByRole('status')).toHaveText(
    'Pick a surface for Depth (cut down to it) · Esc to cancel',
  )
  const box = (await viewport.boundingBox())!
  // the camera settles before a click lands on the floor (a miss picks nothing)
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(depth).toHaveValue('facing1.floor.z - pocket1.floor.z', { timeout: 1000 })
  }).toPass({ timeout: 10_000 })
  await expect(depth).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(async () => {
    const { operations } = await bridgeCall<{
      operations: { id: string; depth?: { source: string; exact: { num: string; den: string } } }[]
    }>(page, 'design.operation.list', { partId })
    expect(operations.find((o) => o.id === 'pocket2')?.depth).toMatchObject({
      source: 'facing1.floor.z - pocket1.floor.z',
      exact: { num: '3', den: '1' },
    })
  }).toPass({ timeout: 10_000 })
})
