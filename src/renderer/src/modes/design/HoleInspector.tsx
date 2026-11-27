// The hole inspector (v0.4 U2): name, On and Position as a drilling's, Type (Simple / Counterbore
// / Countersink / Recessed countersink, H1: its cb* fields read "Recess …"), Fastener (size, purpose, fit, the sources of the filled sizes), Sizes with the
// section illustration drawn from the entered values (SketchView over the pure holeSection),
// Tools (one tool field per owned operation, each with its lock) and a closed Defaults accordion
// (head sink, a stepped countersink's stepdown). DF110 S4: Type and Fastener are one Type group. A countersink has a Method (Chamfer mill / Stepped, F7) and, stepped, a Stepdown;
// the section then draws the terraces and Tools says whether it shares the hole's end mill. Every edit is one `design.hole.update` (one undo step); a refill that overwrote
// entered sizes says so in the undo toast; errors and findings show at their field, the custom-size
// note with "Use <table value>". The focused size field's measured part is amber in the drawing;
// hovering a part highlights its field's label, clicking it focuses the field.
// H3: the Slotted switch closes the Type group; a slotted hole's Sizes add Slot length, Rotation and
// the read-only Overall after Diameter, and the section is drawn along the slot.
// Doc: docs/conventions/ui.md#hole-inspector, #section-illustration;
// docs/modes/hole-slots-and-round-corners.md#implementation-h3;
// docs/modes/design-v0.4.md#implementation-f3, docs/conventions/inspector-layout.md#s4-implementation-notes
import { useEffect, useRef, useState } from 'react'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { dfmMessages, lengthSource } from '../../messages/dfm'
import { useCancelGesture } from '../../shell/hooks'
import { useShell, useUi } from '../../shell/ShellContext'
import {
  ErrorMessage,
  Field,
  FieldIcon,
  FieldInput,
  Icon,
  IconButton,
  InspectorGroup,
  revealInInspector,
  PanelHeader,
  QuantityInput,
  SegmentedControl,
  Select,
  Switch,
  Term,
  WarningList,
  type FieldIconName,
  type FieldMessage,
  type GroupSeverity,
  type StepKind,
} from '../../ui'
import { holeSection } from '../../viewport/hole-section'
import { SketchView } from '../../viewport/SketchView'
import { warningLabels, warningView } from './DesignInspector'
import styles from './Design.module.css'
import { FIXABLE_FIELDS, operationUnits, warningFeatureField } from './feature-view'
import {
  blindDepth,
  defaultSlotLength,
  headDefaults,
  customSizeNote,
  enteredSizesReplaced,
  fastenerSources,
  followingHead,
  holeRecord,
  sectionValues,
  sharedToolNote,
  sizeFields,
  slotOverall,
  stockBelow,
  type CsMethod,
  type FastenerList,
  type HoleFit,
  type HolePurpose,
  type RefillChoice,
  type HoleSizeField,
  type HoleType,
} from './hole-view'
import { NameField } from './NameField'
import { placeErrors, refusalText, type FieldError } from './OperationFields'
import { sameTool, ToolField } from './ToolField'
import {
  axisNames,
  defaultUnit,
  onChoices,
  quantityOf,
  referenceChoices,
  surfaceDirection,
  type DesignPart,
  dfmNames,
} from './model'
import { useCommand, useDesignSelection, type DesignWarnings } from './useDesign'
import { CutField } from './CutField'

const m = designMessages
const t = m.inspector
const h = m.features.hole

const TYPES: readonly HoleType[] = ['simple', 'counterbore', 'countersink', 'recessedCountersink']
const TYPE_ICON = {
  simple: 'hole-simple',
  counterbore: 'hole-counterbore',
  countersink: 'hole-countersink',
  recessedCountersink: 'hole-recessed-countersink',
} as const

/** A size field's label; a recessed countersink's cb* fields are its recess (H1). */
const fieldLabel = (field: HoleSizeField, type: HoleType): string =>
  type === 'recessedCountersink' && field === 'cbDiameter'
    ? h.recessDiameter
    : type === 'recessedCountersink' && field === 'cbDepth'
      ? h.recessDepth
      : FIELD_LABEL[field]

