import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, findToastAction, renderUi } from '../../test/render'
import { Toast, ToastRegion } from './Toast'

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
