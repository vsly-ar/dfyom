import { screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { ANCHOR_GRID, AnchorPicker, type AnchorValue } from './AnchorPicker'

const NAMES = { min: 'low', centre: 'mid', max: 'high' } as const
const name = (p: AnchorValue) => `${NAMES[p.v]} ${NAMES[p.u]}`

function Controlled({
  onChange,
  disabled = false,
}: {
  onChange: (a: AnchorValue) => void
  disabled?: boolean
}): React.JSX.Element {
  const [value, setValue] = useState<AnchorValue>({ u: 'centre', v: 'centre' })
  return (
    <AnchorPicker
      label="Anchor"
      value={value}
      pointLabel={name}
      disabled={disabled}
      onValueChange={(a) => {
        setValue(a)
        onChange(a)
      }}
    />
  )
}

describe('AnchorPicker', () => {
  it('is a radio group of nine named points, top row the highest v', () => {
    renderUi(<Controlled onChange={() => {}} />)
    const group = screen.getByRole('radiogroup', { name: 'Anchor' })
    const radios = screen.getAllByRole('radio')
    expect(group).toBeInTheDocument()
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(ANCHOR_GRID.map(name))
    expect(radios[0]).toHaveAccessibleName('high low')
    expect(screen.getByRole('radio', { name: 'mid mid' })).toBeChecked()
    // roving tab stop: only the chosen point is in the tab order
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1)
  })

  it('chooses by click and moves in the grid with the arrow keys', async () => {
    const onChange = vi.fn()
    const { user } = renderUi(<Controlled onChange={onChange} />)
    await user.click(screen.getByRole('radio', { name: 'low low' }))
    expect(onChange).toHaveBeenLastCalledWith({ u: 'min', v: 'min' })
    expect(screen.getByRole('radio', { name: 'low low' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(onChange).toHaveBeenLastCalledWith({ u: 'min', v: 'centre' })
    expect(screen.getByRole('radio', { name: 'mid low' })).toHaveFocus()
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith({ u: 'max', v: 'centre' })
    expect(onChange).toHaveBeenCalledTimes(4) // the edge stops; no repeat for the same point
    await user.keyboard('{Home}')
    expect(onChange).toHaveBeenLastCalledWith({ u: 'min', v: 'max' })
    await user.keyboard('{End}')
    expect(onChange).toHaveBeenLastCalledWith({ u: 'max', v: 'min' })
  })

  it('disabled: stays focusable and announces it, but never changes', async () => {
    const onChange = vi.fn()
    const { user } = renderUi(<Controlled onChange={onChange} disabled />)
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('radio', { name: 'low low' }))
    await user.keyboard('{ArrowUp}')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('radio', { name: 'mid mid' })).toBeChecked()
  })

  it('has no axe violations', async () => {
    renderUi(<Controlled onChange={() => {}} />)
    await expectNoAxeViolations()
  })
})
