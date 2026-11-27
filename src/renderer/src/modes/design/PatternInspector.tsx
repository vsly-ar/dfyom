// The pattern inspector (patterns P1, P2): name, the read-out (cells · web · slivers dropped)
// and Presets, then the groups Cell (kind with thumbnails, its sizes, rotation), Layout (lattice
// incl. Polar, gap or pitch, angle, origin: empty = the area's centre), Area (On, the boundary:
// Whole face or a closed shape with its centre and rotation, margin, Whole/Clip, Invert), Cut
// (P4: Through, else depth; the pocket's tool), Roughing (DF108; DF122 R2: the accordion shared
// with the Pocket inspector, RoughingGroup.tsx: switch, roughing tool, margins), Chamfer (P3: a
// switch, then width, angle and the chamfer's tool). P4: on another pattern's floor the
// Boundary's face option names its cells. DF107: Presets… opens the Presets dialog.
// Every edit is one `design.pattern.update` (one undo step); errors
// and findings show at their field, the rest under Findings. DF110 S4: rarely used fields (cell
// Rotation; Origin U/V and Flip; Boundary cells and Invert) sit behind their group's More
// row, shown open while one holds a non-default value or a problem; Chamfer is an accordion,
// closed unless on.
// Doc: docs/modes/patterns.md#ui, docs/conventions/ui.md#pattern-inspector-p1,
// docs/modes/patterns.md#implementation-p4, docs/modes/patterns.md#implementation-df107df109,
// docs/conventions/inspector-layout.md#s4-implementation-notes, docs/modes/roughing.md#implementation-r2
// H1 (docs/modes/pattern-presets.md#implementation-h1): Margin's "Per side" splits it into Across
// and Along (`margin: [u, v]`); straight fins read out as a heatsink; the Presets dialog's
// heatsink step applies the fields and the slot tool as one gesture. H2: pin fins read out as pins
// ("49 pins 3 mm · 8 mm high (1:2.7) · base 6 mm"); the dialog's current heatsink card starts its
// step from the pattern's sizes. H3: the Radial lattice (Count and Radius in place of the spacing);
// radial fins read out as "21 slots 2 mm · fins 1.59 mm at the hub · 8 mm high (1:5) · base 4 mm".
import { useMemo, useState } from 'react'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import {
  pinsReadout,
  radialReadout,
  straightFinsReadout,
  type FinsFields,
  type FinsReadout,
  type PinsReadout,
  type RadialReadout,
} from '../../../../core/design/pattern/heatsink'
import type { PatternFacts } from '../../../../core/design/pattern/layout'
import { patternFacts } from '../../../../core/design/pattern/pattern'
import { chainBounds } from '../../../../core/geometry/2d/model'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { dfmMessages, lengthSource } from '../../messages/dfm'
import { useCancelGesture } from '../../shell/hooks'
import { useRegion2d, useShell } from '../../shell/ShellContext'
import {
  Button,
  ErrorMessage,
  Field,
  InspectorGroup,
  newGestureId,
  PanelHeader,
  QuantityInput,
  SegmentedControl,
  Select,
  Switch,
  WarningList,
  type FieldMessage,
  type GroupSeverity,
  type StepKind,
} from '../../ui'
import { warningLabels, warningView } from './DesignInspector'
import styles from './Design.module.css'
import { operationUnits, warningFeatureField } from './feature-view'
import { NameField } from './NameField'
import { placeErrors, refusalText, type FieldError } from './OperationFields'
import { MiniOutline, shapeLoops } from './ShapePicker'
import {
  PatternPresetsDialog,
  PIN_CARD,
  PRESET_GROUP_KEY,
  type CurrentHeatsink,
  useFlatEndMills,
  type Group,
} from './PatternPresetsDialog'
import { adjustedNote, RoundField } from './RoundField'
import { ToolField } from './ToolField'
import { RoughingGroup } from './RoughingGroup'
import { patternRoughing } from './roughing-view'
import { defaultUnit, dfmNames, onChoices, quantityOf, type DesignPart } from './model'
import { useCommand, useDesignSelection, type DesignWarnings } from './useDesign'

const m = designMessages
const t = m.inspector
const p = m.features.pattern

type CellKind = 'circle' | 'rectangle' | 'obround' | 'polygon' | 'shape'
type Lattice = 'square' | 'staggered' | 'hex' | 'polar' | 'radial'
const CELL_KINDS: readonly CellKind[] = ['circle', 'rectangle', 'obround', 'polygon', 'shape']
const LATTICES: readonly Lattice[] = ['square', 'staggered', 'hex', 'polar', 'radial']
/** The Boundary select's value for the whole face. */
const FACE = 'face'
/** The size fields of each primitive cell, in order. */
type CellField = 'diameter' | 'length' | 'width' | 'cornerRadius' | 'sides'
const CELL_FIELDS: Record<CellKind, readonly CellField[]> = {
  circle: ['diameter'],
  rectangle: ['length', 'width', 'cornerRadius'],
  obround: ['length', 'width'],
  polygon: ['sides', 'diameter', 'cornerRadius'],
  shape: [],
}
/** A new cell kind's starting sizes (mm, as entered; the core parses units). */
const CELL_START: Record<Exclude<CellKind, 'shape'>, Record<string, string>> = {
  circle: { diameter: '8 mm' },
  rectangle: { length: '10 mm', width: '6 mm', cornerRadius: '1 mm' },
  obround: { length: '12 mm', width: '5 mm' },
  polygon: { sides: '6', diameter: '8 mm', across: 'flats', cornerRadius: '0.5 mm' },
}

type CellRecord = { kind: CellKind; shapeId?: string; across?: string } & Record<string, unknown>

const sourceOf = (q: unknown): string | undefined =>
  (q as QuantityDTO | undefined)?.source ?? undefined

