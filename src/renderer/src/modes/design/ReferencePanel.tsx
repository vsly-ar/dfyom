// The Reference panel (dogfood DF2, DF3, DF5–DF8; replaced D45's Reference dialog and the R3
// reference inspector): shown in the right sidebar while the toolbar's "Reference" toggle is
// pressed. Import / replace / remove the STL, the visibility toggle, "See through stock", the
// placed size, source unit, scale with its anchor (a scale change keeps the anchor point),
// rotation, position, the Levels and Section rows (DF60, ReferenceTools.tsx) and the warnings;
// "Fit to stock…" swaps the body for Fit mode (scale to fit,
// margin, anchor, height, live ghost preview, Apply / Cancel). Every edit is one
// `design.reference.update` (one undo step); visibility, see-through and the preview are per
// window view state, never commands.
// Doc: docs/conventions/ui.md#reference-panel-hardening-df2df8, docs/modes/reference-model.md#display
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  FIT_AXES,
  FIT_Z,
  placedExtent,
  type FitAxis,
  type FitZ,
  type ReferenceWarning,
  type SourceUnit,
} from '../../../../core/design/reference'
import type { ReferenceDTO } from '../../../../core/design/reference.dto'
import { fieldContext } from '../../../../core/design/operation'
import { Quantity } from '../../../../core/quantity/quantity'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { dfmMessages } from '../../messages/dfm'
import { referenceMessages } from '../../messages/reference'
import { useCancelGesture } from '../../shell/hooks'
import { useShell, useUi } from '../../shell/ShellContext'
import {
  AnchorPicker,
  Button,
  Checkbox,
  ErrorMessage,
  Field,
  Icon,
  IconButton,
  PanelHeader,
  QuantityInput,
  SegmentedControl,
  Select,
  WarningList,
  type AnchorValue,
  type FieldMessage,
  type WarningView,
} from '../../ui'
import styles from './Design.module.css'
import { defaultUnit, quantityOf, type DesignPart } from './model'
import { placeErrors, type FieldError } from './OperationFields'
import { ReferenceTools } from './ReferenceTools'
import {
  fitPreview,
  lengthSource,
  liveWarnings,
  referencePlacement,
  scaleAbout,
  sizeText,
  sourceSize,
  stockSizeOf,
  unitGuessOf,
} from './reference-view'
import {
  useCommand,
  useDesignReferences,
  useDesignSelection,
  type DesignReference,
} from './useDesign'

const m = referenceMessages
const t = m.inspector
const AXES = ['x', 'y', 'z'] as const
const UNITS: readonly SourceUnit[] = ['mm', 'inch']

const warningLabels = {
  list: t.warnings,
  dismiss: dfmMessages.dismiss,
  dismissed: dfmMessages.dismissed,
  show: dfmMessages.show,
  hide: dfmMessages.hide,
  tier: dfmMessages.severity,
}

const warningView = (w: ReferenceWarning): WarningView => ({
  id: `${w.code}:${w.referenceId}`,
  tier: w.severity === 'info' ? 'soft' : 'hard',
  text: w.message,
})

const note = (id: string, text: string): FieldMessage => ({ id, severity: 'note', text })

interface Imported {
  readonly referenceId: string
  readonly warnings: readonly ReferenceWarning[]
}

/** The right sidebar's Reference panel (design mode, `referencePanel` in the UI store). */
export function ReferencePanel({ part }: { part: DesignPart | undefined }): React.JSX.Element {
  const setDialog = useUi((s) => s.setDesignDialog)
  return (
    <div className={styles['inspector']}>
      <PanelHeader title={m.title} />
      {part === undefined ? (
        <div className={styles['fields']}>
          <p className={styles['note']}>{m.panel.noPart}</p>
          <div className={styles['setupActions']}>
            <Button size="sm" icon={<Icon name="stock" />} onClick={() => setDialog('stock')}>
              {m.panel.setUpStock}
            </Button>
          </div>
        </div>
      ) : (
        <PanelBody part={part} />
      )}
    </div>
  )
}

