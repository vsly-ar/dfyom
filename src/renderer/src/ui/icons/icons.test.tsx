import { readFileSync } from 'node:fs'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FIELD_ICON_NAMES, FieldIcon } from './field/FieldIcon'
import { ICON_NAMES, ICON_SET, Icon, iconLabel } from './Icon'
import type { IconPart } from './iconSet'

describe('field illustrations', () => {
  it('has the shapes of the design system', () => {
    expect(FIELD_ICON_NAMES).toEqual([
      'length',
      // H3: a slotted hole's travel between its end centres
      'slotTravel',
      'width',
      'depth',
      'stepdown',
      'corner',
      'chamfer',
      'tool',
      'feed',
      'tabs',
      // DF25: one illustration per meaning (ui.md#field)
      'diameter',
      'positionX',
      'positionY',
      'rotation',
      'scale',
      'offsetDistance',
      'floorRadius',
      'slotWidth',
      'tabWidth',
      'tabThickness',
      'breakthrough',
      'counterboreDiameter',
      'counterboreDepth',
      'countersinkDiameter',
      'headSink',
      'fluteLength',
      'overallLength',
      'stickout',
      'shank',
      'tipDiameter',
      'spindle',
      'plunge',
      'stepover',
      'allowance',
      'finishStepdown',
      'chipBreak',
      'clearance',
      'retract',
      'arcTolerance',
      // DF47: the Clones row fields (ui.md#clones)
      'cloneColumns',
      'cloneRows',
      'cloneStepU',
      'cloneStepV',
      'cloneCount',
      'cloneDirection',
      'cloneDistance',
      'cloneRadius',
      'cloneCentreAngle',
      'cloneSweep',
      'cloneStepAngle',
      'clonePath',
      'cloneStart',
      'cloneSpacing',
      'machine',
      'stock-length',
      'stock-width',
      'stock-thickness',
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

describe('own icon set (B22)', () => {
  it.each(ICON_NAMES)('%s: decorative 16-grid icon with a label', (name) => {
    const { container } = render(<Icon name={name} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('viewBox', '0 0 16 16')
    expect(svg?.children.length).toBe(ICON_SET[name].parts.length)
    expect(iconLabel(name)).toMatch(/^[A-Z]/)
  })

  it('keeps every drawing inside the 16 px canvas with a margin', () => {
    for (const name of ICON_NAMES)
      for (const p of ICON_SET[name].parts as readonly IconPart[]) {
        const nums = (p.d?.match(/-?\d*\.?\d+/g) ?? []).map(Number)
        const box = p.rect ?? p.circle ?? []
        for (const n of [...nums, ...box]) expect(Math.abs(n), name).toBeLessThanOrEqual(16)
      }
  })

  it('gives concept icons an accent part, never generic actions or status icons', () => {
    for (const name of ICON_NAMES) {
      const { group, parts } = ICON_SET[name]
      const accent = parts.some((p) => 'a' in p)
      if (group === 'status' || group === 'action') expect(accent, name).toBe(false)
      if (group === 'operation' || group === 'feature' || group === 'tool')
        expect(accent, name).toBe(true)
    }
  })

  it('names an icon that carries meaning alone (role img)', () => {
    const { getByRole } = render(<Icon name="info" label="Changed by the import" />)
    expect(getByRole('img', { name: 'Changed by the import' })).toHaveAttribute('data-icon', 'info')
  })

  it('takes a size token', () => {
    const { container } = render(<Icon name="add" size="lg" />)
    expect(container.querySelector('svg')).toHaveAttribute('data-size', 'lg')
  })

  it('turns the drawing about its centre when asked (DF99), never by default', () => {
    const turned = render(<Icon name="facing" rotate={90} />).container.querySelector('svg')!
    expect(turned).toHaveAttribute('data-rotate', '90')
    expect(turned.querySelector('g')).toHaveAttribute('transform', 'rotate(90 8 8)')
    const plain = render(<Icon name="facing" />).container.querySelector('svg')!
    expect(plain).not.toHaveAttribute('data-rotate')
    expect(plain.querySelector('g')).toBeNull()
  })

  it('is the icon sheet of the design-system page (design/icons/b22/sync-page.mjs)', () => {
    const page = readFileSync(`${process.cwd()}/docs/conventions/ui-design-system.html`, 'utf8')
    const block = page.slice(page.indexOf('/* icons:begin'), page.indexOf('/* icons:end */'))
    const shown = ICON_NAMES.filter((n) => !('reserved' in ICON_SET[n]))
    expect([...block.matchAll(/^ {2}'([a-z-]+)': \[/gm)].map((m) => m[1])).toEqual(shown)
    for (const name of shown) {
      const parts = ICON_SET[name].parts as readonly IconPart[]
      for (const p of parts) {
        const geometry =
          p.d ?? (p.rect ? `x="${p.rect[0]}" y="${p.rect[1]}"` : `cx="${p.circle?.[0]}"`)
        expect(block, name).toContain(geometry)
      }
    }
  })
})
