// Reference inspector (task R3): the selected reference model's name, file facts, source unit (with
// the unit guess), scale, rotation (three angle fields, each with −90° / +90° turn buttons),
// position (the placed box's min corner) and "Fit to stock" with the anchor picker and the height
// choice. Every edit is one `design.reference.update` (one undo step; the turn buttons send
// `turn`, Fit sends `fit`); errors show at their field. Warnings: `exceedsStock` live, plus the
// import's own notes in this window. Doc: docs/modes/reference-model.md#display,
// docs/conventions/ui.md#panels-and-inspectors, #reference-ghost-v02
import { useState } from 'react'
import {
  FIT_Z,
  type FitZ,
  type ReferenceWarning,
  type SourceUnit,
} from '../../../../core/design/reference'
import type { ReferenceDTO } from '../../../../core/design/reference.dto'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { dfmMessages } from '../../messages/dfm'
import { referenceMessages } from '../../messages/reference'
import { useCancelGesture } from '../../shell/hooks'
import { useUi } from '../../shell/ShellContext'
import {
  Icon,
  AnchorPicker,
  Button,
  ErrorMessage,
  Field,
  IconButton,
  PanelHeader,
  QuantityInput,
  SegmentedControl,
  WarningList,
  type AnchorValue,
  type FieldMessage,
  type WarningView,
} from '../../ui'
import styles from './Design.module.css'
import { defaultUnit, quantityOf, type DesignPart } from './model'
import { NameField } from './NameField'
import { placeErrors, type FieldError } from './OperationFields'
import { liveWarnings, sourceSize, stockSizeOf, unitGuessOf } from './reference-view'
import { useCommand, useDesignReferences } from './useDesign'

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

export function ReferenceInspector({
  part,
  reference: ref,
}: {
  part: DesignPart
  reference: ReferenceDTO
}): React.JSX.Element {
  const call = useCommand()
  const cancelGesture = useCancelGesture()
  const notes = useUi((s) => s.referenceNotes[ref.id])
  const view = useDesignReferences(part).find((r) => r.ref.id === ref.id)
  const [errors, setErrors] = useState<readonly FieldError[]>([])
  const [summary, setSummary] = useState<AppErrorData | undefined>(undefined)
  const [anchor, setAnchor] = useState<AnchorValue>({ u: 'centre', v: 'centre' })
  const [height, setHeight] = useState<FitZ>('top')
  const stock = stockSizeOf(part)
  const guess = unitGuessOf(ref, stock)
  const resolver = part.table?.resolver(0)

  const send = async (
    args: Record<string, unknown>,
    path: string | undefined,
    gesture?: string,
  ) => {
    const r = await call(
      'design.reference.update',
      { partId: part.dto.id, referenceId: ref.id, ...args },
      gesture === undefined ? undefined : { gesture },
    )
    const placed = r.ok ? undefined : placeErrors(r.error, path)
    setErrors(placed?.errors ?? [])
    setSummary(placed?.summary)
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

  return (
    <div className={styles['inspector']}>
      <PanelHeader title={ref.name} meta={t.meta} />
      <div className={styles['fields']}>
        {summary ? <ErrorMessage error={summary} message={t.commandFailed} /> : null}
        <NameField
          label={t.name}
          name={ref.name}
          onCommit={(name) => void send({ name }, 'name')}
        />
        <p className={styles['muted']}>
          {t.file(ref.asset.triangles, sourceSize(ref.asset.bounds))}
        </p>
        {view && !view.visible ? (
          <p className={styles['muted']}>{t.mesh.hidden}</p>
        ) : view?.mesh?.status === 'loading' ? (
          <p className={styles['muted']} role="status">
            {t.mesh.loading}
          </p>
        ) : view?.mesh?.status === 'failed' ? (
          <ErrorMessage error={view.mesh.error} message={t.mesh.failed} />
        ) : null}

        <Field
          label={t.sourceUnit}
          kind="toggle"
          messages={[
            ...messagesAt('sourceUnit'),
            ...(guess
              ? [{ id: 'guess', severity: 'note' as const, text: t.guess(guess.reason) }]
              : []),
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
        <QuantityInput
          label={t.scale}
          kind="scalar"
          defaultUnit={defaultUnit('scalar', part.units)}
          value={quantityOf(ref.scale)}
          onCommit={(q, gesture) => void send({ scale: q.source }, 'scale', gesture)}
          onCancelGesture={cancelGesture}
          messages={messagesAt('scale')}
        />

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

        <section className={styles['group']} aria-label={t.fit}>
          <h3 className={styles['groupTitle']}>{t.fit}</h3>
          <Field label={t.anchor} kind="toggle">
            <AnchorPicker
              label={t.anchor}
              value={anchor}
              onValueChange={setAnchor}
              caption={designMessages.anchorPoint('+z', anchor)}
              pointLabel={(p) => designMessages.anchorPoint('+z', p)}
            />
          </Field>
          <Field label={t.height} kind="toggle">
            <SegmentedControl
              label={t.height}
              size="sm"
              options={FIT_Z.map((z) => ({ value: z, label: t.heights[z] }))}
              value={height}
              onValueChange={setHeight}
            />
          </Field>
          <div className={styles['fitRow']}>
            <Button size="sm" onClick={() => void send({ fit: { anchor, z: height } }, 'fit')}>
              {t.fitButton}
            </Button>
            <span className={styles['muted']}>{t.fitHint}</span>
          </div>
          {messagesAt('fit').map((e) => (
            <p key={e.id} className={styles['muted']} role="alert">
              {e.text}
            </p>
          ))}
        </section>

        <section aria-label={t.warnings} className={styles['warnings']}>
          <h3 className={styles['groupTitle']}>{t.warnings}</h3>
          <WarningList
            labels={warningLabels}
            items={warnings.map(warningView)}
            empty={t.noWarnings}
          />
        </section>
      </div>
    </div>
  )
}