/** A stored quantity's exact value (mm, °). */
const exactOf = (q: unknown): number | undefined => {
  const e = (q as QuantityDTO | undefined)?.exact
  return e === undefined ? undefined : Number(e.num) / Number(e.den)
}

/**
 * The pattern's fields as the heatsink read-outs read them (H1 straight fins, H2 pins); undefined:
 * not a heatsink.
 */
function finsFields(
  feature: FeatureDTO,
  facts: PatternFacts,
  thickness: number | undefined,
): FinsFields | undefined {
  const c = feature['cell'] as CellRecord
  const b = chainBounds(facts.area.pieces.flatMap((x) => x.outer.elements))
  if (b === undefined) return undefined
  const m = feature['margin'] as QuantityDTO | [QuantityDTO, QuantityDTO] | undefined
  const [mu, mv] = Array.isArray(m) ? m.map(exactOf) : [exactOf(m), exactOf(m)]
  const depth = exactOf(feature['depth'])
  const radial = feature['lattice'] === 'radial'
  // a Round cell reads as heatsink only on the radial lattice (H3's round-ended slots)
  if (depth === undefined || (c['round'] === true && !radial)) return undefined
  const count = exactOf(feature['count'])
  const radius = exactOf(feature['radius'])
  const length = exactOf(c['length'])
  const width = exactOf(c['width'])
  const diameter = exactOf(c['diameter'])
  return {
    cell:
      c.kind === 'rectangle' && length !== undefined && width !== undefined
        ? {
            kind: 'rectangle',
            length,
            width,
            cornerRadius:
              c['round'] === true ? Math.min(length, width) / 2 : (exactOf(c['cornerRadius']) ?? 0),
            rotation: exactOf(c['rotation']) ?? 0,
          }
        : c.kind === 'circle' && diameter !== undefined
          ? { kind: 'circle', diameter }
          : { kind: 'other' },
    lattice: String(feature['lattice']),
    alternate: feature['alternate'] === 'flip' ? 'flip' : 'none',
    invert: feature['invert'] === true,
    through: feature['through'] === true,
    gap: exactOf((feature['spacing'] as { gap?: QuantityDTO }).gap),
    angle: exactOf(feature['angle']) ?? 0,
    depth,
    cells: facts.cells,
    area: { min: [b.min[0], b.min[1]], max: [b.max[0], b.max[1]] },
    margin: [mu ?? 0, mv ?? 0],
    thickness,
    ...(radial && count !== undefined && radius !== undefined ? { radial: { count, radius } } : {}),
  }
}

/** H2: the heatsink card a pattern is, with its sizes in the step's terms (mm). */
function currentCard(
  f: FinsFields,
  fins: FinsReadout | undefined,
  pins: PinsReadout | undefined,
  radial: RadialReadout | undefined,
): CurrentHeatsink | undefined {
  if (radial !== undefined)
    return {
      id: 'radialFins',
      values: {
        fin: radial.hubFin,
        slot: radial.slot,
        height: radial.height,
        hub: radial.hub,
        outer: radial.outer,
        count: f.radial?.count ?? radial.slots,
      },
    }
  if (fins !== undefined && f.cell.kind === 'rectangle')
    return {
      id: 'straightFins',
      values: {
        fin: fins.fin,
        slot: Math.min(f.cell.length, f.cell.width),
        height: fins.height,
        // the preset's wall is across the fins; the margin along them is 0
        wall: Math.max(f.margin[0], f.margin[1]),
      },
    }
  if (pins !== undefined)
    return {
      id: PIN_CARD[pins.kind],
      values: { pin: pins.pin, channel: pins.channel, height: pins.height },
    }
  return undefined
}

type RoundPart = { centre: [number, number]; diameter: number; name?: string }

/** A placed circle (face frame): an inline circle, or a named shape that is one circle. */
function placedCircle(
  shape: unknown,
  shapes: readonly { id: string; items: readonly unknown[] }[],
): { centre: [number, number]; diameter: number } | undefined {
  const sh = shape as
    { kind?: string; shapeId?: string; center?: unknown[]; diameter?: unknown } | undefined
  if (sh === undefined) return undefined
  const named = sh.kind === 'named' ? shapes.find((x) => x.id === sh.shapeId) : undefined
  const item = (named?.items.length === 1 ? named.items[0] : undefined) as
    { kind?: string; op?: string; diameter?: unknown } | undefined
  const d =
    sh.kind === 'circle'
      ? exactOf(sh.diameter)
      : item?.kind === 'circle' && item.op !== 'subtract'
        ? exactOf(item.diameter)
        : undefined
  const u = exactOf(sh.center?.[0])
  const v = exactOf(sh.center?.[1])
  return u === undefined || v === undefined || d === undefined || !(d > 0)
    ? undefined
    : { centre: [u, v], diameter: d }
}

/**
 * H3: the round part the radial step centres on (face frame): the pattern's boundary when it is a
 * circle; else the largest outside profile round a circle inside the face (the part's outline,
 * its name); else a radial pattern's own origin; else the face's centre and smaller side.
 */
