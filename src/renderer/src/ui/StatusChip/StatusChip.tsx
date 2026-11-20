// StatusChip: evaluation, plan and stale status as a label with an icon (colour never alone).
// Machine state has its own badge (MachineStateBadge). Doc: docs/conventions/ui.md#inventory-v01
import { Check, CircleAlert, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import styles from './StatusChip.module.css'

export type StatusTone = 'neutral' | 'success' | 'busy' | 'warning' | 'danger'

const ICONS: Record<StatusTone, LucideIcon | null> = {
  neutral: null,
  success: Check,
  busy: LoaderCircle,
  warning: TriangleAlert,
  danger: CircleAlert,
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
  const Icon = ICONS[tone]
  return (
    <span data-tone={tone} className={[styles['chip'], className].filter(Boolean).join(' ')}>
      {icon ?? (Icon ? <Icon aria-hidden="true" className={styles['icon']} /> : null)}
      {children}
    </span>
  )
}