const FIELD_LABEL: Record<HoleSizeField, string> = {
  diameter: h.diameter,
  depth: h.depth,
  cbDiameter: h.cbDiameter,
  cbDepth: h.cbDepth,
  csDiameter: h.csDiameter,
  csAngle: h.csAngle,
  csStepdown: h.csStepdown,
  headSink: h.headSink,
}
/** Adjust steps per size field (inspector-layout.md § Step assignment per field). */
const FIELD_STEP: Record<HoleSizeField, StepKind> = {
  diameter: 'small',
  depth: 'depth',
  cbDiameter: 'small',
  cbDepth: 'depth',
  csDiameter: 'small',
  csAngle: 'angle',
  csStepdown: 'stepdown',
  headSink: 'depth',
}
const FIELD_ICON: Record<HoleSizeField, FieldIconName> = {
  diameter: 'diameter',
  depth: 'depth',
  cbDiameter: 'counterboreDiameter',
  cbDepth: 'counterboreDepth',
  csDiameter: 'countersinkDiameter',
  csAngle: 'chamfer',
  csStepdown: 'stepdown',
  headSink: 'headSink',
}

/** `design.fastener.list` once per window (static table). */
let fastenerCache: FastenerList | undefined
function useFastenerList(): FastenerList | undefined {
  const { bridge } = useShell()
  const [list, setList] = useState(fastenerCache)
  useEffect(() => {
    if (list !== undefined) return
    let live = true
    void bridge.call('design.fastener.list', {}).then((r) => {
      if (!r.ok) return
      fastenerCache = r.value as FastenerList
      if (live) setList(fastenerCache)
    })
    return () => {
      live = false
    }
  }, [bridge, list])
  return list
}

