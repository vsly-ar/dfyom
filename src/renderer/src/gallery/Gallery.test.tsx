import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderUi } from '../test/render'
import { Gallery } from './Gallery'

describe('Gallery (dev only)', () => {
  it('renders every specimen in a light and a dark pane', async () => {
    renderUi(<Gallery />)
    expect(screen.getByRole('heading', { name: 'Component gallery' })).toBeInTheDocument()
    expect(document.querySelectorAll('.t-light, .t-dark')).toHaveLength(2)
    expect(screen.getAllByRole('radiogroup', { name: 'Mode' })).toHaveLength(2)
    expect(await screen.findAllByRole('menu')).toHaveLength(2)
  })
})
