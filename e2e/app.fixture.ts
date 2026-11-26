// Launches the built app (out/main/index.js, or a packaged app: DFYOM_E2E_APP) isolated from the
// developer's app data.
// Doc: docs/conventions/testing.md#end-to-end
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test'

export interface AppFixture {
  readonly app: ElectronApplication
  /** The temp `--data-dir`: app data, Chromium profile and logs (docs/architecture/persistence.md#files-and-folders). */
  readonly dataDir: string
  /** Console errors and uncaught exceptions of every window, collected from creation on. */
  readonly rendererErrors: readonly string[]
}

/** Record a Playwright trace of every launch (CI, or DFYOM_E2E_TRACE=1); kept only for a failed test. */
const TRACE = !!process.env['CI'] || process.env['DFYOM_E2E_TRACE'] === '1'

/** The environment of an app launch: the built renderer, windows hidden. */
export function launchEnv(): Record<string, string> {
  // Without ELECTRON_RENDERER_URL the app loads the built renderer, not a dev server.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] =>
        e[1] !== undefined && e[0] !== 'ELECTRON_RENDERER_URL' && e[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  )
  // Windows stay hidden (no pop-ups, no focus stealing); DFYOM_E2E_SHOW=1 shows them for debugging.
  if (process.env['DFYOM_E2E_SHOW'] !== '1') env['DFYOM_HIDE_WINDOWS'] = '1'
  return env
}

/**
 * Launches the built app on `dataDir` and collects its windows' console errors. The fixture uses
 * it; a test may launch again on the same data dir to close and reopen the app. `args` follow
 * `--data-dir` (e.g. a project file to open, hardening U5).
 */
export async function launchApp(
  dataDir: string,
  args: readonly string[] = [],
): Promise<{ app: ElectronApplication; rendererErrors: string[] }> {
  const env = launchEnv()
  // DFYOM_E2E_APP runs the tests on a packaged app's executable instead (npm run smoke:packaged,
  // docs/conventions/packaging.md#smoke-test).
  const packaged = process.env['DFYOM_E2E_APP']
  const app = await electron.launch(
    packaged
      ? { executablePath: packaged, args: [`--data-dir=${dataDir}`, ...args], env }
      : { args: ['out/main/index.js', `--data-dir=${dataDir}`, ...args], env },
  )
  const rendererErrors: string[] = []
  const watched = new WeakSet<Page>()
  const watch = (page: Page) => {
    if (watched.has(page)) return
    watched.add(page)
    page.on('console', (m) => {
      if (m.type() === 'error') rendererErrors.push(`${page.url()}: ${m.text()}`)
    })
    page.on('pageerror', (e) => rendererErrors.push(`${page.url()}: ${e.message}`))
  }
  app.on('window', watch)
  app.windows().forEach(watch)
  await stubMessageBoxes(app)
  if (TRACE) await app.context().tracing.start({ screenshots: true, snapshots: true })
  return { app, rendererErrors }
}

/** What the stubbed native message boxes were asked (main process global, see stubMessageBoxes). */
interface MessageBoxStub {
  /** Label of the button to press; a box without it presses its first "…quit…" button, else Cancel. */
  answer: string | undefined
  readonly asked: { message: string; detail?: string; buttons: string[] }[]
}

/**
 * Native message boxes (the quit confirmations, src/main/index.ts) cannot be driven by Playwright
 * and would show on screen, so every launch replaces them: by default they answer with the quit
 * button ("Quit without saving", "Stop run and quit"), so closing the app at the end of a test
 * never waits. `answerMessageBoxes` picks another button; `askedMessageBoxes` lists the questions.
 */
async function stubMessageBoxes(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const stub: MessageBoxStub = { answer: undefined, asked: [] }
    ;(globalThis as unknown as { dfyomMessageBoxes: MessageBoxStub }).dfyomMessageBoxes = stub
    dialog.showMessageBox = ((...args: unknown[]) => {
      const o = args[args.length - 1] as Electron.MessageBoxOptions
      const buttons = o.buttons ?? ['OK']
      stub.asked.push({ message: o.message, ...(o.detail ? { detail: o.detail } : {}), buttons })
      let response = stub.answer === undefined ? -1 : buttons.indexOf(stub.answer)
      if (response < 0) response = buttons.findIndex((b) => /quit/i.test(b))
      if (response < 0) response = o.cancelId ?? 0
      return Promise.resolve({ response, checkboxChecked: false })
    }) as typeof dialog.showMessageBox
  })
}

