// Marks from Run in the built app (hardening DF135 C2): a pocket and a chamfer on its rim, planned
// through the bridge, run to the end on the virtual machine with the test seam
// DFYOM_TEST_VIRTUAL_CUT_MARKS=1 (the virtual machine counts as real for the marks; without it, it
// marks nothing). The run section says "Marked 2 operations as already cut in Design." with Undo;
// Design's rows show the run's Cut marker; an edit of the run-cut pocket turns it into "Changed".
// Windows stay hidden (fixture). Selectors are roles and accessible names.
// Docs: docs/modes/cut-state.md#marking, #implementation-c2
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { PartDTO } from '../src/core/design/part.dto'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, launchApp, test, zeroXyz } from './app.fixture'

async function bridgeCall<T>(page: Page, name: string, args: object = {}): Promise<T> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

const ALU = {
  name: 'Alu',
  materialClass: 'aluminum',
  spindleSpeed: '18000',
  feedRate: '900',
  plungeRate: '300',
  stepdown: '1',
  stepover: '2.4',
}

/** A block with a pocket and a chamfer on its rim. Returns the part and the plan. */
async function pocketPlan(page: Page): Promise<{ partId: string; planId: string }> {
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
  for (const tool of [
    { name: 'Flat 6', type: 'flatEndMill', fluteLength: '20' },
    { name: 'Chamfer 6', type: 'chamferMill', angle: '90', fluteLength: '8' },
  ])
    await call('library.tool.add', {
      values: {
        diameter: '6',
        overallLength: '50',
        fluteCount: '2',
        toolMaterial: 'carbide',
        presets: [ALU],
        ...tool,
      },
    })
  const machine = await call<{ id: string }>('library.machine.add', {
    values: {
      name: 'Shapeoko',
      controller: 'grbl',
      travel: { x: '800', y: '800', z: '100' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'gcode', maxSpeed: '24000' },
      programUnits: 'mm',
      toolChanger: 'none',
    },
  })
  await call('project.create', { name: 'Run marks', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Lid',
    stockLibraryItemId: stock.id,
  })
  await call('design.pocket.add', {
    partId,
    shape: {
      kind: 'rectangle',
      center: ['50', '30'],
      length: '40',
      width: '24',
      cornerRadius: '4',
    },
    depth: '3',
  })
  await call('design.chamfer.add', { partId, edgeOf: 'pocket1', width: '1' })
  await call('project.apply', {})
  const { planId } = await call<{ planId: string }>('plan.create', {
    partId,
    machineLibraryItemId: machine.id,
  })
  return { partId, planId }
}

test('run: a run to the end marks its operations already cut, by run; an edit shows Changed (DF135 C2)', async () => {
  test.setTimeout(240_000)
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'dfyom-e2e-')))
  // only this launch: the virtual machine's runs count as real for the marks (the test seam)
  process.env['DFYOM_TEST_VIRTUAL_CUT_MARKS'] = '1'
  const { app, rendererErrors } = await launchApp(dataDir).finally(() => {
    delete process.env['DFYOM_TEST_VIRTUAL_CUT_MARKS']
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const { partId } = await pocketPlan(page)
    const part = async () =>
      (await bridgeCall<{ part: PartDTO }>(page, 'design.part.get', { partId })).part
    const navigator = page.getByRole('navigation', { name: 'Navigator' })

    // ── Run on the virtual machine to the end ────────────────────────────────────────────────
    await page.keyboard.press('ControlOrMeta+3')
    await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
    const inspector = page.getByRole('complementary', { name: 'Inspector' })
    if (!(await inspector.isVisible()))
      await page.getByRole('button', { name: 'Inspector' }).click()
    const machine = page.getByRole('group', { name: 'Machine' })
    await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
    await navigator.getByRole('combobox', { name: 'Time scale' }).click()
    await page.getByRole('option', { name: '10×' }).click()
    await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(machine.getByText('Virtual machine · 10×')).toBeVisible()
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
    await zeroXyz(page)
    expect((await part()).alreadyCut).toBeUndefined()
    await inspector.getByRole('button', { name: 'Start run' }).click()
    await page
      .getByRole('dialog', { name: 'Start run?' })
      .getByRole('button', { name: 'Start run' })
      .click()
    const waits = () => page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
    const complete = page.getByText(/^Run complete: \d+ lines in/)
    for (;;) {
      await expect(waits().or(complete)).toBeVisible({ timeout: 120_000 })
      if (await complete.isVisible()) break
      const title = (await waits().getByRole('heading').first().textContent()) ?? ''
      await waits().getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('dialog', { name: title })).toBeHidden()
    }

    // ── the marks: the notice with Undo, the design's list by run ────────────────────────────
    const notice = inspector.getByRole('status', { name: 'Already cut' })
    await expect(notice).toContainText('Marked 2 operations as already cut in Design.')
    await expect(notice).toContainText('Pocket 1, Chamfer 1')
    await expect(notice.getByRole('button', { name: 'Undo' })).toBeVisible()
    await expect.poll(async () => (await part()).alreadyCut).toEqual(['pocket1', 'chamfer1'])
    const marks = (await part()).alreadyCutMarks!
    expect(marks['pocket1']).toMatchObject({ by: 'run', fingerprint: expect.any(String) })
    expect(marks['chamfer1']).toMatchObject({ by: 'run' })
    await navigator.getByRole('button', { name: 'Disconnect' }).click()

    // ── Design: the rows' Cut markers; editing the run-cut pocket shows Changed ─────────────────
    await page.keyboard.press('ControlOrMeta+1')
    await expect(page.getByRole('radio', { name: 'Design' })).toBeChecked()
    const rows = page.locator('[data-cut-marker="run"]')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText('Cut')
    await bridgeCall(page, 'design.pocket.update', { partId, operationId: 'pocket1', depth: '4' })
    await expect(page.locator('[data-cut-marker="run"][data-tone="warning"]')).toHaveCount(1)
    await expect(page.locator('[data-cut-marker="run"][data-tone="warning"]')).toContainText(
      'Changed',
    )
    expect(rendererErrors).toEqual([])
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
