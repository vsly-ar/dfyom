/**
 * Streamed STL parser (binary and ASCII) for reference models: reads chunks, keeps only a
 * summary (triangle count, bounds, whether the mesh is closed), never the whole file.
 * Doc: docs/modes/reference-model.md#stl-parser-task-r2
 *
 * Pure and headless; the worker task (src/core/workers/tasks.ts) feeds it a file's chunks.
 * Bad input is `input.malformed` with the byte offset (binary) or line (ASCII) in the issue.
 */
import type { Issue } from '../../shared/errors/app-error'
import { fail, Ok, type AppResult } from '../../shared/result'
import { MAX_ASSET_BYTES } from '../project/assets'

export interface Xyz {
  readonly x: number
  readonly y: number
  readonly z: number
}
export interface Box {
  readonly min: Xyz
  readonly max: Xyz
}

/** Limits measured in task R2 (reference-model.md § Performance). */
export const STL_LIMITS = {
  /** Larger files are refused before they are copied or read. */
  maxBytes: MAX_ASSET_BYTES,
  /** More triangles are refused. */
  maxTriangles: 5_000_000,
  /** More triangles warn (`reference.manyTriangles`): the viewport may get slow. */
  warnTriangles: 1_000_000,
} as const

export interface StlLimits {
  readonly maxBytes: number
  readonly maxTriangles: number
}

export interface StlSummary {
  readonly format: 'binary' | 'ascii'
  readonly triangles: number
  /** In source units, as read (float32 values). */
  readonly bounds: Box
  /** Every directed edge has its opposite: closed and consistently oriented (hash check). */
  readonly closed: boolean
}

export interface StlParser {
  push(chunk: Uint8Array): AppResult<void>
  finish(): AppResult<StlSummary>
}

const HEADER = 84
const RECORD = 50
/** An ASCII line longer than this is not a text STL (e.g. a binary file starting with "solid"). */
const MAX_LINE = 4096
const WHERE = 'stl.parse'
/** Shared success value: the hot loops allocate nothing per token or record. */
const OK: AppResult<void> = Ok(undefined)

function malformed(
  rule: string,
  message: string,
  params: Record<string, number> = {},
): AppResult<never> {
  const issue: Issue = { path: ['path'], rule, message, params }
  return fail('input.malformed', `not a readable STL file: ${message}`, {
    where: WHERE,
    issues: [issue],
  })
}

function tooLarge(what: 'bytes' | 'triangles', limit: number, actual: number): AppResult<never> {
  return fail('input.malformed', `STL has more ${what} than the limit (${limit})`, {
    where: WHERE,
    issues: [
      {
        path: ['path'],
        rule: 'tooLarge',
        message: `more than ${limit} ${what}`,
        params: { limit, actual },
      },
    ],
  })
}

// ── mesh summary ──────────────────────────────────────────────────────────────────────────

function fmix(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  return h ^ (h >>> 16)
}

/**
 * Bounds, count and the closed check. Closed: for a closed, consistently oriented mesh every
 * directed edge a→b has its twin b→a, so the sum of `f(a,b) − f(b,a)` over all edges (with a
 * non-symmetric hash `f` of the vertices' float32 bit patterns) is exactly 0; an open edge
 * leaves it non-zero (two independent 32-bit sums: a false "closed" has odds ~2⁻⁶⁴).
 * Constant memory, one pass. A mesh with flipped triangles counts as open.
 */
class MeshSummary {
  triangles = 0
  private minX = Infinity
  private minY = Infinity
  private minZ = Infinity
  private maxX = -Infinity
  private maxY = -Infinity
  private maxZ = -Infinity
  private s1 = 0
  private s2 = 0
  private readonly h1 = new Int32Array(3)
  private readonly h2 = new Int32Array(3)

