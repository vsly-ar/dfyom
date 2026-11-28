// DF145 FR3 (user TG #492) in the built app: the user faces 22 mm from the front edge of a plate
// without a dummy pocket: Region Band, Width 22, and the 3D view draws the band. Windows stay
// hidden (fixture).
// Docs: docs/modes/design.md#facing-region-hardening-df145
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

test('Facing region: a 22 mm band along the front edge, from the inspector (DF145)', async ({
  dfyom,
}) => {
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const stock = await bridgeCall<{ id: string }>(page, 'library.stock.add', {
    values: {
      name: 'Plate',
      shape: 'block',
      length: '100',
      width: '60',
      thickness: '10',
      material: { name: '6061-T6', class: 'aluminum' },
    },
  })
  await bridgeCall(page, 'project.create', { name: 'band_22', unitSystem: 'mm' })
  const { partId } = await bridgeCall<{ partId: string }>(page, 'design.part.add', {
    name: 'Plate',
    stockLibraryItemId: stock.id,
  })
  await bridgeCall(page, 'design.facing.add', { partId, depth: '0.5' })
  const viewport = page.getByRole('region', { name: '3D viewport' })
  await expect(viewport).toHaveAccessibleDescription(/Part with 1 operation/)
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  await page
    .getByRole('navigation', { name: 'Navigator' })
    .getByRole('button', { name: /^Facing 1/ })
    .click()
  await expect(inspector.getByRole('heading', { name: 'Facing 1' })).toBeVisible()
  await expect(inspector.getByRole('radio', { name: 'Whole face' })).toBeChecked()
  await page.waitForTimeout(500)
  const before = await viewport.screenshot()

  await inspector.getByRole('radio', { name: 'Band' }).click()
  const width = inspector.getByLabel('Width', { exact: true }).and(inspector.locator('input'))
  await expect(width).toHaveValue('15 mm')
  await width.fill('22')
  await width.press('Enter')
  await expect(width).toHaveValue('22')
  await expect(inspector.getByRole('combobox', { name: 'From edge' })).toContainText('Front')
  const { operations } = await bridgeCall<{ operations: { region?: unknown }[] }>(
    page,
    'design.operation.list',
    { partId },
  )
  expect(operations[0]!.region).toMatchObject({
    band: { edge: 'front', width: { source: '22' } },
  })
  // the band's inner side and dashed open sides replace the whole face's outline
  await page.waitForTimeout(500)
  expect(Buffer.compare(await viewport.screenshot(), before)).not.toBe(0)
})
