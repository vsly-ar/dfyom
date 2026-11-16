import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parseWith } from './parse'
import { expectErrCode, expectOk } from './testing/result'

const ChamferDTO = z.object({ angleDeg: z.number(), sizeMm: z.number() })
type ChamferDTO = z.infer<typeof ChamferDTO>

describe('parseWith', () => {
  it('passes valid shapes through typed', () => {
    const v: ChamferDTO = expectOk(parseWith(ChamferDTO, { angleDeg: 45, sizeMm: 1 }, 't'))
    expect(v.sizeMm).toBe(1)
  })
  it('maps zod issues to AppError issues', () => {
    const e = expectErrCode(
      parseWith(z.object({ chamfer: ChamferDTO }), { chamfer: { angleDeg: '45' } }, 'load'),
      'input.malformed',
    )
    expect(e.frames).toEqual([{ where: 'load' }])
    expect(e.issues.map((i) => i.path.join('.'))).toEqual(['chamfer.angleDeg', 'chamfer.sizeMm'])
    expect(e.issues[0]?.rule).toBe('invalid_type')
  })
  it('generates JSON Schema for agent tools', () => {
    expect(z.toJSONSchema(ChamferDTO)).toMatchObject({
      type: 'object',
      required: ['angleDeg', 'sizeMm'],
    })
  })
})
