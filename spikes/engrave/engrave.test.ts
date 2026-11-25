// Spike E0 (throwaway): coloured SVG strokes → lines with per-segment depth → one variable-depth
// gCode program with ramped entries. Report: docs/research/2026-11-25-engraved-patterns-and-lines.md#spike-e0
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../src/shared/testing/result'
import { importSvg } from '../../src/core/import/svg'
import { parseXml } from '../../src/core/import/svg/xml'
import { postGrbl } from '../../src/core/post/grbl/post'
import type { Block, MachiningProgram } from '../../src/core/post/program'
import { createAppScopeRegistry, createProjectRegistry } from '../../src/core/commands/registry'
import { SESSION_TOOLS } from '../../src/core/agent/session'
import { buildAgentTools, mcpToolList } from '../../src/core/agent/tools'
import {
  cutOpenLine,
  evalPL,
  LinePath,
  linesFromImport,
  profileOf,
  strokesById,
  type LineCut,
} from './line'

const here = 'spikes/engrave'

describe('spike E0: engraved lines', () => {
  it('maps coloured strokes to per-segment depth and posts a ramped variable-depth line', () => {
    const text = readFileSync(join(here, 'sample.svg'), 'utf8')
    const imp = expectOk(importSvg(text, { split: 'element' }))
    const root = expectOk(parseXml(text, 256))
    const strokes = strokesById(root)
    const { lines, unlevelled } = linesFromImport(imp.shapes, strokes)
    console.log('import report', {
      shapes: imp.shapes.length,
      openPaths: imp.report.openPaths,
      loops: imp.report.loops,
      lines: imp.report.lines,
      arcs: imp.report.arcs,
      beziersFitted: imp.report.beziersFitted,
      maxDeviation: imp.report.maxDeviation,
      unit: imp.report.unit,
    })
    expect(unlevelled).toEqual([])
    const MIN = 0.2
    const MAX = 1.5
    for (const l of lines) {
      const prof = profileOf(l, MIN, MAX, 1)
      console.log(
        `line ${[...new Set(l.pieces.map((p) => p.source))].join('+')} closed=${l.closed}`,
        `pieces=${l.pieces.length}`,
        `levels=${l.pieces.map((p) => `${p.l0.toFixed(3)}→${p.l1.toFixed(3)}`).join(' ')}`,
        `depth ${(-Math.max(...prof.z)).toFixed(3)}..${(-Math.min(...prof.z)).toFixed(3)} mm`,
      )
    }
    // the chained, three-colour line
    const chain = lines.find((l) => l.pieces.some((p) => p.source === '#seg2'))!
    expect(new Set(chain.pieces.map((p) => p.source)).size).toBe(3)
    const prof = profileOf(chain, MIN, MAX, 1)
    const path = new LinePath(chain)
    // levels: #000 → 1, #808080 → 0.498, rgb(192,192,192) → 0.247
    expect(evalPL(prof, 5)).toBeCloseTo(-1.5, 6)
    expect(evalPL(prof, path.length - 5)).toBeCloseTo(-(MIN + 0.24706 * (MAX - MIN)), 3)
    const cut: LineCut = {
      stepdown: 0.8,
      rampAngle: 10,
      feed: 1200,
      plunge: 300,
      retract: 1,
      clearance: 10,
    }
    const moves: Block[] = []
    const rep = cutOpenLine(path, prof, cut, moves)
    const program: MachiningProgram = {
      name: 'Spike E0 variable-depth line',
      setupName: 'Setup 1',
      units: 'mm',
      spindleControl: 'gcode',
      clearanceZ: 10,
      blocks: [
        {
          kind: 'toolChange',
          number: 1,
          tool: { name: '60° V-bit', diameter: 6.35, type: 'chamferMill' },
        },
        { kind: 'spindle', rpm: 18000 },
        ...moves,
      ],
    }
    const g = expectOk(postGrbl(program, { generator: 'DFYOM spike E0' }))
    writeFileSync(join(here, 'variable-depth-line.nc'), g)
    // stats
    let cutLen = 0
    let pos: [number, number, number] = [0, 0, 10]
    let minZ = 0
    for (const b of moves) {
      if (b.kind === 'feed' || b.kind === 'arc') {
        const d =
          b.kind === 'feed'
            ? Math.hypot(b.to[0] - pos[0], b.to[1] - pos[1], b.to[2] - pos[2])
            : arcLen(pos, b)
        cutLen += d
        minZ = Math.min(minZ, b.to[2])
      }
      if (b.kind === 'feed' || b.kind === 'arc' || b.kind === 'rapid') pos = [...b.to]
    }
    const gl = g.trim().split('\n')
    console.log('program', {
      lineLength: path.length.toFixed(2),
      passes: rep.passes,
      rampLengths: rep.rampLengths.map((x) => x.toFixed(2)),
      minZ: minZ.toFixed(3),
      cutLength: cutLen.toFixed(1),
      feedMinutes: (cutLen / cut.feed).toFixed(2),
      gcodeLines: gl.length,
      g1: gl.filter((l) => /^G1|^X|^Y|^Z/.test(l) && !l.startsWith('G0')).length,
      g2g3: gl.filter((l) => /^G[23]\b/.test(l)).length,
      widthAtMax60: (2 * MAX * Math.tan(Math.PI / 6)).toFixed(3),
    })
    expect(minZ).toBeCloseTo(-1.5, 6)
    expect(rep.passes).toBe(2)
  })

  it('every preset SVG imports and levels cleanly', () => {
    const dir = 'src/core/design/engraving/presets'
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith('.svg'))
      .sort()) {
      const text = readFileSync(join(dir, f), 'utf8')
      const imp = expectOk(importSvg(text, { split: 'element' }))
      const strokes = strokesById(expectOk(parseXml(text, 256)))
      const { lines, unlevelled } = linesFromImport(imp.shapes, strokes)
      const levels = new Set(lines.flatMap((l) => l.pieces.map((p) => p.l0.toFixed(2))))
      const len = lines.reduce((s, l) => s + new LinePath(l).length, 0)
      console.log(
        f.padEnd(28),
        `size ${imp.report.size?.width}×${imp.report.size?.height}`,
        `lines ${lines.length}`.padEnd(10),
        `length ${len.toFixed(0)} mm`.padEnd(14),
        `levels ${[...levels].sort().join(',')}`,
        imp.report.warnings.length
          ? `warnings ${imp.report.warnings.map((w) => w.rule).join(',')}`
          : '',
      )
      expect(unlevelled).toEqual([])
      expect(lines.length).toBeGreaterThan(0)
    }
  })

  it('measures tools/list today', () => {
    const tools = expectOk(
      buildAgentTools(
        { app: expectOk(createAppScopeRegistry()), project: expectOk(createProjectRegistry()) },
        SESSION_TOOLS,
      ),
    )
    const size = JSON.stringify({ tools: mcpToolList(tools) }).length
    const by = (prefix: string) =>
      mcpToolList(tools)
        .filter((t) => t.name.startsWith(prefix))
        .map((t) => [t.name, JSON.stringify(t).length] as const)
    console.log('tools/list chars', size, 'tools', tools.length)
    console.log(by('design_pattern'), by('design_profile'), by('design_chamfer'))
  })
})

function arcLen(p: readonly number[], b: Extract<Block, { kind: 'arc' }>): number {
  const cx = p[0]! + b.i
  const cy = p[1]! + b.j
  const r = Math.hypot(b.i, b.j)
  const a0 = Math.atan2(p[1]! - cy, p[0]! - cx)
  const a1 = Math.atan2(b.to[1] - cy, b.to[0] - cx)
  let sw = a1 - a0
  if (b.cw) while (sw >= 0) sw -= 2 * Math.PI
  else while (sw <= 0) sw += 2 * Math.PI
  return Math.hypot(Math.abs(sw) * r, b.to[2] - p[2]!)
}
