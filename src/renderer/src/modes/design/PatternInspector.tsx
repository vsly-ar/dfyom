// The pattern inspector (patterns P1, P2): name, the read-out (cells · web · slivers dropped)
// and Presets, then the groups Cell (kind with thumbnails, its sizes, rotation), Layout (lattice
// incl. Polar, gap or pitch, angle, origin: empty = the area's centre), Area (On, the boundary:
// Whole face or a closed shape with its centre and rotation, margin, Whole/Clip, Invert), Cut
// (depth, the pocket's tool), Chamfer (P3: a switch, then width, angle and the chamfer's tool).
// Every edit is one `design.pattern.update` (one undo step); errors
// and findings show at their field, the rest under Findings.
// Doc: docs/modes/patterns.md#ui, docs/conventions/ui.md#pattern-inspector-p1
import { useMemo, useState } from 'react'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import { patternFacts } from '../../../../core/design/pattern/pattern'
import { PATTERN_PRESETS } from '../../../../core/design/pattern/presets'
import { chainBounds } from '../../../../core/geometry/2d/model'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { dfmMessages, lengthSource } from '../../messages/dfm'
import { useCancelGesture } from '../../shell/hooks'
import { useRegion2d } from '../../shell/ShellContext'
import {
  Button,
  ErrorMessage,
  Field,
  Menu,
  PanelHeader,
  QuantityInput,
  SegmentedControl,
  Select,
  Switch,
  WarningList,
  type FieldMessage,
} from '../../ui'
import { warningLabels, warningView } from './DesignInspector'
import styles from './Design.module.css'
import { operationUnits, warningFeatureField } from './feature-view'
import { NameField } from './NameField'
import { placeErrors, type FieldError } from './OperationFields'
import { MiniOutline, shapeLoops } from './ShapePicker'
import { ToolField } from './ToolField'
import { defaultUnit, dfmNames, onChoices, quantityOf, type DesignPart } from './model'
import { useCommand, useDesignSelection, type DesignWarnings } from './useDesign'

const m = designMessages
const t = m.inspector
const p = m.features.pattern