function roundPart(
  feature: FeatureDTO,
  part: DesignPart,
  face: { min: readonly number[]; max: readonly number[] },
): RoundPart {
  const shapes = part.dto.shapes ?? []
  const [u0, v0] = [face.min[0]!, face.min[1]!]
  const [u1, v1] = [face.max[0]!, face.max[1]!]
  const boundary = feature['boundary'] as { shapeId: string; center: unknown[] } | undefined
  const onBoundary =
    boundary === undefined ? undefined : placedCircle({ kind: 'named', ...boundary }, shapes)
  if (onBoundary !== undefined && boundary !== undefined)
    return { ...onBoundary, name: shapes.find((x) => x.id === boundary.shapeId)?.name ?? '' }
  let best: RoundPart | undefined
  for (const op of part.dto.operations) {
    const o = op as unknown as { kind: string; side?: string; shape?: unknown; name: string }
    if (o.kind !== 'profile' || (o.side ?? 'outside') !== 'outside') continue
    const c = placedCircle(o.shape, shapes)
    if (c === undefined) continue
    const [u, v] = c.centre
    const r = c.diameter / 2
    if (u - r < u0 - 1e-6 || u + r > u1 + 1e-6 || v - r < v0 - 1e-6 || v + r > v1 + 1e-6) continue
    if (best === undefined || c.diameter > best.diameter) best = { ...c, name: o.name }
  }
  if (best !== undefined) return best
  const origin = feature['origin'] as unknown[] | undefined
  const [ou, ov] = [exactOf(origin?.[0]), exactOf(origin?.[1])]
  const side = Math.min(u1 - u0, v1 - v0)
  if (feature['lattice'] === 'radial' && ou !== undefined && ov !== undefined)
    return { centre: [ou, ov], diameter: side }
  return { centre: [(u0 + u1) / 2, (v0 + v1) / 2], diameter: side }
}

/** The cell as `design.pattern.update` takes it: its sources, `changes` applied. */
function cellArgs(cell: CellRecord, changes: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { kind: cell.kind }
  if (cell.kind === 'shape' && cell.shapeId !== undefined) out['shapeId'] = cell.shapeId
  if (cell.kind === 'polygon' && cell.across !== undefined) out['across'] = cell.across
  for (const k of [...CELL_FIELDS[cell.kind], 'rotation']) {
    const s = sourceOf(cell[k])
    if (s !== undefined) out[k] = s
  }
  return { ...out, ...changes }
}

