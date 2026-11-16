// Example models from docs/conventions/error-handling/models.md, used by the shared tests.
// Not app code: the real Chamfer feature will live in src/core when Design mode is implemented.
import { construct, invariants } from '../model'
import { collect, ctx, fail, Ok, type AppResult } from '../result'

export interface ChamferProps {
  readonly angleDeg: number
  readonly sizeMm: number
}

export class Chamfer {
  private constructor(
    readonly angleDeg: number,
    readonly sizeMm: number,
  ) {
    invariants('Chamfer', (c) => {
      c.check(
        Number.isFinite(angleDeg) && angleDeg > 0 && angleDeg < 90,
        ['angleDeg'],
        'range',
        'must be between 0° and 90° (exclusive)',
        { min: 0, max: 90, actual: angleDeg },
      )
      c.check(
        Number.isFinite(sizeMm) && sizeMm > 0,
        ['sizeMm'],
        'positive',
        'must be greater than 0',
        {
          actual: sizeMm,
        },
      )
    })
    Object.freeze(this)
  }

  static create(p: ChamferProps): AppResult<Chamfer> {
    return construct('Chamfer', () => new Chamfer(p.angleDeg, p.sizeMm))
  }

  with(patch: Partial<ChamferProps>): AppResult<Chamfer> {
    return Chamfer.create({ ...this.toDTO(), ...patch })
  }

  toDTO(): ChamferProps {
    return { angleDeg: this.angleDeg, sizeMm: this.sizeMm }
  }
}

export class EdgeTreatment {
  private constructor(
    readonly chamfers: readonly Chamfer[],
    readonly maxTotalMm: number,
  ) {
    invariants('EdgeTreatment', (c) => {
      const total = chamfers.reduce((s, ch) => s + ch.sizeMm, 0)
      c.check(
        total <= maxTotalMm,
        ['chamfers'],
        'maxTotal',
        `total chamfer size ${total} mm exceeds ${maxTotalMm} mm`,
        { total, maxTotalMm },
      )
    })
  }

  static create(p: {
    readonly chamfers: readonly ChamferProps[]
    readonly maxTotalMm: number
  }): AppResult<EdgeTreatment> {
    const children = collect(
      p.chamfers.map((c, i) => Chamfer.create(c).mapErr((e) => e.prefixIssues('chamfers', i))),
    )
    if (children.isErr()) return children
    return construct('EdgeTreatment', () => new EdgeTreatment(children.unwrap(), p.maxTotalMm))
  }
}

export function addChamferToPart(partId: string, input: ChamferProps): AppResult<Chamfer> {
  if (partId === '')
    return fail('model.invariant', 'part id is empty', { where: 'addChamferToPart' })
  return Chamfer.create(input).mapErr(ctx('addChamferToPart', { partId }))
}

export function previewChamferArea(partId: string, input: ChamferProps): AppResult<number> {
  const ch = addChamferToPart(partId, input)
  if (ch.isErr()) return ch
  const { sizeMm, angleDeg } = ch.unwrap()
  return Ok(0.5 * sizeMm * sizeMm * Math.tan((angleDeg * Math.PI) / 180))
}
