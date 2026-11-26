// The engraved pattern inspector (engraved-patterns.md E3): name, the read-out (lines · width ·
// groove length) with the motif's thumbnail and Presets…, then the groups Motif (Preset or Shapes;
// the shapes as Selects of the part's shapes), Area (On, Boundary: Whole face or a closed shape
// with its centre and rotation, Margin), Placement (Fit: Size or Fit to boundary, Width; Centre
// and Rotation behind More), Depth (From levels: Deepest and Shallowest, or Constant) and Cut (the
// owned Line's tool). The conventions of the S1–S6 inspectors (inspector-layout.md): groups, a More
// row shown open while it holds a value or a problem, (i) tips on the fields that need one,
// `stepKind` on every quantity, errors and findings at their field, the rest under Findings.
// Every edit is one `design.engraving.update` (one undo step).
// Doc: docs/modes/engraved-patterns.md#ui, docs/modes/engraved-patterns.md#implementation-e3,
// docs/conventions/inspector-layout.md
import { useMemo, useState } from 'react'
import { engravingResolved } from '../../../../core/design/engraving/engraving'
import { engravingPreset } from '../../../../core/design/engraving/presets'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import { SHAPE_ID_PATTERN } from '../../../../core/design/shape.dto'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { Quantity } from '../../../../core/quantity/quantity'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { dfmMessages, lengthSource } from '../../messages/dfm'
import { engravingMessages } from '../../messages/engraving'
import { useCancelGesture } from '../../shell/hooks'
import { useRegion2d } from '../../shell/ShellContext'
import {
  ErrorMessage,
  Field,
  InspectorGroup,
  PanelHeader,
  QuantityInput,
  SegmentedControl,
  Select,
  WarningList,
  type FieldMessage,
  type GroupSeverity,
  type StepKind,
} from '../../ui'
import { warningLabels, warningView } from './DesignInspector'
import styles from './Design.module.css'
import { EngravingPresetsDialog, MotifPreview } from './EngravingPresetsDialog'
import { motifThumb, presetThumb } from './engraving-thumbs'
import { operationUnits, warningFeatureField } from './feature-view'
import { NameField } from './NameField'
import { placeErrors, type FieldError } from './OperationFields'
import { MiniOutline, shapeLoops } from './ShapePicker'
import { ToolField } from './ToolField'
import { defaultUnit, dfmNames, onChoices, quantityOf, type DesignPart } from './model'
import { useCommand, useDesignSelection, type DesignWarnings } from './useDesign'
import { DEFAULTS } from '../../../../core/design/operation'

const m = designMessages
const t = m.inspector
const e = engravingMessages

/** The Boundary select's value for the whole face. */
const FACE = 'face'

type Motif = { preset: string } | { shapeIds: string[] }
type Depth =
  QuantityDTO | { min: QuantityDTO; max: QuantityDTO } | { start: QuantityDTO; end: QuantityDTO }

const sourceOf = (q: unknown): string | undefined =>
  (q as QuantityDTO | undefined)?.source ?? undefined

/** Adjust steps per engraving field (inspector-layout.md § Step assignment per field). */
const STEP: Record<string, StepKind> = {
  'boundary.center.0': 'xy',
  'boundary.center.1': 'xy',
  'boundary.rotation': 'rotation',
  margin: 'xy',
  size: 'xy',
  'center.0': 'xy',
  'center.1': 'xy',
  rotation: 'rotation',
  'depth.max': 'depth',
  'depth.min': 'depth',
  depth: 'depth',
}