/**
 * Closes the app through its normal quit path (`app.close()` quits it). The Library window asks
 * about an unsaved draft in the window itself (Save / Discard / Cancel), not in a native message
 * box, so nothing stubbed answers it; left alone, the quit waits for it forever and the worker's
 * teardown hangs (hardening B1). While the app quits, such a prompt is answered with Discard;
 * returns how many were.
 * Doc: docs/conventions/testing.md#end-to-end
 */
export async function closeApp(app: ElectronApplication): Promise<number> {
  let done = false
  let answered = 0
  const closed = app.close().finally(() => {
    done = true
  })
  const discard = async () => {
    for (const w of app.windows()) {
      const prompt = w.getByRole('dialog', { name: /^Save changes to / })
      if (!(await prompt.isVisible().catch(() => false))) continue
      await prompt
        .getByRole('button', { name: 'Discard' })
        .click({ timeout: 1000 })
        .catch(() => undefined)
      // P8: count a prompt once it is gone, not by the click's result. A click that landed can
      // still reject (Discard lets the quit close the window while Playwright finishes the click),
      // and a prompt still closing must not be clicked and counted again. A click that didn't
      // land leaves the prompt open: the next round tries again.
      const gone = await prompt.waitFor({ state: 'hidden', timeout: 15_000 }).then(
        () => true,
        () => w.isClosed(),
      )
      if (gone) answered++
    }
  }
  while (!done) {
    await Promise.race([closed, new Promise((r) => setTimeout(r, 200))])
    if (!done) await discard()
  }
  await closed
  return answered
}

/** The next native message boxes press the button labelled `label`. */
export async function answerMessageBoxes(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate((_e, l) => {
    ;(globalThis as unknown as { dfyomMessageBoxes: MessageBoxStub }).dfyomMessageBoxes.answer = l
  }, label)
}

/** The native message boxes asked so far (message, detail, buttons). */
export function askedMessageBoxes(app: ElectronApplication): Promise<MessageBoxStub['asked']> {
  return app.evaluate(
    () => (globalThis as unknown as { dfyomMessageBoxes: MessageBoxStub }).dfyomMessageBoxes.asked,
  )
}

export const test = base.extend<{ dfyom: AppFixture }>({
  // Playwright requires the destructuring pattern for fixture dependencies, even when empty.
  // eslint-disable-next-line no-empty-pattern
  dfyom: async ({}, use, testInfo) => {
    const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'dfyom-e2e-')))
    const { app, rendererErrors } = await launchApp(dataDir)
    try {
      await use({ app, dataDir, rendererErrors })
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus
      // A trace survives only while the app runs: a test that already closed it has none.
      if (TRACE && failed && app.windows().length > 0) {
        const path = testInfo.outputPath('trace.zip')
        const stopped = await app
          .context()
          .tracing.stop({ path })
          .then(() => true)
          .catch(() => false)
        if (stopped)
          testInfo.attachments.push({ name: 'trace', path, contentType: 'application/zip' })
      }
      if (failed) {
        // the app's logs (main, workers, machine host) next to the trace, before the folder goes
        await cp(join(dataDir, 'logs'), testInfo.outputPath('logs'), { recursive: true }).catch(
          () => undefined,
        )
      }
      await closeApp(app)
      await rm(dataDir, { recursive: true, force: true })
    }
  },
})

/**
 * Opens one of design mode's part-setup dialogs (D45: Stock, Shapes) from the main
 * toolbar, unless it is open; returns the dialog. While a modal dialog is open the rest of the
 * window is hidden from role queries: close it (`closeDialog`) before using the navigator or the
 * inspector. Doc: docs/conventions/ui.md#design-sidebar-and-setup-dialogs-v04-d45
 */
export async function openPartSetup(page: Page, name: 'Stock' | 'Shapes'): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name })
  if (!(await dialog.isVisible()))
    await page.getByRole('toolbar', { name: 'Part setup' }).getByRole('button', { name }).click()
  await expect(dialog).toBeVisible()
  return dialog
}

