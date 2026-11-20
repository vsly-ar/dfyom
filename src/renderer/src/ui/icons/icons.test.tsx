import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FIELD_ICON_NAMES, FieldIcon } from './field/FieldIcon'
import { TOOL_ICON_NAMES, ToolIcon, toolIconLabel } from './tool/ToolIcon'

describe('field illustrations', () => {
  it('has the shapes of the design system', () => {
    expect(FIELD_ICON_NAMES).toEqual([
      'length',
      'width',
      'depth',
      'stepdown',
      'corner',
      'chamfer',
      'tool',
      'feed',
      'tabs',
    ])
  })

  it.each(FIELD_ICON_NAMES)(
    '%s: decorative 20-grid drawing with an amber measured part',
    (name) => {
      const { container } = render(<FieldIcon name={name} />)
      const svg = container.querySelector('svg')
      expect(svg).toHaveAttribute('aria-hidden', 'true')
      expect(svg).toHaveAttribute('viewBox', '0 0 20 20')
      expect(svg?.querySelectorAll('[data-accent]').length).toBeGreaterThan(0)
      expect(svg?.querySelectorAll(':not([data-accent])').length).toBeGreaterThan(0)
    },
  )
})

describe('tool icons', () => {
  it.each(TOOL_ICON_NAMES)(
    '%s: decorative 16-grid icon with one accent detail and a label',
    (name) => {
      const { container } = render(<ToolIcon name={name} />)
      const svg = container.querySelector('svg')
      expect(svg).toHaveAttribute('aria-hidden', 'true')
      expect(svg?.querySelectorAll('[data-accent]').length).toBeGreaterThan(0)
      expect(toolIconLabel(name)).toMatch(/^[A-Z]/)
    },
  )
})