export function EngravingInspector({
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

  const motif = feature['motif'] as Motif
  const preset = 'preset' in motif ? motif.preset : undefined
  const unit = operationUnits(part).find((u) => u.id === feature.id)
  const owned = unit?.kind === 'feature' ? unit.ops : []
  const ownedIds = new Set([feature.id, ...owned.map((o) => o.id)])
  const index = Math.max(
    0,
    part.dto.operations.findIndex((o) => ownedIds.has(o.id)),
  )
  const table = part.table
  const ons = table ? onChoices(part.dto, table, index, 'pocket') : []
  const named = (part.dto.shapes ?? []).filter((s) => SHAPE_ID_PATTERN.test(s.id))
  const closedShapes = named.filter(
    (s) => !s.items.some((i) => i.kind === 'path' && i.closed === false),
  )
  const resolved =
    port === undefined ? undefined : engravingResolved(feature.id, part.dto.shapes ?? [], port)
  const facts = resolved?.facts
  const shapesKey = JSON.stringify(named)
  const outlines = useMemo(
    () => new Map(named.map((s) => [s.id, shapeLoops(port, s)])),
    // the shapes' records, not the filtered array (new every render)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [port, shapesKey],
  )
  const shapeOption = (s: { id: string; name: string }) => ({
    value: s.id,
    label: s.name,
    icon: <MiniOutline loops={outlines.get(s.id) ?? []} />,
  })
  const boundary = feature['boundary'] as
    { shapeId: string; center: [QuantityDTO, QuantityDTO]; rotation: QuantityDTO } | undefined
  const center = feature['center'] as [QuantityDTO, QuantityDTO] | undefined
  const fit = (feature['fit'] as string | undefined) ?? 'whole'
  const depth = feature['depth'] as Depth
  const levels = typeof depth === 'object' && 'min' in depth
  const lineOp = owned.find((o) => o.id === `${feature.id}_line`)

  const findings = warnings.warnings.filter((w) => ownedIds.has(w.operation))
  const fieldOf = (w: DfmWarning): string | undefined => {
    if (w.parameter === 'tool') return 'tool'
    const op = part.dto.operations.find((o) => o.id === w.operation)
    return op === undefined ? w.parameter : warningFeatureField(feature, op, w)
  }
  const shown = new Set([
    'motif',
    'on',
    'boundary',
    'margin',
    'fit',
    'size',
    'center',
    'rotation',
    'depth',
    'tool',
  ])
  const unplaced = findings.filter((w) => {
    const f = fieldOf(w)
    return f === undefined || !shown.has(f.split('.')[0]!)
  })

  const update = async (args: Record<string, unknown>, path: string, gesture?: string) => {
    const r = await call(
      'design.engraving.update',
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

  const messagesAt = (path: string): FieldMessage[] => [
    ...errors
      .filter((x) => x.path === path || x.path.startsWith(`${path}.`))
      .map((x, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: x.text })),
    ...findings
      .filter((w) => fieldOf(w) === path)
      .map((w): FieldMessage => ({
        id: `${w.code}:${w.operation}:${path}`,
        severity: dfmMessages.tier(w),
        text: dfmMessages.text(w, units, dfmNames(part.dto)),
      })),
  ]
  const problemAt = (paths: readonly string[]): GroupSeverity | undefined => {
    const ms = paths.flatMap(messagesAt)
    if (ms.some((x) => x.severity === 'error')) return 'error'
    if (ms.some((x) => x.severity === 'hard' || x.severity === 'soft')) return 'warning'
    return undefined
  }

  const quantityField = (
    path: string,
    label: string,
    kind: 'length' | 'angle',
    dto: unknown,
    commit: (source: string | undefined) => Record<string, unknown>,
    opts: { placeholder?: string; optional?: boolean; info?: string } = {},
  ) => (
    <div key={path} data-feature-field={path}>
      <QuantityInput
        label={label}
        kind={kind}
        defaultUnit={defaultUnit(kind, units)}
        value={dto === undefined ? undefined : quantityOf(dto as QuantityDTO)}
        stepKind={STEP[path] ?? 'xy'}
        stepKey={`engraving.${path}`}
        {...(opts.placeholder === undefined ? {} : { placeholder: opts.placeholder })}
        {...(opts.info === undefined ? {} : { info: opts.info })}
        {...(opts.optional === true
          ? {
              optional: true as const,
              onCommit: (q: Quantity | undefined, gesture?: string) =>
                void update(commit(q?.source), path, gesture),
            }
          : {
              onCommit: (q: Quantity, gesture?: string) =>
                void update(commit(q.source), path, gesture),
            })}
        onCancelGesture={cancelGesture}
        messages={messagesAt(path)}
      />
    </div>
  )

  /** The area's box centre (mm): where an empty centre puts the motif. */
  const areaCentre = (): [number, number] => {
    const a = facts?.area
    return a === undefined ? [0, 0] : [(a.min[0] + a.max[0]) / 2, (a.min[1] + a.max[1]) / 2]
  }
  const boundaryCenter = (): string[] =>
    boundary === undefined
      ? []
      : [sourceOf(boundary.center[0]) ?? '0', sourceOf(boundary.center[1]) ?? '0']

  const thumb = useMemo(() => {
    if (preset !== undefined) return presetThumb(preset)
    if (resolved === undefined || facts?.bounds === undefined) return undefined
    // a shapes motif: its placed lines, moved to the frame's corner
    const b = facts.bounds
    const lines = resolved.lines.map((l) => ({
      elements:
        l.shape.contour.kind === 'path'
          ? l.shape.contour.path.elements
          : l.shape.contour.kind === 'region'
            ? l.shape.contour.region.pieces.flatMap((p) => p.outer.elements)
            : [],
      closed: l.shape.contour.kind === 'region',
    }))
    const moved = lines.map((l) => ({
      ...l,
      elements: l.elements.map((x) => ({
        ...x,
        a: [x.a[0] - b.min[0], x.a[1] - b.min[1]] as [number, number],
        b: [x.b[0] - b.min[0], x.b[1] - b.min[1]] as [number, number],
        ...(x.kind === 'arc'
          ? { centre: [x.centre[0] - b.min[0], x.centre[1] - b.min[1]] as [number, number] }
          : {}),
      })),
    }))
    return motifThumb(moved as never, b.max[0] - b.min[0] || 1, b.max[1] - b.min[1] || 1)
  }, [preset, resolved, facts?.bounds])

  const placementMore =
    center !== undefined ||
    !['0', '0°', '0 deg', ''].includes(
      (sourceOf(feature['rotation']) ?? '').replace(/\s+/g, ' ').trim(),
    )
  const shapeIds = 'shapeIds' in motif ? motif.shapeIds : []

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
        <div className={styles['engravingRow']}>
          {thumb === undefined ? null : (
            <MotifPreview thumb={thumb} className={styles['engravingThumb']} />
          )}
          <p className={styles['muted']} data-engraving-readout>
            {facts === undefined
              ? ''
              : e.readout(
                  facts.lines,
                  lengthSource(Math.round(facts.size * 10) / 10, units),
                  lengthSource(Math.round(facts.length), units),
                )}
          </p>
          <EngravingPresetsDialog
            current={preset}
            units={units}
            onApply={(p) => void update({ motif: { preset: p.id } }, 'motif')}
          />
        </div>

        <InspectorGroup title={e.groups.motif}>
          <div data-feature-field="motif">
            <Field label={e.motif} kind="toggle" messages={messagesAt('motif')} info={e.motifNote}>
              <SegmentedControl<string>
                label={e.motif}
                options={['preset', 'shapes']
                  .filter((k) => k === 'preset' || named.length > 0)
                  .map((k) => ({ value: k, label: e.motifKinds[k] ?? k }))}
                value={preset === undefined ? 'shapes' : 'preset'}
                onValueChange={(k) => {
                  if (k === (preset === undefined ? 'shapes' : 'preset')) return
                  const first = named[0]
                  if (k === 'shapes' && first !== undefined)
                    void update({ motif: { shapeIds: [first.id] } }, 'motif')
                  else if (k === 'preset') void update({ motif: { preset: 'rosette' } }, 'motif')
                }}
              />
            </Field>
          </div>
          {preset !== undefined ? (
            <Field label={e.preset} readOnly>
              <span data-engraving-preset={preset}>{e.presetNames[preset] ?? preset}</span>
            </Field>
          ) : (
            shapeIds.map((id, i) => {
              const options = named.map(shapeOption)
              if (!options.some((o) => o.value === id))
                options.push({ value: id, label: e.shapeMissing, icon: <MiniOutline loops={[]} /> })
              return (
                <div key={`${id}-${i}`} data-feature-field={`motif.shapeIds.${i}`}>
                  <Field label={e.shape(i + 1)} messages={messagesAt(`motif.shapeIds.${i}`)}>
                    <Select
                      options={options}
                      value={id}
                      onValueChange={(next) => {
                        const ids = [...shapeIds]
                        ids[i] = next
                        void update({ motif: { shapeIds: ids } }, 'motif')
                      }}
                    />
                  </Field>
                </div>
              )
            })
          )}
        </InspectorGroup>

        <InspectorGroup title={e.groups.area}>
          <div data-feature-field="on">
            <Field label={e.on} messages={messagesAt('on')}>
              <Select
                options={ons.map((c) => ({ value: c.id, label: c.label, group: c.group }))}
                value={feature.on}
                onValueChange={(on) => void update({ on }, 'on')}
              />
            </Field>
          </div>
          <div data-feature-field="boundary">
            <Field label={e.boundary} messages={messagesAt('boundary')}>
              <Select
                options={[{ value: FACE, label: e.boundaryFace }, ...closedShapes.map(shapeOption)]}
                value={boundary?.shapeId ?? FACE}
                onValueChange={(shapeId) => {
                  if (shapeId === (boundary?.shapeId ?? FACE)) return
                  if (shapeId === FACE) return void update({ boundary: null }, 'boundary')
                  const c = areaCentre()
                  const at =
                    boundary === undefined
                      ? [lengthSource(c[0], units), lengthSource(c[1], units)]
                      : boundaryCenter()
                  void update({ boundary: { shapeId, center: at } }, 'boundary')
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
                    e.boundaryCenter(i),
                    'length',
                    boundary.center[i],
                    (s) => {
                      const at = boundaryCenter()
                      at[i] = s ?? '0'
                      const rotation = sourceOf(boundary.rotation)
                      return {
                        boundary: {
                          shapeId: boundary.shapeId,
                          center: at,
                          ...(rotation === undefined ? {} : { rotation }),
                        },
                      }
                    },
                  ),
                ),
                quantityField(
                  'boundary.rotation',
                  e.boundaryRotation,
                  'angle',
                  boundary.rotation,
                  (rotation) => ({
                    boundary: { shapeId: boundary.shapeId, center: boundaryCenter(), rotation },
                  }),
                ),
              ]}
          {quantityField('margin', e.margin, 'length', feature['margin'], (margin) => ({ margin }))}
        </InspectorGroup>

        <InspectorGroup title={e.groups.placement}>
          <div data-feature-field="fit">
            <Field label={e.fit} kind="toggle" messages={messagesAt('fit')} info={e.fitNote}>
              <SegmentedControl<string>
                label={e.fit}
                options={['whole', 'boundary'].map((v) => ({ value: v, label: e.fits[v] ?? v }))}
                value={fit}
                onValueChange={(next) => next !== fit && void update({ fit: next }, 'fit')}
              />
            </Field>
          </div>
          {fit === 'boundary'
            ? null
            : quantityField(
                'size',
                e.size,
                'length',
                feature['size'],
                (s) => ({ size: s ?? null }),
                {
                  optional: true,
                  placeholder:
                    preset === undefined
                      ? e.sizePlaceholder
                      : lengthSource(engravingPreset(preset)?.size[0] ?? 0, units),
                },
              )}
          <InspectorGroup.More
            fields={[e.centerShort, e.rotation]}
            rememberKey="engraving.placement.more"
            forceOpen={
              placementMore || problemAt(['center.0', 'center.1', 'rotation']) !== undefined
            }
          >
            {fit === 'boundary'
              ? null
              : ([0, 1] as const).map((i) =>
                  quantityField(
                    `center.${i}`,
                    e.center(i),
                    'length',
                    center?.[i],
                    (s) => {
                      if (s === undefined) return { center: null }
                      const c = areaCentre()
                      const next = [
                        sourceOf(center?.[0]) ?? lengthSource(c[0], units),
                        sourceOf(center?.[1]) ?? lengthSource(c[1], units),
                      ]
                      next[i] = s
                      return { center: next }
                    },
                    { optional: true, placeholder: e.centerPlaceholder },
                  ),
                )}
            {quantityField(
              'rotation',
              e.rotation,
              'angle',
              feature['rotation'],
              (rotation) => ({ rotation: rotation ?? '0' }),
              { placeholder: '0°' },
            )}
          </InspectorGroup.More>
        </InspectorGroup>

        <InspectorGroup title={e.groups.depth}>
          <div data-feature-field="depth">
            <Field label={e.depthMode} kind="toggle" messages={messagesAt('depth')}>
              <SegmentedControl<string>
                label={e.depthMode}
                options={['levels', 'constant'].map((v) => ({
                  value: v,
                  label: e.depthModes[v] ?? v,
                }))}
                value={levels ? 'levels' : 'constant'}
                onValueChange={(mode) => {
                  if ((mode === 'levels') === levels) return
                  const deepest =
                    typeof depth === 'object' && 'max' in depth
                      ? depth.max.source
                      : typeof depth === 'object' && 'end' in depth
                        ? depth.end.source
                        : (depth as QuantityDTO).source
                  void update(
                    mode === 'levels'
                      ? { depth: { min: DEFAULTS.lineLevelMin[units], max: deepest } }
                      : { depth: deepest },
                    'depth',
                  )
                }}
              />
            </Field>
          </div>
          {levels
            ? [
                quantityField(
                  'depth.max',
                  e.max,
                  'length',
                  (depth as { max: QuantityDTO }).max,
                  (max) => ({
                    depth: { min: (depth as { min: QuantityDTO }).min.source, max },
                  }),
                  { info: e.levelsNote },
                ),
                quantityField(
                  'depth.min',
                  e.min,
                  'length',
                  (depth as { min: QuantityDTO }).min,
                  (min) => ({
                    depth: { min, max: (depth as { max: QuantityDTO }).max.source },
                  }),
                ),
              ]
            : quantityField(
                'depth',
                e.depth,
                'length',
                typeof depth === 'object' && 'start' in depth ? depth.end : depth,
                (d) => ({ depth: d }),
              )}
        </InspectorGroup>

        {lineOp === undefined ? null : (
          <InspectorGroup title={e.groups.cut}>
            <div data-feature-field="tool">
              <ToolField
                part={part}
                op={lineOp}
                warnings={warnings.warnings.filter((w) => w.operation === lineOp.id)}
                label={e.tool}
              />
            </div>
          </InspectorGroup>
        )}

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
