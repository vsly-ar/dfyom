import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { ErrorMessage } from './ErrorMessage'

const IO: AppErrorData = {
  code: 'persist.io',
  message: 'atomic write failed: EACCES',
  issues: [{ path: ['target'], rule: 'readOnly', message: 'the folder is read-only' }],
  frames: [{ where: 'writeFileAtomic' }, { where: 'project.save' }],
}

const ABORTED: AppErrorData = { code: 'op.aborted', message: 'aborted', issues: [], frames: [] }

describe('ErrorMessage', () => {
  it('shows the friendly text as an alert, the details only on request', async () => {
    const { user } = renderUi(<ErrorMessage error={IO} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('The file could not be read or written.')
    expect(screen.queryByText('atomic write failed: EACCES')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('atomic write failed: EACCES')).toBeVisible()
    expect(screen.getByText('persist.io')).toBeVisible()
    expect(screen.getByText('writeFileAtomic ← project.save')).toBeVisible()
  })

  it('prefers the catalogue message and offers a retry for retryable errors', async () => {
    const onRetry = vi.fn()
    const { user } = renderUi(
      <ErrorMessage
        error={IO}
        message="Export failed: the folder is read-only. Choose another folder."
        onRetry={onRetry}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Export failed')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('copies the details for bug reports', async () => {
    const { user } = renderUi(<ErrorMessage error={IO} />)
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    await user.click(screen.getByRole('button', { name: 'Details' }))
    await user.click(screen.getByRole('button', { name: 'Copy details' }))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"code": "persist.io"'))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('shows a cancellation neutrally, as a status', () => {
    renderUi(<ErrorMessage error={ABORTED} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('The operation was cancelled.')
  })

  it('has no axe violations, details open', async () => {
    const { user } = renderUi(<ErrorMessage error={IO} onRetry={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Details' }))
    await expectNoAxeViolations()
  })
})
