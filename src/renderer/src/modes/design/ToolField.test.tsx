// The tool field (task F5) against the fake bridge bound to a real project runtime (design and
// library commands, the apply hooks, in-memory library): the auto choice on Apply with its
// source note and reason, "Chosen again on Apply" (muted) and "May change on Apply" checks while
// edits wait, the lock (one undo step), picking a library tool (locks), the fix of a locked tool
// that stopped fitting, and axe. The viewport canvas is stubbed.
// Doc: docs/modes/design-v0.2.md#implementation-task-f5, docs/conventions/ui.md#testing
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dispatcher } from '../../../../core/commands/dispatcher'
import type { OperationDTO, PartDTO } from '../../../../core/design/part.dto'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import type { ToolChangeView } from '../../state/pending'
import { createFakeBridge, designDispatcher } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { autoChangeReason, operationPending } from './ToolField'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

const UI = { kind: 'ui', id: 'test' } as const

async function renderPocket(kind: 'pocket' | 'profile' = 'pocket') {
  const bridge = createFakeBridge()
  const d: Dispatcher = await designDispatcher()
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
    UI,
  )
  await d.dispatch(
    'design.part.add',
    { name: 'Bracket', stockLibraryItemId: (stock.unwrap().value as { id: string }).id },
    UI,
  )
  bridge.bind(d, 'p1', { file: '/p/bracket.dfyom' })
  const shell = createShell(bridge)
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const nav = screen.getByRole('navigation', { name: 'Navigator' })
  await r.user.click(await within(nav).findByRole('button', { name: `Add ${kind}` }))
  const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
  await within(inspector()).findByRole('heading', {
    name: kind === 'pocket' ? 'Pocket 1' : 'Profile 1',
  })
  const op = (): OperationDTO => Object.values(d.doc.parts)[0]!.operations[0]!
  const group = () => within(inspector()).getByRole('region', { name: 'Tool' })
  const combo = () => within(group()).getByRole('combobox', { name: 'Tool' })
  const lock = () => within(group()).getByRole('button', { name: 'Lock tool' })
  const apply = async () => {
    await shell.pending.apply()
  }
  const addTool = async (
    name: string,
    diameter: string,
    presets: unknown[] = [],
    extra: Record<string, string> = {},
  ) =>
    (
      (
        await d.dispatch(
          'library.tool.add',
          {
            values: {
              name,
              type: 'flatEndMill',
              diameter,
              fluteLength: '25',
              overallLength: '60',
              fluteCount: '2',
              presets,
              ...extra,
            },
          },
          UI,
        )
      ).unwrap().value as { id: string }
    ).id
  return { ...r, d, bridge, shell, inspector, op, group, combo, lock, apply, addTool }
}

const ALU_PRESET = {
  name: 'Alu',
  materialClass: 'aluminum',
  spindleSpeed: '18000',
  feedRate: '800',
  plungeRate: '200',
}

