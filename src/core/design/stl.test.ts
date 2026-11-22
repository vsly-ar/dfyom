// STL parser: binary and ASCII, chunking, closed check, malformed files and limits.
// Spec: docs/modes/reference-model.md#stl-parser-task-r2
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { evaluatePart } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import { nodeManifoldSource } from '../geometry/testing/node-wasm'
import { testPart } from '../geometry/testing/test-part'
import { createStlParser, parseStl, STL_LIMITS, type StlSummary } from './stl'
import {
  asciiStl,
  binaryStl,
  boxSoup,
  ENCLOSURE_TRIANGLES,
  enclosureStl,
  soupOf,
} from './stl.testing'

/** Feeds `bytes` in chunks of `size`. */
function chunked(bytes: Uint8Array, size: number) {
  const p = expectOk(createStlParser(bytes.length))
  for (let i = 0; i < bytes.length; i += size) expectOk(p.push(bytes.subarray(i, i + size)))
  return p.finish()
}

const box = boxSoup(20, 10, 5)
const boxBounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 10, z: 5 } }

describe('STL parser', () => {
  it('reads a binary box: count, bounds, closed', () => {
    expect(expectOk(parseStl(binaryStl(box)))).toEqual({
      format: 'binary',
      triangles: 12,
      bounds: boxBounds,
      closed: true,
    } satisfies StlSummary)
  })

  it('reads an ASCII box (CRLF, names) the same way', () => {
    expect(expectOk(parseStl(asciiStl(box, 'my part')))).toEqual({
      format: 'ascii',
      triangles: 12,
      bounds: boxBounds,
      closed: true,
    })
  })

  it('a binary file whose header starts with "solid" is still binary (size rule)', () => {
    expect(expectOk(parseStl(binaryStl(box, 'solid but binary'))).format).toBe('binary')
  })

  it('gives the same result for any chunking (records and lines split across chunks)', () => {
    const whole = expectOk(parseStl(binaryStl(box)))
    for (const size of [1, 7, 49, 50, 51, 83, 84, 85])
      expect(expectOk(chunked(binaryStl(box), size)), `binary ${size}`).toEqual(whole)
    const ascii = expectOk(parseStl(asciiStl(box)))
    for (const size of [1, 3, 64]) expect(expectOk(chunked(asciiStl(box), size))).toEqual(ascii)
  })

  it('detects open meshes and flipped triangles', () => {
    expect(expectOk(parseStl(binaryStl(box.slice(9)))).closed).toBe(false) // one missing
    const flipped = [...box]
    flipped.splice(0, 9, ...box.slice(6, 9), ...box.slice(3, 6), ...box.slice(0, 3))
    expect(expectOk(parseStl(binaryStl(flipped))).closed).toBe(false)
  })

  it('treats -0 like 0 (same vertex) and keeps scientific notation', () => {
    const neg = box.map((v) => (v === 0 ? -0 : v))
    expect(expectOk(parseStl(binaryStl(neg))).closed).toBe(true)
    const text = new TextDecoder().decode(asciiStl(box)).replaceAll(' 20 ', ' 2e1 ')
    expect(expectOk(parseStl(new TextEncoder().encode(text))).bounds.max.x).toBe(20)
  })

  it('reads the real enclosure STL ("MESH-…" header) as a closed binary mesh', () => {
    const s = expectOk(parseStl(enclosureStl()))
    expect(s).toMatchObject({ format: 'binary', triangles: ENCLOSURE_TRIANGLES })
    expect(s.bounds.max.x - s.bounds.min.x).toBeGreaterThan(0)
  })

  it('reads the evaluated test part as a closed mesh, in binary and ASCII', async () => {
    const kernel = expectOk(await loadManifold(nodeManifoldSource()))
    const ev = expectOk(kernel.withSolids((s) => evaluatePart(testPart(), s)))
    const soup = soupOf(ev.positions, ev.indices)
    for (const bytes of [binaryStl(soup), asciiStl(soup)]) {
      const s = expectOk(parseStl(bytes))
      expect(s).toMatchObject({ triangles: ev.indices.length / 3, closed: true })
      expect(s.bounds.max.x - s.bounds.min.x).toBeCloseTo(100, 3)
    }
  })
})

