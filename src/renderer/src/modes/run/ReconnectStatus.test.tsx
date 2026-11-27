// Auto-reconnect's state in the navigator (hardening DF129, RC4): trying with "Stop trying",
// reconnected until homed, gave up; a polite live region that is always there.
// Spec: docs/modes/run-recovery.md#implementation-rc4
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { ReconnectStatus } from './AlarmPanel'

const lost = (reconnect?: RunStatus['connection']['reconnect']): RunStatus => {
  const s = closedStatus()
  return {
    ...s,
    connection: {
      ...s.connection,
      lost: { target: 'serial', port: { path: '/dev/cu.usbmodem1101', baud: 115200 } },
      ...(reconnect === undefined ? {} : { reconnect }),
    },
  }
}

describe('ReconnectStatus (DF129 RC4)', () => {
  it('trying: the attempt and "Stop trying"', async () => {
    const onStop = vi.fn()
    const { user } = renderUi(
      <ReconnectStatus status={lost({ phase: 'waiting', attempt: 3 })} onStop={onStop} />,
    )
    const region = screen.getByRole('status', { name: 'Reconnecting' })
    expect(region).toHaveTextContent('Reconnecting… attempt 3')
    await user.click(screen.getByRole('button', { name: 'Stop trying' }))
    expect(onStop).toHaveBeenCalledOnce()
    await expectNoAxeViolations()
  })

  it('reconnected and not homed; gave up; nothing otherwise', () => {
    const open: RunStatus = {
      ...closedStatus(),
      connection: {
        state: 'open',
        target: 'serial',
        timeScale: 1,
        reconnect: { phase: 'reconnected', attempt: 2 },
      },
      state: 'Alarm',
      homed: false,
    }
    const { rerender } = renderUi(<ReconnectStatus status={open} onStop={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent('Reconnected — machine needs homing')
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<ReconnectStatus status={{ ...open, homed: true }} onStop={() => {}} />)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    rerender(<ReconnectStatus status={lost({ phase: 'gaveUp', attempt: 15 })} onStop={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent('Gave up after 2 min — reconnect manually')
    rerender(<ReconnectStatus status={lost()} onStop={() => {}} />)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })
})
