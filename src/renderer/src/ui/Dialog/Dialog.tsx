// Dialog: modal panel over the --bg-overlay scrim with a title, body and a footer of actions
// (tool change, export). Focus is trapped and returns to the trigger. Confirmations use
// ConfirmDialog. Doc: docs/conventions/ui.md#radix-wrapping-pattern, #elevation
import { Dialog as RadixDialog, VisuallyHidden } from 'radix-ui'
import type { ReactElement, ReactNode } from 'react'
import { usePortalContainer } from '../UiProvider/UiProvider'
import styles from './Dialog.module.css'

export interface DialogProps {
  title: ReactNode
  /** One-sentence summary, read with the title; hidden when `hideDescription`. */
  description?: ReactNode
  hideDescription?: boolean
  children?: ReactNode
  /** Action buttons, right-aligned in the footer (at most one primary). */
  footer?: ReactNode
  /** Optional trigger element (Radix `asChild`); otherwise control `open`. */
  trigger?: ReactElement
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** Modal by default; the gallery shows dialogs inline with `modal={false}`. */
  modal?: boolean
}

export function Dialog({
  title,
  description,
  hideDescription = false,
  children,
  footer,
  trigger,
  open,
  defaultOpen,
  onOpenChange,
  modal = true,
}: DialogProps): React.JSX.Element {
  const container = usePortalContainer()
  return (
    <RadixDialog.Root
      modal={modal}
      {...(open !== undefined ? { open } : {})}
      {...(defaultOpen !== undefined ? { defaultOpen } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal container={container}>
        <RadixDialog.Overlay className={styles['overlay']} />
        <RadixDialog.Content
          className={styles['content']}
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
        >
          <RadixDialog.Title className={styles['title']}>{title}</RadixDialog.Title>
          {description !== undefined ? (
            hideDescription ? (
              <VisuallyHidden.Root asChild>
                <RadixDialog.Description>{description}</RadixDialog.Description>
              </VisuallyHidden.Root>
            ) : (
              <RadixDialog.Description className={styles['body']}>
                {description}
              </RadixDialog.Description>
            )
          ) : null}
          {children ? <div className={styles['body']}>{children}</div> : null}
          {footer ? <div className={styles['footer']}>{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/** Wraps a footer button so it closes the dialog (Cancel, Done). */
export function DialogClose({ children }: { children: ReactElement }): React.JSX.Element {
  return <RadixDialog.Close asChild>{children}</RadixDialog.Close>
}
