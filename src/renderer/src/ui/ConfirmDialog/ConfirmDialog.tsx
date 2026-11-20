// ConfirmDialog: only for what cannot be undone. Names the item and the consequence; the
// confirming button names the action ("Remove plan", never "OK"); Cancel is focused first.
// Doc: docs/conventions/ui.md#confirmations (decision 11)
import { AlertDialog } from 'radix-ui'
import type { ReactElement, ReactNode } from 'react'
import { Button } from '../Button/Button'
import styles from '../Dialog/Dialog.module.css'
import { usePortalContainer } from '../UiProvider/UiProvider'

export interface ConfirmDialogProps {
  /** Names the item: 'Remove plan "Roughing"?' */
  title: ReactNode
  /** The consequence: "Its toolpaths and export settings are deleted. This cannot be undone." */
  description: ReactNode
  /** Verb + object naming the action ("Remove plan"). */
  confirmLabel: string
  onConfirm: () => void
  cancelLabel?: string
  /** Destructive actions use the danger button (red label, never a red fill). */
  destructive?: boolean
  trigger?: ReactElement
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  cancelLabel = 'Cancel',
  destructive = true,
  trigger,
  open,
  defaultOpen,
  onOpenChange,
}: ConfirmDialogProps): React.JSX.Element {
  const container = usePortalContainer()
  return (
    <AlertDialog.Root
      {...(open !== undefined ? { open } : {})}
      {...(defaultOpen !== undefined ? { defaultOpen } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {trigger ? <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger> : null}
      <AlertDialog.Portal container={container}>
        <AlertDialog.Overlay className={styles['overlay']} />
        <AlertDialog.Content className={styles['content']} data-size="sm">
          <AlertDialog.Title className={styles['title']}>{title}</AlertDialog.Title>
          <AlertDialog.Description className={styles['body']}>
            {description}
          </AlertDialog.Description>
          <div className={styles['footer']}>
            {/* Radix focuses Cancel first: the safe choice */}
            <AlertDialog.Cancel asChild>
              <Button>{cancelLabel}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant={destructive ? 'danger' : 'default'} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
