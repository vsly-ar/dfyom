import { screen } from '@testing-library/react'
import { Check } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Button } from './Button'

describe('Button', () => {
  it('is a button named by its label that calls onClick', async () => {
    const onClick = vi.fn()
    const { user } = renderUi(<Button onClick={onClick}>Export gCode</Button>)
    const button = screen.getByRole('button', { name: 'Export gCode' })
    expect(button).toHaveAttribute('type', 'button')
    await user.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('exposes variant and size as data attributes for the CSS module', () => {
    renderUi(
      <Button variant="primary" size="lg" icon={<Check aria-hidden />}>
        Generate toolpaths
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Generate toolpaths' })
    expect(button).toHaveAttribute('data-variant', 'primary')
    expect(button).toHaveAttribute('data-size', 'lg')
  })

  it('does not fire when disabled', async () => {
    const onClick = vi.fn()
    const { user } = renderUi(
      <Button disabled onClick={onClick}>
        Simulate
      </Button>,
    )
    await user.click(screen.getByRole('button', { name: 'Simulate' }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('renders a child element with the button look (asChild)', () => {
    renderUi(
      <Button asChild className="layout">
        <a href="#plan">Go to Plan</a>
      </Button>,
    )
    const link = screen.getByRole('link', { name: 'Go to Plan' })
    expect(link).toHaveAttribute('data-variant', 'default')
    expect(link.className).toContain('layout')
  })

  it('has no axe violations', async () => {
    renderUi(
      <div>
        <Button>Default</Button>
        <Button variant="danger">Remove plan</Button>
        <Button variant="ghost">Cancel</Button>
      </div>,
    )
    await expectNoAxeViolations()
  })
})
