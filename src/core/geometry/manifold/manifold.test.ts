import { beforeAll, describe, expect, it } from 'vitest'
import { fail, Ok } from '../../../shared/result'
import { expectErrCode, expectOk } from '../../../shared/testing/result'
import { offsetLoft, type LabelledMesh } from '../loft'
import type { SolidKernel } from '../solid-port'
import { signedVolume } from '../testing/mesh-oracles'
import { nodeManifoldSource } from '../testing/node-wasm'
import { loadManifold } from './index'

const box = (length: number, width: number, height: number, faces = 1): LabelledMesh =>
  offsetLoft(
    { kind: 'rectangle', length, width, cornerRadius: 0 },
    [
      { offset: 0, z: height },
      { offset: 0, z: 0 },
    ],
    { band: () => faces, top: faces + 1, bottom: faces + 2 },
  ).unwrap()

let kernel: SolidKernel

beforeAll(async () => {
  kernel = expectOk(await loadManifold())
})

describe('loadManifold', () => {
  it('loads with the package lookup and with a binary passed in by the host', async () => {
    const hosted = expectOk(await loadManifold(nodeManifoldSource()))
    expect(hosted.heapBytes().unwrap()).toBeGreaterThan(0)
    expect(kernel.heapBytes().isNone()).toBe(true)
  })

  it('fails with geometry.evaluation for a broken binary', async () => {
    expectErrCode(
      await loadManifold({ wasmBinary: new Uint8Array([0, 1, 2, 3]) }),
      'geometry.evaluation',
    )
  })
})

describe('withSolids', () => {
  it('builds a solid from a labelled mesh with status NoError and its volume', () => {
    const r = kernel.withSolids((s) => {
      const id = expectOk(s.reserveOriginalId())
      const solid = expectOk(s.fromMesh(box(10, 6, 2), id))
      return Ok({ status: expectOk(s.status(solid)), volume: expectOk(s.volume(solid)) })
    })
    expect(expectOk(r)).toEqual({ status: 'NoError', volume: expect.closeTo(120, 6) })
    expect(kernel.liveObjects()).toBe(0)
  })

  it('keeps (original id, face) labels through booleans and translation', () => {
    const r = kernel.withSolids((s) => {
      const a = expectOk(s.reserveOriginalId())
      const b = expectOk(s.reserveOriginalId())
      const big = expectOk(s.fromMesh(box(10, 10, 10, 1), a))
      const small = expectOk(s.translate(expectOk(s.fromMesh(box(4, 4, 20, 5), b)), [0, 0, 5]))
      const cut = expectOk(s.subtract(big, small))
      return s.toMesh(cut).map((m) => ({ m, a, b, volume: expectOk(s.volume(cut)) }))
    })
    const { m, a, b, volume } = expectOk(r)
    expect(volume).toBeCloseTo(1000 - 16 * 5, 6)
    const keys = new Set<string>()
    for (let t = 0; t < m.triangleFace.length; t++)
      keys.add(`${m.triangleOriginal[t]}:${m.triangleFace[t]}`)
    // big: walls, top (pierced), bottom; small: its walls and bottom (the floor of the hole)
    expect(keys).toEqual(new Set([`${a}:1`, `${a}:2`, `${a}:3`, `${b}:5`, `${b}:7`]))
    expect(m.indices.length).toBe(3 * m.triangleFace.length)
    expect(
      signedVolume({ positions: Float64Array.from(m.positions), triangles: m.indices }),
    ).toBeCloseTo(volume, 3)
    expect(kernel.liveObjects()).toBe(0)
  })

  it('decomposes into pieces and unions a batch', () => {
    const r = kernel.withSolids((s) => {
      const id = expectOk(s.reserveOriginalId())
      const one = expectOk(s.fromMesh(box(1, 1, 1), id))
      const two = expectOk(s.translate(expectOk(s.fromMesh(box(1, 1, 1), id)), [5, 0, 0]))
      const both = expectOk(s.union([one, two]))
      const overlap = expectOk(s.intersect(both, one))
      return Ok({
        pieces: expectOk(s.decompose(both)).length,
        overlap: expectOk(s.volume(overlap)),
      })
    })
    expect(expectOk(r)).toEqual({ pieces: 2, overlap: expect.closeTo(1, 9) })
  })

  it('frees every object on Err and on a thrown bug', () => {
    const err = kernel.withSolids((s) => {
      expectOk(s.fromMesh(box(1, 1, 1), expectOk(s.reserveOriginalId())))
      return fail('internal.unexpected', 'stop')
    })
    expectErrCode(err, 'internal.unexpected')
    expect(kernel.liveObjects()).toBe(0)
    expect(() =>
      kernel.withSolids((s) => {
        expectOk(s.fromMesh(box(1, 1, 1), expectOk(s.reserveOriginalId())))
        throw new Error('bug')
      }),
    ).toThrow('bug')
    expect(kernel.liveObjects()).toBe(0)
  })

  it('wraps library exceptions: an open mesh is geometry.evaluation', () => {
    const open = box(1, 1, 1)
    const torn: LabelledMesh = {
      positions: open.positions,
      triangles: open.triangles.slice(3),
      faces: open.faces.slice(1),
    }
    const e = kernel.withSolids((s) => s.fromMesh(torn, expectOk(s.reserveOriginalId())))
    expectErrCode(e, 'geometry.evaluation')
    expect(kernel.liveObjects()).toBe(0)
  })

  it('frees the library object of a rejected mesh (heap stays flat)', async () => {
    const hosted = expectOk(await loadManifold(nodeManifoldSource()))
    const ring = offsetLoft(
      { kind: 'rectangle', length: 1, width: 1, cornerRadius: 0 },
      [
        { offset: 0, z: 1 },
        { offset: 0, z: 0 },
      ],
      { band: () => 1, top: 2, bottom: 3 },
    ).unwrap()
    const torn: LabelledMesh = {
      positions: ring.positions,
      triangles: ring.triangles.slice(3),
      faces: ring.faces.slice(1),
    }
    const failOnce = () =>
      expectErrCode(
        hosted.withSolids((s) => s.fromMesh(torn, expectOk(s.reserveOriginalId()))),
        'geometry.evaluation',
      )
    for (let i = 0; i < 50; i++) failOnce()
    const warm = hosted.heapBytes().unwrap()
    // ~190 B leaked per call before the fix: 40 000 calls outgrow the free heap (≈ 7 MB)
    for (let i = 0; i < 40000; i++) failOnce()
    expect(hosted.heapBytes().unwrap() - warm).toBeLessThan(2 ** 20)
    expect(hosted.liveObjects()).toBe(0)
  })

  it('rejects a solid used outside its arena', () => {
    const leaked = expectOk(
      kernel.withSolids((s) => s.fromMesh(box(1, 1, 1), expectOk(s.reserveOriginalId()))),
    )
    const e = kernel.withSolids((s) => s.volume(leaked))
    expectErrCode(e, 'internal.unexpected')
  })
})
