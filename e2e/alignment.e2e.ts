// Alignment phase 1 exit (hardening DF78) in the real app: a two-sided part (library, project and
// plan through the bridge, the Top moved first); then through the UI only: the Top's setup
// inspector adds two registration holes and two witness marks for the Bottom, the Bottom's
// inspector lists them as its points and picks one more in the viewport; toolpaths; Run on the
// virtual machine at Max: the Top's run, the setup change with the points on the setup picture,
// the holes on the flip axis (Q106, drawn dashed), the prompt handing over to the docked alignment
// panel (Q107: zero first, Next wrapping, every point checked where the pointer is, a re-zero with
// the navigator's jog pad clearing the checks, confirm, back to the prompt) and the Bottom's run.
// With DFYOM_RENDERS=1 light and dark renders go to design/features/renders/df78-aids-*.png,
// df78-pick-*.png, df78-flip-axis-*.png, df78-align-panel-*.png. DF83: a registration hole's
// depth into the spoilboard, peck depth and tool are changed in its inspector and the Top's
// exported program follows each (renders df83-aid-hole-*.png, df83-aid-mark-*.png).
// Windows stay hidden (fixture). Selectors are roles and accessible names.
// Docs: docs/modes/alignment.md#implementation-slice-2, docs/conventions/testing.md#end-to-end
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

