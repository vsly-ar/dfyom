/**
 * `SolidPort` on manifold-3d, with the per-evaluation arena. The only code that imports
 * manifold-3d or calls `.delete()`.
 * Doc: docs/architecture/geometry.md#wasm-lifetime-and-ownership
 */
// The glue file, not the package root: `.` is exported for `import` only, and the CJS main build
// (compute worker chunk, docs/architecture/workers.md#lanes-and-pool) `require`s it.
import Module, { type Manifold, type ManifoldToplevel, type Mesh } from 'manifold-3d/manifold.js'
import {
  Err,
  fail,
  None,
  Ok,
  Some,
  tryAsync,
  tryCatch,
  type AppResult,
  type AsyncAppResult,
  type Option,
} from '../../../shared/result'
import type { LabelledMesh } from '../loft'
import type { Solid, SolidKernel, SolidMesh, SolidPort } from '../solid-port'

/**
 * How the host supplies `manifold.wasm`; `src/core` has no `fs`/`fetch` of its own.
 * - `wasmBinary`: the bytes (worker hosts; also enables `heapBytes`).
 * - `locateFile`: URL of the binary (bundled browser worker).
 * - neither: the package's own lookup (Node resolves it next to the glue).
 */
export interface ManifoldWasmSource {
  readonly wasmBinary?: Uint8Array | ArrayBuffer
  readonly locateFile?: (file: string) => string
}

/**
 * The few WebAssembly APIs used here. The global exists in every target (Node, workers,
 * browsers), but `lib: ES2023` without DOM has no declarations for it.
 */
interface WasmMemory {
  readonly buffer: ArrayBuffer
}
interface WasmInstance {
  readonly exports: Readonly<Record<string, unknown>>
}
interface WasmApi {
  compile(bytes: Uint8Array): Promise<object>
  instantiate(module: object, imports: object): Promise<WasmInstance>
  readonly Memory: abstract new (...args: never[]) => WasmMemory
}
const WebAssemblyApi = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly

/** Emscripten module options the manifold-3d typings leave out. */
interface EmscriptenOptions {
  locateFile?: (file: string) => string
  instantiateWasm?: (
    imports: object,
    receive: (instance: WasmInstance, module: object) => void,
  ) => object
}

const WHERE = 'manifold'

/** Load and initialize one manifold-3d module (once per worker, lazily on the first task). */
export async function loadManifold(source: ManifoldWasmSource = {}): AsyncAppResult<SolidKernel> {
  let memory: WasmMemory | undefined
  const wasm = await tryAsync(
    async () => {
      const options: EmscriptenOptions = {}
      if (source.locateFile !== undefined) options.locateFile = source.locateFile
      // Emscripten's instantiateWasm hook has no error path, so failures race its promise.
      let failInit: (e: unknown) => void = () => {}
      const failed = new Promise<never>((_, reject) => (failInit = reject))
      if (source.wasmBinary !== undefined) {
        const compiled = await WebAssemblyApi.compile(new Uint8Array(source.wasmBinary))
        options.instantiateWasm = (imports, receive) => {
          WebAssemblyApi.instantiate(compiled, imports).then((instance) => {
            memory = Object.values(instance.exports).find(
              (e): e is WasmMemory => e instanceof WebAssemblyApi.Memory,
            )
            receive(instance, compiled)
          }, failInit)
          return {}
        }
      }
      const factory = Module as (o: EmscriptenOptions) => Promise<ManifoldToplevel>
      const w = await Promise.race([factory(options), failed])
      w.setup()
      return w
    },
    'geometry.evaluation',
    'manifold-3d failed to load',
  )
  return wasm.map((w) => new ManifoldKernel(w, () => memory))
}

/** Handle given out to callers: the Manifold plus the arena that owns it. */
interface Handle extends Solid {
  readonly manifold: Manifold
  readonly arena: Arena
}

class Arena {
  open = true
  readonly owned: Manifold[] = []
}

/**
 * The library's own Manifold constructor. In manifold-3d 3.5.4, `Manifold.ofMesh` and
 * `new Manifold(mesh)` wrap it, check `status()` and throw without deleting the object, which
 * leaks WASM memory for every rejected mesh. The raw constructor returns the object whatever
 * its status, so the arena can free it.
 */
type RawManifoldCtor = new (mesh: Mesh) => Manifold

function rawConstructor(wasm: ManifoldToplevel): RawManifoldCtor {
  const probe = wasm.Manifold.cube(1)
  const ctor = (Object.getPrototypeOf(probe) as { constructor: RawManifoldCtor }).constructor
  probe.delete()
  return ctor
}

class ManifoldKernel implements SolidKernel {
  private live = 0
  private readonly RawManifold: RawManifoldCtor

  constructor(
    private readonly wasm: ManifoldToplevel,
    private readonly memory: () => WasmMemory | undefined,
  ) {
    this.RawManifold = rawConstructor(wasm)
  }

