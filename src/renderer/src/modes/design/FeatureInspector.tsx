// Feature inspectors (v0.4 task U1): the read-only owned-operation inspector (breadcrumb, "Edited
// through Hole 1" with its lock reason, the usual OperationFields read-only, name and tool still
// editable as A4 allows, findings with "Fix in Hole 1") and a minimal feature inspector until the
// kinds' own (hole: U2, Clones: U3): name, the feature's values read-only, its operations or
// source, and its findings with fixes that a single feature field can take. "Edited through" and
// "Fix in" select the feature and ask it to focus the mapped field (ui store `featureFocus`).
// Doc: docs/conventions/ui.md#owned-operations-and-clone-instances, #feature-rows-and-add;
// docs/modes/design-v0.4.md#implementation-f3
import { useEffect, useId, useRef, useState } from 'react'
import { featureKind } from '../../../../core/design/feature'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import type { OperationDTO } from '../../../../core/design/part.dto'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { dfmMessages } from '../../messages/dfm'
import { useCancelGesture } from '../../shell/hooks'
import { useShell, useUi } from '../../shell/ShellContext'
import { ErrorMessage, Icon, PanelHeader, ReadOnlyReason, WarningList } from '../../ui'
import { warningLabels, warningView } from './DesignInspector'
import styles from './Design.module.css'
import {
  cloneInstances,
  featureFieldOf,
  featureOfWarning,
  featureReadout,
  firstGeometricPath,
  FIXABLE_FIELDS,
  operationUnits,
  roleLabel,
  warningFeatureField,
} from './feature-view'
import { NameField } from './NameField'
import { OperationFields, warningPath, type OperationFieldsContext } from './OperationFields'
import { operationIcon } from './OperationList'
import { ToolField } from './ToolField'
import type { DesignPart } from './model'
import { useCommand, useDesignSelection, type DesignWarnings } from './useDesign'

const m = designMessages
const f = m.features

export type FixIn = (w: DfmWarning) => { label: string; onApply: () => void } | undefined

/** Selects a feature and asks its inspector to focus `field` (dotted, `center.0`). */
function useOpenFeature(): (featureId: string, field: string | undefined) => void {
  const { ui } = useShell()
  const [, select] = useDesignSelection()
  return (featureId, field) => {
    ui.getState().setFeatureFocus(field === undefined ? null : { featureId, field })
    select(featureId)
  }
}

/**
 * The fix of a finding with a suggestion on a feature or one of its owned operations: "Fix in
 * Hole 1" selects the feature and focuses the mapped field, where the fix is (ui.md § Owned
 * operations and clone instances); undefined for plain operations and findings without one.
 */
export function useFixIn(part: DesignPart | undefined): FixIn {
  const open = useOpenFeature()
  return (w) => {
    if (part === undefined || w.suggestion === undefined) return undefined
    const feature = featureOfWarning(part, w)
    if (feature === undefined) return undefined
    const op = part.dto.operations.find((o) => o.id === w.operation)
    const field = op === undefined ? w.parameter : warningFeatureField(feature, op, w)
    return { label: f.fixIn(feature.name), onApply: () => open(feature.id, field) }
  }
}

// ── owned operation ───────────────────────────────────────────────────────────────────────

