// Fit table of the operation tool field and the DFM rules against the operation's own tool.
// Doc: docs/modes/design-v0.2.md#fit-when-a-tool-can-make-the-operation, #dfm-with-the-tool
import { describe, expect, it } from 'vitest'
import {
  parameterChecks,
  type DfmTool,
  type OperationTool,
  type ParameterCheckOptions,
} from './dfm'
import type { DfmWarning, OperationGeometry } from './model'
import { TEST_STOCK } from './testing/test-part'
import { chamferFit, coneSlant, toolFit } from './tool-fit'

type Op<K extends OperationGeometry['kind']> = Extract<OperationGeometry, { kind: K }>

const rect = (length: number, width: number, cornerRadius: number) => ({
  center: [50, 30] as const,
  contour: { kind: 'rectangle' as const, length, width, cornerRadius },
})
const pocket = (over: Partial<Op<'pocket'>> = {}): Op<'pocket'> => ({
  kind: 'pocket',
  id: 'pocket1',
  onZ: 0,
  shape: rect(40, 25, 4),
  depth: 8,
  floorRadius: 0,
  ...over,
})
const drill = (over: Partial<Op<'drilling'>> = {}): Op<'drilling'> => ({
  kind: 'drilling',
  id: 'drill1',
  onZ: 0,
  center: [20, 20],
  diameter: 6,
  bottom: { kind: 'through' },
  ...over,
})
const profile = (over: Partial<Op<'profile'>> = {}): Op<'profile'> => ({
  kind: 'profile',
  id: 'profile1',
  shape: rect(84, 44, 5),
  side: 'outside',
  slotWidth: 6,
  tabs: { count: 4, width: 8, thickness: 3 },
  ...over,
})
const flat = (diameter: number, reach?: number): DfmTool => ({
  type: 'flatEndMill',
  diameter,
  ...(reach !== undefined && { reach }),
})
const rule = (tool: DfmTool, op: OperationGeometry) =>
  toolFit(tool, op, TEST_STOCK, 'metric')?.rule ?? 'fits'

describe('toolFit: the fit table', () => {
  it('facing: a flat end mill only', () => {
    const f: OperationGeometry = { kind: 'facing', id: 'facing1', depth: 0.5 }
    expect(rule(flat(12), f)).toBe('fits')
    expect(rule({ type: 'ballEndMill', diameter: 6 }, f)).toBe('type')
  })

  it('pocket: end mill type, width, corner radius, floor radius', () => {
    expect(rule(flat(8), pocket())).toBe('fits')
    expect(rule({ type: 'drill', diameter: 6 }, pocket())).toBe('type')
    expect(rule(flat(30), pocket())).toBe('width')
    // radius 5 > cornerRadius 4
    expect(toolFit(flat(10), pocket(), TEST_STOCK, 'metric')).toMatchObject({
      rule: 'cornerRadius',
      need: { relation: 'atLeast', value: 5 },
    })
    expect(rule(flat(8), pocket({ floorRadius: 1 }))).toBe('floorRadius')
    const bull = { type: 'bullNoseEndMill', diameter: 6, cornerRadius: 1 } as const
    expect(rule(bull, pocket({ floorRadius: 1 }))).toBe('fits')
    expect(rule(bull, pocket({ floorRadius: 1.5 }))).toBe('floorRadius')
    // a bull nose leaves a fillet a sharp floor does not want
    expect(rule(bull, pocket())).toBe('floorRadius')
    // circle: the diameter is the narrowest size
    const circle = pocket({ shape: { center: [50, 30], contour: { kind: 'circle', radius: 5 } } })
    expect(rule(flat(10), circle)).toBe('fits')
    expect(rule(flat(10.5), circle)).toBe('width')
  })

  it('drilling: a drill of the diameter, or helical boring with a flat end mill', () => {
    const d = (diameter: number): DfmTool => ({ type: 'drill', diameter })
    expect(rule(d(6), drill())).toBe('fits')
    expect(rule(d(6.005), drill())).toBe('fits')
    expect(rule(d(5), drill())).toBe('diameter')
    expect(rule(d(6), drill({ bottom: { kind: 'flat', depth: 5 } }))).toBe('type')
    expect(rule(flat(4), drill())).toBe('fits')
    expect(rule(flat(4), drill({ bottom: { kind: 'flat', depth: 5 } }))).toBe('fits')
    expect(rule(flat(3), drill())).toBe('diameter')
    expect(rule(flat(6), drill())).toBe('diameter')
    const point = drill({ bottom: { kind: 'drillPoint', depth: 5, pointAngle: 118 } })
    expect(rule(flat(4), point)).toBe('type')
    expect(rule({ type: 'ballEndMill', diameter: 4 }, drill())).toBe('type')
  })

  it('profile: a flat end mill no wider than the slot; inside corners', () => {
    expect(rule(flat(6), profile())).toBe('fits')
    expect(rule(flat(8), profile())).toBe('width')
    expect(rule({ type: 'bullNoseEndMill', diameter: 6, cornerRadius: 1 }, profile())).toBe('type')
    expect(rule(flat(6), profile({ side: 'inside', shape: rect(40, 20, 2) }))).toBe('cornerRadius')
  })

  it('reach: specific tools only; profile adds the default breakthrough', () => {
    // pocket 8 deep below a floor 2 down: 10
    expect(rule(flat(8, 10), pocket({ onZ: -2 }))).toBe('fits')
    expect(rule(flat(8, 9.9), pocket({ onZ: -2 }))).toBe('reach')
    expect(rule(flat(8), pocket({ depth: 100 }))).toBe('fits')
    // through hole: the stock thickness (20)
    expect(rule({ type: 'drill', diameter: 6, reach: 19 }, drill())).toBe('reach')
    // profile: 20 + 0.5 breakthrough
    expect(rule(flat(6, 20.4), profile())).toBe('reach')
    expect(rule(flat(6, 20.5), profile())).toBe('fits')
    expect(toolFit(flat(6, 20.5), profile(), TEST_STOCK, 'inch')?.rule).toBe('reach')
    // a blind `on` groove (v0.3): its depth, no breakthrough
    const groove = profile({ side: 'on', depth: 3 })
    expect(rule(flat(6, 3), groove)).toBe('fits')
    expect(rule(flat(6, 2.9), groove)).toBe('reach')
  })
})

