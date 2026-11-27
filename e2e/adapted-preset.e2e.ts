// A recommended preset adapted down to the plan machine in the real app (hardening DF139 A3): a
// hardwood pocket with a Flat 6 whose preset follows the calculator, planned on a 500 W router with
// a 1000 mm/min Z max through the bridge; the operation inspector's feeds group then says what was
// lowered and why ("Adapted for X3 router: …"), and the plan has no power or plunge warning.
// Windows stay hidden (fixture). Selectors are roles and accessible names.
// Doc: docs/architecture/feeds-speeds.md#recommended-presets-on-the-plan-machine-hardening-df139
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

test('plan inspector: a recommended preset adapted to the plan machine (DF139)', async ({
  dfyom,
}) => {
  test.setTimeout(60_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const call = <T>(name: string, args: object = {}) => bridgeCall<T>(page, name, args)
  const stock = await call<{ id: string }>('library.stock.add', {
    values: {
      name: 'Maple block',
      shape: 'block',
      length: '100',
      width: '60',
      thickness: '20',
      material: { name: 'Hard maple', class: 'hardwood' },
    },
  })
  await call('library.tool.add', {
    values: {
      name: 'Flat 6',
      type: 'flatEndMill',
      diameter: '6',
      fluteLength: '25',
      overallLength: '60',
      fluteCount: '2',
      toolMaterial: 'carbide',
      presets: [
        {
          name: 'Hardwood',
          materialClass: 'hardwood',
          recommended: true,
          spindleSpeed: '1',
          feedRate: '1',
          plungeRate: '1',
        },
      ],
    },
  })
  const machine = await call<{ id: string }>('library.machine.add', {
    values: {
      name: 'X3 router',
      controller: 'grbl',
      travel: { x: '800', y: '800', z: '100' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'manual', minSpeed: '8000', maxSpeed: '24000', power: '500' },
      programUnits: 'mm',
      toolChanger: 'none',
    },
  })
  await call('project.create', { name: 'Adapted', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Adapted',
    stockLibraryItemId: stock.id,
  })
  await call('design.pocket.add', {
    partId,
    shape: {
      kind: 'rectangle',
      center: ['50', '30'],
      length: '40',
      width: '25',
      cornerRadius: '4',
    },
    depth: '4',
  })
  await call('project.apply', {})
  const { planId } = await call<{ planId: string }>('plan.create', {
    partId,
    machineLibraryItemId: machine.id,
  })
  const warnings = await call<{ warnings: { code: string; rule?: string }[] }>(
    'plan.warning.list',
    { planId },
  )
  expect(
    warnings.warnings.filter((w) => w.code === 'feeds.powerExceeded' || w.rule === 'maxFeedRate'),
  ).toEqual([])

  await page.getByRole('radio', { name: 'Plan' }).click()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  await navigator
    .getByRole('list', { name: /^Plan operations( of .*)? in machining order$/ })
    .getByRole('button', { name: /^Pocket 1/ })
    .click()
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  // S5: feeds and speeds sit in the operation's Feeds tab
  await inspector.getByRole('tab', { name: 'Feeds' }).click()
  const feeds = await openInspectorGroup(inspector, 'Feeds and speeds')
  const line = feeds.getByTestId('adapted-feeds')
  // 1.8 mm needs 0.34 kW of the 0.3 kW the spindle gives at 18 000 rpm; the plunge 1372 > 1000
  await expect(line).toHaveText(
    'Adapted for X3 router: plunge 1372 → 1000 mm/min (Z max feed) · stepdown 1.8 → 1.6 mm (spindle power)',
  )
  // the fields show the adapted values, still from the preset
  await expect(feeds.getByLabel('Stepdown', { exact: true })).toHaveValue('1.6 mm')
  expect(dfyom.rendererErrors).toEqual([])
})
