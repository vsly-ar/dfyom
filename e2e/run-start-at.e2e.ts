// "Start at" in the real app (hardening DF129 RC3): a one-tool pocket planned through the bridge,
// on the virtual machine. The pre-flight lists the pocket's pass starts; a line inside the cut
// (behind "Choose a line…") shows the in-material warning; the last pass start shows the lead-in
// with its tool wait, the gCode panel marks the start line and skips the lines before it. The
// run waits at the tool (the lead-in's note), runs to the end and ends Idle where the full
// program ends, having streamed the lead-in and the lines from the start on only.
// With DFYOM_RENDERS=1 light and dark renders go to design/features/renders/df129-start-at-*.png.
// Windows stay hidden (fixture). Selectors are roles and accessible names.
// Docs: docs/modes/run-recovery.md#implementation-rc3, docs/conventions/ui.md#run-mode-safety-ui
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { scanProgram } from '../src/core/run/recovery'
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

/** A block with one pocket (four levels) for one end mill, a gCode spindle, and the plan. */
async function pocketPlan(page: Page): Promise<string> {
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
          feedRate: '900',
          plungeRate: '300',
          stepdown: '0.5',
          stepover: '2.4',
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
      spindle: { control: 'gcode', maxSpeed: '24000' },
      programUnits: 'mm',
      toolChanger: 'none',
    },
  })
  await call('project.create', { name: 'Start at', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Pocket',
    stockLibraryItemId: stock.id,
  })
  await call('design.pocket.add', {
    partId,
    shape: {
      kind: 'rectangle',
      center: ['50', '30'],
      length: '30',
      width: '20',
      cornerRadius: '4',
    },
    depth: '2',
  })
  await call('project.apply', {})
  const { planId } = await call<{ planId: string }>('plan.create', {
    partId,
    machineLibraryItemId: machine.id,
  })
  return planId
}

test('run: start a plan at a pass start, with the lead-in and its tool wait (DF129 RC3)', async ({
  dfyom,
}) => {
  test.setTimeout(180_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 860 })
  const planId = await pocketPlan(page)

  await page.keyboard.press('ControlOrMeta+3')
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
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
  // the full program, as the pre-flight reads it
  const full = await bridgeCall<{ program: { lines: string[] } }>(page, 'run.job.check', {
    planId,
    program: true,
  })

  await inspector.getByRole('button', { name: 'Start run' }).click()
  const preflight = page.getByRole('dialog', { name: 'Start run?' })
  await expect(preflight.getByText('Inside the travel at this work zero.')).toBeVisible()
  const startAt = preflight.getByRole('combobox', { name: 'Start at' })
  await expect(startAt).toHaveText(/Beginning/)

  // the pocket's passes are listed; take the last one
  await startAt.click()
  const passes = page.getByRole('option', { name: /^Pass \d+ · line [\d,]+$/ })
  expect(await passes.count()).toBeGreaterThanOrEqual(2)
  const lastPass = (await passes.last().textContent()) ?? ''
  const fromLine = Number(/line ([\d,]+)$/.exec(lastPass)![1]!.replace(/,/g, ''))
  await page.keyboard.press('Escape')

  // a line in the cut behind "Choose a line…": the in-material warning, allowed after reading it
  await startAt.click()
  await page.getByRole('option', { name: 'Choose a line…' }).click()
  const field = preflight.getByRole('textbox', { name: 'Line' })
  await field.fill(String(fromLine + 1))
  await field.press('Enter')
  await expect(preflight.getByText(/^The line starts in the material at Z /)).toBeVisible()
  await expect(
    preflight.getByRole('button', {
      name: `Start at line ${(fromLine + 1).toLocaleString('en-GB')}`,
    }),
  ).toBeEnabled()
  await render(page, 'df129-start-line')

  // the last pass start: the tool wait first, the lead-in's steps, the panel at the start line
  await startAt.click()
  await page.getByRole('option', { name: lastPass }).click()
  await expect(preflight.getByText(/^The run first waits at tool 1: /)).toBeVisible()
  await expect(preflight.getByText(/^Nothing cuts before you continue/)).toBeVisible()
  const steps = preflight.getByRole('region', { name: 'Lead-in' }).getByRole('listitem')
  await expect(steps.first()).toHaveText(
    'Spindle and coolant off, then straight up to the machine top.',
  )
  await expect(steps.last()).toHaveText(
    `Runs the program from line ${fromLine.toLocaleString('en-GB')}.`,
  )
  // behind the modal dialog (aria-hidden while it is open): found by its label
  const panel = page.locator('section[aria-label="gCode"]')
  await expect(panel.getByText(`Starts at line ${fromLine.toLocaleString('en-GB')}`)).toBeVisible()
  await expect(panel.locator('[aria-current="location"]')).toHaveAttribute(
    'data-line',
    String(fromLine),
  )
  await render(page, 'df129-start-at')
  const start = preflight.getByRole('button', {
    name: `Start at line ${fromLine.toLocaleString('en-GB')}`,
  })
  await expect(start).toBeEnabled()
  await start.click()

  // the lead-in waits at the tool and says why; then the rest runs to the end
  const toolChange = page.getByRole('dialog', { name: /^Tool change \d+$/ })
  await expect(toolChange).toBeVisible({ timeout: 30_000 })
  await expect(toolChange.getByText(/^This is the start’s tool wait/)).toBeVisible()
  const waits = () => page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
  const complete = page.getByText(/^Run complete: [\d,]+ lines in/)
  for (;;) {
    await expect(waits().or(complete)).toBeVisible({ timeout: 120_000 })
    if (await complete.isVisible()) break
    const title = (await waits().getByRole('heading').first().textContent()) ?? ''
    await waits().getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('dialog', { name: title })).toBeHidden()
  }
  await expect(machine.getByText('Idle')).toBeVisible()

  // streamed: the lead-in, then the program from the start line on; nothing before it
  const status = await bridgeCall<RunStatus>(page, 'run.status.get')
  const jobId = status.lastRun?.jobId
  expect(jobId).toBeDefined()
  const streamed = await page.evaluate(
    (id) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.run.program(id),
    jobId!,
  )
  expect(streamed!.lines[0]).toBe(`(Resume at line ${fromLine}: lead-in)`)
  const leadIn = streamed!.sections[1]!.fromLine - 1
  expect(streamed!.sections[0]!.label).toBe('Lead-in')
  expect(streamed!.lines.slice(leadIn)).toEqual(full.program.lines.slice(fromLine - 1))
  // it ends where the full program ends (work coordinates)
  const moves = scanProgram(full.program.lines).filter((l) => l.motion !== 'none')
  const end = moves[moves.length - 1]!.end
  for (let i = 0; i < 3; i++) {
    const v = end[i]
    if (v !== undefined) expect(status.wpos[i]).toBeCloseTo(v, 2)
  }

  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  expect(dfyom.rendererErrors).toEqual([])
})
