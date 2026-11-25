/**
 * Pattern presets (patterns P2, Q125): a lattice plus a cell, no special generators. Picking one
 * sets `cell`, `lattice` and `spacing` (one `design.pattern.update`) and nothing else. Sizes are
 * metric sources; the core parses units. UI only: an agent sets those three fields directly.
 * Doc: docs/modes/patterns.md#ui, docs/modes/patterns.md#implementation-p2
 */

export interface PatternPreset {
  readonly id: string
  /** `design.pattern.update` args (cell, lattice, spacing). */
  readonly args: {
    readonly cell: Readonly<Record<string, string>>
    readonly lattice: 'square' | 'staggered' | 'hex' | 'polar'
    readonly spacing: { readonly gap: string }
  }
}

export const PATTERN_PRESETS: readonly PatternPreset[] = [
  {
    id: 'staggeredHoles',
    args: {
      cell: { kind: 'circle', diameter: '6 mm' },
      lattice: 'staggered',
      spacing: { gap: '3 mm' },
    },
  },
  {
    id: 'honeycomb',
    args: {
      cell: {
        kind: 'polygon',
        sides: '6',
        diameter: '10 mm',
        across: 'flats',
        cornerRadius: '1 mm',
        rotation: '30°',
      },
      lattice: 'hex',
      spacing: { gap: '2 mm' },
    },
  },
  {
    id: 'roundedSquares',
    args: {
      cell: { kind: 'rectangle', length: '10 mm', width: '10 mm', cornerRadius: '2 mm' },
      lattice: 'square',
      spacing: { gap: '3 mm' },
    },
  },
  {
    id: 'diamonds',
    args: {
      cell: {
        kind: 'rectangle',
        length: '8 mm',
        width: '8 mm',
        cornerRadius: '0.5 mm',
        rotation: '45°',
      },
      lattice: 'staggered',
      spacing: { gap: '2 mm' },
    },
  },
  {
    id: 'slots',
    args: {
      cell: { kind: 'obround', length: '16 mm', width: '5 mm', rotation: '90°' },
      lattice: 'staggered',
      spacing: { gap: '3 mm' },
    },
  },
  {
    id: 'grille',
    args: {
      cell: { kind: 'circle', diameter: '3 mm' },
      lattice: 'hex',
      spacing: { gap: '1.5 mm' },
    },
  },
]