  /** `v`: 9 float32 values, `bits`: their bit patterns (−0 normalized to 0). */
  add(v: Float32Array, bits: Uint32Array): void {
    this.triangles++
    for (let i = 0; i < 3; i++) {
      const x = v[i * 3]!
      const y = v[i * 3 + 1]!
      const z = v[i * 3 + 2]!
      if (x < this.minX) this.minX = x
      if (x > this.maxX) this.maxX = x
      if (y < this.minY) this.minY = y
      if (y > this.maxY) this.maxY = y
      if (z < this.minZ) this.minZ = z
      if (z > this.maxZ) this.maxZ = z
      const bx = bits[i * 3]!
      const by = bits[i * 3 + 1]!
      const bz = bits[i * 3 + 2]!
      this.h1[i] = fmix(
        Math.imul(bx, 0x9e3779b1) ^ Math.imul(by, 0x85ebca77) ^ Math.imul(bz, 0xc2b2ae3d),
      )
      this.h2[i] = fmix(
        (Math.imul(bx, 0x165667b1) + Math.imul(by, 0xd3a2646c) + Math.imul(bz, 0xfd7046c5)) | 0,
      )
    }
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3
      const a1 = this.h1[i]!
      const b1 = this.h1[j]!
      const a2 = this.h2[i]!
      const b2 = this.h2[j]!
      this.s1 =
        (this.s1 + fmix(Math.imul(a1, 0x9e3779b1) + b1) - fmix(Math.imul(b1, 0x9e3779b1) + a1)) | 0
      this.s2 =
        (this.s2 + fmix(Math.imul(a2, 0x27d4eb2f) ^ b2) - fmix(Math.imul(b2, 0x27d4eb2f) ^ a2)) | 0
    }
  }

  summary(format: StlSummary['format']): AppResult<StlSummary> {
    if (this.triangles === 0) return malformed('emptyMesh', 'it contains no triangles')
    return Ok({
      format,
      triangles: this.triangles,
      bounds: {
        min: { x: this.minX, y: this.minY, z: this.minZ },
        max: { x: this.maxX, y: this.maxY, z: this.maxZ },
      },
      closed: this.s1 === 0 && this.s2 === 0,
    })
  }
}

const finiteBits = (b: number) => (b & 0x7f800000) !== 0x7f800000

// ── binary ────────────────────────────────────────────────────────────────────────────────

class BinaryParser implements StlParser {
  private readonly mesh = new MeshSummary()
  private readonly carry = new Uint8Array(RECORD)
  private readonly carryView = new DataView(this.carry.buffer)
  private carried = 0
  private done = 0
  private readonly v = new Float32Array(9)
  private readonly bits = new Uint32Array(9)

  constructor(
    private readonly count: number,
    /** Bytes before the first record that were already consumed. */
    private offset: number,
  ) {}

  private record(view: DataView, at: number): AppResult<void> {
    for (let k = 0; k < 9; k++) {
      let b = view.getUint32(at + 12 + k * 4, true)
      if (!finiteBits(b))
        return malformed('stlValue', `triangle ${this.done + 1} has a non-finite coordinate`, {
          offset: this.offset + 12 + k * 4,
        })
      if (b === 0x80000000) b = 0
      this.bits[k] = b
      this.v[k] = view.getFloat32(at + 12 + k * 4, true)
    }
    this.mesh.add(this.v, this.bits)
    this.done++
    this.offset += RECORD
    return OK
  }

  push(chunk: Uint8Array): AppResult<void> {
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let i = 0
    while (i < chunk.length && this.done < this.count) {
      if (this.carried > 0 || chunk.length - i < RECORD) {
        const take = Math.min(RECORD - this.carried, chunk.length - i)
        this.carry.set(chunk.subarray(i, i + take), this.carried)
        this.carried += take
        i += take
        if (this.carried < RECORD) break
        this.carried = 0
        const r = this.record(this.carryView, 0)
        if (r.isErr()) return r
      } else {
        const r = this.record(view, i)
        if (r.isErr()) return r
        i += RECORD
      }
    }
    return OK
  }

  finish(): AppResult<StlSummary> {
    if (this.done < this.count)
      return malformed(
        'stlTruncated',
        `the file ends after ${this.done} of ${this.count} triangles`,
        {
          offset: this.offset + this.carried,
        },
      )
    return this.mesh.summary('binary')
  }
}

// ── ASCII ─────────────────────────────────────────────────────────────────────────────────

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

