// Plan mode against the fake bridge bound to a real project runtime (core plan fixture: the test
// part, four library tools and a machine): create a plan, the operation list in machining order,
// the tool picker, feeds and speeds with their source, auto mode and locks, stale notices with
// rebuild, read-only statuses, toolpath generation and the export (job, toolpaths and the export
// itself are scripted: the fixture runtime has no toolpath cache or file port). The viewport
// canvas is stubbed. Doc: docs/conventions/ui.md#plan-mode-task-37, #testing
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { planSetup, type PlanSetup } from '../../../../core/plan/plan.fixture'
import type { CallReply } from '../../../../shared/preload-api'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge, type FakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

const ok = (value: unknown = {}): CallReply => ({ ok: true, value, revision: 0 })

async function renderPlan(
  opts: {
    plan?: boolean
    setup?: (s: PlanSetup) => Promise<void>
    /** Scripts the bridge and the shell before the first render (DF45: machines, settings). */
    before?: (s: PlanSetup, bridge: FakeBridge, shell: ReturnType<typeof createShell>) => void
  } = {},
) {
  const s = await planSetup()
  if (opts.plan !== false) await s.create({ machineLibraryItemId: s.machineId })
  await opts.setup?.(s)
  const bridge = createFakeBridge()
  bridge.bind(s.d)
  const shell = createShell(bridge)
  opts.before?.(s, bridge, shell)
  shell.ui.getState().setMode('plan')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  // test windows are narrow: the inspector is an overlay, opened by its toggle
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const nav = () => screen.getByRole('navigation', { name: 'Navigator' })
  // plan mode without a plan: the Plan start card over the view (DF29)
  const start = () => screen.getByRole('dialog', { name: 'Plan the part' })
  const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
  const callsOf = (name: string) => bridge.calls.filter((c) => c.name === name).map((c) => c.args)
  const rows = () =>
    within(nav())
      .getByRole('list', { name: 'Plan operations in machining order' })
      .querySelectorAll(':scope > li > button')
  const planId = () => Object.keys(s.d.doc.plans)[0]!
  return { ...r, s, bridge, nav, start, inspector, callsOf, rows, planId }
}

