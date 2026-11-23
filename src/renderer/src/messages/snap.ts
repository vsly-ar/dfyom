// User-facing strings of snapping and the measure tool (task U3), shared by the Shape Editor's flat
// view and the 3D viewport. Doc: docs/conventions/ui.md#snap-and-measure, #internationalization
import type { UnitSystem } from '../../../core/project/document'
import type { SnapKind } from '../viewport/snap'
import { lengthText } from './shape'

export const snapMessages = {
  /** The label chip beside the snap glyph. */
  target: {
    end: 'End point',
    corner: 'Stock corner',
    centre: 'Centre',
    midpoint: 'Midpoint',
    edge: 'Stock edge',
    reference: 'Reference',
    grid: 'Grid point',
  } satisfies Record<SnapKind, string>,
  /** In the 3D viewport, a corner or end can be any mesh vertex, not only the stock's. */
  vertex: 'Vertex',
  toggle: 'Snap',
  toggleHint: 'Hold Alt while dragging to place freely.',
  sectionDepth: 'Section depth',
  sectionHint: 'Depth of the reference section below the face.',
  measure: {
    tool: 'Measure',
    prompt: 'Click two points to measure. Esc ends.',
    second: 'Click the second point.',
    /** The 3D viewport's second-point prompt (DF20: Shift locks the line to an axis). */
    secondAxis: 'Click the second point. Hold Shift to lock to an axis.',
    along: (axis: 'x' | 'y' | 'z') => `Along ${axis.toUpperCase()}. Click the second point.`,
    /** Two points set: the next click or Esc clears them (DF21). */
    clear: 'Click or press Esc to clear.',
    distance: (mm: number, units: UnitSystem) => `Distance ${lengthText(mm, units)}`,
    chip: (mm: number, units: UnitSystem) => lengthText(mm, units),
    /** Tooltip of the chip: the components along the frame's axes ("ΔX 12.00 mm, ΔY 5.00 mm"). */
    deltas: (parts: readonly (readonly [string, number])[], units: UnitSystem) =>
      parts.map(([axis, mm]) => `Δ${axis.toUpperCase()} ${lengthText(mm, units)}`).join(', '),
    summary: (mm: number, parts: readonly (readonly [string, number])[], units: UnitSystem) =>
      `Distance ${lengthText(mm, units)} (${snapMessages.measure.deltas(parts, units)}).`,
  },
} as const
