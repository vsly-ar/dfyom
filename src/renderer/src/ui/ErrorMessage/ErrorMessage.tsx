// ErrorMessage: an AppError shown inline in the panel that started the action. Friendly text first
// (the catalogue's message, else the code's userMessage); code, developer message, issues and
// frames only in a "Details" expander with "Copy details" (for bug reports). Info-level errors
// (incl. `op.aborted`) render neutral. Doc: docs/conventions/ui.md#errors
import { Icon, type IconName } from '../icons/Icon'
import { Collapsible } from 'radix-ui'
import { useState } from 'react'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { ERROR_CODES } from '../../../../shared/errors/codes'
import { Button } from '../Button/Button'
import styles from './ErrorMessage.module.css'

export interface ErrorMessageProps {
  error: AppErrorData
  /** Catalogue text for this error (messages/); default: the code's `userMessage`. */
  message?: string
  /** Shown as "Try again" when the error is retryable. */
  onRetry?: () => void
  /** Overrides the code's `retryable` (e.g. a reply's own flag). */
  retryable?: boolean
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
}

type Tone = 'neutral' | 'warning' | 'danger'

function toneOf(error: AppErrorData): Tone {
  const severity = ERROR_CODES[error.code]?.severity ?? 'error'
  if (severity === 'info') return 'neutral'
  return severity === 'warn' ? 'warning' : 'danger'
}

const ICONS = { neutral: 'info', warning: 'warning', danger: 'error' } as const satisfies Record<
  Tone,
  IconName
>

/** Developer-facing text of the error, as copied for bug reports. */
export function errorDetails(error: AppErrorData): string {
  return JSON.stringify(error, null, 2)
}

export function ErrorMessage({
  error,
  message,
  onRetry,
  retryable,
  className,
}: ErrorMessageProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const tone = toneOf(error)
  const icon = ICONS[tone]
  const text = message ?? ERROR_CODES[error.code]?.userMessage ?? error.message
  const canRetry = (retryable ?? ERROR_CODES[error.code]?.retryable ?? false) && onRetry
  return (
    <div
      role={tone === 'neutral' ? 'status' : 'alert'}
      data-tone={tone}
      className={[styles['root'], className].filter(Boolean).join(' ')}
    >
      <Icon name={icon} className={styles['icon']} />
      <div className={styles['body']}>
        <p className={styles['text']}>{text}</p>
        <Collapsible.Root className={styles['details']}>
          <div className={styles['actions']}>
            {canRetry ? (
              <Button size="sm" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
            <Collapsible.Trigger asChild>
              <Button size="sm" variant="ghost">
                Details
              </Button>
            </Collapsible.Trigger>
          </div>
          <Collapsible.Content className={styles['content']}>
            <dl className={styles['facts']}>
              <dt>Code</dt>
              <dd>
                <code>{error.code}</code>
              </dd>
              <dt>Message</dt>
              <dd>{error.message}</dd>
              {error.issues.length > 0 ? (
                <>
                  <dt>Issues</dt>
                  <dd>
                    <ul className={styles['list']}>
                      {error.issues.map((i, n) => (
                        <li key={n}>
                          <code>{i.path.join('.') || '(root)'}</code> {i.rule}: {i.message}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </>
              ) : null}
              {error.frames.length > 0 ? (
                <>
                  <dt>Where</dt>
                  <dd>
                    <code>{error.frames.map((f) => f.where).join(' ← ')}</code>
                  </dd>
                </>
              ) : null}
            </dl>
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(errorDetails(error))
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false))
              }}
            >
              {copied ? 'Copied' : 'Copy details'}
            </Button>
          </Collapsible.Content>
        </Collapsible.Root>
      </div>
    </div>
  )
}
