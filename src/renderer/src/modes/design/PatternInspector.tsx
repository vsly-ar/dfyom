// The pattern inspector (patterns P1, minimal): name, then the groups Cell (kind, its sizes,
// rotation; a named closed shape of the part), Layout (lattice, gap or pitch, angle), Area (On;
// the boundary is the whole face less the margin), Cut (depth, the pocket's tool) and the cell
// read-out. Every edit is one `design.pattern.update` (one undo step); errors and findings show
// at their field, the rest under Findings. The L-review, presets and the viewport ghosts are P2.
// Doc: docs/modes/patterns.md#ui, docs/conventions/ui.md#pattern-inspector-p1
import { useState } from 'react'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import { patternCells } from '../../../../core/design/pattern/pattern'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { dfmMessages } from '../../messages/dfm'
import { useCancelGesture } from '../../shell/hooks'
import { useRegion2d } from '../../shell/ShellContext'
import {
  ErrorMessage,
  Field,
  PanelHeader,
  QuantityInput,
  SegmentedControl,
  Select,
  WarningList,
  type FieldMessage,
} from '../../ui'
import { warningLabels, warningView } from './DesignInspector'
import styles from './Design.module.css'
import { operationUnits, warningFeatureField } from './feature-view'
import { NameField } from './NameField'
import { placeErrors, type FieldError } from './OperationFields'
import { ToolField } from './ToolField'
import { defaultUnit, dfmNames, onChoices, quantityOf, type DesignPart } from './model'
import { useCommand, useDesignSelection, type DesignWarnings } from './useDesign'

const m = designMessages
const t = m.inspector
const p = m.features.pattern

type CellKind = 'circle' | 'rectangle' | 'obround' | 'polygon' | 'shape'
type Lattice = 'square' | 'staggered' | 'hex'
const CELL_KINDS: readonly CellKind[] = ['circle', 'rectangle', 'obround', 'polygon', 'shape']
const LATTICES: readonly Lattice[] = ['square', 'staggered', 'hex']
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
  const cells =
    port === undefined ? undefined : patternCells(feature.id, part.dto.shapes ?? [], port)

  const findings = warnings.warnings.filter((w) => ownedIds.has(w.operation))
  const fieldOf = (w: DfmWarning): string | undefined => {
    if (w.parameter === 'tool') return 'tool'
    const op = part.dto.operations.find((o) => o.id === w.operation)
    return op === undefined ? w.parameter : warningFeatureField(feature, op, w)
  }
  const shown = new Set(['cell', 'lattice', 'spacing', 'angle', 'on', 'margin', 'depth', 'tool'])
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
        <p className={styles['muted']} data-pattern-readout>
          {cells === undefined ? '' : p.readout(cells)}
        </p>

        <Group title={p.groups.cell}>
          <div data-feature-field="cell">
            <Field label={p.cell} messages={messagesAt('cell')}>
              <Select
                options={CELL_KINDS.filter((k) => k !== 'shape' || closedShapes.length > 0).map(
                  (k) => ({ value: k, label: p.cells[k] ?? k }),
                )}
                value={cell.kind}
                onValueChange={(k) => chooseCell(k as CellKind)}
              />
            </Field>
          </div>
          {cell.kind === 'shape' ? (
            <Field label={p.shape}>
              <Select
                options={closedShapes.map((s) => ({ value: s.id, label: s.name }))}
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
                  p.pitch(i),
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
          <p className={styles['muted']}>{p.boundaryFace}</p>
          {quantityField('margin', p.margin, 'length', feature['margin'], (margin) => ({
            margin,
          }))}
        </Group>

        <Group title={p.groups.cut}>
          {quantityField('depth', p.depth, 'length', feature['depth'], (depth) => ({ depth }))}
          {owned.map((op) => (
            <div key={op.id} data-feature-field="tool">
              <ToolField
                part={part}
                op={op}
                warnings={warnings.warnings.filter((w) => w.operation === op.id)}
                label={p.tool}
              />
            </div>
          ))}
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