describe('tool field', () => {
  it('is the group after on’s; the auto choice runs on Apply and says why it changed', async () => {
    const { user, inspector, group, combo, lock, apply, op } = await renderPocket()
    const groups = within(inspector())
      .getAllByRole('region')
      .map((g) => g.getAttribute('aria-label'))
    expect(groups.indexOf('Tool')).toBe(groups.indexOf('Depth') + 1)
    // added, not applied: no tool yet, the lock can't pin anything
    expect(combo()).toHaveTextContent('No tool yet')
    expect(
      within(group()).getByText('No tool yet. Apply chooses one, or pick one from the list.'),
    ).toBeInTheDocument()
    expect(lock()).toHaveAttribute('aria-disabled', 'true')
    await apply()
    // empty library: the largest standard size that fits the 3 mm corner
    await waitFor(() => expect(combo()).toHaveTextContent('6 mm flat end mill'))
    expect(within(group()).getByText('Chosen automatically.')).toBeInTheDocument()
    expect(lock()).toHaveAttribute('aria-pressed', 'false')
    expect(lock()).not.toHaveAttribute('aria-disabled')
    // no matching library tool: Plan needs one
    expect(within(group()).getByText(/Plan needs a 6 mm flat end mill/)).toBeInTheDocument()

    // a commit without Apply (Tab): the tool is chosen again on Apply, its checks may change
    const corner = within(inspector()).getByLabelText('Corner radius', { selector: 'input' })
    await user.clear(corner)
    await user.type(corner, '2', { skipClick: true })
    await user.tab()
    await waitFor(() => expect(within(group()).getByText('Chosen again on Apply.')).toBeVisible())
    expect(combo()).toHaveAttribute('data-muted')
    expect(
      within(group()).getByText(/Corner radius 2 mm is smaller than the radius of the 6 mm/),
    ).toHaveTextContent(/May change on Apply/)

    await apply()
    await waitFor(() => expect(combo()).toHaveTextContent('4 mm flat end mill'))
    expect(
      within(group()).getByText(
        'Chosen automatically: the 6 mm flat end mill didn’t fit the 2 mm corner.',
      ),
    ).toBeInTheDocument()
    expect(combo()).not.toHaveAttribute('data-muted')
    expect(op().toolLocked).toBeUndefined()
    await expectNoAxeViolations()
  })

  it('locks and unlocks as one undo step each; picking a library tool locks it', async () => {
    const { user, d, group, combo, lock, apply, op, addTool } = await renderPocket()
    await apply()
    await waitFor(() => expect(combo()).toHaveTextContent('6 mm flat end mill'))
    await user.click(lock())
    await waitFor(() => expect(lock()).toHaveAttribute('aria-pressed', 'true'))
    expect(within(group()).getByText('Chosen by you.')).toBeInTheDocument()
    expect(op().toolLocked).toBe(true)
    await user.click(await screen.findByRole('button', { name: /^Undo Lock tool/ }))
    await waitFor(() => expect(lock()).toHaveAttribute('aria-pressed', 'false'))

    // the library's tools of the type: those that fit in auto-choice order (preset first) with
    // their reasons, then the others nearest first, saying what does not fit (DF42)
    const flat3 = await addTool('Flat 3', '3', [ALU_PRESET])
    await addTool('Flat 5', '5')
    await addTool('Flat 8', '8') // too wide for the 3 mm corner: listed, last
    await user.click(combo())
    const list = await screen.findByRole('listbox')
    // the list re-reads the candidates when it opens (library edits change no revision)
    await waitFor(() => expect(within(list).getAllByRole('group')).toHaveLength(3))
    const groups = within(list).getAllByRole('group')
    expect(within(groups[0]!).getByText('Generalized tool')).toBeInTheDocument()
    expect(within(groups[1]!).getByText('Library')).toBeInTheDocument()
    await waitFor(() => expect(within(groups[1]!).getAllByRole('option')).toHaveLength(3))
    const library = within(groups[1]!).getAllByRole('option')
    expect(library.map((o) => o.textContent)).toEqual([
      expect.stringMatching(/^Flat 3 · Ø 3 mm/),
      expect.stringMatching(/^Flat 5 · Ø 5 mm/),
      expect.stringMatching(/^Flat 8 · Ø 8 mm/),
    ])
    expect(library[0]).toHaveAccessibleDescription('2 flutes · Has a preset for aluminium')
    expect(library[1]).toHaveAccessibleDescription('2 flutes')
    expect(library[2]).toHaveAccessibleDescription(
      '2 flutes · Doesn’t fit: too wide for the 3 mm corner',
    )
    await expectNoAxeViolations()
    await user.click(library[0]!)
    await waitFor(() => expect(combo()).toHaveTextContent('Flat 3 · Ø 3 mm'))
    expect(lock()).toHaveAttribute('aria-pressed', 'true')
    expect(op().tool).toMatchObject({ kind: 'specific' })
    const snap = d.doc.snapshots[(op().tool as { snapshotId: string }).snapshotId]!
    expect(snap.libraryItemId).toBe(flat3)
  })

  it('a locked tool that stops fitting warns at the field with a fitting tool as its fix', async () => {
    const { user, inspector, group, combo, lock, apply, op } = await renderPocket()
    await apply()
    await waitFor(() => expect(combo()).toHaveTextContent('6 mm flat end mill'))
    await user.click(lock())
    await waitFor(() => expect(lock()).toHaveAttribute('aria-pressed', 'true'))
    const corner = within(inspector()).getByLabelText('Corner radius', { selector: 'input' })
    await user.clear(corner)
    await user.type(corner, '2{Enter}', { skipClick: true })
    // locked: never replaced, the check is final (no "May change on Apply")
    const warning = await within(group()).findByText(
      'Corner radius 2 mm is smaller than the radius of the 6 mm flat end mill (3 mm). Unlock it or pick another tool.',
    )
    expect(warning).not.toHaveTextContent(/May change on Apply/)
    expect(combo()).toHaveTextContent('6 mm flat end mill')
    await user.click(within(group()).getByRole('button', { name: 'Use 4 mm flat end mill' }))
    await waitFor(() => expect(combo()).toHaveTextContent('4 mm flat end mill'))
    expect(op().toolLocked).toBe(true)
    expect(within(group()).queryByText(/Unlock it or pick another tool/)).toBeNull()
  })
})

