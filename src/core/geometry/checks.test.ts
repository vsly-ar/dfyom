/**
 * Geometry checks of the evaluation: piece count, `dfm.loosePiece`, `dfm.retainedRemoved`,
 * `dfm.surfaceMissing`. Doc: docs/architecture/geometry.md#evaluation-checks
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { evaluatePart, type PartEvaluation } from './evaluate'
import { loadManifold } from './manifold'
import type { DfmWarning, OperationGeometry, PartGeometryInput } from './model'
import type { SolidKernel } from './solid-port'
import { TEST_STOCK, testPart } from './testing/test-part'

let kernel: SolidKernel

beforeAll(async () => {
  kernel = expectOk(await loadManifold())
})

const evaluate = (input: PartGeometryInput): PartEvaluation =>
  expectOk(kernel.withSolids((s) => evaluatePart(input, s)))

const codes = (e: PartEvaluation): string[] => e.warnings.map((w) => w.code)
const only = (e: PartEvaluation, code: string): DfmWarning[] =>
  e.warnings.filter((w) => w.code === code)

type Profile = Extract<OperationGeometry, { kind: 'profile' }>
type Pocket = Extract<OperationGeometry, { kind: 'pocket' }>

const profile = (over: Partial<Profile> = {}): Profile => ({
  kind: 'profile',
  id: 'profile1',
  shape: {
    center: [50, 30],
    contour: { kind: 'rectangle', length: 84, width: 44, cornerRadius: 5 },
  },
  side: 'outside',
  slotWidth: 6,
  tabs: { count: 4, width: 8, thickness: 3 },
  ...over,
})

const pocket = (over: Partial<Pocket> = {}): Pocket => ({
  kind: 'pocket',
  id: 'pocket1',
  onZ: 0,
  shape: {
    center: [50, 30],
    contour: { kind: 'rectangle', length: 40, width: 25, cornerRadius: 4 },
  },
  depth: 8,
  floorRadius: 2,
  ...over,
})

const part = (...operations: OperationGeometry[]): PartGeometryInput => ({
  stock: TEST_STOCK,
  operations,
})

/** The test part with its profile replaced or extra operations appended. */
function testPartWith(
  replace: Partial<Profile> | undefined,
  ...extra: OperationGeometry[]
): PartGeometryInput {
  const base = testPart()
  const operations = base.operations.map((op) =>
    op.kind === 'profile' && replace !== undefined ? { ...op, ...replace } : op,
  )
  return { ...base, operations: [...operations, ...extra] }
}

describe('evaluatePart: pieces', () => {
  it('counts one piece and no geometry warning for the test part (offcut held by tabs)', () => {
    const e = evaluate(testPart())
    expect(e.pieces).toBe(1)
    expect(e.warnings).toEqual([])
  })

  it('counts one piece for a part without profiles', () => {
    const e = evaluate(part(pocket()))
    expect(e.pieces).toBe(1)
    expect(e.warnings).toEqual([])
  })

  it('reports the offcut of an outside profile without tabs as loose, not the part', () => {
    // part 20 × 20 is smaller than the offcut frame: the largest piece is waste
    const e = evaluate(
      part(
        profile({
          shape: {
            center: [50, 30],
            contour: { kind: 'rectangle', length: 20, width: 20, cornerRadius: 3 },
          },
          tabs: { count: 0, width: 8, thickness: 3 },
        }),
      ),
    )
    expect(e.pieces).toBe(2)
    const [w, ...rest] = only(e, 'dfm.loosePiece')
    expect(rest).toEqual([])
    expect(w).toMatchObject({
      severity: 'warning',
      operation: 'profile1',
      parameter: 'tabs',
      params: { offcut: true, operations: ['profile1'] },
    })
    // the frame: stock minus the outer slot edge 32 × 32 R9
    const frame = 100 * 60 * 20 - (32 * 32 - (4 - Math.PI) * 81) * 20
    expect(w!.params['volume'] as number).toBeCloseTo(frame, -2)
  })

  it('reports the slug of an inside profile without tabs as loose', () => {
    const e = evaluate(
      part(
        profile({
          side: 'inside',
          shape: {
            center: [50, 30],
            contour: { kind: 'rectangle', length: 40, width: 30, cornerRadius: 5 },
          },
          tabs: { count: 0, width: 8, thickness: 3 },
        }),
      ),
    )
    expect(e.pieces).toBe(2)
    const loose = only(e, 'dfm.loosePiece')
    expect(loose).toHaveLength(1)
    expect(loose[0]!.params['offcut']).toBe(true)
    // slug 28 × 18, sharp corners (inset of R5 by 6)
    expect(loose[0]!.params['volume'] as number).toBeCloseTo(28 * 18 * 20, -1)
  })

  it('reports the spike part (stock margin < slot): the stock corners fall free', () => {
    // the spike's test part: margin 3 < slot 6, so the slot removes the frame and the tabs end
    // in the air; only the four stock corners beyond the slot's R11 outer corners are left, and
    // nothing holds them. dfm.slotLeavesStock (dfm.ts) names the cause.
    const e = evaluate(
      testPartWith({
        shape: {
          center: [50, 30],
          contour: { kind: 'rectangle', length: 94, width: 54, cornerRadius: 5 },
        },
      }),
    )
    expect(e.pieces).toBe(5)
    const loose = only(e, 'dfm.loosePiece')
    expect(loose).toHaveLength(4)
    for (const w of loose) {
      expect(w).toMatchObject({ operation: 'profile1', params: { offcut: true } })
      expect(w.params['volume'] as number).toBeLessThan(30 * 20) // a corner sliver
    }
  })

  it('reports a part split into two by an inside cut across the stock', () => {
    // an opening 10 wide crossing the whole stock width, slot covering it: two halves, no offcut
    const e = evaluate(
      part(
        profile({
          side: 'inside',
          shape: {
            center: [30, 30],
            contour: { kind: 'rectangle', length: 10, width: 80, cornerRadius: 0 },
          },
          slotWidth: 6,
          tabs: { count: 2, width: 4, thickness: 2 },
        }),
      ),
    )
    expect(e.pieces).toBe(2)
    const loose = only(e, 'dfm.loosePiece')
    expect(loose).toHaveLength(1)
    // the smaller half x 0..25
    expect(loose[0]!.params['volume'] as number).toBeCloseTo(25 * 60 * 20, -1)
    expect(loose[0]!.params['offcut']).toBe(false)
    expect(loose[0]!.operation).toBe('profile1')
  })

  it('keeps the part whole when the tabs are there (inside profile with tabs)', () => {
    const e = evaluate(
      part(
        profile({
          side: 'inside',
          shape: {
            center: [50, 30],
            contour: { kind: 'rectangle', length: 40, width: 30, cornerRadius: 5 },
          },
        }),
      ),
    )
    expect(e.pieces).toBe(1)
    expect(e.warnings).toEqual([])
  })
})

