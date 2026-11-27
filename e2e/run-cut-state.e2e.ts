// Run with an already-cut operation in the built app (hardening DF137, TG #454): a pocket and a
// chamfer on its rim, planned through the bridge; the pocket is marked already cut (DF135). Plan
// draws only the chamfer's toolpath; Run, on the virtual machine, draws the same (no toolpath of
// the pocket), its program equals the exported file and holds no pocket line, and the program the
// run streams (the gCode panel's) is that program.
// Windows stay hidden (fixture). Selectors are roles and accessible names.
// Docs: docs/modes/cut-state.md#run-df137, docs/modes/run.md#gcode-panel-df84
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { RunStatus } from '../src/core/run/service'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test, zeroXyz } from './app.fixture'

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

/** A block with a pocket and a chamfer on its rim; the pocket already cut. Returns the plan. */
async function cutPocketPlan(page: Page): Promise<string> {
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
      presets: [ALU],
    },
  })
  await call('library.tool.add', {
    values: {
      name: 'Chamfer 6',
      type: 'chamferMill',
      diameter: '6',
      angle: '90',
      fluteLength: '8',
      overallLength: '50',
      fluteCount: '2',
      toolMaterial: 'carbide',
      presets: [ALU],
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
  await call('project.create', { name: 'Cut pocket', unitSystem: 'mm' })
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
  // the user cut the pocket already (TG #454): marked in Design, the draft plan follows
  await call('design.part.update', { partId, alreadyCut: ['pocket1'] })
  await call('project.apply', {})
  return planId
}

test('run: an already-cut pocket is neither drawn nor streamed; only the chamfer runs (DF137)', async ({
  dfyom,
}) => {
  test.setTimeout(240_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const planId = await cutPocketPlan(page)
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const view = page.getByRole('region', { name: '3D viewport' })

  // ── Plan: the chamfer's toolpath only ("Show cut toolpaths" off) ───────────────────────────
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByRole('radio', { name: 'Plan' })).toBeChecked()
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 90_000 })
  await expect(navigator.getByRole('switch', { name: 'Show cut toolpaths' })).not.toBeChecked()
  await expect(view).toHaveAttribute('data-toolpath-segments', /^[1-9]\d*$/, { timeout: 30_000 })
  const planned = Number(await view.getAttribute('data-toolpath-segments'))
  // with the cut toolpaths shown, the pocket's are drawn too
  await navigator.getByRole('switch', { name: 'Show cut toolpaths' }).click()
  await expect
    .poll(async () => Number(await view.getAttribute('data-toolpath-segments')))
    .toBeGreaterThan(planned)
  const everything = Number(await view.getAttribute('data-toolpath-segments'))
  await navigator.getByRole('switch', { name: 'Show cut toolpaths' }).click()
  await expect(view).toHaveAttribute('data-toolpath-segments', String(planned))
  // the export: the chamfer, no pocket
  await bridgeCall(page, 'plan.export', { planId, target: join(dfyom.dataDir, 'lid.nc') })
  const exported = readFileSync(join(dfyom.dataDir, 'lid.nc'), 'utf8').split('\n')
  if (exported.at(-1) === '') exported.pop()
  expect(exported).toContain('(Chamfer 1)')
  expect(exported).not.toContain('(Pocket 1)')
  // one tool: the chamfer mill's tool change only
  const toolLines = exported.filter((l) => /^\(Tool \d+:/.test(l))
  expect(toolLines).toHaveLength(1)
  expect(toolLines[0]).not.toContain('Flat')

  // ── Run on the virtual machine: the same toolpath, the same program ───────────────────────
  await page.keyboard.press('ControlOrMeta+3')
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  const machine = page.getByRole('group', { name: 'Machine' })
  await expect(view).toHaveAttribute('data-toolpath-segments', String(planned), {
    timeout: 30_000,
  })
  expect(planned).toBeLessThan(everything)
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
  // the pre-flight's program (Start at, the gCode panel before the start) is the export's
  const checked = await bridgeCall<{
    program: { lines: string[]; points: { kind: string; label?: string }[] }
  }>(page, 'run.job.check', { planId, program: true })
  expect(checked.program.lines).toEqual(exported)
  expect(checked.program.points.some((p) => p.label?.includes('Pocket') === true)).toBe(false)
  await expect(view).toHaveAttribute('data-toolpath-segments', String(planned))

  // the run: one tool (the chamfer mill), and the panel's program is the export's
  await inspector.getByRole('button', { name: 'Start run' }).click()
  const preflight = page.getByRole('dialog', { name: 'Start run?' })
  // TG #456: the tool list is the program's (the chamfer mill only, not the pocket's end mill)
  await expect(preflight.getByText('Chamfer 6')).toBeVisible()
  await expect(preflight.getByText('Flat 6')).toHaveCount(0)
  // Start at offers the program's operations and passes only, at the program's line numbers
  const startAt = preflight.getByRole('combobox', { name: 'Start at' })
  await startAt.click()
  const options = (await page.getByRole('option').allTextContents()).join('\n')
  expect(options).not.toMatch(/Pocket/)
  const pass = /line ([\d,]+)/.exec(options)
  expect(pass).not.toBeNull()
  const line = Number(pass![1]!.replace(/,/g, ''))
  expect(line).toBeLessThanOrEqual(exported.length)
  await page.keyboard.press('Escape')
  await preflight.getByRole('button', { name: 'Start run' }).click()
  let jobId: string | undefined
  await expect
    .poll(async () => (jobId = (await bridgeCall<RunStatus>(page, 'run.status.get')).job?.jobId), {
      timeout: 30_000,
      intervals: [20],
    })
    .toBeDefined()
  const waits = () => page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
  const complete = page.getByText(/^Run complete: \d+ lines in/)
  for (;;) {
    await expect(waits().or(complete)).toBeVisible({ timeout: 120_000 })
    if (await complete.isVisible()) break
    const title = (await waits().getByRole('heading').first().textContent()) ?? ''
    await waits().getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('dialog', { name: title })).toBeHidden()
  }
  const streamed = await page.evaluate(
    (id) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.run.program(id),
    jobId!,
  )
  expect(streamed?.lines).toEqual(exported)
  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  expect(dfyom.rendererErrors).toEqual([])
})
