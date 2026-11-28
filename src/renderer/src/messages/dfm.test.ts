// DFM catalogue: every code has a sentence, values in the project unit system, suggestions
// rounded so they satisfy the check. Doc: docs/conventions/ui.md#warnings-and-dfm
import { describe, expect, it } from 'vitest'
import { DFM_WARNING_CODES, type DfmWarning } from '../../../core/geometry/model'
import { dfmMessages, lengthSource } from './dfm'

const w = (over: Partial<DfmWarning>): DfmWarning => ({
  code: 'dfm.cornerTooSmall',
  severity: 'warning',
  message: 'core text',
  operation: 'pocket1',
  parameter: 'shape.cornerRadius',
  params: { cornerRadius: 1, toolRadius: 3.175 },
  suggestion: { relation: 'atLeast', value: 3.175 },
  ...over,
})

/** Readable names of the fixture's ids, as the design inspector resolves them (DF43). */
const NAMES: Readonly<Record<string, string>> = {
  pocket1: 'Pocket 1',
  drill1: 'Drilling 1',
  'pocket1.floor': 'Pocket 1 floor',
}
const names = {
  item: (id: string) => NAMES[id] ?? 'Unknown operation',
  surface: (id: string) => NAMES[id] ?? 'Unknown operation surface',
}

