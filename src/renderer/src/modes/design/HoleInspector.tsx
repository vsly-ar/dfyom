// The hole inspector (v0.4 U2): name, On and Position as a drilling's, Type (Simple / Counterbore
// / Countersink), Fastener (size, purpose, fit, the sources of the filled sizes), Sizes with the
// section illustration drawn from the entered values (SketchView over the pure holeSection), a
// collapsed Defaults group (head sink) and Tools (one tool field per owned operation, each with
// its lock). A countersink has a Method (Chamfer mill / Stepped, F7) and, stepped, a Stepdown;
// the section then draws the terraces and Tools says whether it shares the hole's end mill. Every edit is one `design.hole.update` (one undo step); a refill that overwrote
// entered sizes says so in the undo toast; errors and findings show at their field, the custom-size
// note with "Use <table value>". The focused size field's measured part is amber in the drawing;
// hovering a part highlights its field's label, clicking it focuses the field.
// Doc: docs/conventions/ui.md#hole-inspector, #section-illustration;
// docs/modes/design-v0.4.md#implementation-f3
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
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
  Icon,
  IconButton,
  PanelHeader,
  QuantityInput,
  SegmentedControl,
  Select,
  Term,
  WarningList,
  type FieldIconName,
  type FieldMessage,
} from '../../ui'
import { holeSection } from '../../viewport/hole-section'
import { SketchView } from '../../viewport/SketchView'
import { warningLabels, warningView } from './DesignInspector'
import styles from './Design.module.css'
import { FIXABLE_FIELDS, operationUnits, warningFeatureField } from './feature-view'
import {
  blindDepth,
  headDefaults,
  customSizeNote,
  enteredSizesReplaced,
  fastenerSources,
  holeRecord,
  sectionValues,
  sharedToolNote,
  sizeFields,
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
import { placeErrors, type FieldError } from './OperationFields'
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

const m = designMessages
const t = m.inspector
const h = m.features.hole

const TYPES: readonly HoleType[] = ['simple', 'counterbore', 'countersink']
const TYPE_ICON = {
  simple: 'hole-simple',
  counterbore: 'hole-counterbore',
  countersink: 'hole-countersink',
} as const

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
  const [defaultsOpen, setDefaultsOpen] = useState(false)

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
  // Defaults group opens first when the field is in it
  const openDefaults = () => flushSync(() => setDefaultsOpen(true))
  useEffect(() => {
    if (focus === null || focus.featureId !== feature.id) return
    ui.getState().setFeatureFocus(null)
    const field = focus.field
    // after this render (flushSync may not run inside an effect)
    requestAnimationFrame(() =>
      focusFeatureField(rootRef.current, field, () => flushSync(() => setDefaultsOpen(true))),
    )
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
          label={FIELD_LABEL[field]}
          kind={angle ? 'angle' : 'length'}
          defaultUnit={defaultUnit(angle ? 'angle' : 'length', units)}
          value={dto === undefined ? undefined : quantityOf(dto)}
          onCommit={(q, gesture) => void update({ [field]: q.source }, field, gesture)}
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
          label={t.position('Center', i === 0 ? names.u : names.v)}
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
  const purposeMessages: FieldMessage[] = [
    ...messagesAt('purpose'),
    ...(headed
      ? [{ id: 'tapDrillSimple', severity: 'note' as const, text: h.tapDrillSimple }]
      : []),
  ]
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

  return (
    <div ref={rootRef} className={styles['inspector']}>
      <PanelHeader title={feature.name} itemId={feature.id} />
      <div className={styles['fields']}>
        {summary ? <ErrorMessage error={summary} message={t.commandFailed} /> : null}
        <NameField
          label={t.name}
          name={feature.name}
          onCommit={(name) => void update({ name }, 'name')}
        />

        <Group title={h.groups.position}>
          {onField}
          {centerField(0)}
          {centerField(1)}
        </Group>

        <Group title={h.groups.type}>
          <div {...track('type')}>
            <Field label={h.type} kind="toggle" messages={typeMessages}>
              <SegmentedControl<HoleType>
                label={h.type}
                options={TYPES.map((type) => ({
                  value: type,
                  label: h.types[type] ?? type,
                  icon: <Icon name={TYPE_ICON[type]} size="sm" />,
                }))}
                value={hole.type}
                onValueChange={chooseType}
                className={styles['holeTypes']}
              />
            </Field>
          </div>
        </Group>

        <Group title={h.groups.fastener}>
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
            <Field label={h.purpose} kind="toggle" messages={purposeMessages}>
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
        </Group>

        <Group title={h.groups.sizes}>
          <SketchView
            sketch={sketch}
            highlighted={focused ?? undefined}
            onPartHover={setHovered}
            onPartClick={(field) => focusFeatureField(rootRef.current, field, openDefaults)}
            className={styles['holeSketch']}
          />
          {sizeField('diameter')}
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
          {hole.type === 'countersink' && hole.csMethod === 'stepped'
            ? sizeField('csStepdown')
            : null}
          <section className={styles['holeDefaults']} data-defaults aria-label={h.groups.defaults}>
            <h4 className={styles['groupTitle']}>
              <button
                type="button"
                className={styles['disclosure']}
                aria-expanded={defaultsOpen}
                onClick={() => setDefaultsOpen(!defaultsOpen)}
              >
                <span className={styles['chevronInline']} data-open={defaultsOpen || undefined}>
                  <Icon name="chevron-down" size="sm" />
                </span>
                {h.groups.defaults}
              </button>
            </h4>
            {defaultsOpen ? (
              <>
                <p className={styles['muted']}>{h.defaultsHint}</p>
                {sizeField('headSink')}
              </>
            ) : null}
          </section>
        </Group>

        {owned.length > 0 ? (
          <Group title={h.groups.tools}>
            {owned.map((op) => (
              <div key={op.id} {...track(`tool:${op.id}`)}>
                <ToolField
                  part={part}
                  op={op}
                  warnings={opWarnings(op.id)}
                  label={h.roleLabel(op.featureRole ?? op.kind)}
                />
                {toolNote !== undefined && op.featureRole === 'countersink' ? (
                  <p className={styles['muted']} data-shared-tool={toolNote}>
                    {h.sharedTool[toolNote]}
                  </p>
                ) : null}
              </div>
            ))}
          </Group>
        ) : null}

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

/**
 * Focuses a hole field by its path (`cbDepth`, `center.0`; `center` = its first): the control in
 * its `data-feature-field` wrapper. `openDefaults` renders the collapsed Defaults group first
 * when the field is not shown (head sink).
 */
function focusFeatureField(
  root: HTMLElement | null,
  field: string,
  openDefaults: () => void,
): void {
  if (root === null) return
  const find = () => {
    const wrappers = [...root.querySelectorAll<HTMLElement>('[data-feature-field]')]
    return (
      wrappers.find((w) => w.dataset['featureField'] === field) ??
      wrappers.find((w) => field.startsWith(`${w.dataset['featureField']}.`)) ??
      wrappers.find((w) => w.dataset['featureField']?.startsWith(`${field}.`))
    )
  }
  let target = find()
  if (target === undefined && field === 'headSink') {
    openDefaults()
    target = find()
  }
  target?.querySelector<HTMLElement>('input, [role="combobox"], button[data-state="on"]')?.focus()
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
