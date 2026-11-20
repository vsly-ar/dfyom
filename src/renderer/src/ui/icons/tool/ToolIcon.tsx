// Own CNC tool and view icons (16 px grid, 1.35 px stroke); the `data-accent` part turns amber
// only while the tool is active. Shapes from the approved design system's icon sheet.
// Doc: docs/conventions/ui.md#icons
import type { ReactNode } from 'react'
import styles from './ToolIcon.module.css'

const ICONS = {
  select: {
    label: 'Select',
    body: (
      <>
        <path d="M3.5 2.5l8.5 5-3.8 1L6.2 12z" />
        <path data-accent="" d="M8.4 8.6l2.6 4" />
      </>
    ),
  },
  rect: {
    label: 'Rectangle',
    body: (
      <>
        <rect x="2.5" y="4" width="11" height="8" rx=".5" />
        <path data-accent="" d="M1.5 3h2v2h-2zM12.5 11h2v2h-2z" />
      </>
    ),
  },
  circle: {
    label: 'Circle',
    body: (
      <>
        <circle cx="8" cy="8" r="5.5" />
        <path data-accent="" d="M8 8l3.9-3.9" />
        <circle data-accent="" data-fill="" cx="8" cy="8" r="1" />
      </>
    ),
  },
  line: {
    label: 'Polyline',
    body: (
      <>
        <path d="M2.5 12.5L7 4.5l6.5 4" />
        <circle data-accent="" cx="7" cy="4.5" r="1.3" />
        <circle data-accent="" cx="2.5" cy="12.5" r="1.3" />
        <circle data-accent="" cx="13.5" cy="8.5" r="1.3" />
      </>
    ),
  },
  measure: {
    label: 'Measure',
    body: (
      <>
        <path d="M2 11.5L11.5 2 14 4.5 4.5 14z" />
        <path data-accent="" d="M5 8.5l1.3 1.3M7 6.5l1 1M9 4.5l1.3 1.3" />
      </>
    ),
  },
  facing: {
    label: 'Facing',
    body: (
      <>
        <rect x="2" y="9" width="12" height="4.5" rx="1" />
        <path data-accent="" d="M2 6.5h12M2 4h12" />
      </>
    ),
  },
  profile: {
    label: 'Profile',
    body: (
      <>
        <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
        <rect data-accent="" x="2" y="2" width="12" height="12" rx="3" strokeDasharray="2 2" />
      </>
    ),
  },
  pocket: {
    label: 'Pocket',
    body: (
      <>
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
        <path data-accent="" d="M5 6h6M5 8h6M5 10h6" />
      </>
    ),
  },
  drill: {
    label: 'Drill',
    body: (
      <>
        <circle cx="8" cy="8" r="3.5" />
        <path data-accent="" d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" />
      </>
    ),
  },
  tabs: {
    label: 'Tabs',
    body: (
      <>
        <path d="M1.5 10h4v-2h5v2h4" />
        <path data-accent="" d="M5.5 10V8h5v2" />
      </>
    ),
  },
  endmill: {
    label: 'End mill',
    body: (
      <>
        <path d="M6 1.5h4v5H6zM6 6.5l-.5 8h5l-.5-8" />
        <path data-accent="" d="M5.5 14.5h5" />
      </>
    ),
  },
  simulate: {
    label: 'Simulate',
    body: (
      <>
        <path d="M5 3.3l8 4.7-8 4.7z" />
        <path data-accent="" d="M2.5 5v6" />
      </>
    ),
  },
  jog: {
    label: 'Jog',
    body: (
      <>
        <rect x="6" y="6" width="4" height="4" rx="1" />
        <path
          data-accent=""
          d="M8 1.5v3M6.5 3L8 1.5 9.5 3M8 14.5v-3M6.5 13L8 14.5 9.5 13M1.5 8h3M3 6.5L1.5 8 3 9.5M14.5 8h-3M13 6.5L14.5 8 13 9.5"
        />
      </>
    ),
  },
  zero: {
    label: 'Work zero',
    body: (
      <>
        <path d="M2 14V2M2 14h12" />
        <circle data-accent="" cx="2" cy="14" r="1.6" />
        <path d="M6 10l3-3" />
      </>
    ),
  },
  probe: {
    label: 'Probe Z',
    body: (
      <>
        <path d="M8 2v7M5.5 6.5L8 9l2.5-2.5" />
        <path data-accent="" d="M2.5 13.5h11" />
      </>
    ),
  },
  fit: {
    label: 'Fit',
    body: (
      <>
        <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
        <rect data-accent="" x="5.5" y="5.5" width="5" height="5" rx=".5" />
      </>
    ),
  },
  iso: {
    label: 'Isometric',
    body: (
      <>
        <path d="M8 2l5.5 3v6L8 14l-5.5-3V5z" />
        <path data-accent="" d="M8 8l5.5-3M8 8L2.5 5M8 8v6" />
      </>
    ),
  },
  // View presets (task 3.5): the cube of `iso` with the viewed face as the accent part.
  top: {
    label: 'Top',
    body: (
      <>
        <path d="M8 2l5.5 3v6L8 14l-5.5-3V5zM8 8v6" />
        <path data-accent="" d="M2.5 5L8 8l5.5-3L8 2z" />
      </>
    ),
  },
  front: {
    label: 'Front',
    body: (
      <>
        <path d="M8 2l5.5 3v6L8 14l-5.5-3V5zM8 8l5.5-3" />
        <path data-accent="" d="M2.5 5L8 8v6l-5.5-3z" />
      </>
    ),
  },
  right: {
    label: 'Right',
    body: (
      <>
        <path d="M8 2l5.5 3v6L8 14l-5.5-3V5zM8 8L2.5 5" />
        <path data-accent="" d="M13.5 5L8 8v6l5.5-3z" />
      </>
    ),
  },
  grid: {
    label: 'Grid',
    body: (
      <>
        <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
        <path data-accent="" d="M6.2 2.5v11M9.8 2.5v11M2.5 6.2h11M2.5 9.8h11" />
      </>
    ),
  },
} satisfies Record<string, { label: string; body: ReactNode }>

export type ToolIconName = keyof typeof ICONS

export const TOOL_ICON_NAMES = Object.keys(ICONS) as ToolIconName[]

/** Default label of an icon (for tooltips and accessible names). */
export function toolIconLabel(name: ToolIconName): string {
  return ICONS[name].label
}

export interface ToolIconProps {
  name: ToolIconName
  className?: string | undefined
}

/** Decorative (aria-hidden); the control that shows it carries the accessible name. */
export function ToolIcon({ name, className }: ToolIconProps): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
      className={[styles['icon'], className].filter(Boolean).join(' ')}
    >
      {ICONS[name].body}
    </svg>
  )
}
