// Strategy group of the plan inspector (v0.2, strategy editing phase 1): the operation kind's
// pass-strategy parameters, only those that apply. Choices are segmented controls (the drilling
// cycle a Select, its options by tool type); lengths and angles are QuantityInputs showing the
// entered value or the resolved default, with "Use default" on an entered one. Every edit is one
// `plan.operation.update { strategy }` command. Doc: docs/conventions/ui.md#plan-mode-task-37
// (Strategy), docs/modes/plan-v0.1.md#pass-strategies-v01
import type { PlanWarning } from '../../../../core/plan/checks'
import type { PlanDTO, PlanOperationDTO } from '../../../../core/plan/plan.dto'
import type { StrategyKey } from '../../../../core/plan/strategy'
import type { UnitSystem } from '../../../../core/project/document'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import { planMessages } from '../../messages/plan'
import {
  Field,
  FieldIcon,
  QuantityInput,
  SegmentedControl,
  Select,
  type FieldIconName,
  type FieldMessage,
} from '../../ui'
import { defaultUnit, quantityOf } from '../design/model'
import { fieldMessages } from './fieldMessages'
import {
  ANGLE_KEYS,
  CHOICE_KEYS,
  shownStrategyKeys,
  strategyQuantity,
  type PlanOperationView,
} from './model'
import styles from './Plan.module.css'

const t = planMessages.inspector
const s = t.strategy

/** Values each choice offers, per kind (a profile enters by ramp or plunge, a chamfer is plunged or contoured). */
function choiceValues(key: StrategyKey, kind: PlanOperationView['kind']): readonly string[] {
  switch (key) {
    case 'direction':
      return ['climb', 'conventional']
    case 'pattern':
      return ['zigzag', 'oneWay']
    case 'axis':
      return ['x', 'y']
    case 'entry':
      return kind === 'profile'
        ? ['ramp', 'plunge']
        : kind === 'chamfer'
          ? ['plunge', 'contour']
          : ['helix', 'ramp', 'plunge']
    default:
      return []
  }
}

const ICON: Partial<Record<StrategyKey, FieldIconName>> = {
  overshoot: 'length',
  helixDiameter: 'width',
  rampAngle: 'chamfer',
  finishAllowance: 'width',
  finishStepdown: 'stepdown',
  peckDepth: 'depth',
  chipBreakBack: 'depth',
  helixPitch: 'stepdown',
  breakthrough: 'depth',
}

/** Paths of the strategy findings the group shows at a field (the rest join the list below). */
export function shownStrategyFields(plan: PlanDTO, view: PlanOperationView): Set<string> {
  return new Set(
    shownStrategyKeys(view.kind, view.strategy, isThrough(plan, view))
      .filter((k) => !CHOICE_KEYS.has(k) || k === 'cycle')
      .map((k) => `strategy.${k}`),
  )
}

function isThrough(plan: PlanDTO, view: PlanOperationView): boolean {
  const design = plan.design.part.operations.find((o) => o.id === view.designOperationIds[0])
  return (design as { bottom?: string } | undefined)?.bottom === 'through'
}

export function StrategyGroup({
  plan,
  op,
  view,
  units,
  readOnly,
  findings,
  onUpdate,
  onCancelGesture,
}: {
  plan: PlanDTO
  op: PlanOperationDTO
  view: PlanOperationView
  units: UnitSystem
  readOnly: boolean
  findings: readonly PlanWarning[]
  /** One `plan.operation.update`; `gesture` for a live adjust-popover step. */
  onUpdate: (args: object, gesture?: string) => void
  /** Escape in a field's adjust popover (QuantityInput `onCancelGesture`). */
  onCancelGesture: (gesture: string) => Promise<boolean>
}): React.JSX.Element {
  const set = (key: StrategyKey, value: string | null, gesture?: string) =>
    onUpdate({ strategy: { [key]: value } }, gesture)
  const keys = shownStrategyKeys(view.kind, view.strategy, isThrough(plan, view))
  const toolType = (
    plan.snapshots.find((x) => x.id === op.tool)?.values as { type?: string } | undefined
  )?.type

  return (
    <section className={styles['group']} aria-label={t.groups.strategy}>
      <h3 className={styles['groupTitle']}>{t.groups.strategy}</h3>
      {keys.map((key) => {
        const resolved = view.strategy[key]
        const label = s.labels[key]
        if (key === 'cycle')
          return (
            <CycleField
              key={key}
              value={String(resolved ?? '')}
              stored={op.strategy.cycle !== undefined}
              toolType={toolType}
              readOnly={readOnly}
              messages={fieldMessages(findings, 'strategy.cycle')}
              onChange={(v) => set('cycle', v)}
            />
          )
        if (CHOICE_KEYS.has(key))
          return (
            <div key={key} className={styles['choice']}>
              <span className={styles['caption']} aria-hidden="true">
                {label}
              </span>
              <SegmentedControl<string>
                label={label}
                options={choiceValues(key, view.kind).map((v) => ({
                  value: v,
                  label: s.choices[key]?.[v] ?? v,
                }))}
                value={String(resolved ?? '')}
                disabled={readOnly}
                onValueChange={(v) => {
                  if (v !== resolved || op.strategy[key] === undefined) set(key, v)
                }}
              />
            </div>
          )
        const stored = op.strategy[key] as QuantityDTO | undefined
        return (
          <StrategyQuantity
            key={key}
            strategyKey={key}
            label={label}
            stored={stored}
            resolved={typeof resolved === 'number' ? resolved : undefined}
            units={units}
            readOnly={readOnly}
            findings={fieldMessages(findings, `strategy.${key}`)}
            onSet={(v, gesture) => set(key, v, gesture)}
            onCancelGesture={onCancelGesture}
          />
        )
      })}
    </section>
  )
}

