/**
 * Test-only: the black-box test's exported enclosure programs (2026-11-22, app 0.3.2; plans/
 * v0.4-llm-first.md § Source) read back into toolpaths, one per tool, for the simulated cut's
 * oracle and performance tests (docs/modes/deviation.md#implementation-s9-v2). A minimal reader
 * of DFYOM's own GRBL output: G0–G3 with X Y Z I J F, the tool list in the header and the tool
 * change comments. Node is reached through `process.getBuiltinModule` (src/core stays headless).
 */
import type { Move, Toolpath, ToolpathTool, Vec3 } from '../model'
import { drill, endMill } from './fixtures'

/** 26 185 lines: 6 mm flat end mill, cavity and outline with tabs (setup +z, no turn or zero). */
export const ENCLOSURE_TOP_NC = new URL('../__fixtures__/enclosure-top.nc.gz', import.meta.url)
/** 4 736 lines: 6 mm flat end mill, then a 2.5 mm drill (setup −z). */
export const ENCLOSURE_BOTTOM_NC = new URL(
  '../__fixtures__/enclosure-bottom.nc.gz',
  import.meta.url,
)
/** The black-box test's stock (mm). */
export const ENCLOSURE_STOCK = { length: 250, width: 200, thickness: 40 } as const

interface NodeProcess {
  getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL): Uint8Array }
  getBuiltinModule(id: 'node:zlib'): { gunzipSync(b: Uint8Array): Uint8Array }
}

export function readGcode(url: URL): string {
  const proc = (globalThis as unknown as { process: NodeProcess }).process
  const gz = proc.getBuiltinModule('node:fs').readFileSync(url)
  return new TextDecoder().decode(proc.getBuiltinModule('node:zlib').gunzipSync(gz))
}

/** A tool from the header's description ("6 mm flat end mill, …", "2.5 mm drill, …"). */
function toolOf(id: string, text: string): ToolpathTool {
  const d = Number(/dia ([\d.]+) mm/.exec(text)?.[1] ?? /([\d.]+) mm/.exec(text)?.[1])
  return /drill/i.test(text) ? { ...drill(d), id } : { ...endMill(d), id }
}

export interface ProgramToolpath {
  readonly tool: ToolpathTool
  readonly toolpath: Toolpath
}

/** The program's moves, one toolpath (one pass) per tool. */
export function parseGcode(text: string): ProgramToolpath[] {
  const tools = new Map<string, ToolpathTool>()
  const out: { tool: ToolpathTool; moves: Move[] }[] = []
  let mode = 0
  let feed = 0
  let pos: Vec3 = [0, 0, 0]
  for (const raw of text.split('\n')) {
    const header = /^\(Tool (\d+): (.*)\)$/.exec(raw)
    if (header) tools.set(header[1]!, toolOf(`T${header[1]}`, header[2]!))
    const change = /^\(DFYOM TOOL CHANGE (\d+):/.exec(raw)
    if (change) out.push({ tool: tools.get(change[1]!)!, moves: [] })
    const line = raw.replace(/\(.*?\)/g, '').trim()
    if (line === '') continue
    const words = new Map<string, number>()
    let motion = false
    for (const [, letter, value] of line.matchAll(/([A-Z])(-?[\d.]+)/g)) {
      const n = Number(value)
      if (letter === 'G') {
        if (n >= 0 && n <= 3) {
          mode = n
          motion = true
        }
      } else words.set(letter!, n)
    }
    if (words.has('F')) feed = words.get('F')!
    if (!words.has('X') && !words.has('Y') && !words.has('Z')) continue
    if (words.has('P') && !motion) continue
    const to: Vec3 = [words.get('X') ?? pos[0], words.get('Y') ?? pos[1], words.get('Z') ?? pos[2]]
    const cur = out[out.length - 1]
    if (cur !== undefined) {
      if (mode === 0) cur.moves.push({ kind: 'rapid', to })
      else if (mode === 1) cur.moves.push({ kind: 'line', to, feed })
      else
        cur.moves.push({
          kind: 'arc',
          to,
          center: [pos[0] + (words.get('I') ?? 0), pos[1] + (words.get('J') ?? 0)],
          cw: mode === 2,
          feed,
        })
    }
    pos = to
  }
  return out.map(({ tool, moves }, k) => ({
    tool,
    toolpath: {
      planOperationId: `program-${k + 1}`,
      tool: tool.id,
      spindleSpeed: 0,
      passes: [{ kind: 'rough', moves }],
      stats: { cutLength: 0, rapidLength: 0, estimatedSeconds: 0 },
    },
  }))
}
