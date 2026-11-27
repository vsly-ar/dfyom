// Clones mirror UI (hardening DF126 M2) against the fake bridge bound to a real project runtime:
// Add row → Mirror in the Make Clones… draft (the card: Mirror in "u (+X)" / "v (+Y)", About,
// the read-outs "· 1 on the line" and "Mirrors 1 · 1 on the line"), a new path row goes above
// the mirror row and a move below it is refused, About → Feature centre by select and by the
// viewport pick, Coordinate, the navigator's "mirrored" instance rows and the instance's
// "Mirrored" fact, and a refusal at a mirror row shown inline by name. The canvas is stubbed.
// Doc: docs/modes/clones-mirror.md#ui, docs/conventions/ui.md#clones
import { render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dispatcher } from '../../../../core/commands/dispatcher'
import type { PartDTO } from '../../../../core/design/part.dto'
import { App } from '../../App'
import { createShell, ShellProvider, type Shell } from '../../shell/ShellContext'
import { createFakeBridge, designDispatcher, type FakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { UiProvider } from '../../ui'
import { CloneRowList } from './CloneRowList'
import { mirrorRefusal } from './ClonesInspector'
import { designPart } from './model'

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
const navigator = () => screen.getByRole('navigation', { name: 'Navigator' })
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
const readout = () => within(inspector()).getAllByText(/instances? ·|limited to/)[0]!
const rowList = () => within(inspector()).getByRole('list', { name: 'Rows in path order' })
const rowNames = () =>
  within(rowList())
    .getAllByRole('button', { name: /^Row \d: / })
    .map((b) => /^Row \d: (\w+)/.exec(b.getAttribute('aria-label') ?? '')?.[1])

async function stockAndPart(d: Dispatcher) {
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
  const partId = Object.keys(d.doc.parts)[0]!
  // the source at (20, 30) and a second pocket at (70, 45) to mirror about
  for (const center of [
    ['20', '30'],
    ['70', '45'],
  ])
    await d.dispatch(
      'design.pocket.add',
      { partId, shape: { kind: 'circle', center, diameter: '10' }, depth: '5' },
      ui,
    )
}

async function openDraft() {
  const bridge: FakeBridge = createFakeBridge()
  const d = await designDispatcher()
  await stockAndPart(d)
  bridge.bind(d, 'p1', { file: '/p/bracket.dfyom' })
  const shell: Shell = createShell(bridge)
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const part = (): PartDTO => Object.values(d.doc.parts)[0]!
  const row = await within(navigator()).findByRole('button', { name: /^Pocket 1/ })
  await r.user.pointer({ keys: '[MouseRight]', target: row })
  const menu = await screen.findByRole('menu', { name: 'Actions for Pocket 1' })
  await r.user.click(within(menu).getByRole('menuitem', { name: 'Make Clones…' }))
  await within(inspector()).findByRole('button', { name: 'Make clones' })
  await waitFor(() => expect(readout()).toHaveTextContent('1 + 1 clone = 2 instances'))
  return { ...r, d, part, shell }
}

describe('Clones mirror UI (DF126 M2)', () => {
  it('Add row → Mirror: the card, its read-outs; a path row goes above it, a move below is refused', async () => {
    const { user } = await openDraft()
    await user.click(within(inspector()).getByRole('button', { name: 'Add row' }))
    const item = await screen.findByRole('menuitem', { name: 'Mirror' })
    expect(item.querySelector('svg[data-icon="row-mirror"]')).not.toBeNull()
    await user.click(item)
    await waitFor(() => expect(rowNames()).toEqual(['Offset', 'Mirror']))
    // the axes as DF127 names them on the top face
    const flip = within(inspector()).getByRole('radiogroup', { name: 'Mirror in' })
    expect(
      within(flip)
        .getAllByRole('radio')
        .map((b) => b.textContent),
    ).toEqual(['u (+X)', 'v (+Y)'])
    expect(within(flip).getByRole('radio', { name: 'u (+X)' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(within(inspector()).getByRole('combobox', { name: 'About' })).toHaveTextContent(
      'Stock centre',
    )
    // the draft's offset clone sits at u 20 + 10 + 3 = 33; their mirrors about u 50: 80 and 67
    await waitFor(() =>
      expect(readout()).toHaveTextContent('1 + 3 clones = 4 instances · 0 on the line · 0 skipped'),
    )
    expect(within(inspector()).getByTestId('mirror-readout')).toHaveTextContent('Mirrors 2')
    expect(
      within(rowList())
        .getByRole('button', { name: /^Row 2: Mirror, / })
        .getAttribute('aria-label'),
    ).toBe('Row 2: Mirror, Mirror · u (+X) · stock centre · 2 positions')
    await expectNoAxeViolations()

    // a new path row goes above the mirror row (mirror rows come last)
    await user.click(within(inspector()).getByRole('button', { name: 'Add row' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Grid' }))
    await waitFor(() => expect(rowNames()).toEqual(['Offset', 'Grid', 'Mirror']))
    // Alt+↓ on the grid would put it below the mirror row: refused, said why
    within(rowList())
      .getByRole('button', { name: /^Row 2: Grid/ })
      .focus()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    // shown by the list and announced
    expect(
      await within(inspector()).findAllByText(
        'Mirror rows come last: move the path rows above them.',
      ),
    ).toHaveLength(2)
    expect(rowNames()).toEqual(['Offset', 'Grid', 'Mirror'])
  })

  it('About: Feature centre by select and by the viewport pick, Coordinate; Make clones', async () => {
    const { user, part, shell } = await openDraft()
    await user.click(within(inspector()).getByRole('button', { name: 'Add row' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Mirror' }))
    // in v (+Y) about Pocket 2's centre (v 45): the source (v 30) → v 60, its clone likewise
    await user.click(within(inspector()).getByRole('radio', { name: 'v (+Y)' }))
    await user.click(within(inspector()).getByRole('combobox', { name: 'About' }))
    await user.click(await screen.findByRole('option', { name: 'Feature centre' }))
    const ref = await within(inspector()).findByRole('combobox', { name: 'Mirror about' })
    expect(ref).toHaveTextContent('Pocket 1')
    await user.click(ref)
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
      'Pocket 1',
      'Pocket 2',
    ])
    await user.keyboard('{Escape}')
    // the pick: a surface of Pocket 2 picks it
    const pick = within(inspector()).getByRole('button', {
      name: 'Pick the item to mirror about in the viewport',
    })
    await user.click(pick)
    const request = shell.ui.getState().pick
    expect(request?.field).toBe('Mirror about')
    request!.onPick('pocket2.floor')
    shell.ui.getState().setPick(null)
    await waitFor(() =>
      expect(within(inspector()).getByRole('combobox', { name: 'Mirror about' })).toHaveTextContent(
        'Pocket 2',
      ),
    )
    await waitFor(() =>
      expect(
        within(rowList()).getByRole('button', { name: /^Row 2: Mirror/ }),
      ).toHaveAccessibleName(/Mirror · v \(\+Y\) · Pocket 2/),
    )
    await expectNoAxeViolations()
    await user.click(within(inspector()).getByRole('button', { name: 'Make clones' }))
    await waitFor(() => expect(part().features?.[0]?.kind).toBe('clones'))
    expect(part().features![0]!['rows']).toMatchObject([
      { kind: 'offset' },
      { kind: 'mirror', flip: 'v', about: 'pocket2' },
    ])
    await waitFor(() =>
      expect(readout()).toHaveTextContent('1 + 3 clones = 4 instances · 0 on the line · 0 skipped'),
    )

    // Coordinate: the line at the current reference's v (45 mm), as one update
    await user.click(within(inspector()).getByRole('button', { name: /^Row 2: Mirror/ }))
    await user.click(within(inspector()).getByRole('combobox', { name: 'About' }))
    await user.click(await screen.findByRole('option', { name: 'Coordinate' }))
    await waitFor(() =>
      expect(part().features![0]!['rows']).toMatchObject([
        { kind: 'offset' },
        { kind: 'mirror', flip: 'v', at: { source: '45 mm' } },
      ]),
    )
    expect(within(inspector()).getByRole('combobox', { name: 'Line at (Y)' })).toBeInTheDocument()

    // the navigator's instance rows: the mirror copies say "mirrored"
    const clones = await within(navigator()).findByRole('button', { name: /^Clones 1, ×4/ })
    clones.focus()
    await user.keyboard('{ArrowRight}')
    await user.click(within(navigator()).getByRole('button', { name: /^\d+ clones?$/ }))
    await user.click(within(navigator()).getByRole('button', { name: 'Clone 3, mirrored' }))
    expect(within(inspector()).getByText('Clone 3 of Clones 1')).toBeInTheDocument()
    expect(within(inspector()).getByText('Mirrored')).toBeInTheDocument()
    expect(within(inspector()).getByText('In v (+Y)')).toBeInTheDocument()
    expect(within(inspector()).getByText(/^u 20\.00 mm, v 60\.00 mm$/)).toBeInTheDocument()
    await expectNoAxeViolations()
  })

  it('a refusal at a mirror row reads by name, inline under its field', async () => {
    const d = await designDispatcher()
    await stockAndPart(d)
    const part = designPart(d.doc)!
    const error = mirrorRefusal(
      {
        code: 'model.invariant',
        message: 'refused',
        issues: [
          {
            path: ['rows', 1, 'about'],
            rule: 'clonesMirrorRef',
            message: 'pocket2 is not on this face',
            params: { about: 'pocket2' },
          },
          {
            path: ['rows', 0, 'kind'],
            rule: 'clonesMirrorLast',
            message: 'a path row after a mirror row: move the mirror rows to the end',
          },
        ],
        frames: [],
      },
      part,
    )
    expect(error.issues.map((i) => i.message)).toEqual([
      'Pocket 2 is not on this face.',
      'Mirror rows come last: move the path rows above them.',
    ])
    const shell = createShell(createFakeBridge())
    render(
      <UiProvider>
        <ShellProvider shell={shell}>
          <CloneRowList
            owner="draft"
            rows={[
              { kind: 'offset', count: 1, du: '30 mm', dv: '0 mm' },
              { kind: 'mirror', flip: 'u', about: 'pocket2' },
            ]}
            axes={{ u: 'X', v: 'Y' }}
            units="mm"
            shapes={[]}
            resolver={undefined}
            data={undefined}
            errors={[
              { path: 'rows.1.about', text: error.issues[0]!.message },
              { path: 'rows.0.kind', text: error.issues[1]!.message },
            ]}
            over={undefined}
            step={10}
            lastAt={{ u: 0, v: 0 }}
            onChange={() => {}}
            onCancelGesture={() => Promise.resolve(true)}
            onRestore={() => {}}
            mirror={{
              labels: { u: 'u (+X)', v: 'v (+Y)' },
              refs: [{ value: 'pocket2', label: 'Pocket 2' }],
            }}
          />
        </ShellProvider>
      </UiProvider>,
    )
    // the offset row's own refusal under its head; open the mirror row for its field's
    expect(screen.getByRole('alert')).toHaveTextContent('Mirror rows come last')
    screen.getByRole('button', { name: /^Row 2: Mirror/ }).click()
    const field = await screen.findByRole('combobox', { name: 'Mirror about' })
    expect(field).toHaveAccessibleDescription(/Pocket 2 is not on this face\./)
    await expectNoAxeViolations()
  })
})