describe('dfm messages', () => {
  it('renders every code in mm and inch, never the core fallback', () => {
    for (const code of DFM_WARNING_CODES) {
      const text = dfmMessages.text(w({ code }), 'inch', names)
      expect(text, code).not.toBe('core text')
      expect(text, code).toMatch(/^[A-Z]/)
    }
    expect(dfmMessages.text(w({}), 'mm', names)).toContain('3.18 mm')
    expect(dfmMessages.text(w({}), 'inch', names)).toContain('0.125"')
  })

  it('names operations and surfaces by their readable names, never their ids (DF43)', () => {
    const missing = dfmMessages.text(
      w({
        code: 'dfm.surfaceCutAway',
        parameter: 'on',
        params: { surface: 'pocket1.floor', by: ['drill1'] },
      }),
      'mm',
      names,
    )
    expect(missing).toBe(
      'It starts from or refers to Pocket 1 floor, which Drilling 1 cuts away. Its level still holds, so the cut is measured from a surface the part no longer has. Check the depth or start from another surface.',
    )
    const removed = dfmMessages.text(
      w({
        code: 'dfm.retainedRemoved',
        params: { by: 'drill1', regions: ['floorFillet', 'tab[1]'] },
      }),
      'mm',
      names,
    )
    expect(removed).toBe(
      'Drilling 1 cuts away the floor fillet and tab 2 of this operation. Move Drilling 1.',
    )
    for (const text of [missing, removed]) expect(text).not.toMatch(/pocket1|drill1|\[|floorFillet/)
  })

  it('says what remains of lowered tabs and which operation to change (D4)', () => {
    const tabs = (remains: number, units: 'mm' | 'inch' = 'mm') =>
      dfmMessages.text(
        w({
          code: 'dfm.retainedRemoved',
          params: { by: 'drill1', regions: ['tab[0]', 'tab[1]'], height: 3, remains },
        }),
        units,
        names,
      )
    expect(tabs(0.5)).toBe(
      'Drilling 1 lowers tab 1 and tab 2 of this operation from 3 mm to 0.5 mm. Make Drilling 1 shallower or move it off the tabs.',
    )
    expect(tabs(0.5, 'inch')).toContain('0.118"')
    expect(tabs(0)).toBe(
      'Drilling 1 cuts through tab 1 and tab 2 of this operation. Move Drilling 1 off the tabs.',
    )
  })

  it('suggests a value that satisfies the check, in the project units', () => {
    expect(dfmMessages.suggestionSource(w({}), 'mm')).toBe('3.18 mm') // ≥ 3.175, rounded up
    expect(
      dfmMessages.suggestionSource(
        w({ parameter: 'depth', suggestion: { relation: 'atMost', value: 12.349 } }),
        'mm',
      ),
    ).toBe('12.34 mm')
    expect(
      dfmMessages.suggestionSource(
        w({ parameter: 'tabs.count', suggestion: { relation: 'atLeast', value: 1 } }),
        'mm',
      ),
    ).toBe('1')
    expect(dfmMessages.suggestionSource(w({ parameter: 'shape' }), 'mm')).toBeUndefined()
    expect(dfmMessages.useValue('atLeast', '3.18 mm')).toBe('Use ≥ 3.18 mm')
    expect(dfmMessages.tier(w({ severity: 'info' }))).toBe('soft')
    expect(lengthSource(25.4, 'inch')).toBe('1"')
  })

  it('a chamfer through a thin floor names the cut under it (B4)', () => {
    const tooDeep = (params: DfmWarning['params']) =>
      dfmMessages.text(
        w({ code: 'dfm.chamferTooDeep', operation: 'chamfer1', parameter: 'width', params }),
        'mm',
        names,
      )
    expect(tooDeep({ depth: 2, edgeDepth: 1.5, edgeOf: 'pocket1', floor: 1 })).toBe(
      'The chamfer is 2 mm deep and cuts through the 1.5 mm floor above Pocket 1.',
    )
    expect(tooDeep({ depth: 2, edgeDepth: 1, edgeOf: 'drill1' })).toBe(
      'The chamfer is 2 mm deep, deeper than Drilling 1 (1 mm).',
    )
  })

  it('words the tool checks by their fit rule, in the project units (F5)', () => {
    const unfit = (params: DfmWarning['params']) =>
      w({
        code: 'dfm.toolUnfit',
        parameter: 'tool',
        params: { tool: '6 mm flat end mill', ...params },
      })
    const text = (params: DfmWarning['params'], units: 'mm' | 'inch' = 'mm') =>
      dfmMessages.text(unfit(params), units, names)
    expect(text({ rule: 'cornerRadius', cornerRadius: 2, toolRadius: 3, locked: false })).toBe(
      'Corner radius 2 mm is smaller than the radius of the 6 mm flat end mill (3 mm).',
    )
    expect(text({ rule: 'cornerRadius', cornerRadius: 2, toolRadius: 3, locked: true })).toMatch(
      /Unlock it or pick another tool\.$/,
    )
    expect(text({ rule: 'width', toolDiameter: 6, size: 5.08, feature: 'slot' }, 'inch')).toBe(
      'The 6 mm flat end mill is wider than the slot (0.2").',
    )
    expect(text({ rule: 'width', toolDiameter: 6, size: 4, feature: 'pocket' })).toContain(
      'pocket at its narrowest (4 mm)',
    )
    expect(text({ rule: 'floorRadius', floorRadius: 1, toolCornerRadius: 0 })).toContain(
      'needs a bull-nose end mill with corner radius 1 mm',
    )
    expect(text({ rule: 'floorRadius', floorRadius: 0, toolCornerRadius: 1 })).toContain(
      'leaves a 1 mm fillet',
    )
    expect(text({ rule: 'diameter', holeDiameter: 5, toolDiameter: 6 })).toBe(
      'The 6 mm flat end mill does not match the Ø 5 mm hole.',
    )
    expect(text({ rule: 'diameter', holeDiameter: 10, toolDiameter: 4, boring: true })).toContain(
      'between Ø 5 mm and Ø 10 mm',
    )
    expect(text({ rule: 'type', needs: 'endMill' })).toContain('a flat or bull-nose end mill')
    expect(text({ rule: 'type', needs: 'notDrill' })).toBe(
      'A drill cannot make a flat bottom: use a flat end mill.',
    )
    expect(text({ rule: 'reach', reach: 20, depth: 25 })).toBe(
      'The 6 mm flat end mill reaches 20 mm; the operation is 25 mm deep.',
    )
    // DF89: the flutes, with and without a known shank
    expect(
      text({ rule: 'flutes', fluteLength: 20, depth: 28.169, margin: 0.5, shankDiameter: 6.35 }),
    ).toBe(
      'The 6 mm flat end mill has 20 mm flutes; the walls are 28.17 mm deep (0.5 mm kept spare) and its shank (Ø 6.35 mm) is not narrower than the cutter, so the shank would rub the wall. Use a tool with longer flutes.',
    )
    expect(text({ rule: 'flutes', fluteLength: 20, depth: 28.169, margin: 0.5 })).toContain(
      'its shank Ø is not in the library',
    )
    expect(
      dfmMessages.text(
        w({
          code: 'dfm.reach',
          parameter: 'depth',
          params: { depth: 28.169, reach: 52, fluteLength: 25, margin: 0.5 },
        }),
        'mm',
        names,
      ),
    ).toBe(
      'No tool in the library cuts walls 28.17 mm deep with its flutes (longest flute length 25 mm, 0.5 mm kept spare). Below the flutes the shank rubs the wall: add a tool with longer flutes or a reduced shank.',
    )
    // chamfer rules (DF142: they fell back to "does not fit")
    expect(text({ rule: 'angle', toolAngle: 60, angle: 90 })).toBe(
      'The 6 mm flat end mill is 60°; the chamfer is 90°.',
    )
    expect(text({ rule: 'shank', shankDiameter: 8, toolDiameter: 6.35 })).toBe(
      'The 6 mm flat end mill is too small to cut the chamfer in one pass, and its shank (Ø 8 mm) is wider than its cone (Ø 6.35 mm): in levels the shank would rub the bevel.',
    )
    expect(text({ rule: 'bore', edgeDiameter: 6.4, diameter: 13.84 })).toContain(
      "needs the hole's core removed first",
    )
    // values missing (unknown rule): still a sentence naming the tool
    expect(text({ rule: 'other' })).toBe('The 6 mm flat end mill does not fit.')
    // DF142: dfm.chamferNoTool names the reason
    const noTool = (params: DfmWarning['params']) =>
      dfmMessages.text(w({ code: 'dfm.chamferNoTool', parameter: 'angle', params }), 'mm', names)
    const m6 = { angle: 90, edgeDiameter: 6.4, diameter: 13.84 }
    expect(noTool({ ...m6, reason: 'angle' })).toBe(
      'The library has no 90° chamfer mill that cuts Ø6.4 mm to Ø13.84 mm.',
    )
    expect(noTool({ ...m6, reason: 'shank' })).toContain('their shank is wider than their cone')
    expect(noTool({ ...m6, reason: 'bore' })).toContain(
      'Make the hole a drilling or a circle pocket',
    )
    expect(
      dfmMessages.text(
        w({
          code: 'dfm.toolNotInLibrary',
          parameter: 'tool',
          params: { tool: '1/4" flat end mill' },
        }),
        'inch',
        names,
      ),
    ).toBe('Plan needs a 1/4" flat end mill: add one to the library.')
    // a tool check's suggestion is the size the operation needs, never a value of the tool field
    expect(dfmMessages.suggestionSource(unfit({ rule: 'cornerRadius' }), 'mm')).toBeUndefined()
  })

  it('renders split findings by rule in the project units (split parts 4a)', () => {
    const split = (params: DfmWarning['params']): DfmWarning => {
      const { suggestion: _, ...rest } = w({ code: 'design.split', operation: 'split1', params })
      return rest
    }
    expect(
      dfmMessages.text(
        split({ rule: 'thinJoint', axis: 'x', at: 25.4, width: 5.08, limit: 10 }),
        'inch',
        names,
      ),
    ).toBe(
      'The glue face at the line at X 1" is 0.2" wide at its narrowest, less than 0.394": a weak butt joint. Move the split.',
    )
    expect(
      dfmMessages.text(
        split({ rule: 'cutsFeature', operationId: 'drill1', reason: 'line' }),
        'mm',
        names,
      ),
    ).toMatch(/^Drilling 1: A split line crosses it/)
    expect(
      dfmMessages.text(
        split({ rule: 'noStock', piece: 2, blank: [130, 98.5, 40], nearest: 'Board', short: 3 }),
        'mm',
        names,
      ),
    ).toBe(
      'Piece 2: its blank 130 mm × 98.5 mm × 40 mm fits no library stock; Board is 3 mm short. It uses its own blank.',
    )
  })

  it('words the joint findings (keys, dowels, a doweled or key-neck thin joint), never the fallback (design review U9)', () => {
    const split = (params: DfmWarning['params']): DfmWarning => {
      const { suggestion: _, ...rest } = w({ code: 'design.split', operation: 'split1', params })
      return rest
    }
    const text = (params: DfmWarning['params']) => dfmMessages.text(split(params), 'mm', names)
    expect(
      text({
        rule: 'keyFit',
        reason: 'near',
        axis: 'x',
        at: 125,
        run: [11.5, 100],
        pieces: [1, 2],
        tool: 6,
      }),
    ).toBe(
      'No key on the line at X 125 mm between pieces 1 and 2 at Y 11.5 mm–100 mm: a feature or the part edge is within one tool Ø (6 mm) of every place.',
    )
    expect(
      text({
        rule: 'keyFit',
        reason: 'short',
        axis: 'y',
        at: 50,
        run: [0, 12],
        pieces: [3, 4],
        tool: 6,
      }),
    ).toBe(
      'The run of 12 mm on the line at Y 50 mm between pieces 3 and 4 is too short for a key: a butt joint there.',
    )
    expect(text({ rule: 'dowelFit', reason: 'count', level: 0, count: 1, pieces: [1, 2] })).toBe(
      'The glue face at level 1 between pieces 1 and 2 has 1 dowel: 2 or more keep the pieces from turning.',
    )
    expect(text({ rule: 'dowelNear', hole: 2, level: 0, wall: 0.8, limit: 1.5 })).toBe(
      'Dowel hole 2 leaves 0.8 mm of wall, less than 1.5 mm, to an edge or a feature. Move the hole.',
    )
    expect(text({ rule: 'thinJoint', level: -40, width: 6.99, limit: 10, dowel: 6 })).toBe(
      'The glue face at the level at Z -40 mm is 6.99 mm wide at its narrowest, less than 10 mm: Ø6 mm dowels fit only where it is wider.',
    )
    expect(
      text({ rule: 'thinJoint', axis: 'x', at: 125, width: 4, limit: 18, what: 'keyNeck' }),
    ).toMatch(/^The key neck on the line at X 125 mm is 4 mm wide, less than 18 mm/)
    for (const rule of ['keyFit', 'dowelFit', 'dowelNear'])
      expect(text({ rule })).not.toBe('A split finding on this part.')
  })

  it('words the finger and half-lap findings (split parts 4d)', () => {
    const split = (params: DfmWarning['params']): DfmWarning => {
      const { suggestion: _, ...rest } = w({ code: 'design.split', operation: 'split1', params })
      return rest
    }
    const text = (params: DfmWarning['params']) => dfmMessages.text(split(params), 'mm', names)
    const base = { rule: 'keyFit', axis: 'x', at: 125, run: [0, 100], pieces: [1, 2], tool: 6 }
    expect(text({ ...base, reason: 'near', joint: 'halfLap', lap: 18 })).toBe(
      'No half lap on the line at X 125 mm between pieces 1 and 2: a feature or the part edge lies within the 18 mm lap or one tool Ø (6 mm) of it. A butt joint there; move the split or the feature.',
    )
    expect(text({ ...base, reason: 'near', joint: 'finger' })).toBe(
      'No fingers on the line at X 125 mm between pieces 1 and 2 at Y 0 mm–100 mm: a feature or the part edge is within one tool Ø (6 mm) of a finger. A butt joint there; move the split or the feature.',
    )
    expect(text({ ...base, reason: 'short', joint: 'finger', run: [0, 12] })).toBe(
      'The run of 12 mm on the line at X 125 mm between pieces 1 and 2 is too short for fingers: a butt joint there.',
    )
    expect(
      text({ rule: 'thinJoint', axis: 'x', at: 125, width: 8, limit: 18, what: 'fingerWidth' }),
    ).toMatch(/^The fingers on the line at X 125 mm are 8 mm wide, less than 18 mm/)
  })
})
