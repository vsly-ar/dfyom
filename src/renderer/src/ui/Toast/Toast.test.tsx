import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, findToastAction, renderUi } from '../../test/render'
import { useState } from 'react'
import { ConfirmDialog } from '../ConfirmDialog/ConfirmDialog'
import { Dialog } from '../Dialog/Dialog'
import { Toast, ToastRegion } from './Toast'

/** A dialog with a button that shows a toast while the dialog stays open (U1). */
function DialogWithToast({ confirm = false }: { confirm?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [toast, setToast] = useState(false)
  return (
    <ToastRegion>
      {confirm ? (
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="Remove plan?"
          description="It cannot be undone."
          confirmLabel="Remove plan"
          onConfirm={() => {}}
        />
      ) : (
        <Dialog open={open} onOpenChange={setOpen} title="Shapes">
          <button type="button" onClick={() => setToast(true)}>
            Remove shape
          </button>
        </Dialog>
      )}
      <Toast open={toast} onOpenChange={setToast} duration={Infinity} message="Removed Shape 1" />
    </ToastRegion>
  )
}

describe('Toast', () => {
  it('announces its message politely and offers the action', async () => {
    const onUndo = vi.fn()
    const { user } = renderUi(
      <ToastRegion>
        <Toast
          defaultOpen
          duration={Infinity}
          message="Removed Pocket 2"
          action={{ label: 'Undo', altText: 'Undo with Cmd+Z', onClick: onUndo }}
        />
      </ToastRegion>,
    )
    // Radix fills a polite live region on the next frame
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed Pocket 2'))
    await user.click(await findToastAction('Undo'))
    expect(onUndo).toHaveBeenCalledOnce()
    expect(screen.queryByText('Removed Pocket 2')).toBeNull()
  })

  it('Escape closes an open dialog first and leaves the toast (U1)', async () => {
    const { user } = renderUi(<DialogWithToast />)
    await user.click(screen.getByRole('button', { name: 'Remove shape' }))
    await screen.findByText('Removed Shape 1')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Shapes' })).toBeNull())
    expect(screen.getByText('Removed Shape 1')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByText('Removed Shape 1')).toBeNull())
  })

  it('without a toast, Escape still closes a dialog or a confirmation once', async () => {
    const { user, unmount } = renderUi(<DialogWithToast />)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    unmount()
    const r = renderUi(<DialogWithToast confirm />)
    await screen.findByRole('alertdialog')
    await r.user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('has no axe violations', async () => {
    renderUi(
      <ToastRegion>
        <Toast defaultOpen duration={Infinity} message="Saved" />
      </ToastRegion>,
    )
    await screen.findByText('Saved')
    await expectNoAxeViolations()
  })
})