function CycleField({
  value,
  stored,
  toolType,
  readOnly,
  messages,
  onChange,
}: {
  value: string
  stored: boolean
  toolType: string | undefined
  readOnly: boolean
  messages: FieldMessage[]
  onChange: (cycle: string | null) => void
}): React.JSX.Element {
  const fits =
    toolType === undefined ? [] : toolType === 'drill' ? ['simple', 'peck', 'chipBreak'] : ['helix']
  const names = s.choices['cycle']!
  const options = fits.map((c) => ({ value: c, label: names[c] ?? c }))
  if (value !== '' && !fits.includes(value))
    options.push({ value, label: s.notForTool(names[value] ?? value) })
  // a stored cycle that broke (another tool) gets the way back on its error
  const shown =
    stored && !readOnly
      ? messages.map((m, i) =>
          i === 0 && m.fix === undefined
            ? { ...m, fix: { label: s.useDefault, onApply: () => onChange(null) } }
            : m,
        )
      : messages
  return (
    <Field label={s.labels.cycle} messages={shown} readOnly={readOnly}>
      <Select
        options={options}
        {...(value === '' ? {} : { value })}
        disabled={readOnly || options.length === 0}
        onValueChange={(v) => {
          if (v !== value || !stored) onChange(v)
        }}
      />
    </Field>
  )
}

function StrategyQuantity({
  strategyKey,
  label,
  stored,
  resolved,
  units,
  readOnly,
  findings,
  onSet,
  onCancelGesture,
}: {
  strategyKey: StrategyKey
  label: string
  stored: QuantityDTO | undefined
  resolved: number | undefined
  units: UnitSystem
  readOnly: boolean
  findings: FieldMessage[]
  onSet: (source: string | null, gesture?: string) => void
  onCancelGesture: (gesture: string) => Promise<boolean>
}): React.JSX.Element {
  const angle = ANGLE_KEYS.has(strategyKey)
  const value =
    stored !== undefined
      ? quantityOf(stored)
      : resolved !== undefined
        ? strategyQuantity(strategyKey, resolved, units)
        : undefined
  const fix =
    stored !== undefined && !readOnly
      ? { label: s.useDefault, onApply: () => onSet(null) }
      : undefined
  const note: FieldMessage = {
    id: 'strategy.source',
    severity: 'note',
    text: stored !== undefined ? s.entered : s.default,
  }
  // Only the top message shows its fix: a finding about the entered value carries "Use default".
  const host = fix === undefined ? -1 : findings.findIndex((m) => m.fix === undefined)
  const messages: FieldMessage[] =
    fix === undefined
      ? [...findings, note]
      : host < 0
        ? [...findings, { ...note, fix }]
        : [...findings.map((m, i) => (i === host ? { ...m, fix } : m)), note]
  return (
    <QuantityInput
      label={label}
      kind={angle ? 'angle' : 'length'}
      defaultUnit={angle ? 'deg' : defaultUnit('length', units)}
      value={value}
      illustration={<FieldIcon name={ICON[strategyKey] ?? 'length'} />}
      readOnly={readOnly}
      messages={messages}
      onCommit={(q, gesture) => onSet(q.source, gesture)}
      onCancelGesture={onCancelGesture}
    />
  )
}