type CellKind = 'circle' | 'rectangle' | 'obround' | 'polygon' | 'shape'
type Lattice = 'square' | 'staggered' | 'hex' | 'polar'
const CELL_KINDS: readonly CellKind[] = ['circle', 'rectangle', 'obround', 'polygon', 'shape']
const LATTICES: readonly Lattice[] = ['square', 'staggered', 'hex', 'polar']
/** The Boundary select's value for the whole face. */
const FACE = 'face'
/** The size fields of each primitive cell, in order. */
const CELL_FIELDS: Record<CellKind, readonly string[]> = {
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
  const [summary, setSummary] = useState<AppErrorData | undefined>(undefined)
  const [errors, setErrors] = useState<FieldError[]>([])
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
    'angle',
    'origin',
    'on',
    'boundary',
    'margin',
    'fit',
    'invert',
    'depth',
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

  const quantityField = (
    path: string,
    label: string,
    kind: 'length' | 'angle' | 'scalar',
    dto: unknown,
    commit: (source: string) => Record<string, unknown>,
  ) => (
    <div key={path} data-feature-field={path}>
      <QuantityInput
        label={label}
        kind={kind}
        defaultUnit={defaultUnit(kind, units)}
        value={dto === undefined ? undefined : quantityOf(dto as QuantityDTO)}
        onCommit={(q, gesture) => void update(commit(q.source), path, gesture)}
        onCancelGesture={cancelGesture}
        messages={messagesAt(path)}
      />
    </div>
  )

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

  const gap = spacing.gap !== undefined
  const chamfer = feature['chamfer'] as { width: QuantityDTO; angle: QuantityDTO } | undefined
  const pocketOp = owned.find((o) => o.id === `${feature.id}_pocket`)
  const chamferOp = owned.find((o) => o.id === `${feature.id}_chamfer`)
  return (
    <div className={styles['inspector']}>
      <PanelHeader title={feature.name} itemId={feature.id} />
      <div className={styles['fields']}>
        {summary ? <ErrorMessage error={summary} message={t.commandFailed} /> : null}
        <NameField
          label={t.name}
          name={feature.name}
          onCommit={(name) => void update({ name }, 'name')}
        />
        <div className={styles['turnRow']}>
          <p className={styles['muted']} data-pattern-readout>
            {facts === undefined
              ? ''
              : p.readoutFull(
                  facts.cells,
                  facts.web === undefined ? undefined : lengthSource(facts.web.width, units),
                  facts.dropped,
                )}
          </p>
          <Menu
            label={p.presets}
            items={PATTERN_PRESETS.map((preset) => ({
              label: p.presetNames[preset.id] ?? preset.id,
              onSelect: () => void update({ ...preset.args }, 'cell'),
            }))}
          >
            <Button size="sm">{p.presets}</Button>
          </Menu>
        </div>

        <Group title={p.groups.cell}>
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
            ),
          )}
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
          {quantityField('cell.rotation', p.rotation, 'angle', cell['rotation'], (source) => ({
            cell: cellArgs(cell, { rotation: source }),
          }))}
        </Group>

        <Group title={p.groups.layout}>
          <div data-feature-field="lattice">
            <Field label={p.lattice} kind="toggle" messages={messagesAt('lattice')}>
              <SegmentedControl<Lattice>
                label={p.lattice}
                options={LATTICES.map((l) => ({ value: l, label: p.lattices[l] ?? l }))}
                value={lattice}
                onValueChange={(l) => l !== lattice && void update({ lattice: l }, 'lattice')}
              />
            </Field>
          </div>
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
          {quantityField('angle', p.angle, 'angle', feature['angle'], (angle) => ({ angle }))}
          {([0, 1] as const).map((i) => (
            <div key={`origin.${i}`} data-feature-field={`origin.${i}`}>
              <QuantityInput
                label={p.origin(i)}
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
        </Group>

        <Group title={p.groups.area}>
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
            <Field label={p.boundary} messages={messagesAt('boundary')}>
              <Select
                options={[{ value: FACE, label: p.boundaryFace }, ...shapeOptions]}
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
          {quantityField('margin', p.margin, 'length', feature['margin'], (margin) => ({
            margin,
          }))}
          <div data-feature-field="fit">
            <Field label={p.fit} kind="toggle" messages={messagesAt('fit')}>
              <SegmentedControl<string>
                label={p.fit}
                options={['whole', 'clip'].map((v) => ({ value: v, label: p.fits[v] ?? v }))}
                value={(feature['fit'] as string | undefined) ?? 'whole'}
                onValueChange={(fit) => void update({ fit }, 'fit')}
              />
            </Field>
            <p className={styles['muted']}>{p.fitDescription}</p>
          </div>
          <div data-feature-field="invert">
            <Field label={p.invert} kind="toggle" messages={messagesAt('invert')}>
              <Switch
                label={p.invert}
                hideLabel
                checked={feature['invert'] === true}
                onCheckedChange={(invert) => void update({ invert }, 'invert')}
              />
            </Field>
          </div>
        </Group>

        <Group title={p.groups.cut}>
          {quantityField('depth', p.depth, 'length', feature['depth'], (depth) => ({ depth }))}
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
        </Group>

        <Group title={p.groups.chamfer}>
          <div data-feature-field="chamfer">
            <Field label={p.chamfer} kind="toggle" messages={messagesAt('chamfer')}>
              <Switch
                label={p.chamfer}
                hideLabel
                checked={chamfer !== undefined}
                onCheckedChange={(on) => void update({ chamfer: on ? {} : null }, 'chamfer')}
              />
            </Field>
            <p className={styles['muted']}>{p.chamferNote}</p>
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
        </Group>

        {unplaced.length > 0 ? (
          <section className={styles['group']} aria-label={m.features.findings}>
            <h3 className={styles['groupTitle']}>{m.features.findings}</h3>
            <WarningList
              labels={warningLabels}
              items={unplaced.map((w) => warningView(w, part, undefined, select))}
            />
          </section>
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

function Group({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className={styles['group']} aria-label={title}>
      <h3 className={styles['groupTitle']}>{title}</h3>
      {children}
    </section>
  )
}
