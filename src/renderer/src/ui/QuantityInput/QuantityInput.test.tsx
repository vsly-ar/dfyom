// Spec: docs/conventions/ui.md#quantity-and-expression-input (task 3.4); grammar edge cases from
// the plan's known issues (`+1/2` deviation pair, `D -1/2`, Greek mu).
import { act, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ReferenceResolver } from '../../../../core/expression/evaluate'
import { quantityFromSource } from '../../../../core/expression/quantity'
import { Quantity, type ParseContext } from '../../../../core/quantity/quantity'
import { Rational } from '../../../../core/quantity/rational'
import { fail, None, Ok, Some } from '../../../../shared/result'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { ECHO_DELAY_MS, QuantityInput, type QuantityInputBaseProps } from './QuantityInput'
import { StepScaleProvider } from './StepContext'

const MM: ParseContext = { kind: 'length', defaultUnit: 'mm' }

const q = (source: string, resolver: ReferenceResolver = { resolve: () => None }): Quantity =>
  quantityFromSource(source, MM, resolver).unwrap()

const REFS: ReadonlyMap<string, Quantity> = new Map([
  ['D', q('6')],
  ['pocket1.floor.z', q('6 ±0.1')],
  ['pocket1.depth', q('3')],
])
const resolver: ReferenceResolver = {
  resolve: (name) => {
    const v = REFS.get(name)
    return v ? Some(v) : None
  },
}

type HarnessProps = Partial<QuantityInputBaseProps> & {
  initial?: string | undefined
  optional?: boolean
  onCommit?: (v: Quantity | undefined) => void
}

/** Stores what it commits, like the document replica after a command. */
function Harness({ initial, optional, onCommit, ...props }: HarnessProps): React.JSX.Element {
  const [value, setValue] = useState<Quantity | undefined>(
    initial === undefined ? undefined : q(initial, resolver),
  )
  const commit = (v: Quantity | undefined): void => {
    onCommit?.(v)
    setValue(v)
  }
  return (
    <QuantityInput
      label="Width"
      kind="length"
      defaultUnit="mm"
      resolver={resolver}
      value={value}
      {...props}
      {...(optional === true ? { optional, onCommit: commit } : { onCommit: commit })}
    />
  )
}

function setup(props: HarnessProps = {}) {
  const onCommit = vi.fn<(v: Quantity | undefined) => void>()
  const r = renderUi(<Harness initial="3.00" onCommit={onCommit} {...props} />)
  // an editable value field is a combobox: its popup is the adjust panel (ui.md#field, DF9)
  const input = screen.getByRole('combobox', { name: 'Width' })
  return { ...r, onCommit, input: input as HTMLInputElement }
}

/** Replace the text and leave the caret at the end. */
async function retype(
  user: ReturnType<typeof renderUi>['user'],
  input: HTMLElement,
  text: string,
): Promise<void> {
  await user.clear(input)
  if (text !== '') await user.type(input, text)
}

const committed = (fn: ReturnType<typeof setup>['onCommit']): string[] =>
  fn.mock.calls.map(([v]) => (v === undefined ? 'unset' : `${v.source} = ${v.exact.toString()}`))

describe('QuantityInput: display', () => {
  it('shows the stored source, labelled, with the bare-number unit as a muted suffix', async () => {
    const { input } = setup()
    expect(input).toHaveValue('3.00')
    expect(document.querySelector('.unit')).toHaveTextContent('mm')
    await expectNoAxeViolations()
  })

  it('follows the unit typed instead of the suffix, and shows the computed value when unfocused', async () => {
    const { user, input } = setup()
    await retype(user, input, '1/16"')
    expect(document.querySelector('.unit')).toBeNull()
    await user.tab()
    expect(screen.getByText('· 1.588 mm')).toBeInTheDocument()
  })

  it('shows no computed value for a literal in the display unit', async () => {
    setup({ initial: '3 mm' })
    expect(screen.queryByText(/·/)).toBeNull()
  })
})