export function HoleInspector({
  part,
  feature,
  warnings,
}: {
  part: DesignPart
  feature: FeatureDTO
  warnings: DesignWarnings
}): React.JSX.Element {
  const call = useCommand()
  const { ui } = useShell()
  const [, select] = useDesignSelection()
  const cancelGesture = useCancelGesture()
  const focus = useUi((s) => s.featureFocus)
  const pick = useUi((s) => s.pick)
  const setPick = useUi((s) => s.setPick)
  const fasteners = useFastenerList()
  const rows = fasteners?.rows ?? []
  const rootRef = useRef<HTMLDivElement>(null)
  const [summary, setSummary] = useState<AppErrorData | undefined>(undefined)
  const [errors, setErrors] = useState<FieldError[]>([])
  const [focused, setFocused] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)

  const hole = holeRecord(feature)
  const units = part.units
  const unit = operationUnits(part).find((u) => u.id === feature.id)
  const owned = unit?.kind === 'feature' ? unit.ops : []
  const ownedIds = new Set([feature.id, ...owned.map((o) => o.id)])
  // where the hole's block starts: references and `on` choices are those before it
  const index = Math.max(
    0,
    part.dto.operations.findIndex((o) => ownedIds.has(o.id)),
  )
  const table = part.table
  const resolver = table?.resolver(index)
  const choices = table ? referenceChoices(part.dto, table, index) : []
  const references = choices.map((c) => ({ id: c.id, label: c.label }))
  const names = axisNames(surfaceDirection(table, hole.on))

  // findings of the hole and its operations: at the field they map to, else listed
  const findings = warnings.warnings.filter((w) => ownedIds.has(w.operation))
  const fieldOf = (w: DfmWarning): string | undefined => {
    const op = part.dto.operations.find((o) => o.id === w.operation)
    if (w.parameter === 'tool') return 'tool'
    const f = op === undefined ? w.parameter : warningFeatureField(feature, op, w)
    return f === 'center' ? 'center.0' : f
  }
  const shown = new Set<string>([
    'center.0',
    'center.1',
    'on',
    'bottom',
    'type',
    'purpose',
    'tool',
    ...sizeFields(hole),
    'headSink',
    'slotted',
    ...(hole.slot !== undefined ? ['slotLength', 'rotation'] : []),
    ...(hole.type === 'countersink' ? ['csMethod'] : []),
    ...(hole.type === 'countersink' && hole.csMethod === 'stepped' ? ['csStepdown'] : []),
  ])
  const unplaced = findings.filter((w) => {
    const f = fieldOf(w)
    return f === undefined || !shown.has(f)
  })
  const custom = new Set(
    findings
      .filter((w) => w.code === 'dfm.holeCustomSize')
      .map((w) => String(w.params['field'] ?? w.parameter)),
  )

  const update = async (args: Record<string, unknown>, path: string, gesture?: string) => {
    const r = await call(
      'design.hole.update',
      { partId: part.dto.id, featureId: feature.id, ...args },
      gesture === undefined ? undefined : { gesture },
    )
    if (r.ok) {
      setErrors((e) => e.filter((x) => x.path !== path))
      setSummary(undefined)
      return true
    }
    const placed = placeErrors(r.error, path)
    // an issue at a field the inspector does not show (yet): a refused type change's head size
    // shows at the choice that caused it, not nowhere (X2)
    setErrors(placed.errors.map((e) => (shown.has(e.path) ? e : { ...e, path })))
    setSummary(placed.summary)
    return false
  }

  /**
   * A fastener, purpose or fit choice: one update that refills every size; when that overwrites
   * sizes the user had entered, the undo toast says how many (ui.md § Hole inspector, Refill).
   */
  const refillWith = (args: Partial<RefillChoice>, path: string) => {
    const next: RefillChoice = {
      type: args.type ?? hole.type,
      fastener: 'fastener' in args ? args.fastener : hole.fastener,
      purpose: args.purpose ?? hole.purpose,
      fit: args.fit ?? hole.fit,
    }
    const n = enteredSizesReplaced(hole, next, custom, units)
    void update(args, path).then((ok) => {
      if (ok && n > 0 && next.fastener !== undefined)
        ui.getState().setRemovedToast(h.refilled(next.fastener, n))
    })
  }

  // focusing a field (a click on its part of the drawing, "Edited through", "Fix in"): the
  // Defaults accordion opens first when the field is in it
  useEffect(() => {
    if (focus === null || focus.featureId !== feature.id) return
    ui.getState().setFeatureFocus(null)
    const field = focus.field
    // after this render (the reveal's flushSync may not run inside an effect)
    requestAnimationFrame(() => focusFeatureField(rootRef.current, field))
  }, [focus, feature.id, ui])

  // ── the drawing ──
  const sketch = holeSection(
    sectionValues(
      hole,
      part,
      rows,
      errors.map((e) => e.path),
    ),
    units,
  )

  const messagesAt = (path: string): FieldMessage[] => [
    ...errors
      .filter((e) => e.path === path)
      .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text })),
    ...findings
      .filter((w) => fieldOf(w) === path)
      .map((w): FieldMessage => {
        const note = customSizeNote(w, units)
        if (note !== undefined)
          return {
            id: `${w.code}:${path}`,
            severity: dfmMessages.tier(w),
            text: note.text,
            fix: {
              label: h.useTable(note.source),
              onApply: () => void update({ [path]: note.source }, path),
            },
          }
        const source = dfmMessages.suggestionSource(w, units)
        return {
          id: `${w.code}:${w.operation}:${path}`,
          severity: dfmMessages.tier(w),
          text: dfmMessages.text(w, units, dfmNames(part.dto)),
          ...(source !== undefined && w.suggestion !== undefined && FIXABLE_FIELDS.has(path)
            ? {
                fix: {
                  label: dfmMessages.useValue(w.suggestion.relation, source),
                  onApply: () => void update({ [path]: source }, path),
                },
              }
            : {}),
        }
      }),
  ]

  const track = (field: string) => ({
    'data-feature-field': field,
    'data-hovered': hovered === field || undefined,
    onFocus: () => setFocused(field),
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null))
        setFocused((f) => (f === field ? null : f))
    },
  })

  const sizeField = (field: HoleSizeField) => {
    const dto = hole.sizes[field]
    const angle = field === 'csAngle'
    return (
      <div key={field} className={styles['holeField']} {...track(field)}>
        <QuantityInput
          label={fieldLabel(field, hole.type)}
          kind={angle ? 'angle' : 'length'}
          defaultUnit={defaultUnit(angle ? 'angle' : 'length', units)}
          value={dto === undefined ? undefined : quantityOf(dto)}
          onCommit={(q, gesture) =>
            void update(
              {
                [field]: q.source,
                // X2-8: a starting head follows the new diameter or depth
                ...(field === 'diameter' || field === 'depth'
                  ? followingHead(hole, { [field]: q.canonical }, units, stockBelow(part, hole.on))
                  : {}),
              },
              field,
              gesture,
            )
          }
          stepKind={FIELD_STEP[field]}
          stepKey={`hole.${field}`}
          onCancelGesture={cancelGesture}
          illustration={<FieldIcon name={FIELD_ICON[field]} />}
          messages={messagesAt(field)}
          references={references}
          {...(resolver ? { resolver } : {})}
        />
      </div>
    )
  }

  const centerField = (i: 0 | 1) => {
    const path = `center.${i}`
    return (
      <div className={styles['holeField']} {...track(path)}>
        <QuantityInput
          label={t.position('Centre', i === 0 ? names.u : names.v)}
          stepKind="xy"
          stepKey={`hole.${path}`}
          kind="length"
          defaultUnit={defaultUnit('length', units)}
          value={quantityOf(hole.center[i])}
          onCommit={(q, gesture) => {
            const center = [hole.center[0].source, hole.center[1].source]
            center[i] = q.source
            void update({ center }, path, gesture)
          }}
          onCancelGesture={cancelGesture}
          illustration={<FieldIcon name={i === 0 ? 'positionX' : 'positionY'} />}
          messages={messagesAt(path)}
          references={references}
          {...(resolver ? { resolver } : {})}
        />
      </div>
    )
  }

  // ── the slot (H3) ──
  const slotField = (field: 'slotLength' | 'rotation') => {
    const angle = field === 'rotation'
    const dto = field === 'rotation' ? hole.slot?.rotation : hole.slot?.length
    return (
      <div key={field} className={styles['holeField']} {...track(field)}>
        <QuantityInput
          label={angle ? h.rotation : h.slotLength}
          kind={angle ? 'angle' : 'length'}
          defaultUnit={defaultUnit(angle ? 'angle' : 'length', units)}
          value={dto === undefined ? undefined : quantityOf(dto)}
          onCommit={(q, gesture) => void update({ [field]: q.source }, field, gesture)}
          stepKind={angle ? 'rotation' : 'xy'}
          stepKey={`hole.${field}`}
          onCancelGesture={cancelGesture}
          illustration={<FieldIcon name={angle ? 'rotation' : 'slotTravel'} />}
          {...(angle ? {} : { info: h.slotLengthInfo })}
          messages={messagesAt(field)}
          references={references}
          {...(resolver ? { resolver } : {})}
        />
      </div>
    )
  }
  const overall = slotOverall(hole)
  const slotFields =
    hole.slot === undefined ? null : (
      <>
        {slotField('slotLength')}
        {slotField('rotation')}
        <Field
          label={h.overall}
          illustration={<FieldIcon name="slotLength" />}
          readOnly
          info={h.overallInfo}
        >
          <FieldInput
            readOnly
            data-slot-overall
            value={overall === undefined ? '' : lengthSource(overall, units)}
          />
        </Field>
      </>
    )

  const onOwner = `${feature.id}:on`
  const picking = pick?.owner === onOwner
  const ons = table ? onChoices(part.dto, table, index, 'drilling') : []
  const onField = (
    <div className={styles['onRow']} {...track('on')}>
      <Field label={h.on} messages={messagesAt('on')}>
        <Select
          options={ons.map((c) => ({
            value: c.id,
            label: c.label,
            group: c.group,
          }))}
          value={hole.on}
          onValueChange={(on) => void update({ on }, 'on')}
        />
      </Field>
      <IconButton
        label={t.pickOn}
        shortcut="Alt+P"
        icon={<Icon name="pick" />}
        pressed={picking}
        className={styles['pickButton']}
        onClick={() =>
          picking
            ? setPick(null)
            : setPick({
                owner: onOwner,
                field: h.on,
                eligible: new Set(ons.map((c) => c.id)),
                onPick: (surface) => void update({ on: surface }, 'on'),
              })
        }
      />
    </div>
  )

  // ── type, fastener ──
  const headed = hole.type !== 'simple'
  const typeMessages: FieldMessage[] = messagesAt('type')
  const chooseType = (type: HoleType) => {
    if (type === hole.type) return
    // a tap drill hole is simple: a head makes it a clearance hole (refilled from the table)
    if (type !== 'simple' && hole.purpose === 'tapDrill')
      refillWith({ type, purpose: 'clearance' }, 'type')
    // without a fastener the core needs the head's sizes: proportional starting values
    else if (hole.fastener === undefined && type !== 'simple')
      void update({ type, ...headDefaults(hole, type, units, stockBelow(part, hole.on)) }, 'type')
    else void update({ type }, 'type')
  }
  const purposeMessages: FieldMessage[] = messagesAt('purpose')
  const sources = fastenerSources(hole, rows)
  const refOf = (key: string) => fasteners?.sources.find((s) => s.key === key)?.ref ?? key

  // ── tools ──
  const opWarnings = (id: string) => warnings.warnings.filter((w) => w.operation === id)
  const toolNote = sharedToolNote(hole, owned, sameTool)

  // ── countersink method (F7) ──
  const methodField =
    hole.type === 'countersink' ? (
      <div {...track('csMethod')}>
        <Field label={h.csMethod} kind="toggle" messages={messagesAt('csMethod')}>
          <SegmentedControl<CsMethod>
            label={h.csMethod}
            options={(['chamfer', 'stepped'] as const).map((v) => ({
              value: v,
              label: h.csMethods[v] ?? v,
            }))}
            value={hole.csMethod}
            onValueChange={(csMethod) =>
              csMethod !== hole.csMethod && void update({ csMethod }, 'csMethod')
            }
          />
        </Field>
      </div>
    ) : null

  const stepped = hole.type === 'countersink' && hole.csMethod === 'stepped'
  const defaultsMessages = [...messagesAt('headSink'), ...(stepped ? messagesAt('csStepdown') : [])]
  const defaultsProblem: GroupSeverity | undefined = defaultsMessages.some(
    (x) => x.severity === 'error',
  )
    ? 'error'
    : defaultsMessages.some((x) => x.severity === 'hard' || x.severity === 'soft')
      ? 'warning'
      : undefined

  return (
    <div ref={rootRef} className={styles['inspector']}>
      <PanelHeader title={feature.name} itemId={feature.id} />
      <div className={styles['fields']}>
        {summary ? <ErrorMessage error={summary} message={refusalText(summary, part.dto)} /> : null}
        <NameField
          label={t.name}
          name={feature.name}
          onCommit={(name) => void update({ name }, 'name')}
        />
        {/* DF135 C3: the same mark as the row menu's (cut-state.md#implementation-c3) */}
        <CutField part={part} id={feature.id} />

        <InspectorGroup title={h.groups.position}>
          {onField}
          {centerField(0)}
          {centerField(1)}
        </InspectorGroup>

        <InspectorGroup title={h.groups.type}>
          <div {...track('type')}>
            <Field label={h.type} kind="toggle" messages={typeMessages}>
              <SegmentedControl<HoleType>
                label={h.type}
                options={TYPES.map((type) => ({
                  value: type,
                  label: h.typesShort[type] ?? h.types[type] ?? type,
                  ...(h.typesShort[type] === undefined ? {} : { fullLabel: h.types[type] ?? type }),
                  icon: <Icon name={TYPE_ICON[type]} size="sm" />,
                }))}
                value={hole.type}
                onValueChange={chooseType}
                className={styles['holeTypes']}
              />
            </Field>
          </div>
          <div {...track('fastener')}>
            <Field label={h.size} messages={messagesAt('fastener')}>
              <Select
                options={[
                  { value: 'custom', label: h.custom },
                  ...rows.map((r) => ({ value: r.size, label: r.size })),
                ]}
                value={hole.fastener ?? 'custom'}
                onValueChange={(v) =>
                  v === 'custom'
                    ? void update({ fastener: null }, 'fastener')
                    : refillWith({ fastener: v }, 'fastener')
                }
              />
            </Field>
          </div>
          <div {...track('purpose')}>
            {/* design review R11: why Tap drill is disabled is the field's (i), not a box */}
            <Field
              label={h.purpose}
              kind="toggle"
              messages={purposeMessages}
              info={headed ? h.tapDrillSimple : undefined}
            >
              <SegmentedControl<HolePurpose>
                label={h.purpose}
                options={(['clearance', 'tapDrill'] as const).map((p) => ({
                  value: p,
                  label: h.purposes[p] ?? p,
                  disabled: p === 'tapDrill' && headed,
                }))}
                value={hole.purpose}
                onValueChange={(purpose) => refillWith({ purpose }, 'purpose')}
              />
            </Field>
          </div>
          {hole.purpose === 'clearance' ? (
            <div {...track('fit')}>
              <Field label={h.fit} kind="toggle" messages={messagesAt('fit')}>
                <SegmentedControl<HoleFit>
                  label={h.fit}
                  options={(['close', 'normal', 'loose'] as const).map((f) => ({
                    value: f,
                    label: h.fits[f] ?? f,
                  }))}
                  value={hole.fit}
                  onValueChange={(fit) => refillWith({ fit }, 'fit')}
                />
              </Field>
            </div>
          ) : null}
          <div {...track('slotted')}>
            <Field
              label={h.slotted}
              kind="toggle"
              info={h.slottedInfo}
              messages={messagesAt('slotted')}
            >
              <Switch
                label={h.slotted}
                hideLabel
                checked={hole.slot !== undefined}
                onCheckedChange={(on) =>
                  void update({ slotLength: on ? defaultSlotLength(hole, units) : '0' }, 'slotted')
                }
              />
            </Field>
          </div>
          {sources.length > 0 ? (
            <p className={styles['muted']}>
              <span className={styles['srOnly']}>{h.sourcesLabel} </span>
              {sources.map(([key, what], i) => (
                <span key={key}>
                  {i > 0 ? ' · ' : null}
                  <Term definition={refOf(key)}>{key}</Term> {h.sourceWhat[what] ?? what}
                </span>
              ))}
            </p>
          ) : null}
        </InspectorGroup>

        <InspectorGroup title={h.groups.sizes}>
          <SketchView
            sketch={sketch}
            highlighted={focused ?? undefined}
            onPartHover={setHovered}
            onPartClick={(field) => focusFeatureField(rootRef.current, field)}
            className={styles['holeSketch']}
          />
          {sizeField('diameter')}
          {slotFields}
          <div {...track('bottom')}>
            <Field label={h.bottom} messages={messagesAt('bottom')}>
              <Select
                options={(['through', 'flat', 'drillPoint'] as const).map((b) => ({
                  value: b,
                  label: t.bottoms[b],
                }))}
                value={hole.bottom}
                onValueChange={(bottom) =>
                  void update(
                    bottom === 'through' || hole.sizes.depth !== undefined
                      ? { bottom }
                      : { bottom, depth: lengthSource(blindDepth(hole), units) },
                    'bottom',
                  )
                }
              />
            </Field>
          </div>
          {sizeFields(hole).slice(1).map(sizeField)}
          {methodField}
        </InspectorGroup>

        {owned.length > 0 ? (
          <InspectorGroup title={h.groups.tools}>
            {owned.map((op) => (
              <div key={op.id} {...track(`tool:${op.id}`)}>
                <ToolField
                  part={part}
                  op={op}
                  warnings={opWarnings(op.id)}
                  label={h.roleLabel(
                    hole.type === 'recessedCountersink' && op.featureRole === 'counterbore'
                      ? 'recess'
                      : hole.slot !== undefined && op.featureRole === 'drill'
                        ? 'slot'
                        : (op.featureRole ?? op.kind),
                  )}
                />
                {toolNote !== undefined && op.featureRole === 'countersink' ? (
                  <p className={styles['muted']} data-shared-tool={toolNote}>
                    {h.sharedTool[toolNote]}
                  </p>
                ) : null}
              </div>
            ))}
          </InspectorGroup>
        ) : null}

        {/* DF110: set once if ever, a closed accordion after Tools; a problem opens it */}
        <InspectorGroup
          title={h.groups.defaults}
          collapsible
          rememberKey="hole.defaults"
          summary={h.defaultsSummary(
            hole.sizes.headSink?.source,
            stepped ? hole.sizes.csStepdown?.source : undefined,
          )}
          info={h.defaultsHint}
          severity={defaultsProblem}
          forceOpen={defaultsProblem !== undefined}
          data-defaults
        >
          {sizeField('headSink')}
          {stepped ? sizeField('csStepdown') : null}
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

/**
 * Focuses a hole field by its path (`cbDepth`, `center.0`; `center` = its first): the control in
 * its `data-feature-field` wrapper. A field in the closed Defaults accordion (head sink) is
 * revealed first (DF110: the accordion opens itself).
 */
function focusFeatureField(root: HTMLElement | null, field: string): void {
  if (root === null) return
  const wrappers = [...root.querySelectorAll<HTMLElement>('[data-feature-field]')]
  const target =
    wrappers.find((w) => w.dataset['featureField'] === field) ??
    wrappers.find((w) => field.startsWith(`${w.dataset['featureField']}.`)) ??
    wrappers.find((w) => w.dataset['featureField']?.startsWith(`${field}.`))
  revealInInspector(target)
  target?.querySelector<HTMLElement>('input, [role="combobox"], button[data-state="on"]')?.focus()
}
