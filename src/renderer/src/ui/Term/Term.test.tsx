import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Term } from './Term'

describe('Term', () => {
  it('shows its definition when focused by keyboard', async () => {
    const { user } = renderUi(
      <p>
        Each <Term definition="Stepdown: 1.5 mm per pass for this pocket">stepdown</Term> cuts.
      </p>,
    )
    await user.tab()
    const term = screen.getByText('stepdown')
    expect(term).toHaveFocus()
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Stepdown: 1.5 mm per pass for this pocket')
    expect(term).toHaveAccessibleDescription('Stepdown: 1.5 mm per pass for this pocket')
  })

  it('has no axe violations', async () => {
    renderUi(
      <p>
        Set <Term definition="Where the program's X0 Y0 Z0 is on the stock">work zero</Term>.
      </p>,
    )
    await expectNoAxeViolations()
  })
})
