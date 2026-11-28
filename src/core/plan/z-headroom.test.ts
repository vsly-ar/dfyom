// Z headroom estimate (hardening DF68). Doc: docs/architecture/grbl.md#z-headroom-hardening-df68
import { describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { expectOk } from '../../shared/testing/result'
import { len, machineValues } from '../library/library.fixture'
import { Machine } from '../library/machine'
import { MachineValuesDtoSchema } from '../library/machine.dto'
import { zHeadroomFindings, zHeadroomUnknown, type ZHeadroomTool } from './z-headroom'

/** A desktop router: 90 mm Z travel, 125 mm from the spindle nose to the table with Z homed. */
const machine = (extra: object = { noseToTable: len('125'), spoilboardThickness: len('12') }) =>
  expectOk(
    parseWith(
      MachineValuesDtoSchema,
      { ...machineValues(), travel: { x: len('800'), y: len('800'), z: len('90') }, ...extra },
      'test',
    ).andThen((dto) => Machine.fromDTO(dto)),
  )

const extralong: ZHeadroomTool = {
  planOperationId: 'po-4',
  toolName: 'extralong 1/4"',
  stickout: 62,
  zMin: -40.5,
}
const short: ZHeadroomTool = { planOperationId: 'po-1', toolName: '1/8" 4F', stickout: 25 }

const check = (m: Machine, tools: ZHeadroomTool[], clearance = 20) =>
  zHeadroomFindings(m, { setupId: 's2', clearance, stockThickness: 40, tools })

describe('zHeadroomFindings (DF68)', () => {
  it("warns for the user's cut: a 62 mm stickout under a 20 mm clearance on 40 mm stock", () => {
    // tip at Z home: 125 − 12 − 40 − 62 = 11 mm above the stock top; needs 20 + 1
    const [w, ...rest] = check(machine(), [short, extralong])
    expect(rest).toEqual([])
    expect(w).toMatchObject({
      code: 'plan.machine',
      severity: 'warning',
      rule: 'zHeadroom',
      planOperationId: 'po-4',
      field: 'setup.clearanceHeight',
      params: { setupId: 's2', tool: 'extralong 1/4"', needed: 21, available: 11 },
    })
    expect(w!.message).toContain('short by 10 mm')
    expect(w!.message).toContain('Lower the clearance height, use a shorter stickout')
  })

  it('a shorter stickout or a lower clearance clears it', () => {
    expect(check(machine(), [{ ...extralong, stickout: 40 }])).toEqual([])
    expect(check(machine(), [extralong], 10)).toEqual([])
    // exactly the margin below the tip at Z home still fits: 125 − 12 − 40 − 52 = 21
    expect(check(machine(), [{ ...extralong, stickout: 52 }], 20)).toEqual([])
    expect(check(machine(), [{ ...extralong, stickout: 52.5 }], 20)).toHaveLength(1)
  })

  it('without the spoilboard checks as if there were none', () => {
    const m = machine({ noseToTable: len('125') })
    // 125 − 0 − 40 − 62 = 23 ≥ 21: fits without a spoilboard, so no warning, only the note
    expect(check(m, [extralong])).toEqual([])
    expect(zHeadroomUnknown(m)).toMatchObject({
      severity: 'info',
      rule: 'zHeadroomUnknown',
      params: { missing: 'spoilboardThickness' },
    })
    expect(zHeadroomUnknown(m)!.message).toBe(
      'Z headroom only partly checked: enter the spoilboard thickness (0 if none) in the machine',
    )
    // a lower nose: short even without a spoilboard, and the message says to enter it
    const [w] = check(machine({ noseToTable: len('110') }), [extralong])
    expect(w).toMatchObject({ rule: 'zHeadroom', params: { available: 8 } })
    expect(w!.message).toContain('or enter the spoilboard thickness')
  })

  it('without the nose to table distance: nothing checked, the note names both fields', () => {
    const m = machine({})
    expect(check(m, [extralong])).toEqual([])
    expect(zHeadroomUnknown(m)).toMatchObject({
      params: { missing: 'noseToTable,spoilboardThickness' },
    })
    expect(zHeadroomUnknown(m)!.message).toMatch(/^Z headroom not checked: enter the spindle nose/)
    expect(zHeadroomUnknown(machine())).toBeUndefined()
  })

  it('zReach: the lowest Z must be within the Z travel (pull-off 1 mm)', () => {
    // a 10 mm stickout: tip at home 125 − 12 − 40 − 10 = 63, travel ends at 63 − 89 = −26
    const stub = { ...short, stickout: 10, zMin: -30 }
    const [w] = check(machine(), [stub], 5)
    expect(w).toMatchObject({
      rule: 'zReach',
      field: 'stickout',
      params: { lowest: -26, zMin: -30 },
    })
    expect(w!.message).toContain('short by 4 mm')
    expect(check(machine(), [{ ...stub, zMin: -26 }], 5)).toEqual([])
    // unknown spoilboard: the reach is not checked (a spoilboard would lower the stock)
    expect(check(machine({ noseToTable: len('113') }), [stub], 5)).toEqual([])
  })

  it("zReach once per setup, naming the worst tool and what to measure (DF150, the user's plate)", () => {
    // the user's 3020 profile: nose to table 150, spoilboard 23, Z travel 80, 10.1 mm plate. The
    // math holds (tip at home 150 − 23 − 10.1 − 29.7 = 87.2, travel ends 79 lower at 8.2): the
    // profile is what is off, so the finding comes once and says what to measure
    const m = machine({
      noseToTable: len('150'),
      spoilboardThickness: len('23'),
      travel: { x: len('300'), y: len('200'), z: len('80') },
    })
    const tool = (planOperationId: string, toolName: string, zMin: number) => ({
      planOperationId,
      toolName,
      stickout: 29.7,
      zMin,
    })
    const ws = zHeadroomFindings(m, {
      setupId: 's1',
      clearance: 5,
      stockThickness: 10.1,
      tools: [
        tool('po-1', 'Finish 3F', -0.2),
        tool('po-2', 'Flat 1F', -10.5),
        tool('po-3', 'V 90', -1.2),
      ],
    })
    expect(ws).toHaveLength(1)
    expect(ws[0]).toMatchObject({
      rule: 'zReach',
      planOperationId: 'po-2',
      params: { tool: 'Flat 1F', toolsShort: 3, lowest: expect.closeTo(8.2, 6) },
    })
    expect(ws[0]!.params['shortMin']).toBeCloseTo(8.4, 6)
    expect(ws[0]!.message).toMatch(
      /^3 tools cannot reach their lowest Z; Flat 1F at 29\.7 mm stickout: .*short by 18\.7 mm, the others by at least 8\.4 mm\)/,
    )
    expect(ws[0]!.message).toContain('with Z homed, measure from the spindle nose')
  })

  it('one finding per tool name and stickout', () => {
    const again = { ...extralong, planOperationId: 'po-5' }
    expect(check(machine(), [extralong, again]).map((w) => w.planOperationId)).toEqual(['po-4'])
  })
})
