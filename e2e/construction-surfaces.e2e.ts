// DF118 V3 (user TG #369) in the built app: the user's clamps_40 without the rim (Chamfer 1 at
// 3.2 mm cuts the "Pocket for M5" floor away; the recess sits in the middle of the stock here, so
// it is under the viewport's centre from below). The slot's On field shows "Cut away by Chamfer 1"
// and the viewport draws the floor as a dashed outline; in pick mode the outline takes a click,
// which sets another operation's On to the cut-away floor. Follow-ups: Chamfer 1 (an edge chamfer,
// no On field) shows the note at its Edge field, and highlighting the floor in Spot's On list
// draws its outline. Windows stay hidden (fixture). With DFYOM_RENDERS=1 it writes
// construction-{note,edge,hover,pick}-{light,dark}.png to DFYOM_RENDERS_DIR (default
// design/features/renders).
// Docs: docs/modes/construction-surfaces.md#ui, docs/conventions/ui.md#construction-surfaces-df118
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir =
  process.env['DFYOM_RENDERS_DIR'] ?? resolve(__dirname, '../design/features/renders')

async function render(
  page: Page,
  name: string,
  before: () => Promise<void>,
  after?: () => Promise<void>,
): Promise<void> {
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
    await after?.()
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

test('construction surfaces: the cut-away floor is noted at On, outlined and pickable (DF118)', async ({
  dfyom,
}) => {
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const stock = await bridgeCall<{ id: string }>(page, 'library.stock.add', {
    values: {
      name: 'Aluminium',
      shape: 'block',
      length: '80',
      width: '40.35',
      thickness: '10.11',
      material: { name: '6061-T6', class: 'aluminum' },
    },
  })
  await bridgeCall(page, 'project.create', { name: 'clamps_40', unitSystem: 'mm' })
  const { partId } = await bridgeCall<{ partId: string }>(page, 'design.part.add', {
    name: 'Clamp',
    stockLibraryItemId: stock.id,
  })
  await bridgeCall(page, 'design.facing.add', { partId, name: 'Facing top', depth: '0.3' })
  await bridgeCall(page, 'design.facing.add', {
    partId,
    name: 'Facing bottom',
    on: 'stock.bottom',
    depth: '0.3',
  })
  const rect = (length: string, width: string, cornerRadius: string) => ({
    kind: 'rectangle',
    center: ['40', '20.175'],
    length,
    width,
    cornerRadius,
  })
  await bridgeCall(page, 'design.pocket.add', {
    partId,
    name: 'Pocket for M5',
    on: 'facing2.floor',
    shape: rect('11.3', '31', '5.6'),
    depth: '2',
  })
  await bridgeCall(page, 'design.pocket.add', {
    partId,
    name: 'M5 long hole',
    on: 'pocket1.floor',
    shape: rect('5.5', '25', '2.5'),
    depth: '7.8',
  })
  // the user's chamfer was 5.7/2 (a 0.05 mm rim); 3.2 mm leaves no rim
  await bridgeCall(page, 'design.chamfer.add', {
    partId,
    edgeOf: 'pocket2',
    on: 'pocket1.floor',
    width: '3.2',
    angle: '90',
  })
  await bridgeCall(page, 'design.drilling.add', {
    partId,
    name: 'Spot',
    on: 'facing2.floor',
    center: ['70', '8'],
    diameter: '3',
    bottom: 'flat',
    depth: '1',
  })

  const viewport = page.getByRole('region', { name: '3D viewport' })
  // the evaluation is in (no "updating") and raised no cut-away warning
  await expect(viewport).toHaveAccessibleDescription(/Part with 6 operations(, \d+ warnings?)?\./)
  const warnings = await bridgeCall<{
    warnings: { code: string }[]
    construction: { surface: string; consumedBy: string[] }[]
  }>(page, 'design.warning.list', { partId })
  expect(warnings.warnings.map((w) => w.code)).not.toContain('dfm.surfaceCutAway')
  expect(warnings.construction).toEqual([
    expect.objectContaining({ surface: 'pocket1.floor', consumedBy: ['pocket2', 'chamfer1'] }),
  ])

  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  const select = async (name: string) => {
    await page
      .getByRole('navigation', { name: 'Navigator' })
      .getByRole('button', { name: new RegExp(`^${name}`) })
      .click()
    await expect(inspector.getByRole('heading', { name })).toBeVisible()
  }
  await select('M5 long hole')
  await expect(
    inspector.getByText('Cut away by Chamfer 1 · still measured from its level'),
  ).toBeVisible()
  await expect(viewport).toHaveAccessibleDescription(
    /Pocket for M5 floor, cut away by M5 long hole and Chamfer 1, shown as an outline\./,
  )
  // from below, into the recess
  await viewport.focus()
  await page.keyboard.press('Shift+Digit1')
  await expect(viewport).toHaveAccessibleDescription(/View: Bottom\./)
  const box = (await viewport.boundingBox())!
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await render(page, 'construction-note', async () => {
    await expect(inspector.getByRole('heading', { name: 'M5 long hole' })).toBeVisible()
    await page.mouse.move(box.x + 20, box.y + box.height - 20)
  })

  // the edge chamfer has no On field: the note sits at its Edge field and names the face
  await select('Chamfer 1')
  await expect(
    inspector.getByText(
      'Pocket for M5 floor is cut away by M5 long hole · still measured from its level',
    ),
  ).toBeVisible()
  await render(page, 'construction-edge', async () => {
    await expect(inspector.getByRole('heading', { name: 'Chamfer 1' })).toBeVisible()
    await page.mouse.move(box.x + 20, box.y + box.height - 20)
  })

  // highlighting the floor in Spot's On list draws its outline; closing the list drops it
  await select('Spot')
  const outlined =
    /Pocket for M5 floor, cut away by M5 long hole and Chamfer 1, shown as an outline\./
  await expect(viewport).not.toHaveAccessibleDescription(outlined)
  const hoverFloor = async () => {
    await inspector.getByRole('combobox', { name: /^On/ }).click()
    await page.getByRole('option', { name: 'Pocket for M5 floor (construction)' }).hover()
  }
  await hoverFloor()
  await expect(viewport).toHaveAccessibleDescription(outlined)
  const closeList = async () => {
    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox')).toHaveCount(0)
  }
  await closeList()
  await expect(viewport).not.toHaveAccessibleDescription(outlined)
  await render(page, 'construction-hover', hoverFloor, closeList)

  // pick mode offers the cut-away floor: a click on its outline sets Spot's On
  const pickOn = inspector.getByRole('button', { name: 'Pick the surface in the viewport' })
  await pickOn.click()
  await expect(viewport.getByRole('status')).toHaveText('Pick a surface for On · Esc to cancel')
  await render(page, 'construction-pick', async () => {
    if ((await pickOn.getAttribute('aria-pressed')) !== 'true') await pickOn.click()
    await page.mouse.move(centre.x, centre.y)
  })
  if ((await pickOn.getAttribute('aria-pressed')) !== 'true') await pickOn.click()
  // the camera settles before a click lands on the outline (a miss picks nothing)
  await expect(async () => {
    await page.mouse.click(centre.x, centre.y)
    const { operations } = await bridgeCall<{ operations: { name: string; on?: string }[] }>(
      page,
      'design.operation.list',
      { partId },
    )
    expect(operations.find((o) => o.name === 'Spot')?.on).toBe('pocket1.floor')
  }).toPass({ timeout: 10_000 })
  await expect(viewport.getByRole('status')).toHaveCount(0)
})
