// The C ABI binding: version check, and recovery from a trap (a Rust panic aborts) with a fresh
// instance. Doc: docs/architecture/shapes.md#2d-port
import { describe, expect, it } from 'vitest'
import { expectErrCode } from '../../../../shared/testing/result'
import { nodeCavalierWasm } from '../testing/node-wasm'
import { bindCavalierExports, CAVALIER_ABI_VERSION } from './binding'

interface Wasm {
  Module: new (b: Uint8Array) => object
  Instance: new (m: object, i: object) => { exports: Record<string, unknown> }
}
const wasm = (globalThis as unknown as { WebAssembly: Wasm }).WebAssembly
const square = { closed: true, v: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0] }

describe('cavalier binding', () => {
  const module = new wasm.Module(nodeCavalierWasm())
  const real = () => new wasm.Instance(module, {}).exports

  it('offsets through the C ABI', () => {
    const b = bindCavalierExports(module, real()).unwrap()
    const out = b.shapeOffset([square], 1).unwrap()
    expect(out).toHaveLength(1)
    expect(out[0]!.neg).toBe(false)
    expect(Array.from(out[0]!.v)).toHaveLength(12)
  })

  it('checks the exports and the ABI version', () => {
    const x = real()
    expectErrCode(
      bindCavalierExports(module, { ...x, pline_boolean: undefined }),
      'geometry.evaluation',
    )
    const other = bindCavalierExports(module, { ...x, abi_version: () => CAVALIER_ABI_VERSION + 1 })
    expect(expectErrCode(other, 'geometry.evaluation').issues[0]?.rule).toBe('kernel')
  })

  it('a trap fails that call and the next one runs on a fresh instance', () => {
    const x = real()
    const trapping = {
      ...x,
      shape_offset: () => {
        throw new Error('unreachable')
      },
    }
    const b = bindCavalierExports(module, trapping).unwrap()
    const failed = expectErrCode(b.shapeOffset([square], 1), 'geometry.evaluation')
    expect(failed.issues[0]?.rule).toBe('kernel')
    expect(b.shapeOffset([square], 1).unwrap()).toHaveLength(1)
  })
})