describe('tool field: library tools of the type (DF42)', () => {
  const WEXME = { fluteCount: '1', fluteLength: '20', stickout: '30.9', shankDiameter: '6.35' }

  it('offers the nearest library tool of the type beside Add to library; using it locks it', async () => {
    const { user, inspector, group, combo, lock, apply, op, addTool, d } =
      await renderPocket('profile')
    // a 7.6 mm flat is 27 % off the 6 mm: listed, never offered as the near match
    await addTool('Flat 7.6', '7.6')
    const wexme = await addTool('wexme 1/4" 1F', '6.22', [], WEXME)
    await apply()
    // the default 6 mm slot: the library's tools are wider, auto takes the generalized 6 mm
    await waitFor(() => expect(combo()).toHaveTextContent('6 mm flat end mill'))
    expect(within(group()).getByText(/Plan needs a 6 mm flat end mill/)).toBeInTheDocument()
    const use = await within(group()).findByRole('button', { name: 'Use wexme 1/4" 1F (6.22 mm)' })
    expect(within(group()).getByRole('button', { name: 'Add to library' })).toBeInTheDocument()
    await expectNoAxeViolations()

    // the list: every flat end mill of the library, nearest the 6 mm first, with why it doesn't fit
    await user.click(combo())
    const list = await screen.findByRole('listbox')
    const library = within(list).getAllByRole('group')[1]!
    const options = within(library).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringMatching(/^wexme 1\/4" 1F · Ø 6.22 mm/),
      expect.stringMatching(/^Flat 7.6 · Ø 7.6 mm/),
    ])
    expect(options[0]).toHaveAccessibleDescription(
      '1 flute · Doesn’t fit: wider than the 6 mm slot',
    )
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())

    await user.click(use)
    await waitFor(() => expect(combo()).toHaveTextContent('wexme 1/4" 1F · Ø 6.22 mm'))
    expect(lock()).toHaveAttribute('aria-pressed', 'true')
    const snap = d.doc.snapshots[(op().tool as { snapshotId: string }).snapshotId]!
    expect(snap.libraryItemId).toBe(wexme)

    // wider than the slot: widening it is the user's explicit choice, the generalized tool the other
    await within(group()).findByText(/is wider than the slot \(6 mm\)/)
    expect(within(group()).getByRole('button', { name: 'Use 6 mm flat end mill' })).toBeVisible()
    await user.click(within(group()).getByRole('button', { name: 'Widen slot to 6.22 mm' }))
    await waitFor(() =>
      expect((op() as { slotWidth: { source: string } }).slotWidth.source).toBe('6.22 mm'),
    )
    await waitFor(() => expect(within(group()).queryByText(/is wider than the slot/)).toBeNull())
    expect(combo()).toHaveTextContent('wexme 1/4" 1F · Ø 6.22 mm')
    expect(within(inspector()).getByLabelText('Slot width', { selector: 'input' })).toHaveValue(
      '6.22 mm',
    )
  })

  it('picking a tool that does not fit locks it and the check says why', async () => {
    const { user, group, combo, lock, apply, addTool } = await renderPocket()
    await apply()
    await waitFor(() => expect(combo()).toHaveTextContent('6 mm flat end mill'))
    await addTool('Flat 8', '8')
    await user.click(combo())
    await user.click(await screen.findByRole('option', { name: /^Flat 8 · Ø 8 mm/ }))
    await waitFor(() => expect(combo()).toHaveTextContent('Flat 8 · Ø 8 mm'))
    expect(lock()).toHaveAttribute('aria-pressed', 'true')
    // a pocket has no single width to widen: the fix is the generalized tool that fits
    expect(
      await within(group()).findByText(
        /Corner radius 3 mm is smaller than the radius of the Flat 8/,
      ),
    ).toBeInTheDocument()
    expect(within(group()).getByRole('button', { name: 'Use 6 mm flat end mill' })).toBeVisible()
    expect(within(group()).queryByRole('button', { name: /^Widen/ })).toBeNull()
  })
})

