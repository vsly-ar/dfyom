// Clone groups in Plan (hardening DF146) in the built app: a 10 mm hole cloned to four positions
// (built and planned through the bridge) shows as one plan row "… drill × 4"; its chevron lists
// the four instances (read-only); choosing the 6 mm end mill once in the group's inspector
// changes every instance: one plan operation with the new tool, and its generated toolpath bores
// all four positions as helices (arcs). Windows stay hidden (app.fixture.ts). Selectors are roles
// and accessible names.
// Docs: docs/modes/features.md#clone-groups-in-plan-hardening-df146, docs/conventions/testing.md#end-to-end
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

async function bridgeCall<T>(page: Page, name: string, args: object = {}): Promise<T> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

interface PlanOp {
  id: string
  tool?: string
  designOperationIds: string[]
}
interface Plan {
  id: string
  setups: { operations: PlanOp[] }[]
  snapshots: { id: string; values: { name?: string } }[]
}

/** Library items, a part with a 10 mm hole and a Clones of it (4 positions), and its plan. */
async function clonedHolePlan(page: Page): Promise<string> {
  const call = <T>(name: string, args: object = {}) => bridgeCall<T>(page, name, args)
  const stock = await call<{ id: string }>('library.stock.add', {
    values: {
      name: 'Plate',
      shape: 'block',
      length: '100',
      width: '100',
      thickness: '10',
      material: { name: '6061-T6', class: 'aluminum' },
    },
  })
  await call('library.tool.add', {
    values: {
      name: 'Drill 10',
      type: 'drill',
      diameter: '10',
      fluteLength: '40',
      overallLength: '80',
      fluteCount: '2',
      pointAngle: '118',
      presets: [],
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
          name: 'Alu finish',
          materialClass: 'aluminum',
          spindleSpeed: '18000',
          feedRate: '800',
          plungeRate: '200',
          stepdown: '1',
          stepover: '3',
        },
      ],
    },
  })
  const machine = await call<{ id: string }>('library.machine.add', {
    values: {
      name: 'Shapeoko',
      controller: 'grbl',
      travel: { x: '800', y: '800', z: '100' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'manual', maxSpeed: '30000' },
      programUnits: 'mm',
      toolChanger: 'none',
    },
  })
  await call('project.create', { name: 'Plate', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Plate',
    stockLibraryItemId: stock.id,
  })
  await call('design.hole.add', { partId, center: ['20', '20'], diameter: '10' })
  await call('design.clones.add', {
    partId,
    source: { featureId: 'hole1' },
    rows: [{ kind: 'offset', count: 3, du: '20', dv: '0' }],
  })
  const { planId } = await call<{ planId: string }>('plan.create', {
    partId,
    machineLibraryItemId: machine.id,
  })
  return planId
}

test('clone groups: one plan row × 4, one tool change reaches every instance', async ({
  dfyom,
}) => {
  test.setTimeout(90_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const planId = await clonedHolePlan(page)
  const plan = () => bridgeCall<{ plan: Plan }>(page, 'plan.get', { planId }).then((r) => r.plan)
  const before = await plan()
  expect(before.setups.flatMap((s) => s.operations)).toHaveLength(1)

  await page.getByRole('radio', { name: 'Plan' }).click()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const ops = navigator.getByRole('list', { name: 'Plan operations in machining order' })
  const row = ops.getByRole('button', { name: /drill\s*× 4/ })
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('aria-expanded', 'false')

  // the chevron shows the four instances, read-only
  await row.getByTitle(/^Show the instances of /).click()
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  const instances = navigator.getByRole('list', { name: /^Instances of / }).getByRole('button')
  await expect(instances).toHaveCount(4)
  await expect(instances.nth(0)).toHaveText('Instance 1')
  await expect(instances.nth(3)).toHaveText('Instance 4')

  // choosing an instance selects its group: one tool change in its inspector; DF146: the chosen
  // instance is current (its position drawn selected in the viewport while the group is selected)
  await instances.nth(2).click()
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await expect(instances.nth(2)).toHaveAttribute('aria-current', 'true')
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  const toolGroup = inspector.getByRole('region', { name: 'Tool' })
  await toolGroup.getByRole('combobox', { name: 'Tool' }).click()
  await page.getByRole('option', { name: /^Flat 6 · / }).click()
  await expect(toolGroup.getByRole('combobox', { name: 'Tool' })).toHaveText(/Flat 6/)
  await expect(row).toContainText('Flat 6')

  // every instance follows: still one plan operation of the four, with the new tool
  const after = await plan()
  const [op, ...rest] = after.setups.flatMap((s) => s.operations)
  expect(rest).toHaveLength(0)
  expect(op!.designOperationIds).toHaveLength(4)
  expect(after.snapshots.find((t) => t.id === op!.tool)?.values.name).toBe('Flat 6')

  // and its toolpath bores all four positions as helices
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 30_000 })
  const { toolpath } = await bridgeCall<{
    toolpath: { passes: { operationId?: string; moves: { kind: string }[] }[] }
  }>(page, 'plan.toolpath.get', { planId, planOperationId: op!.id })
  for (const id of op!.designOperationIds) {
    const moves = toolpath.passes.filter((p) => p.operationId === id).flatMap((p) => p.moves)
    expect(
      moves.some((m) => m.kind === 'arc'),
      id,
    ).toBe(true)
  }
})