async function render(page: Page, name: string): Promise<void> {
  if (!RENDERS) return
  for (const theme of ['light', 'dark'] as const) {
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

interface PlanView {
  plan: {
    setups: {
      id: string
      name: string
      direction: string
      operations: { id: string; aid?: { kind: string } }[]
    }[]
  }
}

/** Library, a two-sided part with a through profile, its plan with the Top first and a base. */
async function twoSidedPlan(page: Page): Promise<string> {
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
          stepdown: '2',
          stepover: '3',
        },
      ],
    },
  })
  // a 6.2 mm drill for 6 mm dowels (the registration holes' default) and a 90° V-bit
  await call('library.tool.add', {
    values: {
      name: 'Drill 6.2',
      type: 'drill',
      diameter: '6.2',
      fluteLength: '40',
      overallLength: '80',
      fluteCount: '2',
      pointAngle: '118',
      presets: [],
    },
  })
  await call('library.tool.add', {
    values: {
      name: 'V-bit 90',
      type: 'chamferMill',
      diameter: '6',
      angle: '90',
      fluteLength: '8',
      overallLength: '50',
      fluteCount: '2',
      toolMaterial: 'carbide',
      presets: [],
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
  await call('project.create', { name: 'Two sides', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Two sides',
    stockLibraryItemId: stock.id,
  })
  await call('design.facing.add', { partId, depth: '0.5' })
  await call('design.pocket.add', {
    partId,
    shape: { kind: 'rectangle', center: ['50', '30'], length: '40', width: '25' },
    depth: '4',
  })
  await call('design.facing.add', { partId, on: 'stock.bottom', depth: '0.5' })
  await call('design.profile.add', {
    partId,
    shape: {
      kind: 'rectangle',
      center: ['50', '30'],
      length: '84',
      width: '44',
      cornerRadius: '5',
    },
    slotWidth: '6',
    tabs: { count: '4', width: '8', thickness: '3' },
  })
  const { planId } = await call<{ planId: string }>('plan.create', {
    partId,
    machineLibraryItemId: machine.id,
  })
  const { plan } = await call<PlanView>('plan.get', { planId })
  const top = plan.setups.find((s) => s.name === 'Top')!
  if (plan.setups[0]!.id !== top.id)
    await call('plan.setup.move', { planId, setupId: top.id, toIndex: 0 })
  await call('plan.workholding.set', {
    planId,
    setupId: top.id,
    items: [{ kind: 'base', type: 'spoilboard' }],
  })
  return planId
}

test('alignment phase 1: aids for the flipped setup, picking, the alignment step and both runs', async ({
  dfyom,
}) => {
  test.setTimeout(240_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1280, height: 900 })
  const planId = await twoSidedPlan(page)

  // ── Plan: the Top's inspector adds the aids for the Bottom ────────────────────────────────
  await page.getByRole('radio', { name: 'Plan' }).click()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const setups = navigator.getByRole('list', { name: 'Setups in machining order' })
  const top = setups.getByRole('button', { name: /^1\. Top/ })
  const bottom = setups.getByRole('button', { name: /^2\. Bottom/ })
  await top.click({ position: { x: 24, y: 12 } })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  const aids = inspector.getByRole('region', { name: 'Alignment aids' })
  await expect(aids.getByText(/so Bottom can line up on them/)).toBeVisible()
  await expect(aids.getByText(/go on the flip axis to Bottom/)).toBeVisible()
  await aids.getByRole('button', { name: 'Add registration holes' }).click()
  const topOps = navigator.getByRole('list', { name: 'Plan operations of Top in machining order' })
  await expect(topOps.getByText('Registration hole 2')).toBeVisible()
  // Q106: both holes on the flip axis (Y 30 of the 100 × 60 top), drawn dashed in the viewport
  const holes = (await bridgeCall<PlanView>(page, 'plan.get', { planId })).plan.setups[0]!
    .operations as { aid?: { kind: string; center?: [number, number] } }[]
  expect(
    holes.filter((o) => o.aid?.kind === 'registrationHole').map((o) => o.aid!.center![1]),
  ).toEqual([30, 30])
  await expect(page.locator('[data-flip-axis]')).toHaveText('Flip axis with Bottom')
  await aids.getByRole('button', { name: 'Add witness marks' }).click()
  await expect(topOps.getByText('Witness mark 2')).toBeVisible()
  await expect(topOps.locator('[data-aid]')).toHaveCount(4)

  // the drill and the V-bit (the aids' tools) have no presets: cutting values through the bridge
  const { plan } = await bridgeCall<PlanView>(page, 'plan.get', { planId })
  for (const op of plan.setups[0]!.operations.filter((o) => o.aid !== undefined))
    await bridgeCall(page, 'plan.operation.update', {
      planId,
      planOperationId: op.id,
      overrides: { spindleSpeed: '9000', feedRate: '300', plungeRate: '150' },
    })
  // the Top with its holes and marks on the dashed flip axis, the aids section in view
  await aids.scrollIntoViewIfNeeded()
  await page.getByRole('button', { name: 'Fit' }).click()
  await render(page, 'df78-flip-axis')
  // an aid's inspector
  await topOps.getByText('Witness mark 1').click()
  const aid = inspector.getByRole('region', { name: 'Alignment aid' })
  await expect(aid.getByLabel('Mark width', { exact: true })).toHaveValue(/^1/)
  // DF83: the mark's depth by the 90° V-bit (0.5 mm for 1 mm wide)
  await expect(aid.getByLabel('Mark depth', { exact: true })).toHaveValue(/^0\.5/)
  await aid.scrollIntoViewIfNeeded()
  await render(page, 'df83-aid-mark')

  // ── DF83: a hole's depth, peck and tool, each seen in the Top's exported program ─────────────
  const topId = plan.setups[0]!.id
  let n = 0
  /** The Top's program lines of Registration hole 1 (up to the next aid's label). */
  const holeProgram = async (): Promise<string[]> => {
    const target = test.info().outputPath(`top-${n++}.nc`)
    await bridgeCall(page, 'plan.export', { planId, setupId: topId, target, confirm: true })
    const lines = (await readFile(target, 'utf8')).split('\n')
    const from = lines.indexOf('(Registration hole 1)')
    const to = lines.indexOf('(Registration hole 2)')
    expect(from).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    return lines.slice(from, to)
  }
  const minZ = (lines: string[]) =>
    Math.min(...lines.flatMap((l) => [...l.matchAll(/Z(-?[\d.]+)/g)].map((m) => Number(m[1]))))
  const before = await holeProgram()
  await topOps.getByText('Registration hole 1').click()
  await expect(aid.getByLabel('Centre X', { exact: true })).toBeVisible()
  const sb = aid.getByLabel('Into the spoilboard', { exact: true })
  await sb.fill('5')
  await sb.press('Enter')
  await expect(sb).toHaveValue(/^5/)
  const shallower = await holeProgram()
  expect(minZ(shallower) - minZ(before)).toBeCloseTo(5, 2)
  // the peck depth (the 25 mm hole is pecked by default, 6.2 mm per peck)
  const strategy = inspector.getByRole('region', { name: 'Strategy' })
  await expect(strategy.getByText('Peck', { exact: true })).toBeVisible()
  const peck = strategy.getByLabel('Peck depth', { exact: true })
  await peck.fill('2')
  await peck.press('Enter')
  await expect(peck).toHaveValue(/^2/)
  const pecked = await holeProgram()
  expect(pecked.length).toBeGreaterThan(shallower.length + 10)
  expect(minZ(pecked)).toBeCloseTo(minZ(shallower), 2)
  await strategy.scrollIntoViewIfNeeded()
  await render(page, 'df83-aid-hole')
  // the tool: the 6 mm end mill bores it as a helix (arcs instead of the drill's pecks)
  const toolGroup = inspector.getByRole('region', { name: 'Tool' })
  await toolGroup.getByRole('combobox', { name: 'Tool' }).click()
  await page.getByRole('option', { name: /^Flat 6 · / }).click()
  await expect(toolGroup.getByRole('combobox', { name: 'Tool' })).toHaveText(/Flat 6/)
  await expect(strategy.getByText('Helical boring', { exact: true })).toBeVisible()
  const bored = await holeProgram()
  expect(bored.some((l) => /(^|\s)G[23](\s|$)/.test(l))).toBe(true)
  expect(pecked.some((l) => /(^|\s)G[23](\s|$)/.test(l))).toBe(false)

  // ── the Bottom aligns on them; one more point picked in the viewport ───────────────────────
  await bottom.click({ position: { x: 24, y: 12 } })
  const list = inspector.getByRole('list', {
    name: 'Alignment points in the order the spindle visits them',
  })
  await expect(list.getByRole('listitem')).toHaveCount(4)
  await expect(list.getByLabel('Point 3 name', { exact: true })).toHaveValue('Witness mark 1')
  await page.getByRole('button', { name: 'Fit' }).click()
  await render(page, 'df78-aids')
  await inspector.getByRole('button', { name: 'Pick in viewport' }).click()
  const targets = page.locator('[data-align-source]')
  await expect(targets.first()).toBeVisible()
  await render(page, 'df78-pick')
  await page
    .getByRole('button', { name: /^Add .*corner \(X/ })
    .first()
    .click()
  await expect(list.getByRole('listitem')).toHaveCount(5)
  await page.keyboard.press('Escape')
  await expect(targets).toHaveCount(0)

  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 60_000 })

  // ── Run both setups on the virtual machine at Max ───────────────────────────────────────────
  await page.keyboard.press('ControlOrMeta+3')
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  const machine = page.getByRole('group', { name: 'Machine' })
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: 'Max' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(machine.getByText('Virtual machine · Max')).toBeVisible()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  await navigator.getByRole('radio', { name: '100 mm' }).click()
  for (const name of ['Jog X−', 'Jog Y−'])
    for (let i = 0; i < 4; i++) {
      await navigator.getByRole('button', { name }).click()
      await expect(machine.getByText('Idle')).toBeVisible()
    }
  await navigator.getByRole('radio', { name: '10 mm' }).click()
  for (let i = 0; i < 5; i++) {
    await navigator.getByRole('button', { name: 'Jog Z−' }).click()
    await expect(machine.getByText('Idle')).toBeVisible()
  }
  await navigator.getByRole('button', { name: 'Zero X Y Z' }).click()
  await inspector.getByRole('button', { name: 'Start run' }).click()
  const preflight = page.getByRole('dialog', { name: 'Start run?' })
  await expect(preflight.getByText('Top (1 of 2)')).toBeVisible()
  await preflight.getByRole('button', { name: 'Start run' }).click()
  const waitsUntil = async (end: ReturnType<Page['getByRole']>) => {
    for (;;) {
      const wait = page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
      await expect(wait.or(end)).toBeVisible({ timeout: 120_000 })
      if (await end.isVisible()) return
      const title = (await wait.getByRole('heading').first().textContent()) ?? ''
      await wait.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('dialog', { name: title })).toBeHidden()
    }
  }
  const change = page.getByRole('dialog', { name: 'Setup change: setup 2, Bottom' })
  await waitsUntil(change)

  // ── the setup change points to the docked alignment panel (Q107) ─────────────────────────────
  await expect(change.locator('[data-align-point]')).toHaveCount(5)
  await expect(change.getByRole('button', { name: 'Start setup 2' })).toBeDisabled()
  await expect(change.getByRole('button', { name: 'Start alignment' })).toHaveCount(0)
  await change.getByRole('button', { name: 'Align in the Run panel' }).click()
  await expect(change).toBeHidden()
  const panel = inspector.getByRole('region', { name: 'Alignment of Bottom' })
  await expect(panel).toBeFocused()
  await expect(panel.locator('[data-align-point]')).toHaveCount(5)
  await panel.getByRole('button', { name: 'Start alignment' }).click()
  await page
    .getByRole('alertdialog', { name: 'Move the spindle over the alignment points?' })
    .getByRole('button', { name: 'Start alignment' })
    .click()
  const entries = panel.getByRole('list', { name: 'Alignment points' })
  await expect(entries.getByRole('listitem')).toHaveCount(6)
  const current = entries.locator('[aria-current="step"]')
  /** Checks the current entry once the pointer is there (its box enables only then). */
  const checkHere = async () => {
    const box = current.getByRole('checkbox')
    await expect(box).toBeEnabled({ timeout: 30_000 })
    await box.check()
    await expect(box).toBeChecked()
  }
  const cycle = async () => {
    await expect(current).toHaveAttribute('data-align-entry', 'zero')
    await checkHere()
    for (let i = 1; i < 6; i++) {
      await panel.getByRole('button', { name: 'Next', exact: true }).click()
      await expect(current).toHaveAttribute('data-align-entry', /^al/)
      await expect(panel.locator('[data-align-point][data-current]')).toHaveCount(1)
      await checkHere()
    }
  }
  await cycle()
  // the panel beside the DRO, the navigator's jog pad in view; the current point highlighted
  await panel.scrollIntoViewIfNeeded()
  await render(page, 'df78-align-panel')
  // Next wraps to the zero
  await panel.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(current).toHaveAttribute('data-align-entry', 'zero')
  await expect(current.getByRole('checkbox')).toBeEnabled({ timeout: 30_000 })
  // the stock was nudged: a new X zero (the navigator's jog 10 mm, Zero X) clears every check
  await navigator.getByRole('radio', { name: '10 mm' }).click()
  await navigator.getByRole('button', { name: 'Jog X+' }).click()
  // (the machine chip reads "Setup change" between the runs: a short wait for the jog to end)
  await expect(current.getByRole('checkbox')).toBeChecked()
  await page.waitForTimeout(500)
  await navigator.getByRole('button', { name: 'Zero X', exact: true }).click()
  await expect(entries.getByRole('checkbox', { checked: true })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Previous', exact: true }).click()
  await panel.getByRole('button', { name: 'Next', exact: true }).click()
  await cycle()
  await panel.getByRole('button', { name: 'Confirm alignment' }).click()
  await expect(panel.getByText('Alignment confirmed.')).toBeVisible()
  await panel.getByRole('button', { name: 'Back to the setup change (start setup 2)' }).click()
  await expect(change.getByText('Alignment confirmed in the Alignment panel.')).toBeVisible()
  await change.getByRole('button', { name: 'Start setup 2' }).click()
  await expect(change).toBeHidden()
  await waitsUntil(page.getByText(/^Run complete: \d+ lines in/))
  await expect(machine.getByText('Idle')).toBeVisible()
  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  expect(dfyom.rendererErrors).toEqual([])
})
