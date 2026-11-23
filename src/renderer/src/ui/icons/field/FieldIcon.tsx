// Field illustrations (viewBox 20, drawn at --icon-xl 28 px): a thin grey drawing of the feature
// whose measured part is one amber line on the same centreline (butt caps, no arrows).
// Shapes from the approved design system (FI map). Doc: docs/conventions/ui.md#field
import type { ReactNode } from 'react'
import styles from './FieldIcon.module.css'
import { STOCK_SIZE_ICONS } from './stockSize'

/** The stock's length, width and thickness (DF11), from their data in stockSize.ts. */
const stockSize = (name: keyof typeof STOCK_SIZE_ICONS) => (
  <>
    <path d={STOCK_SIZE_ICONS[name].d} />
    <path data-accent="" d={STOCK_SIZE_ICONS[name].accent} />
  </>
)

const ICONS = {
  length: (
    <>
      <rect x="2" y="6" width="16" height="8" rx="4" />
      <path data-accent="" d="M2 10H18" />
    </>
  ),
  width: (
    <>
      <rect x="2" y="6" width="16" height="8" rx="4" />
      <path data-accent="" d="M10 6V14" />
    </>
  ),
  depth: (
    <>
      <path d="M2 6H6V14H14V6H18" />
      <path data-accent="" d="M6 6V14" />
    </>
  ),
  stepdown: (
    <>
      <path d="M2 5H7V9H12V13H18" />
      <path data-accent="" d="M7 5V9" />
    </>
  ),
  corner: (
    <>
      <path d="M3 3V10A7 7 0 0 0 10 17H17" />
      <path data-accent="" d="M3 10A7 7 0 0 0 10 17" />
    </>
  ),
  chamfer: (
    <>
      <path d="M3 3V11L9 17H17" />
      <path data-accent="" d="M3 11L9 17" />
    </>
  ),
  tool: (
    <>
      <path d="M8 2h4v6H8zM8 8l-.5 9h5L12 8" />
      <path data-accent="" d="M8.6 10.5l2.9-1.4M8.4 13.5l3.3-1.6" />
    </>
  ),
  feed: (
    <>
      <circle cx="6.5" cy="10" r="3.5" />
      <path d="M2 15.5H6.5" />
      <path data-accent="" d="M6.5 15.5H18" />
    </>
  ),
  tabs: (
    <>
      <path d="M2 7H18M2 13H18" />
      <path data-accent="" d="M6 13H8M12 13H14" />
    </>
  ),
  'stock-length': stockSize('stock-length'),
  'stock-width': stockSize('stock-width'),
  'stock-thickness': stockSize('stock-thickness'),
} satisfies Record<string, ReactNode>

export type FieldIconName = keyof typeof ICONS

export const FIELD_ICON_NAMES = Object.keys(ICONS) as FieldIconName[]

export interface FieldIconProps {
  name: FieldIconName
  className?: string | undefined
}

/** Decorative (aria-hidden); the field label names the value. Saturation follows the Field. */
export function FieldIcon({ name, className }: FieldIconProps): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
      className={[styles['icon'], className].filter(Boolean).join(' ')}
    >
      {ICONS[name]}
    </svg>
  )
}
