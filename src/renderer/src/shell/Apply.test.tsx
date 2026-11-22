// Apply in the window (task P3) against the fake bridge bound to a real project runtime (the core
// plan fixture: the test part, library tools and a machine): the toolbar button appears with the
// pending count, the field rule (Enter commits and applies, Tab commits only, an invalid value
// applies nothing, the stock setup never applies), Cmd/Ctrl+Enter and the menu item,
// undo of an Apply, a failed Apply, "Applied by agent", and the draft plan's pending notice with
// "Apply now". The viewport canvas is stubbed. Doc: docs/architecture/apply.md#ui
import { act, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { planSetup, type PlanSetup } from '../../../core/plan/plan.fixture'
import { App } from '../App'
import {
  createFakeBridge,
  designDispatcher,
  errorReply,
  WINDOW_SOURCE,
  type FakeBridge,
} from '../test/bridge'
import { expectNoAxeViolations, renderUi } from '../test/render'
import { createShell, ShellProvider } from './ShellContext'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

async function renderApp(opts: { plan?: boolean; mode?: 'design' | 'plan' } = {}) {
  const s: PlanSetup = await planSetup()
  if (opts.plan === true) await s.create({ machineLibraryItemId: s.machineId })
  const bridge: FakeBridge = createFakeBridge()
  bridge.bind(s.d)
  const shell = createShell(bridge)
  shell.ui.getState().setMode(opts.mode ?? 'design')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  // test windows are narrow: the inspector is an overlay, opened by its toggle
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const toolbar = () => screen.getByRole('banner', { name: 'Main toolbar' })
  const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
  const nav = () => screen.getByRole('navigation', { name: 'Navigator' })
  const applies = () => bridge.calls.filter((c) => c.name === 'project.apply').length
  const pocket = () => s.part().operations.find((o) => o.kind === 'pocket')!
  /** A design edit made in the window (pending until Apply). */
  const edit = async (args: object) =>
    s.d.dispatch(
      'design.pocket.update',
      { partId: s.partId, operationId: pocket().id, ...args },
      WINDOW_SOURCE,
    )
  const selectPocket = async () => {
    await r.user.click(await within(nav()).findByRole('button', { name: /^Pocket 1/ }))
    await within(inspector()).findByRole('heading', { name: 'Pocket 1' })
  }
  const field = (label: string) => within(inspector()).getByLabelText(label, { selector: 'input' })
  /** Types without a pointer click (jsdom boxes are empty: the panel separator takes clicks). */
  const retype = async (el: HTMLElement, text: string) => {
    await r.user.clear(el)
    await r.user.type(el, text, { skipClick: true })
  }
  return {
    ...r,
    s,
    bridge,
    shell,
    toolbar,
    inspector,
    nav,
    applies,
    pocket,
    edit,
    selectPocket,
    field,
    retype,
  }
}

const applyButton = (name: RegExp | string = /^Apply \d+ change/) =>
  screen.findByRole('button', { name })

describe('Apply', () => {
  it('Tab commits only and the toolbar shows "Apply N"; the button applies', async () => {
    const t = await renderApp()
    expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull()
    await t.selectPocket()
    await t.retype(t.field('Depth'), '7')
    await t.user.tab()
    await waitFor(() => expect(t.pocket()).toMatchObject({ depth: { source: '7' } }))
    const button = await applyButton('Apply 1 change')
    expect(within(t.toolbar()).getByRole('button', { name: 'Apply 1 change' })).toBe(button)
    expect(t.applies()).toBe(0)
    await expectNoAxeViolations()

    await t.user.click(button)
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull())
    expect(t.applies()).toBe(1)
    expect(t.s.d.applyState.pending()).toEqual([])
  })

  it('Enter in a field commits and applies, after the commit; an invalid value applies nothing', async () => {
    const t = await renderApp()
    await t.selectPocket()
    await t.edit({ depth: '7' }) // pending from before
    await applyButton('Apply 1 change')

    await t.retype(t.field('Depth'), 'abc{Enter}')
    expect(t.applies()).toBe(0)
    await t.user.keyboard('{Escape}')

    await t.retype(t.field('Depth'), '6{Enter}')
    await waitFor(() => expect(t.applies()).toBe(1))
    const names = t.bridge.calls.map((c) => c.name)
    expect(names.lastIndexOf('project.apply')).toBeGreaterThan(
      names.lastIndexOf('design.pocket.update'),
    )
    await waitFor(() => expect(t.s.d.applyState.pending()).toEqual([]))
    expect(t.pocket()).toMatchObject({ depth: { source: '6' } })
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull())

    // an unchanged value + Enter applies the other pending changes
    await t.edit({ depth: '9' })
    await applyButton('Apply 1 change')
    t.field('Depth').focus()
    await t.user.keyboard('{Enter}')
    await waitFor(() => expect(t.applies()).toBe(2))
  })

  it('Cmd/Ctrl+Enter applies anywhere, and the menu item too; not while a modal dialog is open', async () => {
    const t = await renderApp()
    await t.edit({ depth: '7' })
    await applyButton('Apply 1 change')
    act(() => t.bridge.emitMenu('project.apply'))
    await waitFor(() => expect(t.applies()).toBe(1))

    await t.edit({ depth: '8' })
    await applyButton('Apply 1 change')
    act(() => (document.activeElement as HTMLElement | null)?.blur())
    await t.user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(t.applies()).toBe(2))

    // the shortcut list is a modal dialog: Cmd/Ctrl+Enter and the menu item do nothing
    await t.edit({ depth: '9' })
    await applyButton('Apply 1 change')
    act(() => t.bridge.emitMenu('help.shortcuts'))
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    await t.user.keyboard('{Control>}{Enter}{/Control}')
    act(() => t.bridge.emitMenu('project.apply'))
    expect(t.applies()).toBe(2)
  })

  it('undoing the Apply leaves the edits pending again', async () => {
    // a draft plan follows the design on Apply, so the Apply has its own undo entry
    const t = await renderApp({ plan: true })
    await t.selectPocket()
    await t.retype(t.field('Depth'), '7{Enter}')
    await waitFor(() => expect(t.applies()).toBe(1))
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull())
    await t.user.click(await screen.findByRole('button', { name: /^Undo Apply 1 change/ }))
    await applyButton('Apply 1 change')
  })

  it('shows "Apply failed" with the error and retries on click', async () => {
    const t = await renderApp()
    await t.edit({ depth: '7' })
    let fail = true
    t.bridge.handle('project.apply', async () => {
      if (fail)
        return errorReply({
          code: 'internal.unexpected',
          message: 'hook threw',
          issues: [],
          frames: [],
        })
      const r = await t.s.d.dispatch('project.apply', {}, WINDOW_SOURCE)
      return { ok: true, value: r.unwrap().value, revision: r.unwrap().revision }
    })
    await t.user.click(await applyButton('Apply 1 change'))
    const failed = await applyButton('Apply failed')
    fail = false
    await t.user.click(failed)
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull())
    expect(t.s.d.applyState.pending()).toEqual([])
  })

  it('says "Applied by agent" when an agent applied, then hides', async () => {
    const t = await renderApp()
    await t.edit({ depth: '7' })
    await applyButton('Apply 1 change')
    const agent = { kind: 'agent' as const, id: 'a1' }
    // an agent reads before it writes (stale writes, commands.md)
    expect(t.s.d.query('design.warning.list', { partId: t.s.partId }, agent).isOk()).toBe(true)
    await act(async () => {
      const r = await t.s.d.dispatch(
        'design.pocket.update',
        // not the fixture's own depth (8): that would leave nothing to apply
        { partId: t.s.partId, operationId: t.pocket().id, depth: '9' },
        agent,
        { apply: true },
      )
      expect(r.isOk()).toBe(true)
    })
    await applyButton('Applied by agent')
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Appl/ })).toBeNull())
  })

  it('the stock setup keeps its Enter rule: Enter commits the field, no Apply', async () => {
    const bridge = createFakeBridge()
    bridge.bind(await designDispatcher())
    const { user } = renderUi(
      <ShellProvider shell={createShell(bridge)}>
        <App />
      </ShellProvider>,
    )
    const form = await screen.findByRole('region', { name: 'Set up the part' })
    const length = within(form).getByRole('textbox', { name: 'Length (X)' })
    await user.clear(length)
    await user.type(length, '120{Enter}', { skipClick: true })
    expect(length).toHaveValue('120')
    expect(bridge.calls.filter((c) => c.name === 'project.apply')).toEqual([])
  })

  it('a draft plan with design changes not applied shows the pending notice; "Apply now" applies', async () => {
    const t = await renderApp({ plan: true, mode: 'plan' })
    await within(t.nav()).findByRole('combobox', { name: 'Plan status' })
    await act(async () => {
      await t.edit({ depth: '7' })
    })
    const notice = await within(t.nav()).findByText(
      'Design changes not applied yet. This draft plan updates on Apply.',
    )
    // instead of the stale notice
    expect(within(t.nav()).queryByText('The design changed since this plan was made.')).toBeNull()
    expect(notice).toBeInTheDocument()
    await expectNoAxeViolations()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Apply now' }))
    await waitFor(() =>
      expect(
        within(t.nav()).queryByText(
          'Design changes not applied yet. This draft plan updates on Apply.',
        ),
      ).toBeNull(),
    )
    expect(t.applies()).toBe(1)
  })
})
