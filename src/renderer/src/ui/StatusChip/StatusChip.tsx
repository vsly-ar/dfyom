// StatusChip: evaluation, plan and stale status as a label with an icon (colour never alone).
// Machine state has its own badge (MachineStateBadge). Doc: docs/conventions/ui.md#inventory-v01
import { Icon, type IconName } from '../icons/Icon'
import type { ReactNode } from 'react'
import styles from './StatusChip.module.css'

export type StatusTone = 'neutral' | 'success' | 'busy' | 'warning' | 'danger'

const ICONS: Record<StatusTone, IconName | null> = {
  neutral: null,
  success: 'check',
  busy: 'busy',
  warning: 'warning',
  danger: 'error',
}

export interface StatusChipProps {
  tone?: StatusTone
  children: ReactNode
  /** Replaces the tone's default icon. */
  icon?: ReactNode
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
}

export function StatusChip({
  tone = 'neutral',
  children,
  icon,
  className,
}: StatusChipProps): React.JSX.Element {
  const name = ICONS[tone]
  return (
    <span data-tone={tone} className={[styles['chip'], className].filter(Boolean).join(' ')}>
      {icon ?? (name ? <Icon name={name} className={styles['icon']} /> : null)}
      {children}
    </span>
  )
}