type AsciiState =
  | 'solid' // expect `solid`
  | 'facet' // expect `facet` or `endsolid`
  | 'normal' // expect `normal`
  | 'normalValues'
  | 'outer'
  | 'loop'
  | 'vertex' // expect `vertex` (or `endloop` after three)
  | 'vertexValues'
  | 'endfacet'
  | 'after' // after `endsolid`: another `solid` or the end

class AsciiParser implements StlParser {
  private readonly mesh = new MeshSummary()
  private readonly decoder = new TextDecoder('latin1')
  private partial = ''
  private line = 0
  private state: AsciiState = 'solid'
  private skipLine = false
  private values = 0
  private vertices = 0
  private readonly v = new Float32Array(9)
  private readonly bits = new Uint32Array(this.v.buffer)

  constructor(private readonly maxTriangles: number) {}

  private bad(message: string): AppResult<never> {
    return malformed('stlSyntax', `line ${this.line}: ${message}`, { line: this.line })
  }

  private token(t: string): AppResult<void> {
    switch (this.state) {
      case 'solid':
      case 'after':
        if (t !== 'solid') return this.bad(`expected "solid", found "${t.slice(0, 40)}"`)
        this.skipLine = true // the solid's name
        this.state = 'facet'
        return OK
      case 'facet':
        if (t === 'endsolid') {
          this.skipLine = true
          this.state = 'after'
          return OK
        }
        if (t !== 'facet')
          return this.bad(`expected "facet" or "endsolid", found "${t.slice(0, 40)}"`)
        this.state = 'normal'
        return OK
      case 'normal':
        if (t !== 'normal') return this.bad(`expected "normal", found "${t.slice(0, 40)}"`)
        this.state = 'normalValues'
        this.values = 0
        return OK
      case 'normalValues':
        // normals are recomputed by the renderer; some exporters write `nan` here
        if (++this.values === 3) this.state = 'outer'
        return OK
      case 'outer':
        if (t !== 'outer') return this.bad(`expected "outer loop", found "${t.slice(0, 40)}"`)
        this.state = 'loop'
        return OK
      case 'loop':
        if (t !== 'loop') return this.bad(`expected "outer loop", found "outer ${t.slice(0, 40)}"`)
        this.state = 'vertex'
        this.vertices = 0
        return OK
      case 'vertex':
        if (this.vertices === 3) {
          if (t !== 'endloop') return this.bad('a facet must have exactly 3 vertices')
          this.state = 'endfacet'
          this.mesh.add(this.v, this.bits)
          if (this.mesh.triangles > this.maxTriangles)
            return tooLarge('triangles', this.maxTriangles, this.mesh.triangles)
          return OK
        }
        if (t !== 'vertex') return this.bad(`expected "vertex", found "${t.slice(0, 40)}"`)
        this.state = 'vertexValues'
        this.values = 0
        return OK
      case 'vertexValues': {
        if (!NUMBER.test(t)) return this.bad(`"${t.slice(0, 40)}" is not a number`)
        const k = this.vertices * 3 + this.values
        this.v[k] = Number(t)
        if (!finiteBits(this.bits[k]!)) return this.bad(`${t.slice(0, 40)} is out of range`)
        if (this.bits[k] === 0x80000000) this.bits[k] = 0
        if (++this.values === 3) {
          this.vertices++
          this.state = 'vertex'
        }
        return OK
      }
      case 'endfacet':
        if (t !== 'endfacet') return this.bad(`expected "endfacet", found "${t.slice(0, 40)}"`)
        this.state = 'facet'
        return OK
    }
  }

  /** The line `text[start, n)` (without its newline). */
  private processLine(text: string, start = 0, n = text.length): AppResult<void> {
    this.line++
    if (n - start > MAX_LINE) return this.bad(`line longer than ${MAX_LINE} characters`)
    this.skipLine = false
    let i = start
    while (i < n && !this.skipLine) {
      while (i < n && text.charCodeAt(i) <= 32) i++
      if (i >= n) break
      let j = i
      while (j < n && text.charCodeAt(j) > 32) j++
      const r = this.token(text.slice(i, j))
      if (r.isErr()) return r
      i = j
    }
    return OK
  }

