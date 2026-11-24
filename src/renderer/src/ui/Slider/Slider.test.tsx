import { screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Slider } from './Slider'

function Controlled(props: {
  start: number
  limit?: number
  onCommit?: (v: number) => void
}): React.JSX.Element {
  const [v, setV] = useState(props.start)
  return (
    <Slider
      label="Feed override"
      min={10}
      max={200}
      value={v}
      onValueChange={setV}
      limit={props.limit}
      marks={[100]}
      valueText={(x) => `${x} %`}
      {...(props.onCommit === undefined ? {} : { onValueCommit: props.onCommit })}
    />
  )
}

describe('Slider', () => {
  it('is a named slider; arrows step by one, Page Up by ten', async () => {
    const commit = vi.fn()
    const { user } = renderUi(<Controlled start={100} onCommit={commit} />)
    const thumb = screen.getByRole('slider', { name: 'Feed override' })
    expect(thumb).toHaveAttribute('aria-valuenow', '100')
    expect(thumb).toHaveAttribute('aria-valuetext', '100 %')
    await user.tab()
    await user.keyboard('{ArrowRight}')
    expect(thumb).toHaveAttribute('aria-valuenow', '101')
    expect(commit).toHaveBeenLastCalledWith(101)
    await user.keyboard('{PageUp}')
    expect(thumb).toHaveAttribute('aria-valuenow', '111')
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(thumb).toHaveAttribute('aria-valuenow', '109')
  })

  it('stops at the limit and hatches the track past it', async () => {
    const { user } = renderUi(<Controlled start={160} limit={166} />)
    const thumb = screen.getByRole('slider', { name: 'Feed override' })
    expect(screen.getByTestId('slider-beyond')).toBeInTheDocument()
    await user.tab()
    await user.keyboard('{PageUp}{End}')
    expect(thumb).toHaveAttribute('aria-valuenow', '166')
  })

  it('has no axe violations', async () => {
    renderUi(
      <>
        <Controlled start={120} limit={150} />
        <Slider
          label="Spindle override"
          min={10}
          max={200}
          value={100}
          onValueChange={() => {}}
          disabled
        />
      </>,
    )
    await expectNoAxeViolations()
  })
})