export function OwnedOperationInspector({
  part,
  op,
  feature,
  warnings,
}: {
  part: DesignPart
  op: OperationDTO
  feature: FeatureDTO
  warnings: DesignWarnings
}): React.JSX.Element {
  const call = useCommand()
  const cancelGesture = useCancelGesture()
  const [, select] = useDesignSelection()
  const open = useOpenFeature()
  const fixIn = useFixIn(part)
  const reasonId = useId()
  const [summary, setSummary] = useState<AppErrorData | undefined>(undefined)
  // Clones instances are wholly read-only (name and tool too, C3); a hole's keep name and tool (A4)
  const wholly = featureKind(feature.kind).mapOr(false, (k) => k.readOnly === true)
  const kindLabel = f.kindLabel(feature.kind)
  const opWarnings = warnings.warnings.filter((w) => w.operation === op.id)
  const role = roleLabel(feature.name, op.name)
  const driving = featureFieldOf(feature, op, firstGeometricPath(op))

  const ctx: OperationFieldsContext = {
    part,
    op,
    units: part.units,
    warnings: opWarnings,
    errors: [],
    readOnly: true,
    pickable: false,
    send: () => {},
    cancelGesture,
    fixElsewhere: (w) => fixIn(w) ?? { label: f.fixIn(feature.name), onApply: () => {} },
  }
  const unplaced = opWarnings.filter((w) => warningPath(w, op) === undefined)

  return (
    <div className={styles['inspector']}>
      <PanelHeader title={op.name} meta={op.id} />
      <div className={styles['fields']}>
        <nav aria-label={f.breadcrumb}>
          <ol className={styles['breadcrumb']}>
            <li>
              <button type="button" className={styles['crumb']} onClick={() => select(feature.id)}>
                {feature.name}
              </button>
            </li>
            <li aria-hidden="true" className={styles['crumbSep']}>
              ›
            </li>
            <li>
              <button
                type="button"
                className={styles['crumb']}
                aria-current="page"
                onClick={() => select(op.id)}
              >
                {role}
              </button>
            </li>
          </ol>
        </nav>
        <div className={styles['ownedNote']}>
          <Icon name="lock" size="sm" />
          <p className={styles['ownedNoteText']}>
            {f.editedThrough}{' '}
            <button
              type="button"
              className={styles['inlineLink']}
              onClick={() => open(feature.id, driving)}
            >
              {feature.name}
            </button>
            <span id={reasonId} className={styles['srOnly']}>
              {' '}
              {f.readOnly(feature.name, kindLabel)}
            </span>
          </p>
        </div>
        {summary ? <ErrorMessage error={summary} message={m.inspector.commandFailed} /> : null}
        <ReadOnlyReason id={reasonId}>
          {wholly ? null : (
            <NameField
              label={m.inspector.name}
              name={op.name}
              onCommit={(name) =>
                void call(`design.${op.kind}.update`, {
                  partId: part.dto.id,
                  operationId: op.id,
                  name,
                }).then((r) => setSummary(r.ok ? undefined : r.error))
              }
            />
          )}
          <OperationFields
            ctx={ctx}
            {...(wholly ? {} : { tool: <ToolField part={part} op={op} warnings={opWarnings} /> })}
          />
        </ReadOnlyReason>
        {unplaced.length > 0 ? (
          <WarningList
            labels={warningLabels}
            items={unplaced.map((w) => warningView(w, part, undefined, undefined, fixIn))}
          />
        ) : null}
      </div>
    </div>
  )
}

// ── feature (minimal: Clones until U3; holes have HoleInspector) ─────────────────────────

/** The feature's values as read-only rows `[field, label, value]` (field: the focus target). */
function featureFacts(part: DesignPart, feature: FeatureDTO): [string, string, string][] {
  if (feature.kind === 'clones') {
    const instances = cloneInstances(part, feature.id)
    const made = instances.filter((x) => x.kind === 'clone').length
    return [
      ['instances', f.clonesGroup, featureReadout(feature, 1 + made)],
      ['rows', f.rows, String((feature['rows'] as unknown[] | undefined)?.length ?? 0)],
      ['skipped', f.skipped, String(instances.filter((x) => x.kind === 'skipped').length)],
    ]
  }
  return []
}

