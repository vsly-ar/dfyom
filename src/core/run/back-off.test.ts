// DF143: which way "Unlock and back off" jogs. Doc: docs/modes/run-machine.md#unlock-and-back-off-df143
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { backOffMove, jogDirection } from './back-off'

describe('back off a limit switch (DF143)', () => {
  it('reads a jog direction from a relative move or a target', () => {
    expect(jogDirection([-5, 0, 0.0000000001])).toEqual([-1, 0, 0])
    expect(jogDirection([10, 20, -30], [10, 0, 0])).toEqual([0, 1, -1])
  })

  it('backs off against the last jog on each axis it moved, without Pn', () => {
    expect(expectOk(backOffMove([-1, 0, 0], undefined, 3))).toEqual([3, 0, 0])
    expect(expectOk(backOffMove([1, -1, 0], '', 2))).toEqual([-2, 2, 0])
  })

  it('takes the pressed switch from Pn: only that axis backs off', () => {
    // a diagonal jog ran onto the Y switch: only Y moves off it
    expect(expectOk(backOffMove([1, 1, 0], 'Y', 3))).toEqual([0, -3, 0])
    // the probe pin is no limit switch
    expect(expectOk(backOffMove([0, 0, -1], 'PZ', 3))).toEqual([0, 0, 3])
  })

  it('refuses when the direction is unknown', () => {
    const r = expectErrCode(backOffMove([1, 0, 0], 'Y', 3), 'run.state')
    expect(r.issues[0]?.rule).toBe('backOffDirection')
    expect(r.message).toContain('the Y limit switch is pressed')
    expectErrCode(backOffMove([0, 0, 0], undefined, 3), 'run.state')
  })
})
