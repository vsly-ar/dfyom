// v0.2 operation tool field in the built app (task F5), through roles and labels: a new pocket
// has no tool until Apply; Apply chooses one ("Chosen automatically."); a corner edit committed
// with Tab waits ("Chosen again on Apply.", its checks "May change on Apply"); the Apply button
// swaps the tool and says why; the lock pins it as one undo step. Windows stay hidden
// (app.fixture.ts). Docs: docs/modes/design-v0.2.md#operation-tool,
// docs/conventions/ui.md#design-and-plan-controls-v02
import { resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const input = (scope: Locator, label: string) =>
  scope.getByLabel(label, { exact: true }).and(scope.locator('input'))

async function setField(scope: Locator, label: string, value: string): Promise<void> {
  const field = input(scope, label)
  await field.fill(value)
  await field.press('Enter')
  await field.blur()
}

test('tool field: auto choice on Apply with its reason, chosen again on Apply, lock', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Tools')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '100')
  await setField(setup, 'Width (Y)', '60')
  await setField(setup, 'Thickness (Z)', '20')
  await page
    .getByRole('dialog', { name: 'Stock' })
    .getByRole('button', { name: 'Create part' })
    .click()

  await navigator.getByRole('button', { name: 'Add pocket' }).click()
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()
  const tool = inspector.getByRole('region', { name: 'Tool' })
  const combo = tool.getByRole('combobox', { name: 'Tool' })
  const lock = tool.getByRole('button', { name: 'Lock tool' })
  // added, not applied yet: no tool, the lock has nothing to pin
  await expect(combo).toHaveText('No tool yet')
  await expect(lock).toHaveAttribute('aria-disabled', 'true')

  // Cmd/Ctrl+Enter applies: the largest standard size that fits the 3 mm corner
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(combo).toHaveText('6 mm flat end mill')
  await expect(tool.getByText('Chosen automatically.', { exact: true })).toBeVisible()
  await expect(lock).toHaveAttribute('aria-pressed', 'false')

  // Enter applies: the 2 mm corner needs a smaller tool, and the field says why
  await setField(inspector, 'Corner radius', '2')
  await expect(combo).toHaveText('4 mm flat end mill')
  await expect(
    tool.getByText('Chosen automatically: the 6 mm flat end mill didn’t fit the 2 mm corner.'),
  ).toBeVisible()

  // Tab commits only: the tool is chosen again on Apply, its check may change
  const corner = input(inspector, 'Corner radius')
  await corner.fill('1.5')
  await corner.press('Tab')
  await expect(tool.getByText('Chosen again on Apply.')).toBeVisible()
  await expect(combo).toHaveAttribute('data-muted', 'true')
  await expect(
    tool.getByText(/^Corner radius 1.5 mm is smaller.*May change on Apply/),
  ).toBeVisible()
  await page.getByRole('button', { name: /^Apply \d+ changes?$/ }).click()
  await expect(combo).toHaveText('3 mm flat end mill')
  await expect(
    tool.getByText('Chosen automatically: the 4 mm flat end mill didn’t fit the 1.5 mm corner.'),
  ).toBeVisible()

  // the lock pins the tool (one undo step); the generalized option is listed with its note
  await lock.click()
  await expect(lock).toHaveAttribute('aria-pressed', 'true')
  await expect(tool.getByText('Chosen by you.')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(lock).toHaveAttribute('aria-pressed', 'false')
  await combo.click()
  const list = page.getByRole('listbox')
  // the generalized tool, then "New tool…" (no library tool fits)
  await expect(list.getByRole('group')).toHaveCount(2)
  await expect(list.getByRole('option', { name: /^New tool/ })).toBeVisible()
  await expect(
    list.getByRole('option', { name: '3 mm flat end mill' }),
  ).toHaveAccessibleDescription('Type and size only: Plan uses a matching library tool.')
  await page.keyboard.press('Escape')

  expect(dfyom.rendererErrors).toEqual([])
})

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

/** With DFYOM_RENDERS=1: light and dark; `before` restores what the Settings dialog closed. */
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

// DF42: every library tool of the type is listed (with why it doesn't fit); the near match is
// offered beside "Add to library"; a locked tool wider than the slot offers "Widen slot to …".
// With DFYOM_RENDERS=1: df42-near-match-{light,dark}.png and df42-library-list-{light,dark}.png.
test('tool field: library tools of the type, the near match, widen the slot (DF42)', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Lid')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const setup = page.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '100')
  await setField(setup, 'Width (Y)', '60')
  await setField(setup, 'Thickness (Z)', '20')
  await setup.getByRole('button', { name: 'Create part' }).click()
  const added = await page.evaluate(
    (values) =>
      (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call('library.tool.add', { values }),
    {
      name: 'wexme 1/4" 1F',
      type: 'flatEndMill',
      diameter: '6.22',
      fluteLength: '20',
      overallLength: '50',
      stickout: '30.9',
      shankDiameter: '6.35',
      fluteCount: '1',
    },
  )
  expect(added.ok).toBe(true)

  await navigator.getByRole('button', { name: 'Add profile' }).click()
  await expect(inspector.getByRole('heading', { name: 'Profile 1' })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Enter')
  const tool = inspector.getByRole('region', { name: 'Tool' })
  const combo = tool.getByRole('combobox', { name: 'Tool' })
  // the default 6 mm slot: the 6.22 mm tool is wider, so auto takes the generalized 6 mm
  await expect(combo).toHaveText('6 mm flat end mill')
  const use = tool.getByRole('button', { name: 'Use wexme 1/4" 1F (6.22 mm)' })
  await expect(use).toBeVisible()
  await expect(tool.getByRole('button', { name: 'Add to library' })).toBeVisible()
  await tool.scrollIntoViewIfNeeded()
  await render(page, 'df42-near-match', async () => {})

  await combo.click()
  const list = page.getByRole('listbox')
  const option = list.getByRole('option', { name: /^wexme 1\/4" 1F · Ø 6.22 mm/ })
  await expect(option).toHaveAccessibleDescription(
    '1 flute · Doesn’t fit: wider than the 6 mm slot',
  )
  await render(page, 'df42-library-list', async () => {
    if (!(await list.isVisible())) await combo.click()
    await expect(option).toBeVisible()
  })
  await page.keyboard.press('Escape')
  await expect(list).toBeHidden()

  // using it locks it; it is wider than the slot, so widening the slot is offered
  await use.click()
  await expect(combo).toHaveText(/^wexme 1\/4" 1F · Ø 6.22 mm/)
  await expect(tool.getByRole('button', { name: 'Lock tool' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await tool.getByRole('button', { name: 'Widen slot to 6.22 mm' }).click()
  await expect(input(inspector, 'Slot width')).toHaveValue('6.22 mm')
  await expect(tool.getByText(/is wider than the slot/)).toBeHidden()

  expect(dfyom.rendererErrors).toEqual([])
})
