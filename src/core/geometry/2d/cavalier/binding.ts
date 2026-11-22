/**
 * The TypeScript side of our C ABI over the CavalierContours WASM module
 * (vendor/cavalier-contours/src/lib.rs; change both together). The only code that touches the
 * module's memory. Loaders: synchronous where the host allows it (Node, workers), asynchronous in
 * the renderer (Chromium refuses synchronous compiles over 4 KiB on the main thread).
 * Doc: docs/architecture/shapes.md#where-the-2d-layer-runs
 */
import {
  Err,
  Ok,
  tryAsync,
  tryCatch,
  type AppResult,
  type AsyncAppResult,
} from '../../../../shared/result'
import { region2dError, type WireLoop } from '../wire'

/** Must equal `ABI_VERSION` in lib.rs. */
export const CAVALIER_ABI_VERSION = 1

/** A loop of a result; `neg`: a boolean's subtracted space, or a clockwise loop of an offset. */
export interface WireOut extends WireLoop {
  readonly neg: boolean
}

export type BooleanOp = 'or' | 'and' | 'not'
const OP_CODE: Record<BooleanOp, number> = { or: 0, and: 1, not: 2 }

/** Calls into the module; every call copies its input in and its result out. */
export interface CavalierBinding {
  /** Offset of a shape (outer loops counter-clockwise, holes clockwise); positive shrinks. */
  shapeOffset(loops: readonly WireLoop[], d: number): AppResult<WireOut[]>
  /** Offset of one polyline with self-intersect handling; positive lies to the left. */
  plineOffset(loop: WireLoop, d: number): AppResult<WireOut[]>
  /** Boolean of two closed loops. */
  boolean(a: WireLoop, b: WireLoop, op: BooleanOp): AppResult<WireOut[]>
}

/** The module's exports (lib.rs). */
interface CavalierExports {
  readonly memory: { readonly buffer: ArrayBuffer }
  abi_version(): number
  buf_alloc(len: number): number
  buf_free(ptr: number, len: number): void
  result_ptr(): number
  shape_offset(ptr: number, len: number, offset: number): number
  pline_offset(ptr: number, len: number, offset: number): number
  pline_boolean(ptr: number, len: number, op: number): number
}

/**
 * The few WebAssembly APIs used here. The global exists in every target (Node, workers,
 * browsers), but `lib: ES2023` without DOM has no declarations for it.
 */