// multi-step user flows through the whole mode (~2 s each alone, more under a parallel `npm test`,
// docs/conventions/testing.md#commands)
describe('Plan mode', () => {
  it('creates a plan of the part with the machine and lists its operations in machining order', async () => {
    const t = await renderPlan({ plan: false })
    // DF29: "Plan the part" is a non-modal card over the view, the action in its footer
    const card = await screen.findByRole('dialog', { name: 'Plan the part' })
    expect(card).toHaveAttribute('aria-modal', 'false')
    expect(card).toHaveAccessibleDescription(/A plan turns the part into toolpaths/)
    expect(within(t.nav()).getByText('No plan yet: create one in the view.')).toBeVisible()
    expect(within(t.nav()).queryByRole('button', { name: 'Create plan' })).toBeNull()
    await expectNoAxeViolations()
    await t.user.click(within(card).getByRole('button', { name: 'Create plan' }))
    await waitFor(() => expect(t.rows().length).toBeGreaterThan(0))
    expect(screen.queryByRole('dialog', { name: 'Plan the part' })).toBeNull()
    expect(t.callsOf('plan.create')).toEqual([
      { partId: t.s.partId, machineLibraryItemId: t.s.machineId },
    ])
    // facing, drillings, pocket, profile (default order); tools named on the rows
    const names = [...t.rows()].map((b) => b.textContent ?? '')
    expect(names[0]).toMatch(/^Facing 1Flat 6/)
    expect(names.at(-1)).toMatch(/^Profile 1/)
    expect(within(t.nav()).getByRole('combobox', { name: 'Machine' })).toHaveTextContent('Shapeoko')
    expect(within(t.nav()).getByRole('combobox', { name: 'Plan status' })).toHaveTextContent(
      'Draft',
    )
    await expectNoAxeViolations()
  })

  it('chooses the machine in the Plan start card: none, several, the last used (DF45)', async () => {
    // an empty machine library: no select, "Create plan" disabled with the reason, New machine…
    let machines: { id: string; name: string }[] = []
    const t = await renderPlan({
      plan: false,
      before: (_s, bridge) => bridge.handle('library.machine.list', () => ok({ items: machines })),
    })
    const card = await screen.findByRole('dialog', { name: 'Plan the part' })
    const create = within(card).getByRole('button', { name: 'Create plan' })
    await waitFor(() => expect(create).toHaveAccessibleDescription(/machine library is empty/))
    expect(create).toBeDisabled()
    expect(within(card).queryByRole('combobox', { name: 'Machine' })).toBeNull()
    expect(within(card).getByRole('button', { name: 'New machine…' })).toBeVisible()
    await expectNoAxeViolations()
    t.unmount()

    // several machines, none remembered: "Choose a machine", disabled with why until chosen
    machines = [
      { id: 'router', name: 'Router' },
      { id: 'mill', name: 'Mill' },
    ]
    const u = await renderPlan({
      plan: false,
      before: (s, bridge) => {
        machines = [{ id: s.machineId, name: 'Shapeoko' }, ...machines]
        bridge.handle('library.machine.list', () => ok({ items: machines }))
      },
    })
    const card2 = await screen.findByRole('dialog', { name: 'Plan the part' })
    const select = await within(card2).findByRole('combobox', { name: 'Machine' })
    expect(select).toHaveTextContent('Choose a machine')
    const create2 = within(card2).getByRole('button', { name: 'Create plan' })
    expect(create2).toBeDisabled()
    expect(create2).toHaveAccessibleDescription('Choose the machine to plan for.')
    await expectNoAxeViolations()
    await u.user.click(select)
    // the first option is highlighted on open; Enter picks it (Radix can swallow the first
    // pointerup after an opening click in jsdom)
    expect(await screen.findByRole('option', { name: 'Shapeoko' })).toHaveAttribute(
      'data-highlighted',
    )
    await u.user.keyboard('{Enter}')
    await waitFor(() => expect(create2).toBeEnabled())
    await u.user.click(create2)
    await waitFor(() => expect(u.rows().length).toBeGreaterThan(0))
    expect(u.callsOf('plan.create')).toEqual([
      { partId: u.s.partId, machineLibraryItemId: u.s.machineId },
    ])
    expect(u.bridge.settingsPatches).toContainEqual({ lastMachine: u.s.machineId })
    u.unmount()

    // the last machine used is preselected
    await renderPlan({
      plan: false,
      before: (s, bridge, shell) => {
        machines = [
          { id: s.machineId, name: 'Shapeoko' },
          { id: 'router', name: 'Router' },
        ]
        bridge.handle('library.machine.list', () => ok({ items: machines }))
        shell.settings.setState({
          settings: { ...shell.settings.getState().settings, lastMachine: 'router' },
        })
      },
    })
    const card3 = await screen.findByRole('dialog', { name: 'Plan the part' })
    expect(await within(card3).findByRole('combobox', { name: 'Machine' })).toHaveTextContent(
      'Router',
    )
    expect(within(card3).getByRole('button', { name: 'Create plan' })).toBeEnabled()
  })

  it('shows feeds and speeds with their source; a preset has no locks, an entered value resets', async () => {
    const t = await renderPlan()
    await waitFor(() => expect(t.rows().length).toBeGreaterThan(0))
    await t.user.click(t.rows()[0]!)
    const insp = t.inspector()
    await within(insp).findByRole('heading', { name: 'Facing 1' })
    const feed = await within(insp).findByLabelText('Feed rate', { selector: 'input' })
    expect(feed).toHaveValue('800 mm/min')
    expect(within(insp).getAllByText('From preset “Alu finish”.').length).toBeGreaterThan(0)
    // the tool picker offers the ranked suggestions and names why
    expect(within(insp).getByRole('combobox', { name: 'Tool' })).toHaveTextContent('Flat 6')
    expect(within(insp).getByRole('list', { name: 'Why this tool' })).toBeInTheDocument()
    // a preset means fixed values: no locks (stickout has none either)
    expect(within(insp).queryByRole('button', { name: /^Lock / })).toBeNull()

    await t.user.clear(feed)
    await t.user.type(feed, '600{Enter}')
    await waitFor(() =>
      expect(t.callsOf('plan.operation.update')).toContainEqual(
        expect.objectContaining({ overrides: { feedRate: '600' } }),
      ),
    )
    await within(insp).findByText('Entered by you.')
    const op = t.s.plan(t.planId()).setups[0]!.operations[0]!
    expect(op.overrides.feedRate?.source).toBe('600')
    await t.user.click(within(insp).getByRole('button', { name: 'Reset' }))
    await waitFor(() =>
      expect(t.s.plan(t.planId()).setups[0]!.operations[0]!.overrides.feedRate).toBeUndefined(),
    )
    await expectNoAxeViolations()
  })

  it('auto mode: the preset control switches to the calculator; locks pin, follow and unlock to entered', async () => {
    const t = await renderPlan()
    await waitFor(() => expect(t.rows().length).toBeGreaterThan(0))
    await t.user.click(t.rows()[0]!)
    const insp = t.inspector()
    await within(insp).findByRole('heading', { name: 'Facing 1' })
    await t.user.click(within(insp).getByRole('combobox', { name: 'Cutting preset' }))
    await t.user.click(await screen.findByRole('option', { name: 'Auto (calculator)' }))
    await waitFor(() =>
      expect(t.callsOf('plan.operation.update')).toContainEqual(
        expect.objectContaining({ auto: true }),
      ),
    )
    const spindleLock = await within(insp).findByRole('button', { name: 'Lock Spindle speed' })
    expect(spindleLock).toHaveAttribute('aria-pressed', 'false')
    // facing: speed, feed, stepdown and stepover can be locked; plunge rate can't
    for (const name of ['Lock Feed rate', 'Lock Stepdown', 'Lock Stepover'])
      expect(within(insp).getByRole('button', { name })).toBeInTheDocument()
    expect(within(insp).queryByRole('button', { name: 'Lock Plunge rate' })).toBeNull()
    expect(within(insp).getAllByText('Recommended by the calculator.').length).toBeGreaterThan(0)

    // locking pins the shown value
    await t.user.click(spindleLock)
    await waitFor(() =>
      expect(t.callsOf('plan.operation.update')).toContainEqual(
        expect.objectContaining({ locks: { spindleSpeed: true } }),
      ),
    )
    await waitFor(() =>
      expect(within(insp).getByRole('button', { name: 'Lock Spindle speed' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    await within(insp).findByText('Locked: the other values follow it.')
    expect(t.s.plan(t.planId()).setups[0]!.operations[0]!.locked).toEqual(['spindleSpeed'])

    // unlocking keeps the value as entered, with the way back to the recommendation
    await t.user.click(within(insp).getByRole('button', { name: 'Lock Spindle speed' }))
    await within(insp).findByText(/^Entered by you\. Recommended \d+ rpm\.$/)
    await t.user.click(within(insp).getByRole('button', { name: /^Use \d+ rpm$/ }))
    await waitFor(() =>
      expect(t.s.plan(t.planId()).setups[0]!.operations[0]!.overrides.spindleSpeed).toBeUndefined(),
    )

    // a value above the machine's spindle: the lock is disabled with the reason shown
    const speed = within(insp).getByLabelText('Spindle speed', { selector: 'input' })
    await t.user.clear(speed)
    await t.user.type(speed, '40000{Enter}')
    const reason = "40000 rpm is above this machine's 30000 rpm."
    await within(insp).findByText(reason)
    const disabled = within(insp).getByRole('button', { name: 'Lock Spindle speed' })
    expect(disabled).toHaveAttribute('aria-disabled', 'true')
    expect(disabled).toHaveAccessibleDescription(reason)
    await expectNoAxeViolations()
  })

  it('assigns a tool from the picker; a drill without cutting data shows errors until overridden', async () => {
    const t = await renderPlan()
    await waitFor(() => expect(t.rows().length).toBeGreaterThan(0))
    const drillRow = [...t.rows()].find((b) => /^Drilling 1/.test(b.textContent ?? ''))!
    await t.user.click(drillRow)
    const insp = t.inspector()
    const assign = async (option: RegExp, id: string) => {
      await t.user.click(await within(insp).findByRole('combobox', { name: 'Tool' }))
      await t.user.click(await screen.findByRole('option', { name: option }))
      await waitFor(() =>
        expect(t.callsOf('plan.tool.assign')).toContainEqual(
          expect.objectContaining({ toolLibraryItemId: id }),
        ),
      )
    }
    // helical boring with the 4 mm end mill, then back to the drill
    await assign(/^Flat 4/, t.s.tools.flat4)
    await waitFor(() =>
      expect(within(insp).getByRole('combobox', { name: 'Tool' })).toHaveTextContent(/^Flat 4/),
    )
    await assign(/^Drill 6/, t.s.tools.drill6)
    // no preset and no calculator data: the fields say so; Generate is blocked
    await within(insp).findAllByText(/No value: enter one/)
    // auto mode is unavailable, with the reason; no locks
    await within(insp).findByText(/^Auto \(calculator\) is unavailable\. No feeds-and-speeds data/)
    expect(within(insp).queryByRole('button', { name: /^Lock / })).toBeNull()
    expect(within(t.nav()).getByRole('button', { name: 'Generate toolpaths' })).toBeDisabled()
    for (const [label, value] of [
      ['Spindle speed', '3000'],
      ['Feed rate', '150'],
      ['Plunge rate', '150'],
    ] as const) {
      const input = within(insp).getByLabelText(label, { selector: 'input' })
      await t.user.type(input, `${value}{Enter}`)
      await waitFor(() =>
        expect(t.callsOf('plan.operation.update')).toContainEqual(
          expect.objectContaining({
            overrides: {
              [label === 'Spindle speed'
                ? 'spindleSpeed'
                : label === 'Feed rate'
                  ? 'feedRate'
                  : 'plungeRate']: value,
            },
          }),
        ),
      )
    }
  })

  it('generates toolpaths as a job and exports gCode through the save dialog, with the warnings', async () => {
    const t = await renderPlan({
      setup: async (s) => {
        const planId = Object.keys(s.d.doc.plans)[0]!
        for (const op of s.d.doc.plans[planId]!.setups[0]!.operations.filter(
          (o) =>
            s.d.doc.plans[planId]!.snapshots.find((x) => x.id === o.tool)?.values['name'] ===
            'Drill 6',
        ))
          await s.run('plan.operation.update', {
            planId,
            planOperationId: op.id,
            overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
          })
      },
    })
    let generated = false
    t.bridge.handle('plan.toolpath.generate', () => ok({ jobId: 'job-1' }))
    t.bridge.handle('job.get', () => {
      generated = true
      return ok({
        state: 'finished',
        progress: { done: 7, total: 7 },
        outcome: { ok: true, value: { operations: [] } },
      })
    })
    t.bridge.handle('plan.toolpath.get', () =>
      ok({
        toolpath: generated
          ? {
              planOperationId: 'x',
              tool: 't',
              spindleSpeed: 1000,
              passes: [
                {
                  kind: 'rough',
                  moves: [
                    { kind: 'rapid', to: [0, 0, 5] },
                    { kind: 'line', to: [0, 0, -1], feed: 100 },
                  ],
                },
              ],
              stats: { cutLength: 1, rapidLength: 0, estimatedSeconds: 1 },
            }
          : null,
        stale: false,
      }),
    )
    await waitFor(() => expect(t.rows().length).toBeGreaterThan(0))
    const generate = within(t.nav()).getByRole('button', { name: 'Generate toolpaths' })
    await waitFor(() => expect(generate).toBeEnabled())
    // DF45: the next step is the primary; Export still works and says it generates first
    const exportButton = within(t.nav()).getByRole('button', { name: 'Export gCode…' })
    expect(generate).toHaveAttribute('data-variant', 'primary')
    expect(exportButton).toHaveAttribute('data-variant', 'default')
    expect(exportButton).toHaveAccessibleDescription(
      /^Export generates the \d+ missing or outdated toolpaths first\.$/,
    )
    await t.user.click(generate)
    await within(t.nav()).findByText('All toolpaths up to date.')
    expect(generate).toHaveAttribute('data-variant', 'default')
    expect(exportButton).toHaveAttribute('data-variant', 'primary')
    expect(exportButton).not.toHaveAccessibleDescription()
    expect(t.callsOf('plan.toolpath.generate')).toEqual([{ planId: t.planId() }])

    t.bridge.setFileChoice({ export: '/out/Plan 1.nc' })
    t.bridge.handle('plan.export', () =>
      ok({
        filePath: '/out/Plan 1.nc',
        lines: 1234,
        stats: { estimatedSeconds: 725, toolChanges: 2 },
        warnings: [
          {
            code: 'plan.machine',
            severity: 'warning',
            message: 'feed 1200 mm/min exceeds the Z max feed rate 1000 mm/min',
            rule: 'maxFeedRate',
            params: {},
          },
        ],
        softLimitChecked: false,
        regenerated: [],
      }),
    )
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Export gCode…' }))
    const dialog = await screen.findByRole('dialog', { name: 'gCode exported' })
    expect(t.bridge.exportDialogNames).toEqual(['bracket']) // short file name (DF62)
    expect(t.callsOf('plan.export')).toEqual([
      { planId: t.planId(), target: '/out/Plan 1.nc', confirm: true },
    ])
    // the file name in the description, its folder on a line; Show in Finder reveals it (DF48)
    expect(dialog).toHaveAccessibleDescription('The GRBL program was written to Plan 1.nc.')
    expect(within(dialog).getByText('In /out')).toHaveAttribute('title', '/out/Plan 1.nc')
    await t.user.click(within(dialog).getByRole('button', { name: /^Show in (Finder|folder)$/ }))
    expect(t.bridge.shownInFolder).toEqual(['/out/Plan 1.nc'])
    expect(within(dialog).getByText('1234 lines')).toBeInTheDocument()
    expect(within(dialog).getByText('About 12 min 5 s without tool changes')).toBeInTheDocument()
    expect(within(dialog).getByRole('list', { name: 'Export warnings' })).toHaveTextContent(
      'Feed 1200 mm/min exceeds the Z max feed rate 1000 mm/min.',
    )
    await expectNoAxeViolations()
    await t.user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('offers a rebuild when a settled plan’s design changed', async () => {
    const t = await renderPlan({
      setup: async (s) => {
        const planId = Object.keys(s.d.doc.plans)[0]!
        await s.toStatus(planId, 'settledDesign')
        const facing = s.part().operations.find((o) => o.kind === 'facing')!
        await s.run('design.facing.update', {
          partId: s.partId,
          operationId: facing.id,
          depth: '1',
        })
      },
    })
    const banner = await within(t.nav()).findByText('The design changed since this plan was made.')
    expect(banner).toBeInTheDocument()
    expect(within(t.nav()).getAllByText('Changed in design').length).toBeGreaterThan(0)
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Rebuild plan' }))
    await waitFor(() =>
      expect(
        within(t.nav()).queryByText('The design changed since this plan was made.'),
      ).toBeNull(),
    )
    expect(t.callsOf('plan.rebuild')).toEqual([{ planId: t.planId() }])
  })

  it('names where the tool came from and when the design’s tool field changed (F5)', async () => {
    const t = await renderPlan({
      setup: async (s) => {
        const planId = Object.keys(s.d.doc.plans)[0]!
        await s.toStatus(planId, 'settledDesign')
        const facing = s.part().operations.find((o) => o.kind === 'facing')!
        await s.run('design.operation.tool.set', {
          partId: s.partId,
          operationId: facing.id,
          tool: { kind: 'generalized', type: 'flatEndMill', diameter: '4 mm' },
        })
      },
    })
    await waitFor(() => expect(t.rows().length).toBeGreaterThan(0))
    await t.user.click(t.rows()[0]!)
    const insp = t.inspector()
    await within(insp).findByRole('heading', { name: 'Facing 1' })
    expect(await within(insp).findByText('From the design’s tool field.')).toBeInTheDocument()
    expect(
      await within(insp).findByText(/^The design’s tool field changed since this plan was made\./),
    ).toBeInTheDocument()
    // a tool chosen in the plan is kept
    await t.user.click(within(insp).getByRole('combobox', { name: 'Tool' }))
    await t.user.click(await screen.findByRole('option', { name: /^Flat 4/ }))
    expect(await within(insp).findByText('Chosen in this plan.')).toBeInTheDocument()
    expect(
      await within(insp).findByText(
        'The design’s tool field changed. This plan keeps the tool chosen here.',
      ),
    ).toBeInTheDocument()
  })

  it('shows a finalized plan read-only with the way out', async () => {
    const t = await renderPlan({
      setup: async (s) => s.toStatus(Object.keys(s.d.doc.plans)[0]!, 'finalized'),
    })
    await within(t.nav()).findByText(/Finalized plans are read-only/)
    expect(within(t.nav()).queryByRole('button', { name: /^Move / })).toBeNull()
    expect(within(t.nav()).queryByRole('button', { name: /^Actions for / })).toBeNull()
    // the setup's fields are in the inspector (task F6), read-only too
    await t.user.click(within(t.nav()).getByRole('button', { name: /^Top/ }))
    expect(
      within(t.inspector()).getByLabelText('Clearance height', { selector: 'input' }),
    ).toHaveAttribute('readonly')
  })
})
