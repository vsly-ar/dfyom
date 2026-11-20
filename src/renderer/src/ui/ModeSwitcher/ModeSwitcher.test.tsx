import { screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { AppMode } from '../../../../core/modes'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { ModeSwitcher } from './ModeSwitcher'

function Controlled({ onChange }: { onChange?: (m: AppMode) => void }): React.JSX.Element {
  const [mode, setMode] = useState<AppMode>('design')
  return (
    <ModeSwitcher
      value={mode}
      onValueChange={(m) => {
        setMode(m)
        onChange?.(m)
      }}
    />
  )
}

describe('ModeSwitcher', () => {
  it('offers Design, Plan and Run in a group named Mode', () => {
    renderUi(<Controlled />)
    const group = screen.getByRole('radiogroup', { name: 'Mode' })
    expect(group).toBeInTheDocument()
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'Design',
      'Plan',
      'Run',
    ])
    expect(screen.getByRole('radio', { name: 'Design' })).toBeChecked()
  })

  it('switches by click and by arrow keys + Space', async () => {
    const onChange = vi.fn()
    const { user } = renderUi(<Controlled onChange={onChange} />)
    await user.click(screen.getByRole('radio', { name: 'Run' }))
    expect(onChange).toHaveBeenLastCalledWith('run')
    await user.keyboard('{ArrowLeft} ')
    expect(onChange).toHaveBeenLastCalledWith('plan')
    expect(screen.getByRole('radio', { name: 'Plan' })).toBeChecked()
  })

  it('stays on the current mode when it is clicked again', async () => {
    const onChange = vi.fn()
    const { user } = renderUi(<Controlled onChange={onChange} />)
    await user.click(screen.getByRole('radio', { name: 'Design' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('radio', { name: 'Design' })).toBeChecked()
  })

  it('has no axe violations', async () => {
    renderUi(<Controlled />)
    await expectNoAxeViolations()
  })
})
