// EmptyState: a mode or panel without its input explains the next step in one sentence and offers
// one primary action ("Design a part first" → "Go to Design").
// Doc: docs/conventions/ui.md#mode-switching, #copy-and-terminology
import type { ReactNode } from 'react'
import { Button } from '../Button/Button'
import styles from './EmptyState.module.css'

export interface EmptyStateProps {
  /** An own 16-grid icon (ui/icons); its `data-accent` part is amber. */
  icon?: ReactNode
  title: string
  /** One sentence. */
  description: ReactNode
  action?: { label: string; icon: ReactNode; onClick: () => void }
  /** Heading level of the title within the page outline. */
  headingLevel?: 2 | 3 | 4
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  headingLevel = 3,
  className,
}: EmptyStateProps): React.JSX.Element {
  const Heading = `h${headingLevel}` as const
  return (
    <div className={[styles['root'], className].filter(Boolean).join(' ')}>
      {icon ? <span className={styles['icon']}>{icon}</span> : null}
      <Heading className={styles['title']}>{title}</Heading>
      <p className={styles['description']}>{description}</p>
      {action ? (
        <Button variant="primary" icon={action.icon} onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  )
}
