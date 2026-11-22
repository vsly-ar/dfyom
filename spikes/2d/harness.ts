// Spike S1 harness (docs/decisions/0019-2d-geometry-library.md). Run: `npm ci && npm run build:wasm && npm run bench`
// in spikes/2d (Node ≥ 23.6 runs the TypeScript directly). Prints Markdown tables to stdout.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cavalierJs, cavalierWasm, clipper, clipperRings, type Candidate } from './candidates.ts'
import { boolCases, offsetCases, star } from './corpus.ts'
import {
  countKinds,
  crossings,
  maxOffsetError,
  netArea,
  reverse,
  segCount,
  transform,
  type Loop,
} from './geom.ts'

const fmtErr = (e: number): string =>
  e < 1e-3 ? `${(e * 1e3).toFixed(2)} µm` : `${(e * 1e3).toFixed(0)} µm`

async function loadCandidates(): Promise<Candidate[]> {
  const list: Candidate[] = [cavalierJs]
  const wasm = join(import.meta.dirname, 'cc-wasm', 'cc_wasm.wasm')
  if (existsSync(wasm)) list.push(await cavalierWasm(readFileSync(wasm)))
  else
    console.error(
      'cc-wasm/cc_wasm.wasm missing: run `npm run build:wasm` (skipping the WASM candidate)',
    )
  list.push(clipper(true))
  return list
}

function attempt<T>(f: () => T): T | Error {
  try {
    return f()
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  }
}

function offsetTable(cands: Candidate[]): void {
  console.log('\n## Offsets: loops (expected) · arcs/lines out · max distance error · crossings\n')
  console.log(`| Case | d | ${cands.map((c) => c.name).join(' | ')} |`)
  console.log(`| --- | --- | ${cands.map(() => '---').join(' | ')} |`)
  for (const c of offsetCases()) {
    const kin = countKinds(c.region)
    for (const [d, expected] of c.offsets) {
      const cells = cands.map((cand) => {
        const region = c.normalise ? cand.difference(c.region[0]!, reverse(c.region[1]!)) : c.region
        const r = attempt(() => cand.offset(region, d))
        if (r instanceof Error) return `throws: ${r.message.slice(0, 40)}`
        const k = countKinds(r)
        const ok = expected === null || r.length === expected ? '' : ` ✗ (want ${expected})`
        const x = crossings(r)
        return `${r.length}${ok} · ${k.arcs}/${k.lines} · ${fmtErr(maxOffsetError(region, r, d))}${x ? ` · **${x} crossings**` : ''}`
      })
      console.log(`| ${c.name} (in: ${kin.arcs}/${kin.lines}) | ${d} | ${cells.join(' | ')} |`)
    }
  }
}

function boolTable(cands: Candidate[]): void {
  console.log('\n## Booleans: loops (expected) · arcs/lines out · area error · crossings\n')
  console.log(`| Case | ${cands.map((c) => c.name).join(' | ')} |`)
  console.log(`| --- | ${cands.map(() => '---').join(' | ')} |`)
  for (const b of boolCases) {
    const cells = cands.map((cand) => {
      const r = attempt(() => (b.op === 'union' ? cand.union(b.a, b.b) : cand.difference(b.a, b.b)))
      if (r instanceof Error) return `throws: ${r.message.slice(0, 40)}`
      const k = countKinds(r)
      const ok = b.loops === null || r.length === b.loops ? '' : ` ✗ (want ${b.loops})`
      const x = crossings(r)
      return `${r.length}${ok} · ${k.arcs}/${k.lines} · ${(netArea(r) - b.area).toExponential(1)} mm² ${x ? ` · **${x} crossings**` : ''}`
    })
    console.log(`| ${b.name} | ${cells.join(' | ')} |`)
  }
}

/** Pocket clearing rings: offset by `first`, then repeatedly by `step` from the previous ring. */
function rings(
  cand: Candidate | 'clipper-polygons',
  region: Loop[],
  first: number,
  step: number,
  count: number,
): Loop[][] {
  if (cand === 'clipper-polygons') return clipperRings(region, first, step, count, false)
  if (cand.name.startsWith('clipper')) return clipperRings(region, first, step, count, true)
  const out: Loop[][] = []
  let cur = region
  for (let k = 0; k < count; k++) {
    cur = cand.offset(cur, k === 0 ? first : step)
    if (cur.length === 0) break
    out.push(cur)
  }
  return out
}

