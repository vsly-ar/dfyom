import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, findToastAction, renderUi } from '../../test/render'
import { useState } from 'react'
import { ConfirmDialog } from '../ConfirmDialog/ConfirmDialog'
import { Dialog } from '../Dialog/Dialog'
import { ContextMenu, isContextMenuKey, openContextMenu } from '../Menu/Menu'
import { Toast, ToastAnchor, ToastRegion } from './Toast'

/** A dialog with a button that shows a toast while the dialog stays open (U1). */
function DialogWithToast({
  confirm = false,
  menu = false,
}: {
  confirm?: boolean
  menu?: boolean
}): React.JSX.Element {
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
          {menu ? (
            <ContextMenu
              label="Actions for Shape 2"
              items={[{ label: 'Remove', onSelect: () => {} }]}
            >
              <button
                type="button"
                onKeyDown={(e) => {
                  if (isContextMenuKey(e)) openContextMenu(e.currentTarget)
                }}
              >
                Shape 2
              </button>
            </ContextMenu>
          ) : null}
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

  it('Escape closes the topmost layer first: a row menu, then the dialog, then the toast', async () => {
    const { user } = renderUi(<DialogWithToast menu />)
    await user.click(screen.getByRole('button', { name: 'Remove shape' }))
    await screen.findByText('Removed Shape 1')
    screen.getByRole('button', { name: 'Shape 2' }).focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    await screen.findByRole('menu', { name: 'Actions for Shape 2' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByRole('dialog', { name: 'Shapes' })).toBeInTheDocument()
    expect(screen.getByText('Removed Shape 1')).toBeInTheDocument()
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

  it('shows in the mounted anchor (the 3D view), not over the side panels (DF45)', async () => {
    renderUi(
      <div>
        <aside aria-label="Inspector">Tool</aside>
        <main aria-label="View">
          <ToastAnchor insetRight={120} />
        </main>
        <ToastRegion>
          <Toast defaultOpen duration={Infinity} message="Removed cavity" />
        </ToastRegion>
      </div>,
    )
    const text = await screen.findByText('Removed cavity')
    const view = screen.getByRole('main', { name: 'View' })
    expect(view).toContainElement(text)
    expect(screen.getByRole('complementary', { name: 'Inspector' })).not.toContainElement(text)
    // beside an overlay on the view's right edge (the narrow window's inspector)
    expect(view.querySelector('[data-toast-anchor]')).toHaveStyle({ right: '120px' })
    expect(
      screen.getByRole('region', { name: /^Notifications/ }).querySelector('ol'),
    ).toHaveAttribute('data-anchored')
    await expectNoAxeViolations()
  })

  it('closes by itself after 6 s (DF45)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const onOpenChange = vi.fn()
      renderUi(
        <ToastRegion>
          <Toast defaultOpen onOpenChange={onOpenChange} message="Sizes set from M3" />
        </ToastRegion>,
      )
      await screen.findByText('Sizes set from M3')
      vi.advanceTimersByTime(5000)
      expect(onOpenChange).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1500)
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    } finally {
      vi.useRealTimers()
    }
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