function PanelBody({ part }: { part: DesignPart }): React.JSX.Element {
  const { bridge } = useShell()
  const call = useCommand()
  const [selected] = useDesignSelection()
  const references = useDesignReferences(part)
  const openPanel = useUi((s) => s.openReferencePanel)
  const setNotes = useUi((s) => s.setReferenceNotes)
  const setRemovedToast = useUi((s) => s.setRemovedToast)
  const [busy, setBusy] = useState<'importing' | 'replacing' | null>(null)
  const [error, setError] = useState<{ error: AppErrorData; replace: boolean } | undefined>()
  const current = references.find((r) => r.ref.id === selected) ?? references[0]
  // the panel's reference is the design selection (an agent's import while it is open, a remove)
  const currentId = current?.ref.id ?? null
  useEffect(() => {
    if (currentId !== selected) openPanel(currentId)
  }, [currentId, selected, openPanel])

  /** Import a chosen STL (fitted centre + top); with `replace`, then remove that reference. */
  const importReference = async (replace?: DesignReference) => {
    const path = await bridge.files.chooseReference()
    if (path === null) return
    setBusy(replace ? 'replacing' : 'importing')
    const r = await call('design.reference.import', { partId: part.dto.id, path })
    if (r.ok && replace)
      await call('design.reference.remove', { partId: part.dto.id, referenceId: replace.ref.id })
    setBusy(null)
    setError(r.ok ? undefined : { error: r.error, replace: replace !== undefined })
    if (!r.ok) return
    const { referenceId, warnings } = r.value as Imported
    setNotes(referenceId, warnings)
    openPanel(referenceId)
  }
  const remove = async (ref: ReferenceDTO) => {
    const r = await call('design.reference.remove', { partId: part.dto.id, referenceId: ref.id })
    if (!r.ok) return
    openPanel(references.find((x) => x.ref.id !== ref.id)?.ref.id ?? null)
    setRemovedToast(designMessages.navigator.removed(ref.name))
  }

  const status = busy ? (
    <p className={styles['note']} role="status">
      {busy === 'importing' ? m.importing : m.replacing}
    </p>
  ) : null
  const failure = error ? (
    <ErrorMessage error={error.error} message={error.replace ? m.replaceFailed : m.importFailed} />
  ) : null

  if (current === undefined)
    return (
      <div className={styles['fields']}>
        <p className={styles['note']}>{m.empty}</p>
        <div className={styles['setupActions']}>
          <Button
            size="sm"
            icon={<Icon name="import" />}
            disabled={busy !== null}
            onClick={() => void importReference()}
          >
            {m.importStl}
          </Button>
        </div>
        {status}
        {failure}
      </div>
    )
  return (
    <ReferenceBody
      key={current.ref.id}
      part={part}
      current={current}
      references={references}
      busy={busy !== null}
      status={status}
      failure={failure}
      onChoose={openPanel}
      onReplace={() => void importReference(current)}
      onRemove={() => void remove(current.ref)}
    />
  )
}

