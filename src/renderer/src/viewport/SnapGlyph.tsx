// The snap glyph and its label chip (task U3): a square for ends and corners, a circle for centres,
// a triangle for midpoints, a cross for grid points, an hourglass for the nearest point of an edge
// or the reference section. `--vp-edge` outline on the hover tint, so the shape, not the colour,
// tells targets apart. The glyph pulses once when the target changes (`--motion-emphasis`; a cut
// under reduced motion). DOM, so it serves the flat view and, inside an Html overlay, the 3D view.
// Doc: docs/conventions/ui.md#snap-and-measure
import type { SnapKind } from './snap'
import styles from './SnapGlyph.module.css'

/** Glyph outline (16 × 16 box, centred on the point). */
const SHAPE: Readonly<Record<SnapKind, string>> = {
  end: 'M3.5 3.5H12.5V12.5H3.5Z',
  corner: 'M3.5 3.5H12.5V12.5H3.5Z',
  centre: 'M8 3.25A4.75 4.75 0 1 1 7.99 3.25Z',
  midpoint: 'M8 3L13 12H3Z',
  grid: 'M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5',
  edge: 'M4 3.5H12L4 12.5H12Z',
  reference: 'M4 3.5H12L4 12.5H12Z',
}

export function SnapGlyph({
  kind,
  x,
  y,
  label,
  className,
}: {
  kind: SnapKind
  /** Screen position (px) of the snapped point within the positioned parent. */
  x: number
  y: number
  label: string
  className?: string | undefined
}): React.JSX.Element {
  return (
    <div
      className={[styles['snap'], className].filter(Boolean).join(' ')}
      style={{ transform: `translate(${x}px, ${y}px)` }}
      data-testid="snap-glyph"
      data-kind={kind}
      aria-hidden="true"
    >
      <svg className={styles['glyph']} width={16} height={16} viewBox="0 0 16 16">
        <path d={SHAPE[kind]} data-open={kind === 'grid' ? '' : undefined} />
      </svg>
      <span className={styles['label']}>{label}</span>
    </div>
  )
}