export function PatternInspector({
  part,
  feature,
  warnings,
}: {
  part: DesignPart
  feature: FeatureDTO
  warnings: DesignWarnings
}): React.JSX.Element {
  const call = useCommand()
  const port = useRegion2d()
  const [, select] = useDesignSelection()
  const cancelGesture = useCancelGesture()
  const { ui } = useShell()
  const [summary, setSummary] = useState<AppErrorData | undefined>(undefined)
  const [errors, setErrors] = useState<FieldError[]>([])
  const [perSideOn, setPerSide] = useState(false)
  const flatEndMills = useFlatEndMills()
  const units = part.units

  const cell = feature['cell'] as CellRecord
  const lattice = feature['lattice'] as Lattice
  const spacing = feature['spacing'] as { gap?: QuantityDTO; pitch?: [QuantityDTO, QuantityDTO] }
  const unit = operationUnits(part).find((u) => u.id === feature.id)
  const owned = unit?.kind === 'feature' ? unit.ops : []
  const ownedIds = new Set([feature.id, ...owned.map((o) => o.id)])
  const index = Math.max(
    0,
    part.dto.operations.findIndex((o) => ownedIds.has(o.id)),
  )
  const table = part.table
  const ons = table ? onChoices(part.dto, table, index, 'pocket') : []
  const closedShapes = (part.dto.shapes ?? []).filter(
    (s) => s.owner === undefined && !s.items.some((i) => i.kind === 'path' && i.closed === false),
  )
  const facts =
    port === undefined ? undefined : patternFacts(feature.id, part.dto.shapes ?? [], port)
  const shapesKey = JSON.stringify(closedShapes)
  const outlines = useMemo(
    () => new Map(closedShapes.map((s) => [s.id, shapeLoops(port, s)])),
    // the shapes' records, not the filtered array (new every render)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [port, shapesKey],
  )
  const shapeOptions = closedShapes.map((s) => ({
    value: s.id,
    label: s.name,
    icon: <MiniOutline loops={outlines.get(s.id) ?? []} />,
  }))
  const boundary = feature['boundary'] as
    { shapeId: string; center: [QuantityDTO, QuantityDTO]; rotation: QuantityDTO } | undefined
  const origin = feature['origin'] as [QuantityDTO, QuantityDTO] | undefined
  /** The area's box centre (mm): what an empty origin means. */
  const areaCentre = (): [number, number] => {
    const b =
      facts === undefined
        ? undefined
        : chainBounds(facts.area.pieces.flatMap((x) => x.outer.elements))
    return b === undefined ? [0, 0] : [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
  }
  const boundaryCenter = (): string[] =>
    boundary === undefined
      ? []
      : [sourceOf(boundary.center[0]) ?? '0', sourceOf(boundary.center[1]) ?? '0']

  const findings = warnings.warnings.filter((w) => ownedIds.has(w.operation))
  const fieldOf = (w: DfmWarning): string | undefined => {
    if (w.parameter === 'tool') return 'tool'
    const op = part.dto.operations.find((o) => o.id === w.operation)
    return op === undefined ? w.parameter : warningFeatureField(feature, op, w)
  }
  const shown = new Set([
    'cell',
    'lattice',
    'spacing',
    'count',
    'radius',
    'angle',
    'origin',
    'alternate',
    'on',
    'boundary',
    'margin',
    'fit',
    'invert',
    'depth',
    'through',
    'roughing',
    'chamfer',
    'tool',
  ])
  const unplaced = findings.filter((w) => {
    const f = fieldOf(w)
    return f === undefined || !shown.has(f.split('.')[0]!)
  })

  const update = async (args: Record<string, unknown>, path: string, gesture?: string) => {
    const r = await call(
      'design.pattern.update',
      { partId: part.dto.id, featureId: feature.id, ...args },
      gesture === undefined ? undefined : { gesture },
    )
    if (r.ok) {
      setErrors([])
      setSummary(undefined)
      // DF120: a radius too large for the cell applied as Round; say so, with Undo
      const note = adjustedNote(r)
      if (note !== undefined) ui.getState().setRemovedToast(note, { edit: true })
      return
    }
    const placed = placeErrors(r.error, path)
    setErrors(placed.errors)
    setSummary(placed.summary)
  }

  /** Messages of a field and the fields under it (`cell` takes `cell.diameter`'s). */
  const messagesAt = (path: string): FieldMessage[] => [
    ...errors
      .filter((e) => e.path === path || e.path.startsWith(`${path}.`))
      .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text })),
    ...findings
      .filter((w) => fieldOf(w) === path)
      .map((w): FieldMessage => ({
        id: `${w.code}:${w.operation}:${path}`,
        severity: dfmMessages.tier(w),
        text: dfmMessages.text(w, units, dfmNames(part.dto)),
      })),
  ]

  /** Messages of exactly this field (the Roughing switch must not repeat its margins' errors). */
  const exactMessagesAt = (path: string): FieldMessage[] =>
    messagesAt(path)
      .filter((m) => !m.id.startsWith('error-'))
      .concat(
        errors
          .filter((e) => e.path === path)
          .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text })),
      )

  /** A field's standing note, in its support area as the other inspectors' notes (design review U9). */
  const note = (id: string, text: string | undefined): FieldMessage[] =>
    text === undefined ? [] : [{ id: `note-${id}`, severity: 'note', text }]

  /** The worst problem at these field paths: a More row or accordion holding them opens. */
  const problemAt = (paths: readonly string[]): GroupSeverity | undefined => {
    const ms = paths.flatMap(messagesAt)
    if (ms.some((x) => x.severity === 'error')) return 'error'
    if (ms.some((x) => x.severity === 'hard' || x.severity === 'soft')) return 'warning'
    return undefined
  }
  /**
   * A group's More row (DF110): its rarely used fields, shown open while one of them holds a
   * non-default value (`set`, a More row has no summary) or a problem, so nothing hides silently.
   */
  const more = (
    id: string,
    fields: readonly string[],
    paths: readonly string[],
    set: boolean,
    children: React.ReactNode,
  ) => (
    <InspectorGroup.More
      fields={fields}
      rememberKey={`pattern.${id}.more`}
      forceOpen={set || problemAt(paths) !== undefined}
    >
      {children}
    </InspectorGroup.More>
  )

  const quantityField = (
    path: PatternPath,
    label: string,
    kind: 'length' | 'angle' | 'scalar',
    dto: unknown,
    commit: (source: string) => Record<string, unknown>,
    /** Shown while the value is unset (a cell's rotation: none means 0°). */
    placeholder?: string,
    /** The value follows other fields (a Round cell's corner radius, DF120): read-only. */
    derived = false,
  ) => (
    <div key={path} data-feature-field={path}>
      <QuantityInput
        label={label}
        kind={kind}
        defaultUnit={defaultUnit(kind, units)}
        value={dto === undefined ? undefined : quantityOf(dto as QuantityDTO)}
        stepKind={PATTERN_STEP[path]}
        stepKey={`pattern.${path}`}
        {...(path === 'cell.sides' ? { stepMax: 12 } : {})}
        {...(placeholder === undefined ? {} : { placeholder })}
        {...(derived ? { readOnly: true } : {})}
        onCommit={(q, gesture) => void update(commit(q.source), path, gesture)}
        onCancelGesture={cancelGesture}
        messages={messagesAt(path)}
      />
    </div>
  )

  /**
   * A lattice change; H3: the first Radial gets 8 cells on a circle of 30 % of the face's smaller
   * side (count and radius are kept across lattices after that).
   */
  const latticeArgs = (l: Lattice): Record<string, unknown> => {
    if (l !== 'radial' || (feature['count'] !== undefined && feature['radius'] !== undefined))
      return { lattice: l }
    const side =
      own === undefined
        ? 40
        : Math.min(
            own.boundary.max[0] - own.boundary.min[0],
            own.boundary.max[1] - own.boundary.min[1],
          )
    return {
      lattice: l,
      count: sourceOf(feature['count']) ?? '8',
      radius: sourceOf(feature['radius']) ?? lengthSource(Math.round(side * 0.3), units),
    }
  }
  const chooseCell = (kind: CellKind) => {
    if (kind === cell.kind) return
    if (kind === 'shape') {
      const first = closedShapes[0]
      if (first !== undefined) void update({ cell: { kind, shapeId: first.id } }, 'cell')
      return
    }
    void update({ cell: { kind, ...CELL_START[kind] } }, 'cell')
  }
  const cellLabel = (k: string) =>
    k === 'sides' ? p.sides : k === 'cornerRadius' ? p.cornerRadius : (p[k as 'length'] ?? k)

  // DF120: a Round cell's radius is half its narrowest side
  const roundCell = cell.kind === 'rectangle' && cell['round'] === true
  const gap = spacing.gap !== undefined
  const through = feature['through'] === true
  // P4: on another pattern's floor the face is that pattern's cells (stacked)
  const stackedOn = ((): string | undefined => {
    const id = /^(.+)_pocket\.floor$/.exec(feature.on)?.[1]
    const below = part.dto.features?.find((f) => f.id === id && f.kind === 'pattern')
    return below?.name
  })()
  const chamfer = feature['chamfer'] as
    { width: QuantityDTO; angle: QuantityDTO; side?: 'bottom' | 'both' } | undefined
  const pocketOp = owned.find((o) => o.id === `${feature.id}_pocket`)
  // DF108: the bigger tool's pass before the pocket
  const roughing = patternRoughing(feature)
  const roughingOp = owned.find((o) => o.id === `${feature.id}_roughing`)
  const chamferOp = owned.find((o) => o.id === `${feature.id}_chamfer`)
  // P5: the through cells' bottom edges, from a flipped setup
  const bottomChamferOp = owned.find((o) => o.id === `${feature.id}_bottomChamfer`)
  const flip = feature['alternate'] === 'flip'
  // DF110: the rare fields' non-default values keep their More row open
  const rotated = !['0', '0°', '0 deg', ''].includes(
    (sourceOf(cell['rotation']) ?? '').replace(/\s+/g, ' ').trim(),
  )
  const clip = feature['fit'] === 'clip'
  const inverted = feature['invert'] === true
  const chamferProblem = problemAt(['chamfer', 'chamfer.width', 'chamfer.angle', 'chamfer.side'])
  // H1: the margin per side, the face for the heatsink step and the heatsink read-out
  const marginPair = Array.isArray(feature['margin'])
    ? (feature['margin'] as [QuantityDTO, QuantityDTO])
    : undefined
  const marginSource = (i: 0 | 1): string =>
    sourceOf(marginPair === undefined ? feature['margin'] : marginPair[i]) ?? '0'
  const stock = part.loaded?.stock
  const onStock = feature.on === 'stock.top' || feature.on === 'stock.bottom'
  const own = (part.dto.shapes ?? []).find((s) => s.id === `${feature.id}_cells`)?.pattern
  const thickness = onStock && stock !== undefined ? stock.thickness.canonical : undefined
  const heatsinkFace =
    own === undefined
      ? undefined
      : {
          across: own.boundary.max[0] - own.boundary.min[0],
          along: own.boundary.max[1] - own.boundary.min[1],
          thickness,
          round: roundPart(feature, part, own.boundary),
        }
  const ff = facts === undefined ? undefined : finsFields(feature, facts, thickness)
  const fins = ff === undefined ? undefined : straightFinsReadout(ff)
  // H2: pin fins read out as pins; the dialog's current card starts its step from these sizes
  const pins = ff === undefined || fins !== undefined ? undefined : pinsReadout(ff)
  // H3: radial fins read out as slots with the fin at the hub
  const radialFins = ff === undefined ? undefined : radialReadout(ff)
  const currentHeatsink = ff === undefined ? undefined : currentCard(ff, fins, pins, radialFins)
  return (
    <div className={styles['inspector']}>
      <PanelHeader title={feature.name} itemId={feature.id} />
      <div className={styles['fields']}>
        {summary ? <ErrorMessage error={summary} message={refusalText(summary, part.dto)} /> : null}
        <NameField
          label={t.name}
          name={feature.name}
          onCommit={(name) => void update({ name }, 'name')}
        />
        <div className={styles['turnRow']}>
          <p className={styles['muted']} data-pattern-readout>
            {facts === undefined
              ? ''
              : radialFins !== undefined
                ? [
                    p.radialReadout(
                      radialFins.slots,
                      lengthSource(radialFins.slot, units),
                      lengthSource(radialFins.hubFin, units),
                      lengthSource(radialFins.height, units),
                      radialFins.ratio,
                      radialFins.base === undefined
                        ? undefined
                        : lengthSource(radialFins.base, units),
                    ),
                    p.radialRim(lengthSource(radialFins.rimFin, units)),
                  ].join(' · ')
                : fins !== undefined
                  ? p.finsReadout(
                      fins.slots,
                      fins.fins,
                      lengthSource(fins.fin, units),
                      lengthSource(fins.height, units),
                      fins.ratio,
                      fins.base === undefined ? undefined : lengthSource(fins.base, units),
                    )
                  : pins !== undefined
                    ? p.pinsReadout(
                        pins.pins,
                        lengthSource(pins.pin, units),
                        pins.kind !== 'square',
                        lengthSource(pins.height, units),
                        pins.ratio,
                        pins.base === undefined ? undefined : lengthSource(pins.base, units),
                      )
                    : p.readoutFull(
                        facts.cells,
                        facts.web === undefined ? undefined : lengthSource(facts.web.width, units),
                        facts.dropped,
                      )}
          </p>
          <PatternPresetsDialog
            feature={feature}
            onApply={(preset) => void update({ ...preset.args }, 'cell')}
            heatsink={{
              face: heatsinkFace,
              units,
              current: currentHeatsink,
              tools: flatEndMills,
              lastGroup: ui.getState().steps[PRESET_GROUP_KEY] as Group | undefined,
              onGroup: (g) => ui.getState().rememberStep(PRESET_GROUP_KEY, g),
              apply: (args, toolId) =>
                void (async () => {
                  // the fields and the slot tool: two commands, one gesture, one undo step
                  const gesture = newGestureId()
                  await update(args, 'cell', gesture)
                  if (toolId === undefined || pocketOp === undefined) return
                  await call(
                    'design.operation.tool.set',
                    {
                      partId: part.dto.id,
                      operationId: pocketOp.id,
                      tool: { kind: 'specific', toolLibraryItemId: toolId },
                    },
                    { gesture },
                  )
                })(),
            }}
          />
        </div>

        <InspectorGroup title={p.groups.cell}>
          <div data-feature-field="cell">
            <Field label={p.cell} messages={messagesAt('cell')}>
              <Select
                options={CELL_KINDS.filter((k) => k !== 'shape' || closedShapes.length > 0).map(
                  (k) => ({
                    value: k,
                    label: p.cells[k] ?? k,
                    ...(k === 'shape' ? {} : { icon: <MiniOutline loops={CELL_LOOPS[k]} /> }),
                  }),
                )}
                value={cell.kind}
                onValueChange={(k) => chooseCell(k as CellKind)}
              />
            </Field>
          </div>
          {cell.kind === 'shape' ? (
            <Field label={p.shape}>
              <Select
                options={shapeOptions}
                value={cell.shapeId ?? ''}
                onValueChange={(shapeId) =>
                  void update({ cell: cellArgs(cell, { shapeId }) }, 'cell')
                }
              />
            </Field>
          ) : null}
          {CELL_FIELDS[cell.kind].map((k) =>
            quantityField(
              `cell.${k}`,
              cellLabel(k),
              k === 'sides' ? 'scalar' : 'length',
              cell[k],
              (source) => ({ cell: cellArgs(cell, { [k]: source }) }),
              undefined,
              k === 'cornerRadius' && roundCell,
            ),
          )}
          {cell.kind === 'rectangle' ? (
            <div data-feature-field="cell.round">
              <RoundField
                checked={roundCell}
                onChange={(round) =>
                  void update({ cell: { ...cellArgs(cell, {}), round } }, 'cell')
                }
              />
            </div>
          ) : null}
          {cell.kind === 'polygon' ? (
            <Field label={p.across} kind="toggle">
              <SegmentedControl<string>
                label={p.across}
                options={['corners', 'flats'].map((v) => ({
                  value: v,
                  label: p.acrossValues[v] ?? v,
                }))}
                value={cell.across ?? 'corners'}
                onValueChange={(across) =>
                  void update({ cell: cellArgs(cell, { across }) }, 'cell')
                }
              />
            </Field>
          ) : null}
          {more(
            'cell',
            [p.rotation],
            ['cell.rotation'],
            rotated,
            quantityField(
              'cell.rotation',
              p.rotation,
              'angle',
              cell['rotation'],
              (source) => ({ cell: cellArgs(cell, { rotation: source }) }),
              '0°',
            ),
          )}
        </InspectorGroup>

        <InspectorGroup title={p.groups.layout}>
          <div data-feature-field="lattice">
            {/* H3: five lattices do not fit a segmented control in the inspector (as the joints) */}
            <Field
              label={p.lattice}
              messages={[
                ...messagesAt('lattice'),
                ...note('radial', lattice === 'radial' ? p.radialNote : undefined),
              ]}
            >
              <Select
                options={LATTICES.map((l) => ({ value: l, label: p.lattices[l] ?? l }))}
                value={lattice}
                onValueChange={(l) =>
                  l !== lattice && void update(latticeArgs(l as Lattice), 'lattice')
                }
              />
            </Field>
          </div>
          {lattice === 'radial' ? (
            <>
              {quantityField('count', p.count, 'scalar', feature['count'], (count) => ({ count }))}
              {quantityField('radius', p.radius, 'length', feature['radius'], (radius) => ({
                radius,
              }))}
            </>
          ) : (
            <>
              <div data-feature-field="spacing">
                <Field label={p.spacing} kind="toggle" messages={messagesAt('spacing')}>
                  <SegmentedControl<string>
                    label={p.spacing}
                    options={['gap', 'pitch'].map((v) => ({ value: v, label: p.spacings[v] ?? v }))}
                    value={gap ? 'gap' : 'pitch'}
                    onValueChange={(v) => {
                      if ((v === 'gap') === gap) return
                      void update(
                        v === 'gap'
                          ? { spacing: { gap: '2 mm' } }
                          : { spacing: { pitch: ['10 mm', '10 mm'] } },
                        'spacing',
                      )
                    }}
                  />
                </Field>
              </div>
              {gap
                ? quantityField('spacing.gap', p.gap, 'length', spacing.gap, (source) => ({
                    spacing: { gap: source },
                  }))
                : ([0, 1] as const).map((i) =>
                    quantityField(
                      `spacing.pitch.${i}`,
                      p.pitch(i, lattice === 'polar'),
                      'length',
                      spacing.pitch?.[i],
                      (s) => {
                        const pitch = [
                          sourceOf(spacing.pitch?.[0]) ?? s,
                          sourceOf(spacing.pitch?.[1]) ?? s,
                        ]
                        pitch[i] = s
                        return { spacing: { pitch } }
                      },
                    ),
                  )}
            </>
          )}
          {quantityField('angle', p.angle, 'angle', feature['angle'], (angle) => ({ angle }))}
          {more(
            'layout',
            [p.originShort, p.alternate],
            ['origin', 'origin.0', 'origin.1', 'alternate'],
            origin !== undefined || flip,
            <>
              {([0, 1] as const).map((i) => (
                <div key={`origin.${i}`} data-feature-field={`origin.${i}`}>
                  <QuantityInput
                    label={p.origin(i)}
                    stepKind="xy"
                    kind="length"
                    defaultUnit={defaultUnit('length', units)}
                    value={origin === undefined ? undefined : quantityOf(origin[i])}
                    placeholder={p.originCentre}
                    optional
                    onCommit={(q, gesture) => {
                      if (q === undefined) return void update({ origin: null }, 'origin', gesture)
                      const c = areaCentre()
                      const next = [
                        sourceOf(origin?.[0]) ?? lengthSource(c[0], units),
                        sourceOf(origin?.[1]) ?? lengthSource(c[1], units),
                      ]
                      next[i] = q.source
                      void update({ origin: next }, 'origin', gesture)
                    }}
                    onCancelGesture={cancelGesture}
                    messages={messagesAt(`origin.${i}`)}
                  />
                </div>
              ))}
              <div data-feature-field="alternate">
                <Field
                  label={p.alternate}
                  kind="toggle"
                  messages={[
                    ...messagesAt('alternate'),
                    ...note('alternate', flip ? p.alternateNote : undefined),
                  ]}
                >
                  <Switch
                    label={p.alternate}
                    hideLabel
                    checked={flip}
                    onCheckedChange={(on) =>
                      void update({ alternate: on ? 'flip' : 'none' }, 'alternate')
                    }
                  />
                </Field>
              </div>
            </>,
          )}
        </InspectorGroup>

        <InspectorGroup title={p.groups.area}>
          <div data-feature-field="on">
            <Field label={p.on} messages={messagesAt('on')}>
              <Select
                options={ons.map((c) => ({ value: c.id, label: c.label, group: c.group }))}
                value={feature.on}
                onValueChange={(on) => void update({ on }, 'on')}
              />
            </Field>
          </div>
          <div data-feature-field="boundary">
            <Field
              label={p.boundary}
              messages={[
                ...messagesAt('boundary'),
                ...note('stacked', stackedOn === undefined ? undefined : p.stackedNote(stackedOn)),
              ]}
            >
              <Select
                options={[
                  {
                    value: FACE,
                    label: stackedOn === undefined ? p.boundaryFace : p.boundaryFloor(stackedOn),
                  },
                  ...shapeOptions,
                ]}
                value={boundary?.shapeId ?? FACE}
                onValueChange={(shapeId) => {
                  if (shapeId === (boundary?.shapeId ?? FACE)) return
                  if (shapeId === FACE) return void update({ boundary: null }, 'boundary')
                  // a new boundary starts centred on the area (a changed one keeps its place)
                  const c = areaCentre()
                  const center =
                    boundary === undefined
                      ? [lengthSource(c[0], units), lengthSource(c[1], units)]
                      : boundaryCenter()
                  void update({ boundary: { shapeId, center } }, 'boundary')
                }}
              />
            </Field>
          </div>
          {boundary === undefined
            ? null
            : [
                ...([0, 1] as const).map((i) =>
                  quantityField(
                    `boundary.center.${i}`,
                    p.boundaryCenter(i),
                    'length',
                    boundary.center[i],
                    (s) => {
                      const center = boundaryCenter()
                      center[i] = s
                      const rotation = sourceOf(boundary.rotation)
                      return {
                        boundary: {
                          shapeId: boundary.shapeId,
                          center,
                          ...(rotation === undefined ? {} : { rotation }),
                        },
                      }
                    },
                  ),
                ),
                quantityField(
                  'boundary.rotation',
                  p.boundaryRotation,
                  'angle',
                  boundary.rotation,
                  (rotation) => ({
                    boundary: { shapeId: boundary.shapeId, center: boundaryCenter(), rotation },
                  }),
                ),
              ]}
          {marginPair === undefined && !perSideOn ? (
            quantityField('margin', p.margin, 'length', feature['margin'], (margin) => ({
              margin,
            }))
          ) : (
            <>
              {([0, 1] as const).map((i) =>
                quantityField(
                  `margin.${i}`,
                  i === 0 ? p.marginAcross : p.marginAlong,
                  'length',
                  marginPair?.[i] ?? feature['margin'],
                  (source) => ({
                    margin: i === 0 ? [source, marginSource(1)] : [marginSource(0), source],
                  }),
                ),
              )}
            </>
          )}
          <div className={styles['perSideRow']}>
            <Button
              size="sm"
              variant="ghost"
              data-margin-per-side
              onClick={() => {
                if (marginPair === undefined) return setPerSide((x) => !x)
                // back to one margin: the across value for both
                setPerSide(false)
                void update({ margin: marginSource(0) }, 'margin')
              }}
            >
              {marginPair === undefined && !perSideOn ? p.marginPerSide : p.marginPerSideOff}
            </Button>
          </div>
          {more(
            'area',
            [p.fit, p.invertShort],
            ['fit', 'invert'],
            clip || inverted,
            <>
              <div data-feature-field="fit">
                <Field
                  label={p.fit}
                  kind="toggle"
                  messages={messagesAt('fit')}
                  info={p.fitDescription}
                >
                  <SegmentedControl<string>
                    label={p.fit}
                    options={['whole', 'clip'].map((v) => ({ value: v, label: p.fits[v] ?? v }))}
                    value={(feature['fit'] as string | undefined) ?? 'whole'}
                    onValueChange={(fit) => void update({ fit }, 'fit')}
                  />
                </Field>
              </div>
              <div data-feature-field="invert">
                <Field label={p.invert} kind="toggle" messages={messagesAt('invert')}>
                  <Switch
                    label={p.invert}
                    hideLabel
                    checked={inverted}
                    onCheckedChange={(invert) => void update({ invert }, 'invert')}
                  />
                </Field>
              </div>
            </>,
          )}
        </InspectorGroup>

        <InspectorGroup title={p.groups.cut}>
          <div data-feature-field="through">
            <Field
              label={p.through}
              kind="toggle"
              messages={[
                ...messagesAt('through'),
                ...note('through', through ? p.throughNote : undefined),
              ]}
            >
              <Switch
                label={p.through}
                hideLabel
                checked={through}
                onCheckedChange={(on) => void update({ through: on }, 'through')}
              />
            </Field>
          </div>
          {through
            ? null
            : quantityField('depth', p.depth, 'length', feature['depth'], (depth) => ({ depth }))}
          {pocketOp === undefined ? null : (
            <div data-feature-field="tool">
              <ToolField
                part={part}
                op={pocketOp}
                warnings={warnings.warnings.filter((w) => w.operation === pocketOp.id)}
                label={p.tool}
              />
            </div>
          )}
        </InspectorGroup>

        {/* DF122 R2: the same Roughing accordion as the Pocket inspector (roughing.md § UI) */}
        <RoughingGroup
          part={part}
          margins={roughing}
          roughingOp={roughingOp}
          warnings={warnings.warnings}
          messagesAt={exactMessagesAt}
          send={(arg, path, gesture) => void update({ roughing: arg }, path, gesture)}
          rememberKey="pattern"
          info={designMessages.roughing.patternGroupInfo}
        />

        {/* closed unless on: its open state is remembered apart for on and off (DF110) */}
        <InspectorGroup
          title={p.groups.chamfer}
          collapsible
          rememberKey={chamfer === undefined ? 'pattern.chamfer.off' : 'pattern.chamfer.on'}
          defaultOpen={chamfer !== undefined}
          summary={
            chamfer === undefined
              ? p.chamferOff
              : p.chamferSummary(
                  sourceOf(chamfer.width),
                  sourceOf(chamfer.angle),
                  through ? (p.chamferSides[chamfer.side ?? 'top'] ?? chamfer.side) : undefined,
                )
          }
          severity={chamferProblem}
          forceOpen={chamferProblem !== undefined}
        >
          <div data-feature-field="chamfer">
            <Field
              label={p.chamfer}
              kind="toggle"
              messages={messagesAt('chamfer')}
              info={p.chamferNote}
            >
              <Switch
                label={p.chamfer}
                hideLabel
                checked={chamfer !== undefined}
                onCheckedChange={(on) => void update({ chamfer: on ? {} : null }, 'chamfer')}
              />
            </Field>
          </div>
          {chamfer === undefined
            ? null
            : [
                quantityField('chamfer.width', p.chamferWidth, 'length', chamfer.width, (w) => ({
                  chamfer: { width: w },
                })),
                quantityField('chamfer.angle', p.chamferAngle, 'angle', chamfer.angle, (a) => ({
                  chamfer: { angle: a },
                })),
                // P5: through cells have bottom edges too
                through ? (
                  <div key="chamfer.side" data-feature-field="chamfer.side">
                    <Field
                      label={p.chamferSide}
                      kind="toggle"
                      messages={[
                        ...messagesAt('chamfer.side'),
                        ...note(
                          'chamfer.side',
                          (chamfer.side ?? 'top') === 'top' ? undefined : p.chamferSideNote,
                        ),
                      ]}
                    >
                      <SegmentedControl<string>
                        label={p.chamferSide}
                        options={['top', 'bottom', 'both'].map((v) => ({
                          value: v,
                          label: p.chamferSides[v] ?? v,
                        }))}
                        value={chamfer.side ?? 'top'}
                        onValueChange={(side) => void update({ chamfer: { side } }, 'chamfer.side')}
                      />
                    </Field>
                  </div>
                ) : null,
              ]}
          {chamferOp === undefined ? null : (
            <div data-feature-field="chamfer.tool">
              <ToolField
                part={part}
                op={chamferOp}
                warnings={warnings.warnings.filter((w) => w.operation === chamferOp.id)}
                label={p.chamferTool}
              />
            </div>
          )}
          {bottomChamferOp === undefined ? null : (
            <div data-feature-field="chamfer.bottomTool">
              <ToolField
                part={part}
                op={bottomChamferOp}
                warnings={warnings.warnings.filter((w) => w.operation === bottomChamferOp.id)}
                label={p.chamferBottomTool}
              />
            </div>
          )}
        </InspectorGroup>

        {unplaced.length > 0 ? (
          <InspectorGroup title={m.features.findings}>
            <WarningList
              labels={warningLabels}
              items={unplaced.map((w) => warningView(w, part, undefined, select))}
            />
          </InspectorGroup>
        ) : null}
      </div>
    </div>
  )
}