describe('STL parser: malformed files', () => {
  const rejects = (bytes: Uint8Array, rule: string, params?: object) => {
    const e = expectErrCode(parseStl(bytes), 'input.malformed')
    expect(e.issues[0], new TextDecoder().decode(bytes.subarray(0, 40))).toMatchObject({
      path: ['path'],
      rule,
      ...(params === undefined ? {} : { params }),
    })
    return e
  }
  const text = (s: string) => new TextEncoder().encode(s)
  const ascii = new TextDecoder().decode(asciiStl(box.slice(0, 9)))

  it('refuses empty, non-STL and zero-triangle files', () => {
    rejects(new Uint8Array(0), 'emptyMesh')
    rejects(text('hello world, this is not an STL file at all'), 'stlFormat')
    rejects(new Uint8Array(200).fill(7), 'stlTruncated') // header count 0x07070707
    rejects(new Uint8Array(84 + 50 * 2 + 1), 'stlFormat') // count 0: 85 bytes expected
    rejects(binaryStl([]), 'emptyMesh')
    rejects(text('solid x\nendsolid x\n'), 'emptyMesh')
  })

  it('names the byte offset of a truncated or broken binary file', () => {
    const bytes = binaryStl(box)
    // the header claims 12 triangles but the file stops after 2.5 of them
    rejects(bytes.subarray(0, 84 + 125), 'stlTruncated', { offset: 84 + 125 })
    const nan = binaryStl(box)
    new DataView(nan.buffer).setFloat32(84 + 50 + 12 + 4, Number.NaN, true)
    rejects(nan, 'stlValue', { offset: 84 + 50 + 16 })
  })

  it('names the line of an ASCII syntax error', () => {
    rejects(text(ascii.replace('vertex 0 0 0', 'vertex 0 x 0')), 'stlSyntax', { line: 4 })
    rejects(text(ascii.replace('outer loop', 'outer lop')), 'stlSyntax', { line: 3 })
    rejects(text(ascii.replace('endloop', 'vertex 1 1 1\r\n endloop')), 'stlSyntax')
    rejects(text(ascii.replace(/endsolid.*/, '')), 'stlSyntax') // ends before endsolid
    rejects(text(ascii.slice(0, ascii.indexOf('endloop'))), 'stlSyntax') // truncated
    rejects(text(ascii.replace('vertex 0 0 0', 'vertex 1e39 0 0')), 'stlSyntax')
    rejects(text(`solid x\n${'a'.repeat(5000)}\n`), 'stlSyntax')
  })

  it('a binary file starting with "solid" whose size does not match fails as ASCII', () => {
    const bytes = binaryStl(box, 'solid exporter')
    rejects(bytes.subarray(0, bytes.length - 1), 'stlSyntax')
  })
})

describe('STL parser: limits', () => {
  it('refuses a file over the byte limit before reading it', () => {
    const e = expectErrCode(createStlParser(STL_LIMITS.maxBytes + 1), 'input.malformed')
    expect(e.issues[0]).toMatchObject({ rule: 'tooLarge', params: { limit: STL_LIMITS.maxBytes } })
  })

  it('refuses too many triangles: binary from the header, ASCII while counting', () => {
    const limits = { maxBytes: STL_LIMITS.maxBytes, maxTriangles: 11 }
    const b = expectErrCode(parseStl(binaryStl(box), limits), 'input.malformed')
    expect(b.issues[0]).toMatchObject({ rule: 'tooLarge', params: { limit: 11, actual: 12 } })
    const a = expectErrCode(parseStl(asciiStl(box), limits), 'input.malformed')
    expect(a.issues[0]).toMatchObject({ rule: 'tooLarge', params: { limit: 11, actual: 12 } })
    expect(expectOk(parseStl(binaryStl(box), { ...limits, maxTriangles: 12 })).triangles).toBe(12)
  })

  it('the default limits are the measured ones', () => {
    expect(STL_LIMITS).toEqual({
      maxBytes: 512 * 1024 * 1024,
      maxTriangles: 5_000_000,
      warnTriangles: 1_000_000,
    })
  })
})
