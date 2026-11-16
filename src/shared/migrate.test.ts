import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { migrate, type Migrated, type MigrationPlan } from './migrate'
import { parseWith } from './parse'
import { ctx, Ok, tryCatch, type AppResult } from './result'
import { Chamfer } from './testing/chamfer.fixture'
import { expectErrCode, expectOk } from './testing/result'

// Example document from docs/conventions/error-handling/migrations.md
interface DocV1 {
  schemaVersion: 1
  chamfer: { angle: number; size: number }
}
const DocV2 = z.object({
  schemaVersion: z.literal(2),
  chamfer: z.object({ angleDeg: z.number(), sizeMm: z.number() }),
})

const plan: MigrationPlan = {
  document: 'example',
  current: 2,
  migrations: [
    {
      from: 1,
      describe: 'rename chamfer.angle/size → angleDeg/sizeMm; clamp angle ≥ 90° to 89°',
      up(raw, notes) {
        const d = raw as DocV1
        let angleDeg = d.chamfer.angle
        if (angleDeg >= 90) {
          notes.push({
            from: 1,
            path: ['chamfer', 'angleDeg'],
            message: `angle ${angleDeg}° clamped to 89°`,
          })
          angleDeg = 89
        }
        return Ok({ schemaVersion: 2, chamfer: { angleDeg, sizeMm: d.chamfer.size } })
      },
    },
  ],
}

function load(json: string): AppResult<Migrated<Chamfer>> {
  const parsed = tryCatch(() => JSON.parse(json) as unknown, 'input.malformed', 'not valid JSON')
  if (parsed.isErr()) return parsed.mapErr(ctx('load'))
  const m = migrate(parsed.unwrap(), plan)
  if (m.isErr()) return m.mapErr(ctx('load'))
  const { value, notes } = m.unwrap()
  const doc = parseWith(DocV2, value, 'load')
  if (doc.isErr()) return doc
  return Chamfer.create(doc.unwrap().chamfer)
    .map((chamfer) => ({ value: chamfer, notes }))
    .mapErr((e) => e.prefixIssues('chamfer').withContext('load'))
}

describe('migrate', () => {
  it('upgrades v1 step by step and records notes for changed data', () => {
    const { value, notes } = expectOk(
      load(JSON.stringify({ schemaVersion: 1, chamfer: { angle: 90, size: 2 } })),
    )
    expect(value.angleDeg).toBe(89)
    expect(notes).toEqual([
      { from: 1, path: ['chamfer', 'angleDeg'], message: expect.stringMatching(/clamped/) },
    ])
  })

  it('refuses newer documents and rejects malformed ones', () => {
    expectErrCode(migrate({ schemaVersion: 99 }, plan), 'persist.migration')
    expectErrCode(migrate({}, plan), 'input.malformed')
    expectErrCode(migrate({ schemaVersion: 1.5 }, plan), 'input.malformed')
    expectErrCode(load('{nope'), 'input.malformed')
    expectErrCode(
      load(JSON.stringify({ schemaVersion: 2, chamfer: { angleDeg: '30' } })),
      'input.malformed',
    )
  })

  it('fails when a step is missing', () => {
    expectErrCode(migrate({ schemaVersion: 0 }, plan), 'persist.migration')
  })

  it('classifies a throwing migration as persist.migration with step info', () => {
    const e = expectErrCode(migrate({ schemaVersion: 1 }, plan), 'persist.migration') // chamfer missing → TypeError
    expect(e.cause).toBeInstanceOf(TypeError)
    expect(e.frames.at(-1)).toMatchObject({ where: 'migrate:example', data: { from: 1 } })
  })

  it('surfaces invalid migrated data as invariant issues with full path', () => {
    const e = expectErrCode(
      load(JSON.stringify({ schemaVersion: 2, chamfer: { angleDeg: 30, sizeMm: -1 } })),
      'model.invariant',
    )
    expect(e.issues[0]?.path).toEqual(['chamfer', 'sizeMm'])
    expect(e.frames.at(-1)?.where).toBe('load')
  })
})