describe('QuantityInput: echo while typing', () => {
  it('echoes fractions, inch and tolerances in the display unit at field precision', async () => {
    const { user, input } = setup()
    await retype(user, input, '1/16"')
    expect(await screen.findByText('= 1.588 mm')).toBeInTheDocument()
    expect(input).toHaveAccessibleDescription('= 1.588 mm')

    await retype(user, input, '25.4 +0.1/-0.05')
    expect(await screen.findByText('= 25.400 mm, upper +0.100, lower −0.050')).toBeInTheDocument()

    await retype(user, input, '10 ± 1/64')
    expect(await screen.findByText('= 10.000 mm ±0.016')).toBeInTheDocument()
  })

  it('shows no echo for a plain number with or without the field unit', async () => {
    const { user, input } = setup()
    for (const source of ['15', '15 mm', '15mm', '10 ±0.05']) {
      await retype(user, input, source)
      await act(() => new Promise((r) => setTimeout(r, ECHO_DELAY_MS + 50)))
      expect(screen.queryByText(/^= /)).not.toBeInTheDocument()
      expect(input).not.toHaveAccessibleDescription()
    }
    // a unit other than the display unit still echoes the conversion
    await retype(user, input, '0.5 in')
    expect(await screen.findByText('= 12.700 mm')).toBeInTheDocument()
  })

  it('names the references a formula reads', async () => {
    const { user, input } = setup()
    await retype(user, input, 'pocket1.floor.z / 2')
    expect(await screen.findByText('= 3.000 mm ±0.050 (from pocket1.floor.z)')).toBeInTheDocument()
  })

  it('adds the inherited general tolerance to an untoleranced value', async () => {
    const { user, input } = setup({
      inheritedTolerance: { deviation: Rational.create(1n, 10n).unwrap(), scope: 'part' },
    })
    await user.click(input)
    // a plain value: the inherited tolerance alone, not the value again
    expect(await screen.findByText('±0.100 mm from part')).toBeInTheDocument()
    await retype(user, input, '1/8"')
    expect(await screen.findByText('= 3.175 mm · ±0.100 mm from part')).toBeInTheDocument()
  })
})

describe('QuantityInput: echo collapse after a click', () => {
  function WithButton({ onClick }: { onClick: () => void }): React.JSX.Element {
    return (
      <>
        <Harness initial="3" />
        <button type="button" onClick={onClick}>
          Next
        </button>
      </>
    )
  }

  it('keeps the echo while the pointer that blurred the field is down, collapses after the click', async () => {
    const onClick = vi.fn()
    const { user } = renderUi(<WithButton onClick={onClick} />)
    const input = screen.getByRole('combobox', { name: 'Width' })
    await retype(user, input, '1/16"')
    expect(await screen.findByText('= 1.588 mm')).toBeInTheDocument()

    const next = screen.getByRole('button', { name: 'Next' })
    await user.pointer({ keys: '[MouseLeft>]', target: next })
    expect(input).not.toHaveFocus()
    // the support area still holds its height: whatever was under the pointer stays there
    await act(() => new Promise((r) => setTimeout(r, 50)))
    expect(screen.getByText('= 1.588 mm')).toBeInTheDocument()

    await user.pointer({ keys: '[/MouseLeft]', target: next })
    expect(onClick).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByText('= 1.588 mm')).not.toBeInTheDocument())
  })

  it('collapses at once when the field is left with the keyboard', async () => {
    const { user, input } = setup()
    await retype(user, input, '1/16"')
    expect(await screen.findByText('= 1.588 mm')).toBeInTheDocument()
    await user.tab()
    await waitFor(() => expect(screen.queryByText('= 1.588 mm')).not.toBeInTheDocument())
  })
})