export function FeatureInspector({
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
  const focus = useUi((s) => s.featureFocus)
  const factsRef = useRef<HTMLDListElement>(null)
  const [summary, setSummary] = useState<AppErrorData | undefined>(undefined)
  const unit = operationUnits(part).find((u) => u.id === feature.id)
  const owned = unit?.kind === 'feature' ? unit.ops : []
  const nested = unit?.kind === 'feature' ? unit.nested : []
  const ownedIds = new Set([feature.id, ...owned.map((o) => o.id)])
  const findings = warnings.warnings.filter((w) => ownedIds.has(w.operation))
  const facts = featureFacts(part, feature)

  const update = async (args: Record<string, unknown>) => {
    const r = await call(`design.${feature.kind}.update`, {
      partId: part.dto.id,
      featureId: feature.id,
      ...args,
    })
    setSummary(r.ok ? undefined : r.error)
  }

  // "Edited through" / "Fix in": focus the asked field (its row; `center.0` → `center`), once
  useEffect(() => {
    if (focus === null || focus.featureId !== feature.id) return
    const rows = factsRef.current?.querySelectorAll<HTMLElement>('[data-feature-field]') ?? []
    const target =
      [...rows].find((r) => r.dataset['featureField'] === focus.field) ??
      [...rows].find((r) => focus.field.startsWith(`${r.dataset['featureField']}.`))
    target?.focus()
    ui.getState().setFeatureFocus(null)
  }, [focus, feature.id, ui])

  const fix = (w: DfmWarning) => {
    const op = part.dto.operations.find((o) => o.id === w.operation)
    const field = op === undefined ? w.parameter : warningFeatureField(feature, op, w)
    const value = dfmMessages.suggestionSource(w, part.units)
    if (field === undefined || value === undefined || !FIXABLE_FIELDS.has(field)) return undefined
    return {
      label: dfmMessages.useValue(w.suggestion!.relation, value),
      onApply: () => void update({ [field]: value }),
    }
  }

  return (
    <div className={styles['inspector']}>
      <PanelHeader title={feature.name} meta={feature.id} />
      <div className={styles['fields']}>
        {summary ? <ErrorMessage error={summary} message={m.inspector.commandFailed} /> : null}
        <NameField
          label={m.inspector.name}
          name={feature.name}
          onCommit={(name) => void update({ name })}
        />
        <section className={styles['group']} aria-label={f.kindLabel(feature.kind)}>
          <h3 className={styles['groupTitle']}>{f.kindLabel(feature.kind)}</h3>
          <p className={styles['muted']}>{f.placeholder}</p>
          <dl ref={factsRef} className={styles['featureFacts']}>
            {facts.map(([field, label, value]) => (
              <div
                key={field}
                className={styles['featureFact']}
                data-feature-field={field}
                tabIndex={-1}
              >
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
        {nested.length > 0 ? (
          <section className={styles['group']} aria-label={f.source}>
            <h3 className={styles['groupTitle']}>{f.source}</h3>
            <ul className={styles['featureLinks']}>
              {nested.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={styles['inlineLink']}
                    onClick={() => select(n.id)}
                  >
                    {n.kind === 'operation' ? n.op.name : n.feature.name}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {feature.kind !== 'clones' && owned.length > 0 ? (
          <section className={styles['group']} aria-label={f.ownedGroup}>
            <h3 className={styles['groupTitle']}>{f.ownedGroup}</h3>
            <ul className={styles['featureLinks']}>
              {owned.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    className={styles['inlineLink']}
                    onClick={() => select(o.id)}
                  >
                    <Icon name={operationIcon(o)} size="sm" />
                    {roleLabel(feature.name, o.name)}
                  </button>{' '}
                  <span className={styles['opId']}>{o.id}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section className={styles['group']} aria-label={f.findings}>
          <h3 className={styles['groupTitle']}>{f.findings}</h3>
          <WarningList
            labels={warningLabels}
            items={findings.map((w) => {
              const view = warningView(w, part, undefined, select)
              const own = fix(w)
              return own === undefined ? view : { ...view, fix: own }
            })}
            empty={dfmMessages.none}
          />
        </section>
      </div>
    </div>
  )
}