const own = (tool: DfmTool, extra: Partial<OperationTool> = {}): OperationTool => ({
  tool,
  generalized: tool.reach === undefined,
  locked: false,
  label: `${tool.diameter} mm ${tool.type}`,
  ...extra,
})
const checks = (
  ops: OperationGeometry[],
  operationTools: Record<string, OperationTool>,
  tools: readonly DfmTool[] = [],
): DfmWarning[] => {
  const options: ParameterCheckOptions = { tools, unitSystem: 'metric', operationTools }
  return parameterChecks({ stock: TEST_STOCK, operations: ops }, options)
}
const find = (ws: DfmWarning[], code: string) => ws.filter((w) => w.code === code)

describe('DFM with the operation tool', () => {
  it('dfm.toolUnfit: warning at the tool field with the failed rule and the lock state', () => {
    const ws = checks([pocket({ shape: rect(40, 25, 2) })], {
      pocket1: own(flat(6, 30), { locked: true, label: '6 mm end mill' }),
    })
    const [w] = find(ws, 'dfm.toolUnfit')
    expect(w).toMatchObject({
      severity: 'warning',
      parameter: 'tool',
      params: { rule: 'cornerRadius', locked: true, tool: '6 mm end mill' },
      suggestion: { relation: 'atLeast', value: 3 },
    })
    expect(w!.message).toContain('the 6 mm end mill does not fit: cornerRadius 2 mm < tool radius')
    expect(w!.message).toContain('unlock or pick another tool')
    // fits: nothing
    expect(find(checks([pocket()], { pocket1: own(flat(6, 30)) }), 'dfm.toolUnfit')).toEqual([])
    // no tool yet: no own-tool rules
    expect(find(checks([pocket({ shape: rect(40, 25, 2) })], {}), 'dfm.toolUnfit')).toEqual([])
  })

  it('dfm.toolNotInLibrary: info for a generalized tool the library lacks; empty library once per tool', () => {
    const g = own(flat(6))
    const ops = [pocket(), pocket({ id: 'pocket2' })]
    const empty = find(checks(ops, { pocket1: g, pocket2: g }), 'dfm.toolNotInLibrary')
    expect(empty).toHaveLength(1)
    expect(empty[0]).toMatchObject({ severity: 'info', operation: 'pocket1', parameter: 'tool' })
    const other = [flat(3, 10)]
    expect(
      find(checks(ops, { pocket1: g, pocket2: g }, other), 'dfm.toolNotInLibrary'),
    ).toHaveLength(2)
    // a matching library tool (within 0.01 mm) silences it; specific tools never raise it
    expect(find(checks(ops, { pocket1: g }, [flat(6.005, 10)]), 'dfm.toolNotInLibrary')).toEqual([])
    expect(find(checks(ops, { pocket1: own(flat(6, 30)) }), 'dfm.toolNotInLibrary')).toEqual([])
    // a bull nose matches by RE too
    const bull = own({ type: 'bullNoseEndMill', diameter: 6, cornerRadius: 1 })
    const lib = [{ type: 'bullNoseEndMill', diameter: 6, cornerRadius: 0.5, reach: 20 } as const]
    expect(
      find(checks([pocket({ floorRadius: 1 })], { pocket1: bull }, lib), 'dfm.toolNotInLibrary'),
    ).toHaveLength(1)
  })

  it('dfm.reach uses the operation tool: a specific tool its own reach, a generalized one the matching library tools', () => {
    const deep = pocket({ depth: 25, shape: rect(40, 25, 5) })
    const library = [flat(6, 40), flat(10, 15)]
    // without a tool: the library's longest matching reach (40) suffices
    expect(find(checks([deep], {}, library), 'dfm.reach')).toEqual([])
    // the specific 10 mm reaches 15 only
    const [w] = find(checks([deep], { pocket1: own(flat(10, 15)) }, library), 'dfm.reach')
    expect(w).toMatchObject({ params: { depth: 25, reach: 15 } })
    expect(w!.message).toContain('does not reach')
    // generalized 10 mm: matching library tools are the 10 mm one (15)
    expect(find(checks([deep], { pocket1: own(flat(10)) }, library), 'dfm.reach')).toHaveLength(1)
    // generalized 6 mm: the 6 mm one reaches 40
    expect(find(checks([deep], { pocket1: own(flat(6)) }, library), 'dfm.reach')).toEqual([])
    // generalized with no matching library tool: skipped
    expect(find(checks([deep], { pocket1: own(flat(8)) }, library), 'dfm.reach')).toEqual([])
  })
})

