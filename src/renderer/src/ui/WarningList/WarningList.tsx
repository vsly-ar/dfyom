// WarningList and WarningItem: DFM (and later feeds-and-speeds, machine-check) warnings with their
// tier (soft: neutral, "i", dismissible; hard: orange triangle, not dismissible; error: red, an
// impossible value that blocks generation, task 3.7), an optional
// fix button ("Apply ≥ 3.2 mm") and a way to the blamed item. Warnings never block.
// Doc: docs/conventions/ui.md#warnings-and-dfm, #inventory-v01
import { CircleAlert, Info, TriangleAlert, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '../Button/Button'
import { IconButton } from '../IconButton/IconButton'
import styles from './WarningList.module.css'

export type WarningTier = 'soft' | 'hard' | 'error'

export interface WarningView {
  /** Stable id (code + operation + parameter), so a dismissal survives re-renders. */
  id: string
  tier: WarningTier
  text: ReactNode
  /** What it is about ("Pocket 1"); a button when `onSelect` is given. */
  subject?: string
  onSelect?: () => void
  /** One-click fix, dispatched by the caller as one command (one undo step). */
  fix?: { label: string; onApply: () => void }
}

export interface WarningListLabels {
  /** Accessible name of the list ("Warnings"). */
  list: string
  dismiss: string
  dismissed: (n: number) => string
  show: string
  hide: string
  tier: Record<WarningTier, string>
}

export interface WarningListProps {
  items: readonly WarningView[]
  labels: WarningListLabels
  /** Shown instead of the list when there is nothing (and nothing dismissed). */
  empty?: ReactNode
  /** A muted note under the list ("Geometry checks pending."). */
  note?: ReactNode
  className?: string | undefined
}

export function WarningItem({
  item,
  labels,
  onDismiss,
}: {
  item: WarningView
  labels: WarningListLabels
  onDismiss?: (() => void) | undefined
}): React.JSX.Element {
  const Icon = item.tier === 'error' ? CircleAlert : item.tier === 'hard' ? TriangleAlert : Info
  return (
    <li className={styles['item']} data-tier={item.tier}>
      <Icon aria-hidden="true" className={styles['icon']} />
      <div className={styles['body']}>
        <span className={styles['srOnly']}>{labels.tier[item.tier]}: </span>
        {item.subject !== undefined ? (
          item.onSelect ? (
            <button type="button" className={styles['subject']} onClick={item.onSelect}>
              {item.subject}
            </button>
          ) : (
            <span className={styles['subject']}>{item.subject}</span>
          )
        ) : null}
        <span className={styles['text']}>{item.text}</span>
        {item.fix ? (
          <Button size="sm" className={styles['fix']} onClick={item.fix.onApply}>
            {item.fix.label}
          </Button>
        ) : null}
      </div>
      {onDismiss ? (
        <IconButton
          label={labels.dismiss}
          icon={<X aria-hidden="true" />}
          className={styles['dismiss']}
          onClick={onDismiss}
        />
      ) : null}
    </li>
  )
}

export function WarningList({
  items,
  labels,
  empty,
  note,
  className,
}: WarningListProps): React.JSX.Element {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [showDismissed, setShowDismissed] = useState(false)
  const hidden = items.filter((i) => i.tier === 'soft' && dismissed.has(i.id))
  const shown = showDismissed ? items : items.filter((i) => !hidden.includes(i))
  return (
    <div className={[styles['root'], className].filter(Boolean).join(' ')}>
      {shown.length > 0 ? (
        <ul className={styles['list']} aria-label={labels.list}>
          {shown.map((item) => (
            <WarningItem
              key={item.id}
              item={item}
              labels={labels}
              onDismiss={
                item.tier === 'soft' && !dismissed.has(item.id)
                  ? () => setDismissed((d) => new Set([...d, item.id]))
                  : undefined
              }
            />
          ))}
        </ul>
      ) : hidden.length === 0 && empty !== undefined ? (
        <p className={styles['empty']}>{empty}</p>
      ) : null}
      {hidden.length > 0 ? (
        <p className={styles['collapsed']}>
          {labels.dismissed(hidden.length)} ·{' '}
          <button
            type="button"
            className={styles['link']}
            onClick={() => setShowDismissed((s) => !s)}
          >
            {showDismissed ? labels.hide : labels.show}
          </button>
        </p>
      ) : null}
      {note !== undefined ? <p className={styles['note']}>{note}</p> : null}
    </div>
  )
}
