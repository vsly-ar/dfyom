// Dialog: modal panel over the --bg-overlay scrim with a title, body and a footer of actions
// (tool change, export). Focus is trapped and returns to the trigger. Confirmations use
// ConfirmDialog. Enter in a field inside never applies, and Cmd/Ctrl+Enter is inactive while a
// modal one is open (docs/architecture/apply.md#keyboard). Doc: docs/conventions/ui.md#radix-wrapping-pattern, #elevation
import { Dialog as RadixDialog, VisuallyHidden } from 'radix-ui'
import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { ApplyScope, MODAL_ATTR } from '../ApplyButton/ApplyScope'
import { usePortalContainer } from '../UiProvider/UiProvider'
import styles from './Dialog.module.css'
import { useModalStack } from './modal-stack'

/** Controlled or uncontrolled open state, so a toast's Escape can close the dialog (U1). */
export function useOpenState(
  open: boolean | undefined,
  defaultOpen: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined,
): [boolean, (open: boolean) => void] {
  const [inner, setInner] = useState(defaultOpen ?? false)
  const change = (o: boolean) => {
    if (open === undefined) setInner(o)
    onOpenChange?.(o)
  }
  return [open ?? inner, change]
}

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
  /**
   * Where focus goes on close when the dialog has no `trigger` (it was opened from elsewhere, e.g.
   * a toolbar button through a store): called with the close event, `preventDefault()` keeps
   * Radix from focusing the body.
   */
  onCloseAutoFocus?: (event: Event) => void
  /** Width: `md` 420 px (default); `lg` 560 px for reports with a list beside a picture (DF48). */
  size?: 'md' | 'lg'
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
  onCloseAutoFocus,
  size,
}: DialogProps): React.JSX.Element {
  const container = usePortalContainer()
  const [isOpen, setOpen] = useOpenState(open, defaultOpen, onOpenChange)
  const content = useRef<HTMLDivElement>(null)
  useModalStack(isOpen && modal, content, () => setOpen(false))
  return (
    <RadixDialog.Root modal={modal} open={isOpen} onOpenChange={setOpen}>
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal container={container}>
        <RadixDialog.Overlay className={styles['overlay']} />
        <RadixDialog.Content
          ref={content}
          className={styles['content']}
          {...(size !== undefined && size !== 'md' ? { 'data-size': size } : {})}
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
          {...(modal ? { [MODAL_ATTR]: '' } : {})}
          {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
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
          {/* dialogs hold local form state: Enter in their fields never applies (apply.md#keyboard) */}
          {children ? (
            <ApplyScope onApply={null}>
              <div className={styles['body']}>{children}</div>
            </ApplyScope>
          ) : null}
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
