// Homing repeatability in the real app (v0.5 RV8) on the virtual machine (the GRBL emulator, no
// hardware) with the test seam DFYOM_TEST_HOMING_SCATTER=<mm> (each homing lands within ±mm/2 of
// the switch, seeded): after homing and a jog above the virtual Z plate, the dialog takes the
// start, the test homes 3 times and probes after each; the spread per axis and pass/fail show,
// and the result is kept per machine (the Machine group's line). Without the seam: a pass.
// Windows stay hidden (fixture). With DFYOM_RV78_SHOTS=<dir>: light screenshots there.
// Docs: docs/modes/run-machine.md#homing-repeatability-rv8
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, launchApp, test } from './app.fixture'

const SHOTS = process.env['DFYOM_RV78_SHOTS']

async function call(page: Page, name: string, args: object = {}): Promise<CallReply> {
  return page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return
  await page.evaluate(() => {
    ;(
      globalThis as unknown as {
        document: { documentElement: { dataset: Record<string, string> } }
      }
    ).document.documentElement.dataset['theme'] = 'light'
  })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** Records whether the dialog ever showed "Stop test", however briefly. */
async function watchStop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as {
      document: {
        body: object
        querySelectorAll(s: string): ArrayLike<{ textContent: string | null }>
      }
      MutationObserver: new (cb: () => void) => { observe(n: object, o: object): void }
      __stopSeen: boolean
    }
    g.__stopSeen = false
    new g.MutationObserver(() => {
      const buttons = Array.from(g.document.querySelectorAll('[role="dialog"] button'))
      if (buttons.some((b) => (b.textContent ?? '').trim() === 'Stop test')) g.__stopSeen = true
    }).observe(g.document.body, { childList: true, subtree: true, characterData: true })
  })
}

async function stopSeen(page: Page): Promise<boolean> {
  return page.evaluate(() => (globalThis as unknown as { __stopSeen: boolean }).__stopSeen)
}

async function runTest(scatter: string | undefined, shotName: string | undefined) {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'dfyom-e2e-')))
  if (scatter !== undefined) process.env['DFYOM_TEST_HOMING_SCATTER'] = scatter
  const { app, rendererErrors } = await launchApp(dataDir).finally(() => {
    delete process.env['DFYOM_TEST_HOMING_SCATTER']
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    if (SHOTS !== undefined) await page.setViewportSize({ width: 1280, height: 900 })
    const added = await call(page, 'library.machine.add', {
      values: {
        name: 'Router',
        controller: 'grbl',
        travel: { x: '800', y: '600', z: '100' },
        maxFeedRate: { x: '5000', y: '5000', z: '1000' },
        spindle: { control: 'manual', maxSpeed: '24000' },
        programUnits: 'mm',
        toolChanger: 'none',
        homingCorner: 'backRight',
        pullOff: '1',
        softLimits: true,
      },
    })
    expect(added.ok, JSON.stringify(added)).toBe(true)
    const navigator = page.getByRole('navigation', { name: 'Navigator', includeHidden: true })
    const machine = page.getByRole('group', { name: 'Machine', includeHidden: true })
    await navigator.getByRole('button', { name: 'Go to Run' }).click()
    await expect(navigator.getByRole('combobox', { name: 'Machine' })).toHaveText('Router')
    await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
    await navigator.getByRole('combobox', { name: 'Time scale' }).click()
    await page.getByRole('option', { name: 'Max' }).click()
    await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
    await navigator.getByRole('button', { name: 'Home' }).click()
    await expect(machine.getByText('Idle')).toBeVisible()
    // above the target: the virtual operator lays the Z plate 5 mm under the start
    expect((await call(page, 'run.machine.jog', { to: [-300, -200, -20], feed: 5000 })).ok).toBe(
      true,
    )
    await expect(machine.getByText('Idle')).toBeVisible()

    await navigator.getByRole('button', { name: 'Test homing repeatability…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Homing repeatability' })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-start]')).toHaveText('No start yet.')
    await expect(dialog.getByRole('button', { name: 'Use this position' })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Use this position' }).click()
    await expect(dialog.locator('[data-start]')).toContainText('X -300.000 Y -200.000 Z -20.000')
    await dialog.getByRole('textbox', { name: 'Homings' }).fill('3')
    // the test runs: Stop replaces Close throughout. At the Max time scale the whole test can take
    // less than one assertion poll (hardening P14: under load Playwright never saw it), so a
    // MutationObserver started before the click records that Stop was shown, however briefly
    await watchStop(page)
    await dialog.getByRole('button', { name: 'Start test' }).click()
    const table = dialog.getByRole('table', { name: 'Result' })
    await expect(table).toBeVisible({ timeout: 120_000 })
    await expect(dialog.getByRole('button', { name: 'Stop test' })).toHaveCount(0)
    expect(await stopSeen(page)).toBe(true)
    const spread = parseFloat(
      (await table.locator('[data-axis="z"] td').first().textContent()) ?? '',
    )
    const verdict = dialog.locator('[data-pass]')
    if (scatter === undefined) {
      expect(spread).toBeLessThan(0.005)
      await expect(verdict).toHaveAttribute('data-pass', 'pass')
    } else {
      // ±0.05 mm per homing: a spread well over 0.02 mm (the seeded draws), so it fails
      expect(spread).toBeGreaterThan(0.02)
      expect(spread).toBeLessThanOrEqual(Number(scatter) + 0.005)
      await expect(verdict).toHaveAttribute('data-pass', 'fail')
      await expect(verdict).toContainText('check the homing switches')
    }
    if (shotName !== undefined) await shot(page, shotName)
    await dialog.getByRole('button', { name: 'Close' }).first().click()
    await expect(dialog).toHaveCount(0)
    // kept per machine with the date
    await expect(page.locator('[data-repeatability-summary]').first()).toContainText(
      scatter === undefined ? 'Pass' : 'Over',
    )
    expect(rendererErrors).toEqual([])
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}

test('homing repeatability (v0.5 RV8): a scattered homing fails with its spread', async () => {
  test.setTimeout(240_000)
  await runTest('0.1', 'rv8-repeatability-fail')
})

test('homing repeatability (v0.5 RV8): exact homing passes', async () => {
  test.setTimeout(240_000)
  await runTest(undefined, undefined)
})