describe('tool field: new tool (L4)', () => {
  it('adds a library tool prefilled from the generalized one and locks it', async () => {
    const { user, d, combo, lock, apply, op } = await renderPocket()
    await apply()
    await waitFor(() => expect(combo()).toHaveTextContent('6 mm flat end mill'))
    await user.click(combo())
    const list = await screen.findByRole('listbox')
    const options = within(list).getAllByRole('option')
    expect(options.at(-1)).toHaveTextContent('New tool…')
    await user.click(options.at(-1)!)
    const dialog = await screen.findByRole('dialog', { name: 'New tool' })
    // prefilled: type and diameter of the generalized tool, the suggested name from them
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('Flat 6 mm')
    expect(within(dialog).getByLabelText('Diameter', { selector: 'input' })).toHaveValue('6 mm')
    await user.click(within(dialog).getByRole('button', { name: 'Add tool' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(op().tool).toMatchObject({ kind: 'specific' }))
    expect(lock()).toHaveAttribute('aria-pressed', 'true')
    const snap = d.doc.snapshots[(op().tool as { snapshotId: string }).snapshotId]!
    expect((snap.values as { name: string }).name).toBe('Flat 6 mm')
    await waitFor(() => expect(combo()).toHaveTextContent('Flat 6 mm'))
  })
})

describe('tool field helpers', () => {
  const doc = { snapshots: {} } as unknown as Parameters<typeof autoChangeReason>[3]
  const drilling = {
    id: 'drilling1',
    kind: 'drilling',
    name: 'Drilling 1',
    diameter: { kind: 'length', source: '5', defaultUnit: 'mm', exact: { num: '5', den: '1' } },
  } as unknown as OperationDTO
  const change = (over: Partial<ToolChangeView>): ToolChangeView => ({
    partId: 'part1',
    operationId: 'drilling1',
    from: { kind: 'specific', snapshotId: 'snapshot-3' },
    to: { kind: 'specific', snapshotId: 'snapshot-4' },
    reason: 'diameter',
    ...over,
  })

  it('says why from the old tool’s rule, naming a replaced library tool by its kept name', () => {
    expect(autoChangeReason(change({ fromName: 'Drill 6' }), drilling, 'mm', doc)).toBe(
      'the Drill 6 didn’t fit the Ø 5 mm hole',
    )
    // the snapshot is gone and its name unknown
    expect(autoChangeReason(change({}), drilling, 'mm', doc)).toBe(
      'the previous tool didn’t fit the Ø 5 mm hole',
    )
    expect(autoChangeReason(change({ reason: 'unresolved' }), drilling, 'mm', doc)).toBe(
      'the previous tool could not be read',
    )
    // a first choice replaced nothing
    expect(
      autoChangeReason(change({ from: null, reason: 'unset' }), drilling, 'mm', doc),
    ).toBeUndefined()
  })

  it('counts the operation’s own pending changes and its part’s stock or addition', () => {
    const c = (over: object) => ({
      kind: 'design' as const,
      partId: 'part1',
      label: '',
      source: { kind: 'ui', id: 'w' },
      revision: 1,
      ...over,
    })
    const part = {
      id: 'part1',
      name: 'P',
      stock: 's',
      operations: [{ id: 'drilling1' }, { id: 'pocket1' }],
    } as unknown as PartDTO
    const pending = (over: object) => operationPending([c(over)], part, 'drilling1')
    expect(pending({ operationId: 'drilling1', field: 'diameter' })).toBe(true)
    expect(pending({ operationId: 'pocket1', field: 'depth' })).toBe(false)
    expect(pending({ field: 'stock' })).toBe(true)
    expect(pending({ field: 'name' })).toBe(false)
    // a shape key: only the operations using the shape (none before v0.3 K3), never all
    expect(pending({ shapeId: 'shape1', field: 'added' })).toBe(false)
  })
})