function ReferenceBody({
  part,
  current,
  references,
  busy,
  status,
  failure,
  onChoose,
  onReplace,
  onRemove,
}: {
  part: DesignPart
  current: DesignReference
  references: readonly DesignReference[]
  busy: boolean
  status: React.ReactNode
  failure: React.ReactNode
  onChoose: (id: string) => void
  onReplace: () => void
  onRemove: () => void
}): React.JSX.Element {
  const { ref, visible, mesh } = current
  const call = useCommand()
  const cancelGesture = useCancelGesture()
  const notes = useUi((s) => s.referenceNotes[ref.id])
  const setVisible = useUi((s) => s.setReferenceVisible)
  const seeThrough = useUi((s) => s.seeThroughStock)
  const setSeeThrough = useUi((s) => s.setSeeThroughStock)
  const [errors, setErrors] = useState<readonly FieldError[]>([])
  const [summary, setSummary] = useState<AppErrorData | undefined>(undefined)
  const [anchor, setAnchor] = useState<AnchorValue>({ u: 'centre', v: 'centre' })
  const [fitting, setFitting] = useState(false)
  const fitButton = useRef<HTMLButtonElement>(null)
  const wasFitting = useRef(false)
  useLayoutEffect(() => {
    if (wasFitting.current && !fitting) fitButton.current?.focus()
    wasFitting.current = fitting
  }, [fitting])
  const stock = stockSizeOf(part)
  const guess = unitGuessOf(ref, stock)
  const placement = referencePlacement(ref)
  const resolver = part.table?.resolver(0)

  const send = async (
    args: Record<string, unknown>,
    path: string | undefined,
    gesture?: string,
  ): Promise<boolean> => {
    const r = await call(
      'design.reference.update',
      { partId: part.dto.id, referenceId: ref.id, ...args },
      gesture === undefined ? undefined : { gesture },
    )
    const placed = r.ok ? undefined : placeErrors(r.error, path)
    setErrors(placed?.errors ?? [])
    setSummary(placed?.summary)
    return r.ok
  }
  const messagesAt = (path: string): FieldMessage[] =>
    errors
      .filter((e) => e.path === path)
      .map((e, i) => ({ id: `error-${i}`, severity: 'error', text: e.text }))

  const warnings = [
    ...liveWarnings(ref, stock),
    // the import's notes, except the unit guess (shown at the source unit)
    ...(notes ?? []).filter((w) => w.code !== 'reference.unitGuessed'),
  ]
  const anchorField = (
    <Field label={t.anchor} kind="toggle" messages={[note('anchorHint', t.anchorHint)]}>
      <AnchorPicker
        label={t.anchor}
        value={anchor}
        onValueChange={setAnchor}
        caption={designMessages.anchorPoint('+z', anchor)}
        pointLabel={(p) => designMessages.anchorPoint('+z', p)}
      />
    </Field>
  )

  return (
    <div className={styles['fields']}>
      {references.length > 1 ? (
        <Select
          aria-label={m.panel.choose}
          options={references.map((r) => ({ value: r.ref.id, label: r.ref.name }))}
          value={ref.id}
          onValueChange={onChoose}
        />
      ) : null}
      <div className={styles['refFile']} data-hidden={visible ? undefined : ''}>
        <Icon name="reference" />
        <span className={styles['referenceText']}>
          <span className={styles['opName']} title={ref.name}>
            {ref.name}
          </span>
          <span className={styles['referenceMeta']}>
            {visible ? t.file(ref.asset.triangles) : m.hidden}
          </span>
        </span>
        <span className={styles['refActions']}>
          <IconButton
            label={m.show}
            pressed={visible}
            icon={visible ? <Icon name="eye" /> : <Icon name="eye-off" />}
            onClick={() => setVisible(ref.id, !visible)}
          />
          <IconButton
            label={m.replace}
            icon={<Icon name="import" />}
            disabled={busy || fitting}
            onClick={onReplace}
          />
          <IconButton
            label={m.remove}
            icon={<Icon name="delete" />}
            disabled={fitting}
            onClick={onRemove}
          />
        </span>
      </div>
      {status}
      {failure}
      <Checkbox
        label={m.panel.seeThrough}
        checked={seeThrough}
        onCheckedChange={(c) => setSeeThrough(c === true)}
      />
      {!visible ? (
        <p className={styles['muted']}>{t.mesh.hidden}</p>
      ) : mesh?.status === 'loading' ? (
        <p className={styles['muted']} role="status">
          {t.mesh.loading}
        </p>
      ) : mesh?.status === 'failed' ? (
        <ErrorMessage error={mesh.error} message={t.mesh.failed} />
      ) : null}

      {fitting ? (
        <ReferenceFit
          part={part}
          reference={ref}
          anchorField={anchorField}
          anchor={anchor}
          send={send}
          messagesAt={messagesAt}
          summary={summary}
          onClose={() => {
            setErrors([])
            setSummary(undefined)
            setFitting(false)
          }}
        />
      ) : (
        <>
          <dl className={styles['refSize']}>
            <dt>{m.panel.size}</dt>
            <dd>
              {placement ? sizeText(placedExtent(ref.asset.bounds, placement), part.units) : '–'}
            </dd>
            <dt>{m.panel.source}</dt>
            <dd>{m.panel.sourceSize(sourceSize(ref.asset.bounds), ref.sourceUnit)}</dd>
          </dl>
          <div className={styles['setupActions']}>
            <Button
              ref={fitButton}
              size="sm"
              icon={<Icon name="fit" />}
              onClick={() => {
                setErrors([])
                setSummary(undefined)
                setFitting(true)
              }}
            >
              {m.panel.fitOpen}
            </Button>
          </div>
          {summary ? <ErrorMessage error={summary} message={t.commandFailed} /> : null}

          <Field
            label={t.sourceUnit}
            kind="toggle"
            messages={[
              ...messagesAt('sourceUnit'),
              ...(guess ? [note('guess', t.guess(guess.reason))] : []),
            ]}
          >
            <SegmentedControl
              label={t.sourceUnit}
              size="sm"
              options={UNITS.map((u) => ({ value: u, label: t.units[u] }))}
              value={ref.sourceUnit}
              onValueChange={(sourceUnit) => void send({ sourceUnit }, 'sourceUnit')}
            />
          </Field>

          <section className={styles['group']} aria-label={t.scaleGroup}>
            <h3 className={styles['groupTitle']}>{t.scaleGroup}</h3>
            <QuantityInput
              label={t.scale}
              kind="scalar"
              defaultUnit={defaultUnit('scalar', part.units)}
              value={quantityOf(ref.scale)}
              onCommit={(q, gesture) => {
                const k = q.canonical
                // scale about the anchor: its point (X, Y) and the top (Z) stay where they are
                const pos =
                  placement !== undefined && k > 0
                    ? scaleAbout(ref.asset.bounds, placement, k, anchor)
                    : undefined
                void send(
                  pos === undefined
                    ? { scale: q.source }
                    : {
                        scale: q.source,
                        position: {
                          x: lengthSource(pos.x, part.units),
                          y: lengthSource(pos.y, part.units),
                          z: lengthSource(pos.z, part.units),
                        },
                      },
                  'scale',
                  gesture,
                )
              }}
              onCancelGesture={cancelGesture}
              messages={messagesAt('scale')}
            />
            {anchorField}
          </section>

          <section className={styles['group']} aria-label={t.rotation}>
            <h3 className={styles['groupTitle']}>{t.rotation}</h3>
            {AXES.map((axis) => (
              <div key={axis} className={styles['turnRow']}>
                <QuantityInput
                  label={t.rotationAxis(axis)}
                  kind="angle"
                  defaultUnit={defaultUnit('angle', part.units)}
                  value={quantityOf(ref.rotation[axis])}
                  onCommit={(q, gesture) =>
                    void send({ rotation: { [axis]: q.source } }, `rotation.${axis}`, gesture)
                  }
                  onCancelGesture={cancelGesture}
                  messages={messagesAt(`rotation.${axis}`)}
                />
                <span className={styles['turnButtons']}>
                  <IconButton
                    label={t.turn(axis, -1)}
                    icon={<Icon name="rotate-ccw" />}
                    onClick={() => void send({ turn: { axis, turns: -1 } }, `rotation.${axis}`)}
                  />
                  <IconButton
                    label={t.turn(axis, 1)}
                    icon={<Icon name="rotate-cw" />}
                    onClick={() => void send({ turn: { axis, turns: 1 } }, `rotation.${axis}`)}
                  />
                </span>
              </div>
            ))}
          </section>

          <section className={styles['group']} aria-label={t.position}>
            <h3 className={styles['groupTitle']}>{t.position}</h3>
            {AXES.map((axis) => (
              <QuantityInput
                key={axis}
                label={t.positionAxis(axis)}
                kind="length"
                defaultUnit={defaultUnit('length', part.units)}
                value={quantityOf(ref.position[axis])}
                onCommit={(q, gesture) =>
                  void send({ position: { [axis]: q.source } }, `position.${axis}`, gesture)
                }
                onCancelGesture={cancelGesture}
                messages={messagesAt(`position.${axis}`)}
                {...(resolver ? { resolver } : {})}
              />
            ))}
          </section>

          <ReferenceTools part={part} reference={ref} />

          <section aria-label={t.warnings} className={styles['warnings']}>
            <h3 className={styles['groupTitle']}>{t.warnings}</h3>
            <WarningList
              labels={warningLabels}
              items={warnings.map(warningView)}
              empty={t.noWarnings}
            />
          </section>
        </>
      )}
    </div>
  )
}