/** The Shape Editor windows open now (window kind `shapes`), oldest first. */
export async function shapeEditorWindows(app: ElectronApplication): Promise<Page[]> {
  const found: Page[] = []
  for (const w of app.windows()) {
    const kind = await w
      // runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`
      .evaluate(
        () =>
          (globalThis as unknown as { dfyom?: { windowKind?: string } }).dfyom?.windowKind ?? null,
      )
      .catch(() => null)
    if (kind === 'shapes') found.push(w)
  }
  return found
}

/**
 * The project's Shape Editor window (DF94), once a shape row, "Edit shape" or Window → Shape
 * Editor opened it (hidden like every window); with the parts the tests use: its inspector, its
 * flat view (region "Shape Editor") and its shape list.
 * Doc: docs/conventions/ui.md#shape-editor-window-df94
 */
export async function shapeEditorWindow(app: ElectronApplication): Promise<{
  page: Page
  inspector: Locator
  editor: Locator
  list: Locator
}> {
  let page: Page | undefined
  await expect
    .poll(async () => (page = (await shapeEditorWindows(app))[0]) !== undefined, {
      timeout: 15_000,
    })
    .toBe(true)
  const p = page!
  await p.waitForLoadState('domcontentloaded')
  return {
    page: p,
    inspector: p.getByRole('complementary', { name: 'Inspector' }),
    editor: p.getByRole('region', { name: 'Shape Editor' }),
    list: p.getByRole('navigation', { name: 'Shapes' }),
  }
}

/**
 * Opens the Reference panel in the right sidebar (dogfood DF3: the toolbar's "Reference" toggle)
 * unless it is open; returns the inspector that shows it.
 * Doc: docs/conventions/ui.md#reference-panel-hardening-df2df8
 */
export async function openReferencePanel(page: Page): Promise<Locator> {
  const toggle = page.getByRole('toolbar', { name: 'Part setup' }).getByRole('button', {
    name: 'Reference',
  })
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await expect(inspector.getByRole('heading', { name: 'Reference', exact: true })).toBeVisible()
  return inspector
}

/**
 * Fits the panel's reference to the stock through Fit mode (DF5): `scale` false keeps the scale,
 * else the checked stock dimensions govern (default X and Y); `height` Top / Centre / Bottom.
 */
export async function fitReference(
  panel: Locator,
  opts: { height?: 'Top' | 'Centre' | 'Bottom'; scale?: false } = {},
): Promise<void> {
  await panel.getByRole('button', { name: 'Fit to stock…' }).click()
  const fit = panel.getByRole('region', { name: 'Fit to stock' })
  if (opts.scale === false) await fit.getByRole('checkbox', { name: 'Scale to fit' }).click()
  if (opts.height)
    await fit
      .getByRole('radiogroup', { name: 'Height' })
      .getByRole('radio', { name: opts.height })
      .click()
  await fit.getByRole('button', { name: 'Apply' }).click()
  await expect(fit).toBeHidden()
}

/** What a window did while it should have been idle (`idleActivity`). */
export interface IdleActivity {
  /** WebGL frames drawn (`clear` calls of the viewport's context). */
  readonly frames: number
  /** Run-status pushes the window received. */
  readonly statusPushes: number
}

/**
 * Counts the viewport's WebGL frames and the run-status pushes in `page` over `ms` of wall time
 * (P7, idle cost: an idle window draws nothing and hears nothing; the viewport renders on demand,
 * the machine host posts a status only when it changed). The one wait on time in the suite: idling
 * is what it checks. Counting starts after two animation frames, so a render the state the test
 * waited on already scheduled is drawn first, not counted as idle work.
 * Doc: docs/research/2026-11-23-idle-cost.md
 */
export async function idleActivity(page: Page, ms = 2000): Promise<IdleActivity> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  return page.evaluate(async (wait) => {
    const g = globalThis as unknown as {
      WebGL2RenderingContext: { prototype: { clear(mask: number): void } }
      dfyom: { run: { onStatus(l: () => void): () => void } }
      setTimeout(fn: () => void, ms: number): void
      requestAnimationFrame(fn: () => void): number
    }
    const frame = () => new Promise<void>((r) => g.requestAnimationFrame(() => r()))
    await frame()
    await frame()
    const proto = g.WebGL2RenderingContext.prototype
    const clear = proto.clear
    let frames = 0
    let statusPushes = 0
    proto.clear = function (this: unknown, mask: number) {
      frames++
      clear.call(this, mask)
    }
    const off = g.dfyom.run.onStatus(() => statusPushes++)
    await new Promise<void>((r) => g.setTimeout(r, wait))
    off()
    proto.clear = clear
    return { frames, statusPushes }
  }, ms)
}

