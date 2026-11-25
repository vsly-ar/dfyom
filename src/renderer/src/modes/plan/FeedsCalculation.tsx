// "Show calculation" under the plan inspector's feeds fields (v0.2): the calculator's inputs,
// each field's value and source with the derivation steps of calculator values (formula, inputs,
// result), and surface speed, chip thinning, removal rate, power and spindle load at the values
// used, and the finishing pass's feed (DF74), from `plan.operation.feeds.get` (read once per revision while open). Canonical metric
// units, as the calculator's messages. Doc: docs/conventions/ui.md#plan-mode-task-37
// (Calculation), docs/modes/plan-v0.1.md#feeds-explanation-v02
import { useEffect, useId, useState } from 'react'
import type { FeedField } from '../../../../core/plan/plan.dto'
import { designMessages } from '../../messages/design'
import { libraryMessages } from '../../messages/library'
import { planMessages, type FeedSource } from '../../messages/plan'
import { useReplica, useShell } from '../../shell/ShellContext'
import { Button, InspectorGroup } from '../../ui'
import styles from './Plan.module.css'

const t = planMessages.inspector
const c = t.calc

interface Step {
  readonly step: string
  readonly formula: string
  readonly inputs: Readonly<Record<string, number | string>>
  readonly result: number
  readonly unit: string
}

/** `plan.operation.feeds.get`. */
export interface FeedsExplanation {
  readonly auto: 'on' | 'off' | { readonly unavailable: string }
  readonly inputs: {
    readonly materialClass: string
    readonly toolMaterial: string | null
    readonly diameter: number
    readonly fluteCount: number
    readonly cornerRadius: number
    readonly engagement: { readonly kind: string; readonly ae?: number; readonly ap?: number }
    readonly rigidity: string
    readonly spindlePower: number | null
  } | null
  readonly fields: Readonly<
    Record<
      FeedField,
      {
        readonly value: number
        readonly unit: string
        readonly source: FeedSource
        readonly derivation: readonly Step[] | null
      } | null
    >
  >
  readonly used: {
    readonly dCalc: number
    readonly vc: number
    readonly fz: number
    readonly chipThinning: number
    readonly Q: number | null
    readonly Pc: number | null
    readonly spindleLoad: number | null
  } | null
  /** The finishing pass's own feed (DF74); absent from older replies, null without one. */
  readonly finish?: {
    readonly allowance: number
    readonly feedRate: number
    readonly chipThinning: number
    readonly fz: number
    readonly clamped: boolean
  } | null
}

type Loaded = { readonly ok: true; readonly value: FeedsExplanation } | { readonly ok: false }

function useExplanation(
  planId: string,
  planOperationId: string,
  enabled: boolean,
): Loaded | undefined {
  const { bridge } = useShell()
  const replica = useReplica()
  const revision = replica.status === 'open' ? replica.revision : -1
  const [data, setData] = useState<Loaded | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return
    let live = true
    void bridge.call('plan.operation.feeds.get', { planId, planOperationId }).then((r) => {
      if (live) setData(r.ok ? { ok: true, value: r.value as FeedsExplanation } : { ok: false })
    })
    return () => {
      live = false
    }
  }, [bridge, planId, planOperationId, revision, enabled])
  return enabled ? data : undefined
}

/** A number for the explanation: whole above 100, else 3 significant digits. */
export function calcNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  if (Math.abs(n) >= 100) return String(Math.round(n))
  return String(Number(n.toPrecision(3)))
}

const withUnit = (n: number, unit: string): string =>
  unit === '×' ? `×${calcNumber(n)}` : `${calcNumber(n)} ${unit}`

const stepInputs = (inputs: Step['inputs']): string =>
  Object.entries(inputs)
    .map(([k, v]) => `${k} = ${typeof v === 'number' ? calcNumber(v) : v}`)
    .join(', ')

