// Safe links in the real app (hardening DF64, L2): a faced block with two pockets for one end mill
// is built and planned through the bridge; then, through plan mode's UI only: the setup
// inspector's "Link time" once toolpaths exist, the clamp height entered (the links run low and
// the finding goes away) and the links switched to full. With DFYOM_RENDERS=1 light and dark
// review renders of the inspector go to design/features/renders/df64-setup-links-*.png.
// Windows stay hidden (fixture). Selectors are roles and accessible names.
// Docs: docs/conventions/ui.md#design-and-plan-controls-v02, docs/modes/safe-links.md#agent-api-and-settings
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, openInspectorGroup, test } from './app.fixture'

async function bridgeCall<T>(page: Page, name: string, args: object = {}): Promise<T> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

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

/** A 100 × 60 × 20 block: a top facing and two pockets on its floor, all for Flat 6. */
async function oneToolPlan(page: Page): Promise<void> {
  const call = <T>(name: string, args: object = {}) => bridgeCall<T>(page, name, args)
  const stock = await call<{ id: string }>('library.stock.add', {
    values: {
      name: 'Block',
      shape: 'block',
      length: '100',
      width: '60',
      thickness: '20',
      material: { name: '6061-T6', class: 'aluminum' },
    },
  })
  await call('library.tool.add', {
    values: {
      name: 'Flat 6',
      type: 'flatEndMill',
      diameter: '6',
      fluteLength: '20',
      overallLength: '50',
      fluteCount: '2',
      toolMaterial: 'carbide',
      presets: [
        {
          name: 'Alu',
          materialClass: 'aluminum',
          spindleSpeed: '18000',
          feedRate: '600',
          plungeRate: '150',
          stepdown: '0.5',
          stepover: '2.4',
        },
      ],
    },
  })
  const machine = await call<{ id: string }>('library.machine.add', {
    values: {
      name: 'Router',
      controller: 'grbl',
      travel: { x: '800', y: '800', z: '100' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'gcode', maxSpeed: '24000' },
      programUnits: 'mm',
      toolChanger: 'none',
    },
  })
  await call('project.create', { name: 'Links', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Links',
    stockLibraryItemId: stock.id,
  })
  await call('design.facing.add', { partId, on: 'stock.top', depth: '0.5' })
  for (const x of ['25', '75'])
    await call('design.pocket.add', {
      partId,
      on: 'facing1.floor',
      shape: { kind: 'circle', center: [x, '30'], diameter: '16' },
      depth: '2',
    })
  await call('project.apply', {})
  await call('plan.create', { partId, machineLibraryItemId: machine.id })
}

test('setup inspector: link time, clamp height and full retraction (DF64)', async ({ dfyom }) => {
  test.setTimeout(90_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 900 })
  await oneToolPlan(page)

  await page.getByRole('radio', { name: 'Plan' }).click()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const setups = navigator.getByRole('list', { name: 'Setups in machining order' })
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 30_000 })
  await setups.getByRole('button', { name: /^Top/ }).click({ position: { x: 24, y: 12 } })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()

  // the facing ends past the stock edge: only the pocket-to-pocket link runs low without clamps
  await expect(inspector.getByText(/^1 of 2 links low, .* saved\.$/)).toBeVisible()
  const checks = inspector.getByRole('region', { name: 'Setup checks' })
  await expect(checks.getByText(/Enter the clamp height to lower 1 link/)).toBeVisible()

  // S5: the clamp height and the links are in the closed "Links and heights" accordion
  await openInspectorGroup(inspector, 'Links and heights')
  const clamp = inspector.getByLabel('Clamp height', { exact: true })
  await clamp.fill('0')
  await clamp.press('Enter')
  await expect(inspector.getByText(/^2 of 2 links low, .* saved\.$/)).toBeVisible()
  await expect(inspector.getByText(/Enter the clamp height/)).toHaveCount(0)
  await render(page, 'df64-setup-links')

  await inspector
    .getByRole('radiogroup', { name: 'Links' })
    .getByRole('radio', { name: 'Full' })
    .click()
  await expect(
    inspector.getByText('Every link at the clearance height (full retraction).'),
  ).toBeVisible()
})