/** Closes an open dialog by its "Done" (or `button`) and waits until it is gone. */
export async function closeDialog(dialog: Locator, button = 'Done'): Promise<void> {
  await dialog.getByRole('button', { name: button }).click()
  await expect(dialog).toBeHidden()
}

/**
 * Sets the work zero on X, Y and Z with the "0" buttons in the Run inspector's Position table
 * (DF88: there is no "Zero X Y Z" button), waiting for each to reach the DRO and then for the
 * window to have applied the three commands' action events. The DRO follows the machine's status
 * push, which can come well before a command's event under load (1.7 s measured); the event bumps
 * the window's project revision and re-renders it, so a check right after the zeroing (P7's
 * `idleActivity`, P13) would see that render.
 */
export async function zeroXyz(page: Page): Promise<void> {
  const dro = page
    .getByRole('complementary', { name: 'Inspector' })
    .getByRole('table', { name: 'Position' })
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  const before = await page.evaluate(() => {
    const g = globalThis as unknown as {
      dfyomZeroEvents?: number
      dfyom: { project: { onEvent(l: (e: { name?: string }) => void): () => void } }
    }
    if (g.dfyomZeroEvents === undefined) {
      g.dfyomZeroEvents = 0
      g.dfyom.project.onEvent((e) => {
        if (e.name === 'run.workZero.set') g.dfyomZeroEvents = (g.dfyomZeroEvents ?? 0) + 1
      })
    }
    return g.dfyomZeroEvents
  })
  for (const axis of ['X', 'Y', 'Z']) {
    await dro.getByRole('button', { name: `Set ${axis} zero` }).click()
    await expect(dro.getByRole('cell', { name: `Work position ${axis}` })).toHaveText(/^-?0\.0+/)
  }
  await expect
    .poll(() =>
      page.evaluate(() => (globalThis as unknown as { dfyomZeroEvents: number }).dfyomZeroEvents),
    )
    .toBe(before + 3)
}

/**
 * Shows an inspector field kept behind a closed More row, accordion or tab (DF110: Anchor,
 * Rotation, Floor fillet radius, Slot width, tab positions) the way a message's target is shown:
 * the field sends the reveal event (`revealInInspector`), every closed disclosure around it opens.
 * `label` is the field's accessible name (an input's label, a radiogroup's name). Specs call this
 * before setting a rarely used field, never ad-hoc clicks on "More (…)".
 * Doc: docs/conventions/inspector-layout.md#inspector-structure-df110
 */
export async function revealField(scope: Locator, label: string): Promise<void> {
  await scope
    .getByLabel(label, { exact: true })
    .first()
    .evaluate((el) => {
      // runs in the renderer; this tsconfig has no DOM lib, hence the structural types
      const Event = (globalThis as unknown as { CustomEvent: new (n: string, o: object) => object })
        .CustomEvent
      ;(el as unknown as { dispatchEvent(e: object): boolean }).dispatchEvent(
        new Event('dfyom-inspector-reveal', { bubbles: true }),
      )
    })
  await expect(scope.getByLabel(label, { exact: true }).first()).toBeVisible()
}

/**
 * Selects inspector tab `name` ("Feeds") in `scope` unless it is selected (DF110 S5: hidden tab
 * panels stay mounted, but role queries skip them). Doc: docs/conventions/inspector-layout.md
 */
export async function openInspectorTab(scope: Locator, name: string): Promise<void> {
  const tab = scope.getByRole('tab', { name: new RegExp(`^${name}\\b`) })
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

/** Opens the closed inspector accordion `title` ("Tool setup") in `scope`; returns its region. */
export async function openInspectorGroup(scope: Locator, title: string): Promise<Locator> {
  const region = scope.getByRole('region', { name: title, exact: true })
  const toggle = region.locator(':scope > div > :is(h3, h4) > button[aria-expanded]')
  if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) === 'false')
    await toggle.click()
  return region
}

export { expect } from '@playwright/test'
