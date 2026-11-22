// ModeSwitcher: Design / Plan / Run, its own component (decision 23), separate from tabs. An amber
// underline slides to the active mode and the mode icon's accent part turns amber. Its place in
// the window is decided with the shell (3.3b). Doc: docs/conventions/ui.md#mode-switching
import { ToggleGroup } from 'radix-ui'
import { useRef } from 'react'
import { APP_MODES, isAppMode, type AppMode } from '../../../../core/modes'
import { Icon, type IconName } from '../icons/Icon'
import { useSlidingIndicator } from '../useSlidingIndicator'
import styles from './ModeSwitcher.module.css'

const MODES: Record<AppMode, { label: string; icon: IconName }> = {
  design: { label: 'Design', icon: 'design' },
  plan: { label: 'Plan', icon: 'plan' },
  run: { label: 'Run', icon: 'run' },
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
          <Icon name={MODES[m].icon} className={styles['icon']} />
          {MODES[m].label}
        </ToggleGroup.Item>
      ))}
      <span className={styles['indicator']} style={indicator} aria-hidden="true" />
    </ToggleGroup.Root>
  )
}