  liveObjects(): number {
    return this.live
  }

  heapBytes(): Option<number> {
    const m = this.memory()
    return m === undefined ? None : Some(m.buffer.byteLength)
  }

  withSolids<T>(fn: (solids: SolidPort) => AppResult<T>): AppResult<T> {
    const arena = new Arena()
    try {
      return fn(this.port(arena))
    } finally {
      arena.open = false
      for (const m of arena.owned) m.delete()
      this.live -= arena.owned.length
      arena.owned.length = 0
    }
  }

  private port(arena: Arena): SolidPort {
    const { wasm, RawManifold } = this
    const rawManifold = (mesh: Mesh): Manifold => new RawManifold(mesh)
    const own = (m: Manifold): Solid => {
      arena.owned.push(m)
      this.live++
      return { manifold: m, arena } as unknown as Handle
    }
    const get = (s: Solid): AppResult<Manifold> => {
      const h = s as Handle
      if (h.arena !== arena || !arena.open)
        return fail('internal.unexpected', 'solid used outside the arena that made it', {
          where: WHERE,
        })
      return Ok(h.manifold)
    }
    const call = <R>(what: string, f: () => R): AppResult<R> =>
      tryCatch(f, 'geometry.evaluation', `manifold ${what} failed`).mapErr((e) =>
        e.code === 'geometry.evaluation' && e.frames.length === 0
          ? e.withContext(WHERE, { what })
          : e,
      )
    const all = (solids: readonly Solid[]): AppResult<Manifold[]> => {
      const out: Manifold[] = []
      for (const s of solids) {
        const m = get(s)
        if (m.isErr()) return Err(m.unwrapErr())
        out.push(m.unwrap())
      }
      return Ok(out)
    }

    return {
      reserveOriginalId: () => call('reserveIDs', () => wasm.Manifold.reserveIDs(1)),
      fromMesh: (mesh: LabelledMesh, originalId: number) =>
        call('ofMesh', () =>
          rawManifold(
            new wasm.Mesh({
              numProp: 3,
              vertProperties: Float32Array.from(mesh.positions),
              triVerts: mesh.triangles,
              faceID: mesh.faces,
              runOriginalID: new Uint32Array([originalId]),
            }),
          ),
        ).andThen((m) => {
          // the solid is owned before its status is read, so the arena frees it either way
          const solid = own(m)
          const status = m.status()
          return status === 'NoError'
            ? Ok(solid)
            : fail('geometry.evaluation', `mesh is not a valid solid: ${status}`, {
                issues: [{ path: [], rule: 'status', message: status, params: { status } }],
                where: WHERE,
              })
        }),
      union: (solids) =>
        all(solids).andThen((ms) => call('union', () => own(wasm.Manifold.union(ms)))),
      subtract: (a, b) =>
        all([a, b]).andThen(([x, y]) => call('subtract', () => own(x!.subtract(y!)))),
      intersect: (a, b) =>
        all([a, b]).andThen(([x, y]) => call('intersect', () => own(x!.intersect(y!)))),
      transform: (s, { origin: o, u, v, n }) =>
        get(s).andThen((m) =>
          // column-major 4×4 (the last row is ignored)
          call('transform', () =>
            own(m.transform([...u, 0, ...v, 0, ...n, 0, o[0], o[1], o[2], 1])),
          ),
        ),
      status: (s) => get(s).andThen((m) => call('status', () => m.status())),
      decompose: (s) => get(s).andThen((m) => call('decompose', () => m.decompose().map(own))),
      volume: (s) => get(s).andThen((m) => call('volume', () => m.volume())),
      toMesh: (s) => get(s).andThen((m) => call('getMesh', () => copyMesh(m))),
    }
  }
}

/** Copy the output mesh into plain typed arrays with per-triangle (original id, face id). */
function copyMesh(m: Manifold): SolidMesh {
  const mesh = m.getMesh()
  const triangles = mesh.triVerts.length / 3
  const np = mesh.numProp
  const positions = new Float32Array((mesh.vertProperties.length / np) * 3)
  for (let v = 0, n = positions.length / 3; v < n; v++) {
    positions[3 * v] = mesh.vertProperties[v * np]!
    positions[3 * v + 1] = mesh.vertProperties[v * np + 1]!
    positions[3 * v + 2] = mesh.vertProperties[v * np + 2]!
  }
  const triangleOriginal = new Uint32Array(triangles)
  for (let r = 0; r < mesh.runOriginalID.length; r++) {
    triangleOriginal.fill(mesh.runOriginalID[r]!, mesh.runIndex[r]! / 3, mesh.runIndex[r + 1]! / 3)
  }
  return {
    positions,
    indices: Uint32Array.from(mesh.triVerts),
    triangleOriginal,
    triangleFace: Uint32Array.from(mesh.faceID),
  }
}