const zeroLength = (units: DesignPart['units']) =>
  Quantity.parse(units === 'mm' ? '0 mm' : '0"', fieldContext('length', units)).unwrap()

/**
 * Fit mode (DF5): the settings, the result and Apply / Cancel. The ghost previews the fitted
 * placement live (`referencePreview`, no command); unmounting (Cancel, Apply, the panel closing)
 * drops the preview.
 */
function ReferenceFit({
  part,
  reference: ref,
  anchorField,
  anchor,
  send,
  messagesAt,
  summary,
  onClose,
}: {
  part: DesignPart
  reference: ReferenceDTO
  anchorField: React.ReactNode
  anchor: AnchorValue
  send: (args: Record<string, unknown>, path: string | undefined) => Promise<boolean>
  messagesAt: (path: string) => FieldMessage[]
  summary: AppErrorData | undefined
  onClose: () => void
}): React.JSX.Element {
  const f = m.fit
  const setPreview = useUi((s) => s.setReferencePreview)
  const [scaleOn, setScaleOn] = useState(true)
  const [axes, setAxes] = useState<readonly FitAxis[]>(['x', 'y'])
  const [margin, setMargin] = useState(() => zeroLength(part.units))
  const [height, setHeight] = useState<FitZ>('top')
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => first.current?.focus(), [])

  const stock = useMemo(() => stockSizeOf(part), [part])
  const placement = useMemo(() => referencePlacement(ref), [ref])
  const marginMm = margin.canonical
  const preview = useMemo(
    () =>
      stock === undefined || placement === undefined
        ? undefined
        : fitPreview(ref.asset.bounds, placement, stock, {
            anchor: { u: anchor.u, v: anchor.v },
            z: height,
            margin: Math.max(0, marginMm),
            scaleTo: scaleOn ? axes : null,
          }),
    [ref, stock, placement, anchor.u, anchor.v, height, marginMm, scaleOn, axes],
  )
  useEffect(() => {
    setPreview(preview?.ok ? { referenceId: ref.id, placement: preview.placement } : null)
  }, [preview, ref.id, setPreview])
  useEffect(() => () => setPreview(null), [setPreview])

  const apply = async () => {
    const ok = await send(
      {
        fit: {
          anchor: { u: anchor.u, v: anchor.v },
          z: height,
          ...(marginMm !== 0 ? { margin: margin.source } : {}),
          ...(scaleOn ? { scaleTo: FIT_AXES.filter((a) => axes.includes(a)) } : {}),
        },
      },
      'fit',
    )
    if (ok) onClose()
  }
  const toggleAxis = (a: FitAxis, on: boolean) =>
    setAxes((xs) => (on ? [...xs, a] : xs.filter((x) => x !== a)))

  return (
    <section
      className={styles['fitMode']}
      aria-label={f.region}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <h3 className={styles['groupTitle']}>{f.title}</h3>
      {summary ? <ErrorMessage error={summary} message={t.commandFailed} /> : null}
      <div className={styles['group']}>
        <Checkbox
          ref={first}
          label={f.scaleToFit}
          checked={scaleOn}
          onCheckedChange={(c) => setScaleOn(c === true)}
        />
        {scaleOn ? (
          <fieldset className={styles['fitAxes']}>
            <legend className={styles['fitLegend']}>{f.within}</legend>
            {FIT_AXES.map((a) => {
              const on = axes.includes(a)
              return (
                <Checkbox
                  key={a}
                  label={f.axes[a]}
                  checked={on}
                  // at least one dimension governs
                  disabled={on && axes.length === 1}
                  onCheckedChange={(c) => toggleAxis(a, c === true)}
                />
              )
            })}
            <p className={styles['muted']}>{f.scaleHint}</p>
          </fieldset>
        ) : null}
      </div>
      <QuantityInput
        label={f.margin}
        kind="length"
        defaultUnit={defaultUnit('length', part.units)}
        value={margin}
        onCommit={(q) => setMargin(q)}
        messages={[...messagesAt('fit.margin'), note('marginHint', f.marginHint)]}
      />
      {anchorField}
      <Field label={t.height} kind="toggle" messages={[note('heightHint', t.heightHint)]}>
        <SegmentedControl
          label={t.height}
          size="sm"
          options={FIT_Z.map((z) => ({ value: z, label: t.heights[z] }))}
          value={height}
          onValueChange={setHeight}
        />
      </Field>
      <p className={styles['fitResult']} role="status">
        {preview === undefined
          ? null
          : preview.ok
            ? f.result(
                String(preview.placement.scale),
                sizeText(placedExtent(ref.asset.bounds, preview.placement), part.units),
              )
            : f.problems[preview.problem]}
      </p>
      {messagesAt('fit').map((e) => (
        <p key={e.id} className={styles['muted']} role="alert">
          {e.text}
        </p>
      ))}
      <p className={styles['muted']}>{t.fitHint}</p>
      <div className={styles['fitActions']}>
        <Button size="sm" onClick={onClose}>
          {f.cancel}
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Icon name="check" />}
          disabled={preview === undefined || !preview.ok}
          onClick={() => void apply()}
        >
          {f.apply}
        </Button>
      </div>
    </section>
  )
}
