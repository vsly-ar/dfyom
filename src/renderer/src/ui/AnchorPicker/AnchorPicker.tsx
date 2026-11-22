// AnchorPicker: one of the nine points of a feature's bounding box (placement anchor), as a 3 × 3
// radio group drawn over the box's outline. Seen from outside the face: the top row is the
// highest `v`, the left column the lowest `u`. Arrow keys move the choice in the grid (a radio
// group: the choice follows focus), Home/End go to the first/last point. The chosen point is one
// amber dot that slides to it (`--motion-base`). Disabled stays focusable (`aria-disabled`) so its
// reason, linked by `aria-describedby`, can be read.
// Doc: docs/conventions/ui.md#design-and-plan-controls-v02, docs/modes/design-v0.2.md#placement-anchors
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import styles from './AnchorPicker.module.css'

export type AnchorAxisPoint = 'min' | 'centre' | 'max'
export interface AnchorValue {
  readonly u: AnchorAxisPoint
  readonly v: AnchorAxisPoint
}

const AXIS: readonly AnchorAxisPoint[] = ['min', 'centre', 'max']
/** Grid order: rows from the highest `v` (top) down, columns from the lowest `u` (left). */
export const ANCHOR_GRID: readonly AnchorValue[] = (['max', 'centre', 'min'] as const).flatMap(
  (v) => AXIS.map((u) => ({ u, v })),
)

export interface AnchorPickerProps {
  /** Accessible name of the group ("Anchor"). */
  label: string
  value: AnchorValue
  onValueChange: (value: AnchorValue) => void
  /** Name of a point ("Front left", "Centre"). */
  pointLabel: (point: AnchorValue) => string
  /** Outline drawn behind the points: the feature's bounding box, or its circle. */
  shape?: 'rectangle' | 'circle'
  disabled?: boolean
  /** Visible text beside the grid (the chosen point's name); hidden from assistive tech. */
  caption?: ReactNode
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
  /** Layout only; appended to the group's class. */
  className?: string | undefined
}

const same = (a: AnchorValue, b: AnchorValue) => a.u === b.u && a.v === b.v
const col = (p: AnchorValue) => AXIS.indexOf(p.u)
const row = (p: AnchorValue) => 2 - AXIS.indexOf(p.v)

export function AnchorPicker({
  label,
  value,
  onValueChange,
  pointLabel,
  shape = 'rectangle',
  disabled = false,
  caption,
  className,
  ...aria
}: AnchorPickerProps): React.JSX.Element {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const choose = (p: AnchorValue, focus: boolean) => {
    if (focus) buttons.current[ANCHOR_GRID.findIndex((g) => same(g, p))]?.focus()
    if (!disabled && !same(p, value)) onValueChange(p)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, p: AnchorValue) => {
    const r = row(p)
    const c = col(p)
    const at = (rr: number, cc: number) =>
      ANCHOR_GRID[Math.min(2, Math.max(0, rr)) * 3 + Math.min(2, Math.max(0, cc))]!
    const next =
      e.key === 'ArrowLeft'
        ? at(r, c - 1)
        : e.key === 'ArrowRight'
          ? at(r, c + 1)
          : e.key === 'ArrowUp'
            ? at(r - 1, c)
            : e.key === 'ArrowDown'
              ? at(r + 1, c)
              : e.key === 'Home'
                ? ANCHOR_GRID[0]!
                : e.key === 'End'
                  ? ANCHOR_GRID[8]!
                  : undefined
    if (next === undefined) return
    e.preventDefault()
    choose(next, true)
  }
  const group = (
    <div
      role="radiogroup"
      aria-label={label}
      {...aria}
      {...(disabled ? { 'aria-disabled': true } : {})}
      data-shape={shape}
      className={[styles['root'], className].filter(Boolean).join(' ')}
      style={{ '--col': col(value), '--row': row(value) } as React.CSSProperties}
    >
      <span className={styles['outline']} aria-hidden="true" />
      <span className={styles['thumb']} aria-hidden="true" />
      {ANCHOR_GRID.map((p, i) => {
        const checked = same(p, value)
        return (
          <button
            key={`${p.u}-${p.v}`}
            ref={(el) => {
              buttons.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={pointLabel(p)}
            {...(disabled ? { 'aria-disabled': true } : {})}
            tabIndex={checked ? 0 : -1}
            className={styles['point']}
            onClick={() => choose(p, false)}
            onKeyDown={(e) => onKeyDown(e, p)}
          >
            <span className={styles['dot']} />
          </button>
        )
      })}
    </div>
  )
  if (caption === undefined) return group
  return (
    <span className={styles['withCaption']}>
      {group}
      <span className={styles['caption']} aria-hidden="true">
        {caption}
      </span>
    </span>
  )
}