  push(chunk: Uint8Array): AppResult<void> {
    const text = this.partial + this.decoder.decode(chunk)
    let start = 0
    for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n', start)) {
      const r = this.processLine(text, start, nl)
      if (r.isErr()) return r
      start = nl + 1
    }
    this.partial = text.slice(start)
    if (this.partial.length > MAX_LINE) {
      this.line++
      return this.bad(`line longer than ${MAX_LINE} characters`)
    }
    return OK
  }

  finish(): AppResult<StlSummary> {
    if (this.partial.length > 0) {
      const r = this.processLine(this.partial)
      if (r.isErr()) return r
      this.partial = ''
    }
    if (this.state !== 'after') return this.bad('the file ends before "endsolid"')
    return this.mesh.summary('ascii')
  }
}

// ── detection ─────────────────────────────────────────────────────────────────────────────

/** Starts (after optional whitespace) with the keyword `solid`. */
function startsWithSolid(head: Uint8Array): boolean {
  let i = 0
  while (i < head.length && head[i]! <= 32) i++
  const word = 'solid'
  for (let k = 0; k < word.length; k++) if (head[i + k] !== word.charCodeAt(k)) return false
  const after = head[i + word.length]
  return after === undefined || after <= 32
}

/**
 * Binary if the size is exactly `84 + 50 × count` (the count at byte 80), else ASCII if the
 * file starts with `solid`, else refused. Many binary files start with "solid" too, so the
 * size test comes first.
 */
class DetectingParser implements StlParser {
  private readonly head = new Uint8Array(HEADER)
  private got = 0
  private inner: StlParser | undefined

  constructor(
    private readonly size: number,
    private readonly limits: StlLimits,
  ) {}

  private detect(): AppResult<StlParser> {
    const head = this.head.subarray(0, this.got)
    if (this.got >= HEADER) {
      const count = new DataView(this.head.buffer).getUint32(80, true)
      if (this.size === HEADER + RECORD * count) {
        if (count > this.limits.maxTriangles)
          return tooLarge('triangles', this.limits.maxTriangles, count)
        return Ok(new BinaryParser(count, HEADER))
      }
      if (!startsWithSolid(head) && this.size < HEADER + RECORD * count)
        return malformed(
          'stlTruncated',
          `binary header says ${count} triangles (${HEADER + RECORD * count} bytes) but the file has ${this.size}`,
          { offset: this.size },
        )
    }
    if (startsWithSolid(head)) {
      const ascii = new AsciiParser(this.limits.maxTriangles)
      const r = ascii.push(head)
      return r.isErr() ? r : Ok(ascii)
    }
    return malformed(
      'stlFormat',
      'neither a binary STL (size ≠ 84 + 50 × triangles) nor an ASCII STL (no "solid")',
      { offset: 0 },
    )
  }

  push(chunk: Uint8Array): AppResult<void> {
    if (this.inner !== undefined) return this.inner.push(chunk)
    const take = Math.min(HEADER - this.got, chunk.length)
    this.head.set(chunk.subarray(0, take), this.got)
    this.got += take
    if (this.got < HEADER) return OK
    const inner = this.detect()
    if (inner.isErr()) return inner
    this.inner = inner.unwrap()
    return take < chunk.length ? this.inner.push(chunk.subarray(take)) : Ok(undefined)
  }

  finish(): AppResult<StlSummary> {
    if (this.inner === undefined) {
      if (this.got === 0) return malformed('emptyMesh', 'the file is empty', { offset: 0 })
      const inner = this.detect()
      if (inner.isErr()) return inner
      this.inner = inner.unwrap()
    }
    return this.inner.finish()
  }
}

/** A parser for a file of `size` bytes; a size over the limit is refused at once. */
export function createStlParser(
  size: number,
  limits: StlLimits = STL_LIMITS,
): AppResult<StlParser> {
  if (size > limits.maxBytes) return tooLarge('bytes', limits.maxBytes, size)
  return Ok(new DetectingParser(size, limits))
}

/** Parses a whole file held in memory (tests, small files). */
export function parseStl(bytes: Uint8Array, limits: StlLimits = STL_LIMITS): AppResult<StlSummary> {
  return createStlParser(bytes.length, limits).andThen((p) =>
    p.push(bytes).andThen(() => p.finish()),
  )
}