describe('QuantityInput: commit and revert', () => {
  it('commits a valid value once on Enter, and nothing again on blur', async () => {
    const { user, input, onCommit } = setup()
    await retype(user, input, '1 1/2"')
    await user.keyboard('{Enter}')
    await user.tab()
    expect(committed(onCommit)).toEqual(['1 1/2" = 381/10'])
    expect(input).toHaveValue('1 1/2"')
  })

  it('commits on blur', async () => {
    const { user, input, onCommit } = setup()
    await retype(user, input, '4')
    await user.tab()
    expect(committed(onCommit)).toEqual(['4 = 4'])
  })

  it('does not commit an unchanged source', async () => {
    const { user, input, onCommit } = setup()
    await user.click(input)
    await user.keyboard('{Enter}')
    await user.tab()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('reverts to the stored source on Escape (the first one closes the adjust panel)', async () => {
    const { user, input, onCommit } = setup()
    await retype(user, input, '3..5')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(input).toHaveValue('3..5')
    await user.keyboard('{Escape}')
    expect(input).toHaveValue('3.00')
    expect(input).not.toHaveAttribute('aria-invalid')
    await user.tab()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('never commits an invalid value; keeps the text and marks the field', async () => {
    const { user, input, onCommit } = setup()
    await retype(user, input, '3..5')
    await user.keyboard('{Enter}')
    await user.tab()
    expect(onCommit).not.toHaveBeenCalled()
    expect(input).toHaveValue('3..5')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription(
      'Unexpected “.”: expected an operator, a tolerance or nothing more.',
    )
    expect(document.querySelector('.mark')).toHaveTextContent('.5')
    await expectNoAxeViolations()
  })

  it('shows an error only after a pause in typing, never mid-word', async () => {
    const { user, input } = setup()
    await retype(user, input, '3..')
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(await screen.findByText(/Unexpected “\.”/)).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('applies the field’s own rules before committing', async () => {
    const { user, input, onCommit } = setup({
      validate: (v) =>
        v.exact.num > 0n
          ? Ok(v)
          : fail('model.invariant', 'must be positive', {
              issues: [{ path: ['exact'], rule: 'positive', message: 'Must be greater than 0.' }],
            }),
    })
    await retype(user, input, '-1')
    await user.keyboard('{Enter}')
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByText('Must be greater than 0.')).toBeInTheDocument()
  })

  it('follows an external change unless the user is typing', async () => {
    function External(): React.JSX.Element {
      const [value, setValue] = useState(q('3'))
      return (
        <>
          <button type="button" onClick={() => setValue(q('7'))}>
            Agent edit
          </button>
          <QuantityInput
            label="Width"
            kind="length"
            defaultUnit="mm"
            value={value}
            onCommit={() => {}}
          />
        </>
      )
    }
    const { user } = renderUi(<External />)
    const input = screen.getByRole('combobox', { name: 'Width' })
    await user.click(screen.getByRole('button', { name: 'Agent edit' }))
    expect(input).toHaveValue('7')
  })

  it('marks a stored formula whose reference is gone', () => {
    renderUi(
      <QuantityInput
        label="Width"
        kind="length"
        defaultUnit="mm"
        value={q('D / 2', resolver)}
        onCommit={() => {}}
      />,
    )
    const input = screen.getByRole('combobox', { name: 'Width' })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Unknown reference “D”.')
  })
})

describe('QuantityInput: hints for ambiguous input (known issues)', () => {
  it('reads `10 +1/2` as a deviation pair and offers `10 + 1/2`', async () => {
    const { user, input, onCommit } = setup()
    await retype(user, input, '10 +1/2')
    await user.keyboard('{Enter}')
    expect(input).toHaveAccessibleDescription(
      '“+1/2” reads as a tolerance (upper +1, lower +2), and the lower is above the upper. To add or subtract a fraction, put a space after the sign.',
    )
    expect(document.querySelector('.mark')).toHaveTextContent('+1/2')
    await user.click(screen.getByRole('button', { name: 'Use 10 + 1/2' }))
    expect(committed(onCommit)).toEqual(['10 + 1/2 = 21/2'])
    expect(input).toHaveFocus()
  })

  it('reads `D -1/2` as a deviation pair and offers `D - 1/2`', async () => {
    const { user, input, onCommit } = setup()
    await retype(user, input, 'D -1/2')
    await user.keyboard('{Enter}')
    expect(
      screen.getByText(/“-1\/2” reads as a tolerance \(upper −1, lower \+2\)/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Use D - 1/2' }))
    expect(committed(onCommit)).toEqual(['D - 1/2 = 11/2'])
  })

  it('keeps a valid deviation pair as a tolerance (`D +2/1`)', async () => {
    const { user, input } = setup()
    await retype(user, input, 'D +2/1')
    expect(
      await screen.findByText('= 6.000 mm, upper +2.000, lower +1.000 (from D)'),
    ).toBeInTheDocument()
  })

  it('offers the micro sign for Greek mu', async () => {
    const { user, input, onCommit } = setup()
    await retype(user, input, '500 μm')
    await user.keyboard('{Enter}')
    expect(screen.getByText('Use the micro sign “µ” for micrometres.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Use 500 µm' }))
    expect(committed(onCommit)).toEqual(['500 µm = 1/2'])
  })

  it('offers the spaced mixed number for `1-1/2"`', async () => {
    const { user, input } = setup()
    await retype(user, input, '1-1/2"')
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Use 1 1/2"' })).toBeInTheDocument()
  })

  it('offers a grouping for an ambiguous division', async () => {
    const { user, input } = setup()
    await retype(user, input, 'D/2/5')
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Use D/(2/5)' })).toBeInTheDocument()
  })

  it('explains unknown references, units of another kind and a misplaced tolerance', async () => {
    const { user, input } = setup()
    await retype(user, input, 'foo + 1')
    await user.keyboard('{Enter}')
    expect(input).toHaveAccessibleDescription('Unknown reference “foo”.')
    expect(document.querySelector('.mark')).toHaveTextContent('foo')

    await retype(user, input, '10 mm/min')
    await user.keyboard('{Enter}')
    expect(input).toHaveAccessibleDescription('“mm/min” is not a length unit. Use mm, in or ".')

    await retype(user, input, 'D ±0.1 * 2')
    await user.keyboard('{Enter}')
    expect(input).toHaveAccessibleDescription('A tolerance can only come at the very end.')

    await retype(user, input, '')
    await user.keyboard('{Enter}')
    expect(input).toHaveAccessibleDescription('Enter a value.')
  })
})

describe('QuantityInput: optional (empty = unset)', () => {
  it('without the option, an emptied field is an error and never commits', async () => {
    const { user, input, onCommit } = setup()
    await retype(user, input, '')
    await user.keyboard('{Enter}')
    await user.tab()
    expect(onCommit).not.toHaveBeenCalled()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Enter a value.')
  })

  it('commits an emptied field as unset on Enter, once, and shows it empty', async () => {
    const { user, input, onCommit } = setup({ optional: true })
    await retype(user, input, '')
    await user.keyboard('{Enter}')
    await user.tab()
    expect(committed(onCommit)).toEqual(['unset'])
    expect(input).toHaveValue('')
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('treats spaces as empty and commits unset on blur', async () => {
    const { user, input, onCommit } = setup({ optional: true })
    await retype(user, input, '   ')
    await user.tab()
    expect(committed(onCommit)).toEqual(['unset'])
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('never marks an empty optional field, even after the error pause', async () => {
    const { user, input } = setup({ optional: true })
    await retype(user, input, '')
    await act(() => new Promise((r) => setTimeout(r, 700)))
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByText('Enter a value.')).toBeNull()
    await expectNoAxeViolations()
  })

  it('commits nothing for a field that was empty and stays empty; a value typed later commits', async () => {
    const { user, input, onCommit } = setup({ optional: true, initial: undefined })
    expect(input).toHaveValue('')
    await user.click(input)
    await user.keyboard('{Enter}')
    await user.tab()
    expect(onCommit).not.toHaveBeenCalled()
    await retype(user, input, '5')
    await user.tab()
    await retype(user, input, '')
    await user.tab()
    expect(committed(onCommit)).toEqual(['5 = 5', 'unset'])
  })

  it('still rejects invalid text and reverts on Escape', async () => {
    const { user, input, onCommit } = setup({ optional: true })
    await retype(user, input, '3..5')
    await user.keyboard('{Enter}')
    expect(onCommit).not.toHaveBeenCalled()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    await retype(user, input, '')
    await user.keyboard('{Escape}{Escape}')
    expect(input).toHaveValue('3.00')
    await user.tab()
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('QuantityInput: steppers', () => {
  it('steps a plain literal in its own unit (Shift ×10, Alt ×0.1), keeping unit and tolerance', async () => {
    const { user, input, onCommit } = setup({ stepKind: 'depth', initial: '1.50 ±0.05' })
    await user.click(input)
    await user.keyboard('{ArrowUp}')
    expect(input).toHaveValue('1.60 ±0.05')
    await user.keyboard('{Shift>}{ArrowUp}{/Shift}')
    expect(input).toHaveValue('2.60 ±0.05')
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(input).toHaveValue('2.59 ±0.05')
    await user.keyboard('{Enter}')
    expect(committed(onCommit)).toEqual(['2.59 ±0.05 = 259/100'])

    await retype(user, input, '1/16"')
    await user.keyboard('{ArrowUp}')
    expect(input).toHaveValue('0.1625"')
  })

  it('does not step a formula', async () => {
    const { user, input } = setup()
    await retype(user, input, 'D / 2')
    await user.keyboard('{ArrowUp}')
    expect(input).toHaveValue('D / 2')
  })
})

/**
 * Stores what it commits like the replica after a command (optionally a tick later, like the IPC
 * round trip) and cancels a gesture like `history.undo { gesture }`: back to the value before its
 * first step, unless `cancelFails` (someone committed after it).
 */
function GestureHarness({
  onCommit,
  onCancel,
  late = false,
  cancelFails = false,
  rejects = false,
  withCancel = true,
  ...props
}: Partial<QuantityInputBaseProps> & {
  onCommit: (v: Quantity, gesture: string | undefined) => void
  onCancel?: (gesture: string) => void
  late?: boolean
  cancelFails?: boolean
  /** Every step's command fails: nothing lands, so the gesture has no entry to undo. */
  rejects?: boolean
  withCancel?: boolean
}): React.JSX.Element {
  const [value, setValue] = useState<Quantity | undefined>(q('3.00'))
  const [before, setBefore] = useState<{ gesture: string; value: Quantity | undefined } | null>(
    null,
  )
  const land = (v: Quantity | undefined) =>
    late ? void Promise.resolve().then(() => setValue(v)) : setValue(v)
  return (
    <QuantityInput
      label="Width"
      kind="length"
      defaultUnit="mm"
      value={value}
      {...props}
      onCommit={(v, gesture) => {
        onCommit(v, gesture)
        if (rejects) return
        if (gesture !== undefined && before?.gesture !== gesture) setBefore({ gesture, value })
        land(v)
      }}
      {...(withCancel
        ? {
            onCancelGesture: (gesture: string) => {
              onCancel?.(gesture)
              if (cancelFails || before?.gesture !== gesture) return Promise.resolve(false)
              land(before.value)
              return Promise.resolve(true)
            },
          }
        : {})}
    />
  )
}

function gestureSetup(props: Partial<React.ComponentProps<typeof GestureHarness>> = {}) {
  const onCommit = vi.fn<(v: Quantity, gesture: string | undefined) => void>()
  const onCancel = vi.fn<(gesture: string) => void>()
  const r = renderUi(<GestureHarness onCommit={onCommit} onCancel={onCancel} {...props} />)
  const input = screen.getByRole('combobox', { name: 'Width' }) as HTMLInputElement
  // focusing (or clicking) the field opens its adjust panel
  const open = async () => {
    await r.user.click(input)
    await screen.findByRole('dialog', { name: 'Adjust Width' })
  }
  const steps = () => onCommit.mock.calls.map(([v, g]) => [v.source, g])
  return { ...r, input, onCommit, onCancel, open, steps }
}

describe('QuantityInput: adjust panel (live gesture)', () => {
  it('commits every step live with one gesture id; a click outside keeps the value', async () => {
    const { user, input, open, steps, onCancel } = gestureSetup()
    await open()
    await user.click(screen.getByRole('radio', { name: '10' }))
    await user.click(screen.getByRole('button', { name: 'Increase' }))
    await user.click(screen.getByRole('button', { name: 'Increase' }))
    expect(input).toHaveValue('23.00')
    await expectNoAxeViolations()
    const id = steps()[0]?.[1]
    expect(id).toEqual(expect.any(String))
    expect(steps()).toEqual([
      ['13.00', id],
      ['23.00', id],
    ])
    await user.click(document.body)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(steps()).toHaveLength(2)
    expect(onCancel).not.toHaveBeenCalled()
    expect(input).toHaveValue('23.00')
  })

  it('Escape cancels the gesture and restores the value from before the first step', async () => {
    const { user, input, open, steps, onCancel } = gestureSetup()
    await open()
    await user.click(screen.getByRole('button', { name: 'Increase' }))
    await user.click(screen.getByRole('button', { name: 'Increase' }))
    expect(input).toHaveValue('5.00')
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledWith(steps()[0]?.[1])
    await waitFor(() => expect(input).toHaveValue('3.00'))
    expect(steps()).toHaveLength(2) // the revert is the cancel, not another commit
  })

  it('Escape without a step commits and cancels nothing', async () => {
    const { user, input, open, onCommit, onCancel } = gestureSetup()
    await open()
    await user.keyboard('{Escape}')
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(input).toHaveValue('3.00')
  })

  it('a cancel that cannot revert keeps the value and says so', async () => {
    const { user, input, open } = gestureSetup({ cancelFails: true })
    await open()
    await user.click(screen.getByRole('button', { name: 'Increase' }))
    await user.keyboard('{Escape}')
    expect(await screen.findByText(/Escape could not revert it/)).toBeInTheDocument()
    expect(input).toHaveValue('4.00')
  })

  it('Escape after steps that all failed restores the opening value without a "Kept" note', async () => {
    const { user, input, open, steps, onCancel } = gestureSetup({ rejects: true })
    await open()
    await user.click(screen.getByRole('button', { name: 'Increase' }))
    expect(steps()).toHaveLength(1)
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
    await waitFor(() => expect(input).toHaveValue('3.00'))
    await act(() => Promise.resolve())
    expect(screen.queryByText(/Escape could not revert it/)).toBeNull()
  })

  it('the panel hint names only keys that act in the panel', async () => {
    const { open } = gestureSetup()
    await open()
    const dialog = screen.getByRole('dialog', { name: 'Adjust Width' })
    expect(dialog).toHaveTextContent('Esc reverts')
    expect(dialog).not.toHaveTextContent('↑')
  })

  it('without onCancelGesture, Escape commits the opening value again in the same gesture', async () => {
    const { user, input, open, steps } = gestureSetup({ withCancel: false })
    await open()
    await user.click(screen.getByRole('button', { name: 'Increase' }))
    await user.keyboard('{Escape}')
    const id = steps()[0]?.[1]
    expect(steps()).toEqual([
      ['4.00', id],
      ['3.00', id],
    ])
    expect(input).toHaveValue('3.00')
  })

  it('rapid steps that land late are all committed, none lost or repeated', async () => {
    const { user, input, open, steps } = gestureSetup({ late: true })
    await open()
    const plus = screen.getByRole('button', { name: 'Increase' })
    const minus = screen.getByRole('button', { name: 'Decrease' })
    await user.click(plus)
    await user.click(plus)
    await user.click(minus)
    await user.click(minus)
    await waitFor(() => expect(input).toHaveValue('3.00'))
    expect(steps().map(([v]) => v)).toEqual(['4.00', '5.00', '4.00', '3.00'])
  })

  it('each session is a new gesture; "Use …" commits in the session and closes it', async () => {
    const { user, open, steps } = gestureSetup({
      recommended: { source: '12.50', text: '≥ 12.50 mm keeps 3 mm corners' },
    })
    await open()
    await user.click(screen.getByRole('button', { name: 'Increase' }))
    await user.click(document.body)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await open()
    await user.click(screen.getByRole('button', { name: 'Increase' }))
    await user.click(await screen.findByRole('button', { name: 'Use 12.50' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const [a, b, c] = steps().map(([, g]) => g)
    expect(steps().map(([v]) => v)).toEqual(['4.00', '5.00', '12.50'])
    expect(a).not.toEqual(b)
    expect(c).toEqual(b)
  })
})

describe('QuantityInput: references and picking', () => {
  const references = [
    { id: 'pocket1.floor.z', label: 'Pocket 1 floor' },
    { id: 'pocket1.depth', label: 'Pocket 1 depth' },
    { id: 'tool.diameter' },
  ]

  it('offers matching references while typing a name', async () => {
    const { user, input } = setup({ references })
    await retype(user, input, 'po')
    const list = screen.getByRole('listbox', { name: 'References for Width' })
    expect(list).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(input).toHaveAttribute('aria-expanded', 'true')
    await expectNoAxeViolations()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(input).toHaveValue('pocket1.depth')
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.type(input, ' / 2')
    expect(await screen.findByText(/^= 1.500 mm/)).toBeInTheDocument()
  })

  it('lists every reference on Ctrl+Space, and Escape closes only the list', async () => {
    const { user, input } = setup({ references })
    await retype(user, input, '')
    await user.keyboard('{Control>} {/Control}')
    expect(screen.getAllByRole('option')).toHaveLength(3)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input).toHaveValue('')
  })

  it('hands the pick toggle an insert callback; the picked reference goes in at the caret', async () => {
    const onPick = vi.fn<(insert: (reference: string) => void) => void>()
    const { user, input } = setup({ onPick })
    await retype(user, input, ' / 2')
    await user.keyboard('{Home}')
    const pick = screen.getByRole('button', { name: 'Pick Width in the viewport' })
    expect(pick).toHaveAttribute('aria-pressed', 'false')
    await user.click(pick)
    expect(input).toHaveFocus() // a press in the panel keeps the field focused
    expect(onPick).toHaveBeenCalledTimes(1)
    const insert = onPick.mock.calls[0]?.[0]
    act(() => insert?.('pocket1.floor.z'))
    expect(input).toHaveValue('pocket1.floor.z / 2')
    expect(input).toHaveFocus()
    expect(input.selectionStart).toBe('pocket1.floor.z'.length)
  })

  it('the pressed pick toggle cancels pick mode on a second press (DF10)', async () => {
    const onPick = vi.fn()
    const onPickCancel = vi.fn()
    const { user, input } = setup({ onPick, onPickCancel, picking: true })
    await user.click(input)
    const pick = screen.getByRole('button', { name: 'Pick Width in the viewport' })
    expect(pick).toHaveAttribute('aria-pressed', 'true')
    await expectNoAxeViolations()
    await user.click(pick)
    expect(onPickCancel).toHaveBeenCalledTimes(1)
    expect(onPick).not.toHaveBeenCalled()
    expect(input).toHaveFocus()
  })

  it('enters pick mode with Alt+P', async () => {
    const onPick = vi.fn()
    const { user, input } = setup({ onPick })
    await user.click(input)
    await user.keyboard('{Alt>}p{/Alt}')
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('Alt+P while picking cancels pick mode', async () => {
    const onPick = vi.fn()
    const onPickCancel = vi.fn()
    const { user, input } = setup({ onPick, onPickCancel, picking: true })
    await user.click(input)
    await user.keyboard('{Alt>}p{/Alt}')
    expect(onPickCancel).toHaveBeenCalledTimes(1)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('in pick mode Escape is left to the viewport (the panel stays, nothing reverts)', async () => {
    const onKey = vi.fn()
    document.addEventListener('keydown', onKey)
    const { user, input } = setup({ onPick: vi.fn(), onPickCancel: vi.fn(), picking: true })
    await user.click(input)
    await user.keyboard('{Escape}')
    expect(onKey).toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }))
    expect(screen.getByRole('dialog', { name: 'Adjust Width' })).toBeInTheDocument()
    document.removeEventListener('keydown', onKey)
  })

  it("the reference list takes the adjust panel's place while it is open", async () => {
    const { user, input } = setup({ references })
    await user.click(input)
    expect(screen.getByRole('dialog', { name: 'Adjust Width' })).toBeInTheDocument()
    await retype(user, input, 'po')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(input).toHaveAttribute('aria-haspopup', 'listbox')
    expect(input).toHaveAttribute(
      'aria-controls',
      screen.getByRole('listbox', { name: 'References for Width' }).id,
    )
  })
})

describe('QuantityInput: adjust panel on focus (DF9)', () => {
  it('opens under the field on focus while the input keeps focus and takes the typing', async () => {
    const { user, input } = setup()
    expect(input).toHaveAttribute('aria-haspopup', 'dialog')
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(input).not.toHaveAttribute('aria-controls')
    await user.click(input)
    const panel = screen.getByRole('dialog', { name: 'Adjust Width' })
    expect(input).toHaveFocus()
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveAttribute('aria-controls', panel.id)
    await expectNoAxeViolations()
    await user.type(input, '5')
    expect(input).toHaveValue('3.005')
    expect(panel).toHaveTextContent('3.005')
  })

  it('shows the recommended value in the panel; "Use …" only while the value differs', async () => {
    const { user, input, onCommit } = setup({
      recommended: { source: '0.5 mm', text: '0.5 mm, down to enclosure' },
    })
    await user.click(input)
    const panel = screen.getByRole('dialog', { name: 'Adjust Width' })
    expect(panel).toHaveTextContent('Recommended 0.5 mm, down to enclosure')
    const use = within(panel).getByRole('button', { name: 'Use 0.5 mm' })
    expect(use).toBeEnabled()
    await user.click(use)
    expect(committed(onCommit)).toEqual(['0.5 mm = 1/2'])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(input)
    expect(
      within(screen.getByRole('dialog', { name: 'Adjust Width' })).getByRole('button', {
        name: 'Use 0.5 mm',
      }),
    ).toBeDisabled()
  })

  it('has no pencil or other button in the input: Tab goes from field to field', async () => {
    const { user } = renderUi(
      <>
        <Harness initial="3.00" onPick={() => {}} />
        <QuantityInput
          label="Depth"
          kind="length"
          defaultUnit="mm"
          value={q('2')}
          onCommit={() => {}}
        />
      </>,
    )
    expect(screen.queryByRole('button')).toBeNull()
    await user.click(screen.getByRole('combobox', { name: 'Width' }))
    await user.tab()
    expect(screen.getByRole('combobox', { name: 'Depth' })).toHaveFocus()
    // the first panel closed with its field, the second opened
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'Adjust Depth' })).toBeInTheDocument()
  })

  it('closes when focus leaves; a click in the input reopens it', async () => {
    const { user, input } = setup()
    await user.click(input)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(input).toHaveFocus()
    await user.click(input)
    expect(screen.getByRole('dialog', { name: 'Adjust Width' })).toBeInTheDocument()
    await user.click(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a valid Enter closes the panel (done editing); an invalid one keeps it', async () => {
    const { user, input } = setup()
    await retype(user, input, '3..5')
    await user.keyboard('{Enter}')
    expect(screen.getByRole('dialog', { name: 'Adjust Width' })).toBeInTheDocument()
    await retype(user, input, '4')
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(input).toHaveFocus()
  })

  it('a press in the panel keeps the input focused', async () => {
    const { user, input } = setup()
    await user.click(input)
    await user.click(screen.getByRole('radio', { name: '10' }))
    expect(input).toHaveFocus()
    expect(screen.getByRole('radio', { name: '10' })).toHaveAttribute('aria-checked', 'true')
  })

  it('⌘↓ / Ctrl+↓ moves into the panel; arrows move, Escape returns to the input', async () => {
    const { user, input } = setup()
    await user.click(input)
    await user.keyboard('{Meta>}{ArrowDown}{/Meta}')
    expect(input).toHaveValue('3.00') // not a step
    const radios = screen.getAllByRole('radio')
    expect(radios[0]).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(radios[1]).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('button', { name: 'Increase' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(input).toHaveValue('4.00')
    await user.keyboard('{Escape}')
    expect(input).toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(input).toHaveValue('3.00') // Escape cancelled the session's step
  })

  it('↓ moves into the panel when the text cannot step and there is nothing to list', async () => {
    const { user, input } = setup()
    await retype(user, input, 'D / 2')
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('radio')[0]).toHaveFocus()
    // Shift+Tab goes back to the input; the panel's controls are not Tab stops
    await user.tab({ shift: true })
    expect(input).toHaveFocus()
  })

  it('Ctrl+↓ opens a closed panel and moves into it', async () => {
    const { user, input } = setup()
    await user.click(input)
    await user.keyboard('{Escape}')
    await user.keyboard('{Control>}{ArrowDown}{/Control}')
    expect(screen.getAllByRole('radio')[0]).toHaveFocus()
  })

  it('opens nothing for a dense cell', async () => {
    const { user } = renderUi(
      <QuantityInput
        label="Length"
        kind="length"
        defaultUnit="mm"
        value={q('2')}
        onCommit={() => {}}
        dense
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Length' })
    await user.click(input)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(input).not.toHaveAttribute('aria-expanded')
  })
})

describe('QuantityInput: read-only', () => {
  it('shows the value read-only, without adjust or pick, and never commits', async () => {
    const onCommit = vi.fn()
    const { user } = renderUi(
      <QuantityInput
        label="Feed"
        kind="feedRate"
        defaultUnit="mm/min"
        value={quantityFromSource(
          '900',
          { kind: 'feedRate', defaultUnit: 'mm/min' },
          resolver,
        ).unwrap()}
        onCommit={onCommit}
        onPick={() => {}}
        readOnly
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Feed' })
    expect(input).toHaveAttribute('readonly')
    expect(screen.queryByRole('button', { name: /Adjust|Pick/ })).toBeNull()
    await user.click(input)
    await user.keyboard('{ArrowUp}{Enter}')
    expect(onCommit).not.toHaveBeenCalled()
  })
})

// docs/conventions/inspector-layout.md#field-step-model-df104, #title-row-click-df111
describe('QuantityInput: step kinds (DF104)', () => {
  const radio = (name: string) => screen.getByRole('radio', { name })

  it('preselects the step for the value and ↑ uses it (facing depth 0.3 → .1)', async () => {
    const { user, input } = setup({ stepKind: 'depth', initial: '0.3' })
    await user.click(input)
    expect(radio('.1')).toHaveAttribute('aria-checked', 'true')
    await user.keyboard('{ArrowUp}')
    expect(input).toHaveValue('0.4')
  })

  it('scales the ladder to the stock: a 10.1 mm board offers no 10 mm depth step', async () => {
    const { user } = renderUi(
      <StepScaleProvider scale={{ thickness: 10.1 }}>
        <Harness stepKind="depth" initial="3" />
      </StepScaleProvider>,
    )
    await user.click(screen.getByRole('combobox', { name: 'Width' }))
    const steps = screen.getAllByRole('radio').map((r) => r.textContent)
    expect(steps).toEqual(['.01', '.1', '.5', '1', '5'])
  })

  it('an integer field offers integer steps only, and Alt does not step it', async () => {
    const { user, input } = setup({ stepKind: 'count', stepMax: 12, initial: '4' })
    await user.click(input)
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['1', '2', '5'])
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    expect(input).toHaveValue('4')
    await user.keyboard('{ArrowUp}')
    expect(input).toHaveValue('5')
    await user.keyboard('{Shift>}{ArrowUp}{/Shift}')
    expect(input).toHaveValue('15')
  })

  it('remembers a chosen step for the field’s role for the session', async () => {
    const first = setup({ stepKind: 'depth', stepKey: 'pocket.depth', initial: '0.3' })
    await first.user.click(first.input)
    await first.user.click(radio('1'))
    first.unmount()
    const again = setup({ stepKind: 'depth', stepKey: 'pocket.depth', initial: '0.3' })
    await again.user.click(again.input)
    expect(radio('1')).toHaveAttribute('aria-checked', 'true')
  })
})

describe('QuantityInput: title row and info (DF105, DF111)', () => {
  it('a press on the title row focuses the input without opening the adjust panel', async () => {
    const { user, input } = setup()
    await user.click(screen.getByText('Width'))
    expect(input).toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()
    // a click in the input opens it
    await user.click(input)
    expect(await screen.findByRole('dialog', { name: 'Adjust Width' })).toBeInTheDocument()
  })

  it('focus by Tab still opens the panel (DF9)', async () => {
    const { user } = setup()
    await user.tab()
    expect(await screen.findByRole('dialog', { name: 'Adjust Width' })).toBeInTheDocument()
  })

  it('the info is the field’s description, not text under it', async () => {
    const { input } = setup({ info: 'Empty = through the stock.' })
    expect(input).toHaveAccessibleDescription('Empty = through the stock.')
    expect(screen.getByText('Empty = through the stock.')).not.toBeVisible()
    await expectNoAxeViolations()
  })
})
