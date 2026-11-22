// Clones UI (v0.4 task U3) against the fake bridge bound to a real project runtime: the Make
// Clones… draft (nothing written until Make clones, Escape cancels, the read-out from the
// throttled preview, the 100-instance error), the rows editor, the Clones inspector's read-out,
// Skip / Restore from the navigator's instance rows and the chips, and the instance inspector.
// The canvas is stubbed (the viewport's markers: e2e/features.e2e.ts).
// Doc: docs/conventions/ui.md#clones
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dispatcher } from '../../../../core/commands/dispatcher'
import type { PartDTO } from '../../../../core/design/part.dto'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge, designDispatcher, type FakeBridge } from '../../test/bridge'
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

const ui = { kind: 'ui', id: 'test' } as const

async function renderDesign(setup?: (d: Dispatcher) => Promise<void>) {
  const bridge: FakeBridge = createFakeBridge()
  const d = await designDispatcher()
  const stock = await d.dispatch(
    'library.stock.add',
    {
      values: {
        name: 'Block',
        shape: 'block',
        length: '100',
        width: '60',
        thickness: '20',
        material: { name: '6061-T6', class: 'aluminum' },
      },
    },
    ui,
  )
  await d.dispatch(
    'design.part.add',
    { name: 'Bracket', stockLibraryItemId: (stock.unwrap().value as { id: string }).id },
    ui,
  )
  await setup?.(d)
  bridge.bind(d, 'p1', { file: '/p/bracket.dfyom' })
  const r = renderUi(
    <ShellProvider shell={createShell(bridge)}>
      <App />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const part = (): PartDTO => Object.values(d.doc.parts)[0]!
  const openAdd = async () => {
    within(navigator()).getByRole('button', { name: 'Add' }).focus()
    await r.user.keyboard('{Enter}')
    return screen.findByRole('menu')
  }
  return { ...r, bridge, d, part, openAdd }
}

const navigator = () => screen.getByRole('navigation', { name: 'Navigator' })
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
const partId = (d: Dispatcher) => Object.keys(d.doc.parts)[0]!

const addPocket = async (d: Dispatcher) => {
  await d.dispatch(
    'design.pocket.add',
    {
      partId: partId(d),
      shape: { kind: 'circle', center: ['20', '30'], diameter: '10' },
      depth: '5',
    },
    ui,
  )
}

const readout = () => within(inspector()).getAllByText(/instances? ·|limited to/)[0]!

async function openDraft() {
  const r = await renderDesign(addPocket)
  await r.user.click(await within(navigator()).findByRole('button', { name: /^Pocket 1/ }))
  const menu = await r.openAdd()
  await r.user.click(within(menu).getByRole('menuitem', { name: 'Make Clones…' }))
  await within(inspector()).findByRole('button', { name: 'Make clones' })
  await waitFor(() => expect(readout()).toHaveTextContent('1 + 1 clone = 2 instances · 0 skipped'))
  return r
}

async function expandInstances(user: ReturnType<typeof renderUi>['user']) {
  const row = await within(navigator()).findByRole('button', { name: /^Clones 1, ×/ })
  row.focus()
  await user.keyboard('{ArrowRight}')
  await user.click(within(navigator()).getByRole('button', { name: /^Clones\s*\d+$/ }))
}

describe('Clones UI (U3)', () => {
  it('Make Clones… opens a draft: Source, one offset row, read-out; Escape writes nothing', async () => {
    const { user, part, d } = await openDraft()
    const revision = d.revision
    expect(within(inspector()).getByText('New Clones')).toBeInTheDocument()
    expect(within(inspector()).getByText('Pocket 1')).toBeInTheDocument()
    const rows = within(inspector()).getByRole('list', { name: 'Rows in path order' })
    expect(within(rows).getByRole('button', { name: /^Row 1: Offset, / })).toBeInTheDocument()
    await expectNoAxeViolations()
    within(inspector()).getByRole('button', { name: 'Cancel' }).focus()
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(within(inspector()).queryByRole('button', { name: 'Make clones' })).toBeNull(),
    )
    expect(part().features ?? []).toHaveLength(0)
    expect(d.revision).toBe(revision)
  })

  it('a grid row, Make clones, then skip from an instance row and restore from the chip', async () => {
    const { user, part } = await openDraft()
    await user.click(within(inspector()).getByRole('button', { name: `Remove row 1` }))
    // the last row stays: removing it is refused with its reason
    expect(within(inspector()).getByRole('button', { name: /^Row 1: Offset/ })).toBeInTheDocument()
    await user.click(within(inspector()).getByRole('button', { name: 'Add row' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Grid' }))
    await user.click(within(inspector()).getByRole('button', { name: 'Remove row 1' }))
    await waitFor(() =>
      expect(within(inspector()).getByRole('button', { name: /^Row 1: Grid/ })).toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(readout()).toHaveTextContent('1 + 3 clones = 4 instances · 0 skipped'),
    )
    await user.click(within(inspector()).getByRole('button', { name: 'Make clones' }))
    await waitFor(() => expect(part().features?.[0]?.kind).toBe('clones'))
    await within(inspector()).findByRole('textbox', { name: 'Name' })
    expect(readout()).toHaveTextContent('1 + 3 clones = 4 instances · 0 skipped')
    // the Clones group of the navigator: Skip clone 3
    await expandInstances(user)
    await user.click(within(navigator()).getByRole('button', { name: 'Skip clone 3' }))
    await waitFor(() =>
      expect(readout()).toHaveTextContent('1 + 2 clones = 3 instances · 1 skipped'),
    )
    expect(part().features?.[0]?.['rows']).toMatchObject([{ kind: 'grid', skip: [1] }])
    await user.click(within(inspector()).getByRole('button', { name: 'Restore clone 3' }))
    await waitFor(() => expect(readout()).toHaveTextContent('0 skipped'))
    await expectNoAxeViolations()
  })

  it('an instance selects to its read-only inspector with Skip this clone', async () => {
    const { user, part } = await openDraft()
    await user.click(within(inspector()).getByRole('button', { name: 'Make clones' }))
    await waitFor(() => expect(part().features?.[0]?.kind).toBe('clones'))
    await expandInstances(user)
    await user.click(within(navigator()).getByRole('button', { name: 'Clone 2' }))
    expect(within(inspector()).getByText('Clone 2 of Clones 1')).toBeInTheDocument()
    expect(within(inspector()).getByText(/^u \d+\.\d{2} mm, v 30\.00 mm$/)).toBeInTheDocument()
    expect(within(inspector()).getByText('Pocket 1 · 2')).toBeInTheDocument()
    await expectNoAxeViolations()
    await user.click(within(inspector()).getByRole('button', { name: 'Skip this clone' }))
    await waitFor(() => expect(part().features?.[0]?.['rows']).toMatchObject([{ skip: [0] }]))
    expect(await within(inspector()).findByText(/This clone is skipped/)).toBeInTheDocument()
    await user.click(within(inspector()).getByRole('button', { name: 'Restore' }))
    await waitFor(() =>
      expect((part().features?.[0]?.['rows'] as { skip?: number[] }[])[0]?.skip ?? []).toEqual([]),
    )
  })

  it('over 100 instances: the read-out says by how many and Make clones is refused', async () => {
    const { user, part } = await openDraft()
    await user.click(within(inspector()).getByRole('button', { name: 'Add row' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Grid' }))
    const cols = within(inspector()).getByRole('textbox', { name: 'Columns' })
    await user.clear(cols)
    await user.type(cols, '10{Enter}')
    const rowsField = within(inspector()).getByRole('textbox', { name: 'Rows' })
    await user.clear(rowsField)
    await user.type(rowsField, '10{Enter}')
    await waitFor(() =>
      expect(readout()).toHaveTextContent(
        '101 instances: Clones are limited to 100. Remove or skip 1.',
      ),
    )
    // the crossing row says it too
    expect(within(inspector()).getAllByText(/limited to 100/)).toHaveLength(2)
    await user.click(within(inspector()).getByRole('button', { name: 'Make clones' }))
    expect(part().features ?? []).toHaveLength(0)
    await expectNoAxeViolations()
  })
})
