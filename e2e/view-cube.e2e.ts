// The view cube in the real app (v0.3 task L2, B25): drawn in the viewport's one canvas, so only
// the built app shows that its regions take clicks. A part is created through the bridge; then the
// view keys, a click on an edge strip of the cube, the Views menu, a click on the face already in
// view and a drag on the cube, each read back from the viewport's text summary ("View: Front").
// Windows stay hidden (fixture). Docs: docs/conventions/ui-view-cube.md
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

/** ui-view-cube.md: the cube's square is 88 px, 8 px from the viewport's top and right. */
const BOX = 88
const MARGIN = 8
/** Half the cube's edge in px (CUBE_HALF_EDGE_PX) and the chamfer (18 % of the edge). */
const HALF = 28
const FACE = HALF * (1 - 0.36)

test('view cube: keys, a click on an edge, the Views menu, a drag', async ({ dfyom }) => {
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
  await bridgeCall(page, 'project.create', { name: 'Cube', unitSystem: 'mm' })
  await bridgeCall(page, 'design.part.add', { name: 'Cube', stockLibraryItemId: stock.id })

  const viewport = page.getByRole('region', { name: '3D viewport' })
  await expect(viewport).toHaveAccessibleDescription(/Part with/)
  const box = (await viewport.boundingBox())!
  const cx = box.x + box.width - MARGIN - BOX / 2
  const cy = box.y + MARGIN + BOX / 2

  // the toolbar under the cube keeps Fit and adds Views (and Measure, U3); no Top/Front/Right/Iso
  const toolbar = viewport.getByRole('toolbar', { name: 'View' })
  await expect(toolbar.getByRole('button')).toHaveText(['', '', ''])
  await expect(toolbar.getByRole('button', { name: 'Fit' })).toBeVisible()

  await viewport.focus()
  await page.keyboard.press('2')
  await expect(viewport).toHaveAccessibleDescription(/View: Front\./)

  // seen from the front, the strip above the front face is the top front edge
  await page.mouse.click(cx, cy - (FACE + HALF) / 2)
  await expect(viewport).toHaveAccessibleDescription(/View: Top front edge\./)

  // Shift+1 by the physical key: Bottom
  await viewport.focus()
  await page.keyboard.press('Shift+Digit1')
  await expect(viewport).toHaveAccessibleDescription(/View: Bottom\./)

  // the Views menu: every named view
  await toolbar.getByRole('button', { name: 'Views' }).click()
  const menu = page.getByRole('menu', { name: 'Views' })
  await expect(menu.getByRole('menuitem')).toHaveText([
    /^Top/,
    /^Front/,
    /^Right/,
    /^Isometric/,
    /^Bottom/,
    /^Back/,
    /^Left/,
  ])
  await menu.getByRole('menuitem', { name: /^Right/ }).click()
  await expect(viewport).toHaveAccessibleDescription(/View: Right\./)

  // a click on the face in view keeps it; a drag on the cube orbits
  await page.mouse.click(cx, cy)
  await expect(viewport).toHaveAccessibleDescription(/View: Right\./)
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx - 30, cy + 10, { steps: 5 })
  await page.mouse.up()
  await expect(viewport).toHaveAccessibleDescription(/View: custom\./)
})