export function FeedsCalculation({
  planId,
  planOperationId,
  fields,
  presetName,
}: {
  planId: string
  planOperationId: string
  /** The feeds fields of the operation kind, in the card's order. */
  fields: readonly FeedField[]
  presetName: string | null
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()
  const data = useExplanation(planId, planOperationId, open)
  return (
    <div className={styles['calc']}>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {open ? c.hide : c.show}
      </Button>
      {open ? (
        <div id={id} role="region" aria-label={c.title} className={styles['calcBody']}>
          {data === undefined ? (
            <p className={styles['muted']}>{c.loading}</p>
          ) : !data.ok ? (
            <p className={styles['muted']}>{c.failed}</p>
          ) : (
            <Explanation e={data.value} fields={fields} presetName={presetName} />
          )}
        </div>
      ) : null}
    </div>
  )
}

function Explanation({
  e,
  fields,
  presetName,
}: {
  e: FeedsExplanation
  fields: readonly FeedField[]
  presetName: string | null
}): React.JSX.Element {
  const i = e.inputs
  const classes = designMessages.stock.classes as Record<string, string>
  const toolMaterials = libraryMessages.tool.materials as Record<string, string>
  const rigidities = libraryMessages.machine.rigidities as Record<string, string>
  const engagement = (g: NonNullable<FeedsExplanation['inputs']>['engagement']) =>
    g.kind === 'stepover' && g.ae !== undefined
      ? c.engagements.stepover(`${calcNumber(g.ae)} mm`)
      : g.kind === 'helix' && g.ap !== undefined
        ? c.engagements.helix(`${calcNumber(g.ap)} mm`)
        : g.kind === 'drill'
          ? c.engagements.drill
          : c.engagements.slot
  const u = e.used
  return (
    <>
      {i !== null ? (
        <InspectorGroup title={c.inputs} level={4}>
          <dl className={styles['calcList']}>
            <Row term={c.material} value={classes[i.materialClass] ?? i.materialClass} />
            <Row
              term={c.toolMaterial}
              value={
                i.toolMaterial === null
                  ? c.notSet
                  : (toolMaterials[i.toolMaterial] ?? i.toolMaterial)
              }
            />
            <Row term={c.diameter} value={`${calcNumber(i.diameter)} mm`} />
            <Row term={c.flutes} value={calcNumber(i.fluteCount)} />
            <Row term={c.cornerRadius} value={`${calcNumber(i.cornerRadius)} mm`} />
            <Row term={c.engagement} value={engagement(i.engagement)} />
            <Row term={c.rigidity} value={rigidities[i.rigidity] ?? i.rigidity} />
            <Row
              term={c.spindlePower}
              value={i.spindlePower === null ? c.noPower : `${calcNumber(i.spindlePower)} W`}
            />
          </dl>
        </InspectorGroup>
      ) : null}

      <InspectorGroup title={c.fields} level={4}>
        {fields.map((f) => {
          const v = e.fields[f]
          const label = t.feeds[f]
          if (v === null)
            return (
              <p key={f} className={styles['muted']}>
                {c.fieldValue(label, '–')} {t.unresolved}
              </p>
            )
          return (
            <div key={f} className={styles['calcField']}>
              <p className={styles['calcValue']}>
                {c.fieldValue(label, withUnit(v.value, v.unit))}{' '}
                <span className={styles['muted']}>{t.source(v.source, presetName)}</span>
              </p>
              {v.derivation !== null && v.derivation.length > 0 ? (
                <ol className={styles['steps']} aria-label={c.steps(label)}>
                  {v.derivation.map((d, k) => (
                    <li key={`${d.step}:${k}`}>
                      <code className={styles['formula']}>{d.formula}</code>
                      {Object.keys(d.inputs).length > 0 ? (
                        <span className={styles['muted']}> · {stepInputs(d.inputs)}</span>
                      ) : null}
                      <span> → {withUnit(d.result, d.unit)}</span>
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          )
        })}
      </InspectorGroup>

      <InspectorGroup title={c.used} level={4}>
        {u === null ? (
          typeof e.auto === 'object' ? (
            <p className={styles['muted']}>{c.noData(e.auto.unavailable)}</p>
          ) : (
            <p className={styles['muted']}>{t.unresolved}</p>
          )
        ) : (
          <dl className={styles['calcList']}>
            <Row term={c.surfaceSpeed} value={`${calcNumber(u.vc)} m/min`} />
            {i !== null && u.dCalc !== i.diameter ? (
              <Row term={c.effectiveDiameter} value={`${calcNumber(u.dCalc)} mm`} />
            ) : null}
            <Row term={c.chipLoad} value={`${calcNumber(u.fz)} mm`} />
            <Row term={c.chipThinning} value={`×${calcNumber(u.chipThinning)}`} />
            {u.Q !== null ? (
              <Row term={c.removalRate} value={`${calcNumber(u.Q)} mm³/min`} />
            ) : null}
            {u.Pc !== null ? <Row term={c.cuttingPower} value={`${calcNumber(u.Pc)} kW`} /> : null}
            {u.spindleLoad !== null ? (
              <Row term={c.spindleLoad} value={`${calcNumber(u.spindleLoad)} %`} />
            ) : null}
          </dl>
        )}
      </InspectorGroup>

      {e.finish != null ? (
        <InspectorGroup title={c.finish} level={4}>
          <dl className={styles['calcList']}>
            <Row term={c.finishAllowance} value={`${calcNumber(e.finish.allowance)} mm`} />
            <Row
              term={c.finishFeed}
              value={`${calcNumber(e.finish.feedRate)} mm/min${e.finish.clamped ? ` ${c.finishClamped}` : ''}`}
            />
            <Row term={c.finishChipLoad} value={`${calcNumber(e.finish.fz)} mm`} />
            <Row term={c.finishChipThinning} value={`×${calcNumber(e.finish.chipThinning)}`} />
          </dl>
        </InspectorGroup>
      ) : null}
    </>
  )
}

function Row({ term, value }: { term: string; value: string }): React.JSX.Element {
  return (
    <div className={styles['calcRow']}>
      <dt>{term}</dt>
      <dd>{value}</dd>
    </div>
  )
}
