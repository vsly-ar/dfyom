// ModeSwitcher: Design / Plan / Run, its own component (decision 23), separate from tabs. An amber
// underline slides to the active mode and the mode icon's accent part turns amber. Its place in
// the window is decided with the shell (3.3b). Doc: docs/conventions/ui.md#mode-switching
import { ToggleGroup } from 'radix-ui'
import { useRef, type ReactNode } from 'react'
import { APP_MODES, isAppMode, type AppMode } from '../../../../core/modes'
import { useSlidingIndicator } from '../useSlidingIndicator'
import styles from './ModeSwitcher.module.css'

const MODES: Record<AppMode, { label: string; icon: ReactNode }> = {
  design: {
    label: 'Design',
    icon: (
      <>
        <path d="M2.5 13.5h11" />
        <path d="M4 11l6.5-6.5 2 2L6 13H4z" />
        <path data-accent="" d="M10.5 4.5l1-1 2 2-1 1" />
      </>
    ),
  },
  plan: {
    label: 'Plan',
    icon: (
      <>
        <path d="M2.5 4h3M2.5 8h3M2.5 12h3" />
        <path data-accent="" d="M8.5 3.5h5v4.5h-5v4.5h5" />
      </>
    ),
  },
  run: {
    label: 'Run',
    icon: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path data-accent="" d="M6.5 5.3l4 2.7-4 2.7z" />
      </>
    ),
  },
}

export interface ModeSwitcherProps {
  value: AppMode
  onValueChange: (mode: AppMode) => void
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
}

export function ModeSwitcher({
  value,
  onValueChange,
  className,
}: ModeSwitcherProps): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const indicator = useSlidingIndicator(root, '[data-state="on"]', value, 10)
  return (
    <ToggleGroup.Root
      ref={root}
      type="single"
      aria-label="Mode"
      value={value}
      onValueChange={(v) => {
        if (isAppMode(v)) onValueChange(v)
      }}
      className={[styles['root'], className].filter(Boolean).join(' ')}
    >
      {APP_MODES.map((m) => (
        <ToggleGroup.Item key={m} value={m} className={styles['item']}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={styles['icon']}>
            {MODES[m].icon}
          </svg>
          {MODES[m].label}
        </ToggleGroup.Item>
      ))}
      <span className={styles['indicator']} style={indicator} aria-hidden="true" />
    </ToggleGroup.Root>
  )
}