// Doc: docs/modes/design-v0.4.md#chamfer-operation-v04-circular-edges (Fit), task C1
describe('chamferFit (chamfer mill fit row)', () => {
  const vbit = (over: Partial<DfmTool> = {}): DfmTool => ({
    type: 'chamferMill',
    diameter: 12,
    angle: 90,
    tipDiameter: 0,
    ...over,
  })
  const m3 = { edgeDiameter: 3.4, diameter: 6.4, angle: 90 }

  it('fits a chamfer mill of the same angle that covers the chamfer (plunged)', () => {
    expect(chamferFit(vbit(), m3)).toBeUndefined()
    expect(chamferFit(vbit({ angle: 90.4 }), m3)).toBeUndefined()
  })

  it('needs a chamfer mill, of the chamfer angle within 0.5°', () => {
    expect(chamferFit({ type: 'flatEndMill', diameter: 6 }, m3)?.rule).toBe('type')
    expect(chamferFit({ type: 'drill', diameter: 6 }, m3)?.rule).toBe('type')
    const wrong = chamferFit(vbit({ angle: 82 }), m3)
    expect(wrong?.rule).toBe('angle')
    expect(wrong?.values).toEqual({ toolAngle: 82, angle: 90 })
  })

  it('needs a tip smaller than the edge', () => {
    const tip = chamferFit(vbit({ tipDiameter: 3.4 }), m3)
    expect(tip?.rule).toBe('tip')
    expect(tip?.need).toEqual({ relation: 'atLeast', value: 3.4 })
    expect(chamferFit(vbit({ tipDiameter: 1 }), m3)).toBeUndefined()
  })

  it('a smaller tool fits when its cutting edge covers the slant (contoured)', () => {
    // chamfer slant (6.4 − 3.4)/2/sin 45° = 2.12 mm; a Ø6 pointed V-bit has 4.24 mm of edge
    expect(coneSlant(3.4, 6.4, 90)).toBeCloseTo(2.1213, 4)
    expect(chamferFit(vbit({ diameter: 6 }), m3)).toBeUndefined()
    // a Ø4 bit with a 2 mm tip has 1.41 mm of edge
    const short = chamferFit(vbit({ diameter: 4, tipDiameter: 2 }), m3)
    expect(short?.rule).toBe('slant')
    expect(short?.values['cuttingEdge']).toBeCloseTo(1.4142, 4)
  })

  it('toolFit checks reach: plunged to where the tool cone has the chamfer Ø, contoured to the chamfer depth', () => {
    const op: Op<'chamfer'> = {
      kind: 'chamfer',
      id: 'chamfer1',
      onZ: -2,
      center: [20, 20],
      edgeOf: 'drill1',
      edgeDiameter: 3.4,
      diameter: 6.4,
      angle: 90,
    }
    // plunged (DC 12 ≥ 6.4), pointed: the tip sits 3.2 mm under the face, 5.2 below the top
    expect(toolFit(vbit({ reach: 5.2 }), op, TEST_STOCK, 'metric')).toBeUndefined()
    expect(toolFit(vbit({ reach: 5 }), op, TEST_STOCK, 'metric')?.rule).toBe('reach')
    // contoured (Ø6, pointed): the cone's bottom, 1.5 mm under the face, 3.5 below the top
    expect(toolFit(vbit({ diameter: 6, reach: 3.5 }), op, TEST_STOCK, 'metric')).toBeUndefined()
    expect(toolFit(vbit({ diameter: 6, reach: 3.4 }), op, TEST_STOCK, 'metric')?.rule).toBe('reach')
  })

  it('a chamfer mill fits no other operation (the type row)', () => {
    expect(toolFit(vbit(), pocket(), TEST_STOCK, 'metric')?.rule).toBe('type')
    expect(toolFit(vbit(), drill(), TEST_STOCK, 'metric')?.rule).toBe('type')
  })
})