function ringTable(cands: Candidate[]): void {
  console.log(
    '\n## Pocket rings (tool r = 3, stepover 2.4, up to 20 rings; CavalierContours offsets the previous ring, Clipper the original by the cumulative distance)\n',
  )
  console.log(
    '| Fixture | Candidate | Rings | Loops total | Arcs/lines total | Max error over steps | Crossings |',
  )
  console.log('| --- | --- | --- | --- | --- | --- | --- |')
  const fixtures: [string, Loop[]][] = [
    ['pocket, 2 islands', offsetCases()[0]!.region],
    ['star 200 + 2 islands', star(200)],
  ]
  for (const [name, region] of fixtures)
    for (const cand of [...cands, 'clipper-polygons' as const]) {
      const cname = cand === 'clipper-polygons' ? 'clipper2-ts (polygons, no re-fit)' : cand.name
      const rs = attempt(() => rings(cand, region, 3, 2.4, 20))
      if (rs instanceof Error) {
        console.log(`| ${name} | ${cname} | throws: ${rs.message.slice(0, 50)} | | | | |`)
        continue
      }
      // ring k lies exactly 3 + 2.4·k from the original boundary (erosions compose)
      let err = 0
      rs.forEach((r, i) => {
        err = Math.max(err, maxOffsetError(region, r, 3 + 2.4 * i, 3))
      })
      const all = rs.flat()
      const k = countKinds(all)
      const x = rs.reduce((s, r) => s + crossings(r), 0)
      console.log(
        `| ${name} | ${cname} | ${rs.length} | ${all.length} | ${k.arcs}/${k.lines} | ${fmtErr(err)} | ${x} |`,
      )
    }
}

function median(f: () => unknown, runs: number, warm = 2): number {
  for (let i = 0; i < warm; i++) f()
  const t: number[] = []
  for (let i = 0; i < runs; i++) {
    const s = performance.now()
    f()
    t.push(performance.now() - s)
  }
  t.sort((a, b) => a - b)
  return t[t.length >> 1]!
}

function speedTable(cands: Candidate[]): void {
  console.log(
    '\n## Speed (median ms; Node, this machine). Fixture: filleted star of n segments + 2 islands\n',
  )
  console.log(
    '| n (outer) | Candidate | 1 offset | 20 successive offsets | segments after 20 | union with rotated copy |',
  )
  console.log('| --- | --- | --- | --- | --- | --- |')
  for (const n of [50, 200, 500, 2000]) {
    const region = star(n)
    const outer = region[0]!
    const rot = transform(outer, (p) => {
      const a = Math.PI / (2 * segCount(outer))
      return { x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) }
    })
    const all: (Candidate | 'clipper-polygons')[] = [...cands, 'clipper-polygons']
    for (const cand of all) {
      const name = cand === 'clipper-polygons' ? 'clipper2-ts (polygons, no re-fit)' : cand.name
      const off = cand === 'clipper-polygons' ? clipper(false) : cand
      const runs = n >= 2000 ? 5 : 11
      const time = (f: () => unknown, r: number, w?: number): string => {
        const t = attempt(() => median(f, r, w))
        return t instanceof Error ? `throws: ${t.message.slice(0, 40)}` : t.toFixed(2)
      }
      const t1 = time(() => off.offset(region, 3), runs)
      // successive offsets with step 2 stay within the star's 12 mm band → rings stop early; use 0.4
      let segs = 0
      const t20 = time(
        () => {
          const rs = rings(cand, region, 3, 0.4, 20)
          segs = rs.at(-1)?.reduce((s, l) => s + segCount(l), 0) ?? 0
        },
        Math.max(3, runs >> 1),
        1,
      )
      const tu = time(() => off.union(outer, rot), runs)
      console.log(`| ${segCount(outer)} | ${name} | ${t1} | ${t20} | ${segs || '–'} | ${tu} |`)
    }
  }
}

const cands = await loadCandidates()
console.log(
  `# Spike S1 results (${new Date().toISOString().slice(0, 10)}, Node ${process.version})`,
)
offsetTable(cands)
boolTable(cands)
ringTable(cands)
speedTable(cands)
