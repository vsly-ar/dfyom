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

/**
 * A Clones instance in the row-field drawings (DF47): a 4 × 4 rounded square centred on (x, y),
 * the source solid, a copy dashed.
 */
const inst = (x: number, y: number, copy = false) => (
  <rect
    x={x - 2}
    y={y - 2}
    width="4"
    height="4"
    rx="1"
    {...(copy ? { strokeDasharray: '1.5 1' } : {})}
  />
)

/** The centre of an arc in the Clones drawings: a small cross. */
const centre = (x: number, y: number) => (
  <path
    d={`M${x - 1.2} ${y - 1.2}L${x + 1.2} ${y + 1.2}M${x + 1.2} ${y - 1.2}L${x - 1.2} ${y + 1.2}`}
  />
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
  // DF25: one drawing per measured quantity, so no panel shows one drawing for two fields
  // (ui.md § Field, illustration rule)
  diameter: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path data-accent="" d="M3 10H17" />
    </>
  ),
  positionX: (
    <>
      <path d="M3 3V17H17" />
      <circle cx="13" cy="8" r="1.5" />
      <path data-accent="" d="M3 8H11.5" />
    </>
  ),
  positionY: (
    <>
      <path d="M3 3V17H17" />
      <circle cx="13" cy="8" r="1.5" />
      <path data-accent="" d="M13 17V9.5" />
    </>
  ),
  rotation: (
    <>
      <path d="M3 16H17M3 16L13 6" />
      <path data-accent="" d="M10 16A7 7 0 0 0 7.95 11.05" />
    </>
  ),
  floorRadius: (
    <>
      <path d="M2 4H6V10M12 16H18" />
      <path data-accent="" d="M6 10A6 6 0 0 0 12 16" />
    </>
  ),
  slotWidth: (
    <>
      <path d="M2 6H6V14M14 14V6H18" />
      <path data-accent="" d="M6 14H14" />
    </>
  ),
  tabWidth: (
    <>
      <path d="M2 5H18M2 15H7V10M13 10V15H18" />
      <path data-accent="" d="M7 10H13" />
    </>
  ),
  tabThickness: (
    <>
      <path d="M2 5H18M2 15H7V10H13" />
      <path data-accent="" d="M13 10V15" />
    </>
  ),
  breakthrough: (
    <>
      <path d="M2 4H18M2 14H5M9 14H18M5 4V14M9 4V14" />
      <path data-accent="" d="M7 14V18" />
    </>
  ),
  counterboreDiameter: (
    <>
      <path d="M2 4H5V10H8V17M18 4H15V10H12V17" />
      <path data-accent="" d="M5 10H15" />
    </>
  ),
  counterboreDepth: (
    <>
      <path d="M2 4H5M5 10H8V17M18 4H15V10H12V17" />
      <path data-accent="" d="M5 4V10" />
    </>
  ),
  countersinkDiameter: (
    <>
      <path d="M2 4H5L8 8V17M18 4H15L12 8V17" />
      <path data-accent="" d="M5 4H15" />
    </>
  ),
  headSink: (
    <>
      <path d="M2 5H5M15 5H18M5 5L8 11V17M15 5L12 11V17M6 8H14L11 12H9Z" />
      <path data-accent="" d="M10 5V8" />
    </>
  ),
  fluteLength: (
    <>
      <path d="M8 2V8M12 2V8M7 8H13V18H7M7 12L13 10M7 16L13 14" />
      <path data-accent="" d="M7 8V18" />
    </>
  ),
  overallLength: (
    <>
      <path d="M8 2H12V18H8M8 10H12M8 13L12 11.5M8 16L12 14.5" />
      <path data-accent="" d="M8 2V18" />
    </>
  ),
  stickout: (
    <>
      <path d="M4 2H16L14 6H6ZM8 6V18H12V6M8 13L12 11.5" />
      <path data-accent="" d="M8 6V18" />
    </>
  ),
  shank: (
    <>
      <path d="M8 2H12V18H8ZM8 10H12M8 13L12 11.5M8 16L12 14.5" />
      <path data-accent="" d="M8 5H12" />
    </>
  ),
  tipDiameter: (
    <>
      <path d="M4 3H16L12 15H8Z" />
      <path data-accent="" d="M8 15H12" />
    </>
  ),
  spindle: (
    <>
      <circle cx="10" cy="10" r="2" />
      <path d="M10 3.5L12 2M10 3.5L12 5" />
      <path data-accent="" d="M10 3.5A6.5 6.5 0 1 1 3.5 10" />
    </>
  ),
  plunge: (
    <>
      <circle cx="10" cy="6" r="3.5" />
      <path d="M3 18H17" />
      <path data-accent="" d="M10 9.5V18" />
    </>
  ),
  stepover: (
    <>
      <circle cx="7" cy="10" r="4" />
      <circle cx="13" cy="10" r="4" />
      <path data-accent="" d="M7 10H13" />
    </>
  ),
  allowance: (
    <>
      <path d="M4 3V17H17M7 3V14H17" />
      <path data-accent="" d="M4 9H7" />
    </>
  ),
  finishStepdown: (
    <>
      <path d="M2 5H8V12H13V14H18" />
      <path data-accent="" d="M13 12V14" />
    </>
  ),
  chipBreak: (
    <>
      <path d="M6 3V17H14V3" />
      <path d="M10 6V10" />
      <path data-accent="" d="M10 14V10" />
    </>
  ),
  clearance: (
    <>
      <path d="M2 15H18" />
      <path d="M2 4H18" strokeDasharray="2 2" />
      <path data-accent="" d="M10 15V4" />
    </>
  ),
  retract: (
    <>
      <path d="M2 15H18" />
      <path d="M2 10H18" strokeDasharray="2 2" />
      <path data-accent="" d="M10 15V10" />
    </>
  ),
  arcTolerance: (
    <>
      <path d="M3 14H17M3 14A9 9 0 0 1 17 14" />
      <path data-accent="" d="M10 14V10.66" />
    </>
  ),
  // DF47: the Clones row fields (ui.md § Clones); instances as squares, the source solid
  cloneColumns: (
    <>
      {inst(4, 8)}
      {inst(10, 8, true)}
      {inst(16, 8, true)}
      <path data-accent="" d="M2 14H18" />
    </>
  ),
  cloneRows: (
    <>
      {inst(8, 16)}
      {inst(8, 10, true)}
      {inst(8, 4, true)}
      <path data-accent="" d="M14 18V2" />
    </>
  ),
  cloneStepU: (
    <>
      {inst(4, 10)}
      {inst(16, 10, true)}
      <path data-accent="" d="M6 10H14" />
    </>
  ),
  cloneStepV: (
    <>
      {inst(10, 16)}
      {inst(10, 4, true)}
      <path data-accent="" d="M10 14V6" />
    </>
  ),
  cloneCount: (
    <>
      {inst(4, 12)}
      {inst(10, 8, true)}
      {inst(16, 4, true)}
      <path data-accent="" d="M2 17H18" />
    </>
  ),
  cloneDirection: (
    <>
      {inst(4, 16)}
      {inst(16, 6, true)}
      <path d="M6 16H18M5.5 14.75L14.5 7.25" />
      <path data-accent="" d="M11 16A7 7 0 0 0 9.4 11.5" />
    </>
  ),
  cloneDistance: (
    <>
      {inst(4, 16)}
      {inst(16, 6, true)}
      <path d="M6 16H18" />
      <path data-accent="" d="M5.5 14.75L14.5 7.25" />
    </>
  ),
  cloneRadius: (
    <>
      {inst(4, 10)}
      {centre(11, 10)}
      <path d="M11 3A7 7 0 0 1 11 17" strokeDasharray="1.5 1.5" />
      <path data-accent="" d="M6 10H9.5" />
    </>
  ),
  cloneCentreAngle: (
    <>
      {inst(4, 16)}
      {centre(14, 8)}
      <path d="M6 16H18M5.6 14.7L12.8 9" />
      <path data-accent="" d="M10 16A6 6 0 0 0 8.7 12.3" />
    </>
  ),
  cloneSweep: (
    <>
      {inst(3, 10)}
      {centre(10, 10)}
      <path d="M10 3A7 7 0 0 0 3.5 7.5" strokeDasharray="1.5 1.5" />
      <path data-accent="" d="M3.5 12.5A7 7 0 1 0 10 3" />
    </>
  ),
  cloneStepAngle: (
    <>
      {centre(4, 16)}
      {inst(16, 16)}
      {inst(12.5, 7.5, true)}
      <path d="M5.5 16H14M5.1 14.9L11.1 8.9" />
      <path data-accent="" d="M10 16A6 6 0 0 0 8.2 11.8" />
    </>
  ),
  clonePath: (
    <>
      {inst(3, 14)}
      {inst(17, 6, true)}
      <path data-accent="" d="M4 12C7 4 13 16 16 8" />
    </>
  ),
  cloneStart: (
    <>
      <circle cx="2.5" cy="16" r="1" />
      {inst(9, 8, true)}
      <path d="M11 8L14 12L18 4" />
      <path data-accent="" d="M3.1 15.2L7.4 10" />
    </>
  ),
  cloneSpacing: (
    <>
      <path d="M2 16L5 10M14.8 12L18 4" />
      {inst(6, 8, true)}
      {inst(14, 14, true)}
      <path data-accent="" d="M7.6 9.2L12.4 12.8" />
    </>
  ),
  // DF45: the Plan start card's machine choice; a gantry router, the cutter is the amber part
  machine: (
    <>
      <path d="M2 17H18M4 17V4H16V17" />
      <rect x="8" y="4" width="4" height="6" />
      <path data-accent="" d="M10 10V14" />
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
