// Icon: one of DFYOM's own icons (B22 set, decision D33) from the single source `iconSet.ts`.
// 16 px grid, 1.35 px stroke; the `data-accent` part turns amber only while its control is active
// (pressed toggle, selected row, current mode) and in a primary button; the control's CSS does it.
// Doc: docs/conventions/ui.md#icons
import styles from './Icon.module.css'
import { ICON_NAMES, ICON_SET, type IconGroup, type IconName, type IconPart } from './iconSet'

export { ICON_NAMES, ICON_SET, type IconGroup, type IconName }

/** Default label of an icon (tooltips, gallery). */
export function iconLabel(name: IconName): string {
  return ICON_SET[name].label
}

export type IconSize = 'sm' | 'md' | 'lg' | 'xl'

/** Clockwise quarter turns of the drawing about its centre (DF99: a facing on the bottom or a side). */
export type IconRotation = 0 | 90 | 180 | 270

export interface IconProps {
  name: IconName
  /** `--icon-sm` 14 / `md` 16 (default) / `lg` 20 / `xl` 28; a control's CSS may size it too. */
  size?: IconSize
  /**
   * An accessible name for an icon that carries meaning alone (role img). Omit for decorative
   * icons (aria-hidden): the control or the text beside it names them.
   */
  label?: string
  /** Turns the drawing clockwise about its centre; 0 (default) draws it as designed. */
  rotate?: IconRotation | undefined
  className?: string | undefined
  /** Data attributes for styling hooks (e.g. `data-error`). */
  [data: `data-${string}`]: string | boolean | undefined
}

function Part({ part }: { part: IconPart }): React.JSX.Element {
  const common = {
    ...(part.a ? { 'data-accent': '' } : {}),
    ...(part.fill ? { 'data-fill': '' } : {}),
    ...(part.dash !== undefined ? { strokeDasharray: part.dash } : {}),
  }
  if (part.d !== undefined) return <path d={part.d} {...common} />
  if (part.rect !== undefined) {
    const [x, y, width, height, rx] = part.rect
    return <rect x={x} y={y} width={width} height={height} rx={rx} {...common} />
  }
  const [cx, cy, r] = part.circle ?? [0, 0, 0]
  return <circle cx={cx} cy={cy} r={r} {...common} />
}

export function Icon({
  name,
  size,
  label,
  rotate = 0,
  className,
  ...data
}: IconProps): React.JSX.Element {
  const parts = ICON_SET[name].parts.map((p, i) => <Part key={i} part={p} />)
  return (
    <svg
      viewBox="0 0 16 16"
      {...(label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
      focusable="false"
      data-icon={name}
      {...(size !== undefined ? { 'data-size': size } : {})}
      {...(rotate !== 0 ? { 'data-rotate': rotate } : {})}
      {...data}
      className={[styles['icon'], className].filter(Boolean).join(' ')}
    >
      {rotate === 0 ? parts : <g transform={`rotate(${rotate} 8 8)`}>{parts}</g>}
    </svg>
  )
}