describe('evaluatePart: retainedRemoved', () => {
  it('warns when another operation cuts a tab away, naming both operations', () => {
    // tab[0] sits at x 46..54 in the front slot (y 2..8), up to z −17
    const e = evaluate(
      testPartWith(
        undefined,
        pocket({
          id: 'pocket2',
          onZ: -0.5,
          shape: {
            center: [50, 5],
            contour: { kind: 'rectangle', length: 12, width: 8, cornerRadius: 2 },
          },
          depth: 19,
          floorRadius: 0,
        }),
      ),
    )
    const w = only(e, 'dfm.retainedRemoved')
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({
      severity: 'warning',
      operation: 'profile1',
      parameter: 'tabs',
      params: { by: 'pocket2', regions: ['tab[0]'] },
    })
    expect(e.pieces).toBe(1) // the other three tabs still hold
  })

  it('warns when a deeper pocket cuts into a floor fillet', () => {
    const e = evaluate(
      part(
        pocket(),
        pocket({
          id: 'pocket2',
          shape: {
            center: [70, 30],
            contour: { kind: 'rectangle', length: 10, width: 10, cornerRadius: 2 },
          },
          depth: 12,
          floorRadius: 0,
        }),
      ),
    )
    const w = only(e, 'dfm.retainedRemoved')
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({
      operation: 'pocket1',
      parameter: 'floorRadius',
      params: { by: 'pocket2', regions: ['floorFillet'] },
    })
  })

  it('does not warn for a pocket inside another pocket clear of its fillet', () => {
    const e = evaluate(
      part(
        pocket(),
        pocket({
          id: 'pocket2',
          onZ: -8,
          shape: {
            center: [50, 30],
            contour: { kind: 'rectangle', length: 20, width: 10, cornerRadius: 2 },
          },
          depth: 4,
          floorRadius: 1,
        }),
      ),
    )
    expect(codes(e)).toEqual([])
  })

  it('does not warn for operations near but outside a tab', () => {
    const e = evaluate(
      testPartWith(undefined, {
        kind: 'drilling',
        id: 'drill5',
        onZ: -0.5,
        center: [40, 5],
        diameter: 4,
        bottom: { kind: 'through' },
      }),
    )
    expect(codes(e)).toEqual([])
  })
})

describe('evaluatePart: surfaceMissing', () => {
  it('warns when a referenced surface has no triangles', () => {
    const e = evaluate({
      ...testPart(),
      references: [
        { operation: 'pocket1', parameter: 'on', surface: 'stock.top' },
        { operation: 'drill1', parameter: 'on', surface: 'facing1.floor' },
      ],
    })
    expect(e.warnings).toEqual([
      expect.objectContaining({
        code: 'dfm.surfaceMissing',
        operation: 'pocket1',
        parameter: 'on',
        params: { surface: 'stock.top' },
      }),
    ])
  })
})

describe('evaluatePart: seeded random parts keep a valid status', () => {
  /** mulberry32 */
  function rng(seed: number): () => number {
    let a = seed
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('evaluates 30 random parts: pieces and loose-piece warnings agree', () => {
    const rand = rng(28_2026)
    const between = (lo: number, hi: number) => lo + (hi - lo) * rand()
    for (let i = 0; i < 30; i++) {
      const count = Math.floor(between(0, 5))
      const input = part(
        { kind: 'facing', id: 'facing1', depth: between(0.1, 2) },
        pocket({
          onZ: -2,
          shape: {
            center: [between(35, 65), between(25, 35)],
            contour: {
              kind: 'rectangle',
              length: between(5, 30),
              width: between(5, 15),
              cornerRadius: 2,
            },
          },
          depth: between(1, 10),
          floorRadius: between(0, 2),
        }),
        profile({
          shape: {
            center: [50, 30],
            contour: { kind: 'rectangle', length: 70, width: 40, cornerRadius: between(0, 10) },
          },
          side: rand() < 0.5 ? 'outside' : 'inside',
          slotWidth: between(1, 6),
          tabs: { count, width: between(2, 8), thickness: between(1, 5) },
        }),
      )
      const r = kernel.withSolids((s) => evaluatePart(input, s))
      expect(r.isOk(), JSON.stringify({ i, input, err: r.isErr() && r.unwrapErr().toJSON() })).toBe(
        true,
      )
      const e = r.unwrap()
      expect(e.pieces, JSON.stringify({ i, input })).toBe(count === 0 ? 2 : 1)
      expect(only(e, 'dfm.loosePiece')).toHaveLength(e.pieces - 1)
    }
    expect(kernel.liveObjects()).toBe(0)
  })
})