type Loop = { elements: { kind: 'line'; a: Vec; b: Vec }[]; closed: boolean }
type Vec = [number, number]

function arcPoints(c: Vec, r: number, from: number, to: number, n: number): Vec[] {
  const out: Vec[] = []
  for (let i = 0; i < n; i++) {
    const a = ((from + ((to - from) * i) / (n - 1)) * Math.PI) / 180
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)])
  }
  return out
}
function poly(pts: Vec[]): Loop {
  return {
    closed: true,
    elements: pts.map((a, i) => ({ kind: 'line' as const, a, b: pts[(i + 1) % pts.length]! })),
  }
}

/** A pattern quantity field's path (its messages and remembered step). */
type PatternPath =
  | `cell.${CellField}`
  | 'cell.rotation'
  | 'spacing.gap'
  | `spacing.pitch.${0 | 1}`
  | 'count'
  | 'radius'
  | 'angle'
  | `boundary.center.${0 | 1}`
  | 'boundary.rotation'
  | 'margin'
  | `margin.${0 | 1}`
  | 'depth'
  | 'chamfer.width'
  | 'chamfer.angle'

/** Adjust steps per pattern field (inspector-layout.md § Step assignment per field). */
const PATTERN_STEP: Record<PatternPath, StepKind> = {
  'cell.diameter': 'xy',
  'cell.length': 'xy',
  'cell.width': 'xy',
  'cell.cornerRadius': 'small',
  'cell.sides': 'count',
  'cell.rotation': 'rotation',
  'spacing.gap': 'small',
  'spacing.pitch.0': 'xy',
  'spacing.pitch.1': 'xy',
  count: 'count',
  radius: 'xy',
  angle: 'rotation',
  'boundary.center.0': 'xy',
  'boundary.center.1': 'xy',
  'boundary.rotation': 'rotation',
  margin: 'xy',
  'margin.0': 'xy',
  'margin.1': 'xy',
  depth: 'depth',
  'chamfer.width': 'small',
  'chamfer.angle': 'angle',
}

/** A primitive cell kind's mini outline (the Cell select's thumbnails; not to scale). */
const CELL_LOOPS: Record<Exclude<CellKind, 'shape'>, Loop[]> = {
  circle: [poly(arcPoints([0, 0], 4, 0, 345, 24))],
  rectangle: [
    poly([
      [-5, -3],
      [5, -3],
      [5, 3],
      [-5, 3],
    ]),
  ],
  obround: [
    poly([...arcPoints([3.5, 0], 2.5, -90, 90, 8), ...arcPoints([-3.5, 0], 2.5, 90, 270, 8)]),
  ],
  polygon: [poly(arcPoints([0, 0], 4, 30, 330, 6))],
}