interface WasmInstance {
  readonly exports: Readonly<Record<string, unknown>>
}
interface WasmApi {
  readonly Module: new (bytes: Uint8Array) => object
  readonly Instance: new (module: object, imports: object) => WasmInstance
  compile(bytes: Uint8Array): Promise<object>
  instantiate(module: object, imports: object): Promise<WasmInstance>
}
const wasmApi = (): WasmApi => (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly

const WHERE = 'cavalier'
const EXPORTS = [
  'memory',
  'abi_version',
  'buf_alloc',
  'buf_free',
  'result_ptr',
  'shape_offset',
  'pline_offset',
  'pline_boolean',
] as const

/** The module has no imports: only its own memory. */
const NO_IMPORTS = {}

function exportsOf(instance: WasmInstance): AppResult<CavalierExports> {
  const missing = EXPORTS.filter((k) =>
    k === 'memory'
      ? typeof instance.exports[k] !== 'object'
      : typeof instance.exports[k] !== 'function',
  )
  if (missing.length > 0)
    return Err(region2dError('kernel', 'the 2D library module lacks exports', WHERE, { missing }))
  const x = instance.exports as unknown as CavalierExports
  const abi = x.abi_version()
  if (abi !== CAVALIER_ABI_VERSION)
    return Err(
      region2dError('kernel', 'the 2D library module has another ABI version', WHERE, {
        abi,
        expected: CAVALIER_ABI_VERSION,
      }),
    )
  return Ok(x)
}

const bytesOf = (b: Uint8Array | ArrayBuffer): Uint8Array =>
  b instanceof Uint8Array ? b : new Uint8Array(b)

/** Compiles and instantiates synchronously (dispatcher hosts, workers, the CLI, tests). */
export function loadCavalierSync(bytes: Uint8Array | ArrayBuffer): AppResult<CavalierBinding> {
  const api = wasmApi()
  return tryCatch(
    () => {
      const module = new api.Module(bytesOf(bytes))
      return { module, instance: new api.Instance(module, NO_IMPORTS) }
    },
    'geometry.evaluation',
    'the 2D library module failed to load',
  ).andThen(({ module, instance }) => exportsOf(instance).map((x) => new Binding(module, x)))
}

/** Compiles and instantiates asynchronously (the renderer's main thread). */
export async function loadCavalier(
  bytes: Uint8Array | ArrayBuffer,
): AsyncAppResult<CavalierBinding> {
  const api = wasmApi()
  const loaded = await tryAsync(
    async () => {
      const module = await api.compile(bytesOf(bytes))
      return { module, instance: await api.instantiate(module, NO_IMPORTS) }
    },
    'geometry.evaluation',
    'the 2D library module failed to load',
  )
  return loaded.andThen(({ module, instance }) =>
    exportsOf(instance).map((x) => new Binding(module, x)),
  )
}

/**
 * A binding over exports of an instance of `module` (tests wrap the real exports to inject a
 * trap); the loaders above are the way in for app code.
 */
export function bindCavalierExports(
  module: object,
  exports: Readonly<Record<string, unknown>>,
): AppResult<CavalierBinding> {
  return exportsOf({ exports }).map((x) => new Binding(module, x))
}

/**
 * Holds the instance. A trap (a Rust panic aborts) may leave the module's allocator inconsistent,
 * so the instance is dropped and a fresh one made from the compiled module: synchronously where
 * allowed, else asynchronously (calls fail with rule `kernel` until it is back).
 */
class Binding implements CavalierBinding {
  private x: CavalierExports | undefined

  constructor(
    private readonly module: object,
    x: CavalierExports,
  ) {
    this.x = x
  }

  shapeOffset(loops: readonly WireLoop[], d: number): AppResult<WireOut[]> {
    return this.call('shapeOffset', loops, (x, p, l) => x.shape_offset(p, l, d))
  }

  plineOffset(loop: WireLoop, d: number): AppResult<WireOut[]> {
    return this.call('plineOffset', [loop], (x, p, l) => x.pline_offset(p, l, d))
  }

  boolean(a: WireLoop, b: WireLoop, op: BooleanOp): AppResult<WireOut[]> {
    return this.call('boolean', [a, b], (x, p, l) => x.pline_boolean(p, l, OP_CODE[op]))
  }

  private call(
    name: string,
    loops: readonly WireLoop[],
    fn: (x: CavalierExports, ptr: number, len: number) => number,
  ): AppResult<WireOut[]> {
    const x = this.x
    if (x === undefined)
      return Err(
        region2dError('kernel', 'the 2D library is restarting after a failure', `${WHERE}.${name}`),
      )
    let len = 1
    for (const l of loops) len += 2 + l.v.length
    const ran = tryCatch(
      () => {
        const ptr = x.buf_alloc(len)
        const input = new Float64Array(x.memory.buffer, ptr, len)
        input[0] = loops.length
        let i = 1
        for (const l of loops) {
          input[i++] = l.closed ? 1 : 0
          input[i++] = l.v.length / 3
          for (let k = 0; k < l.v.length; k++) input[i++] = l.v[k]!
        }
        const outLen = fn(x, ptr, len)
        x.buf_free(ptr, len)
        // the memory may have grown during the call: views are made after it
        return decode(new Float64Array(x.memory.buffer, x.result_ptr(), outLen))
      },
      'geometry.evaluation',
      'the 2D library failed',
    )
    if (ran.isOk()) return ran
    this.restart()
    const cause = ran.unwrapErr().cause
    return Err(
      region2dError('kernel', 'the 2D library failed (trap)', `${WHERE}.${name}`, {
        cause: cause instanceof Error ? cause.message : String(cause),
      }),
    )
  }

  private restart(): void {
    this.x = undefined
    const api = wasmApi()
    const sync = tryCatch(
      () => new api.Instance(this.module, NO_IMPORTS),
      'geometry.evaluation',
      'sync instantiation refused',
    ).andThen(exportsOf)
    if (sync.isOk()) {
      this.x = sync.unwrap()
      return
    }
    void api.instantiate(this.module, NO_IMPORTS).then(
      (instance) => {
        const x = exportsOf(instance)
        if (x.isOk()) this.x = x.unwrap()
      },
      () => {},
    )
  }
}

function decode(a: Float64Array): WireOut[] {
  const out: WireOut[] = []
  const count = a[0] ?? 0
  let i = 1
  for (let k = 0; k < count; k++) {
    const flags = a[i++]!
    const n = a[i++]!
    out.push({ closed: (flags & 1) === 1, neg: (flags & 2) === 2, v: a.slice(i, i + 3 * n) })
    i += 3 * n
  }
  return out
}
