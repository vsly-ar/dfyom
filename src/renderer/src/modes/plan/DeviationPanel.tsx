// The deviation panel (v0.4-llm-first U4): in the Plan inspector without a selection, the plan's
// simulated cut against the part's reference (`design.reference.compare { source: plan }`, a job
// the plan store runs and follows): a threshold, Compare / Cancel, the statistics and the regions
// with their causes; choosing a region marks and frames it in the Plan viewport (U4 follow-up,
// `regionBox`) and selects its plan operation when it has one. No colour map yet.
// Doc: docs/conventions/ui.md#deviation-panel, docs/modes/deviation.md#implementation-u4,
// docs/modes/deviation.md#region-marker-u4-follow-up
import { useEffect, useRef, useState } from 'react'
import { DIRECTION_LABEL, stockFaceDirection } from '../../../../core/geometry/face'
import type { PlanDTO } from '../../../../core/plan/plan.dto'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import { deviationMessages as m } from '../../messages/deviation'
import {
  Button,
  ErrorMessage,
  Field,
  Icon,
  InspectorGroup,
  Progress,
  QuantityInput,
  Select,
  useReducedMotion,
} from '../../ui'
import { defaultUnit } from '../design/model'
import { lengthQuantity } from '../design/reference-view'
import { regionBox } from './deviation-region'
import { allPlanOperations, lengthText, planOperationName, planStockSize } from './model'
import {
  useDeviationBasis,
  usePlanState,
  usePlanStore,
  type DeviationRegionView,
  type DeviationResultView,
} from './plan-store'
import styles from './Plan.module.css'
import { usePlanSelection } from './usePlan'

/** Default threshold (mm), as the command's. */
export const DEVIATION_THRESHOLD_MM = 0.1
const THRESHOLD_MIN = 0.001
const THRESHOLD_MAX = 10
/** A region over this deviation without a cause is unexplained (the result's `unexplained`). */
const UNEXPLAINED_MM = 0.5

const faceName = (face: string): string => {
  const d = stockFaceDirection(face)
  const label = d === undefined ? face : DIRECTION_LABEL[d]
  return label.charAt(0).toUpperCase() + label.slice(1)
}

const areaText = (mm2: number, units: UnitSystem): string =>
  units === 'mm'
    ? `${Math.round(mm2).toLocaleString('en-US').replaceAll(',', ' ')} mm²`
    : `${(mm2 / 645.16).toFixed(2)} in²`

export function DeviationPanel({
  doc,
  plan,
  units,
}: {
  doc: ProjectDoc
  plan: PlanDTO
  units: UnitSystem
}): React.JSX.Element {
  const store = usePlanStore()
  const run = usePlanState((s) => (s.deviation?.planId === plan.id ? s.deviation : undefined))
  const [, select] = usePlanSelection()
  const basis = useDeviationBasis(plan.id)
  const partId = plan.design.partId
  const references = Object.values(doc.references)
    .filter((r) => r.partId === partId)
    .sort((a, b) => a.name.localeCompare(b.name))
  const [referenceId, setReferenceId] = useState<string | undefined>(undefined)
  const [threshold, setThreshold] = useState(DEVIATION_THRESHOLD_MM)
  const L = (mm: number) => lengthText(mm, units)
  const ref = references.find((r) => r.id === referenceId) ?? references[0]
  const running = run?.running
  const result = run?.result
  // a result that arrives scrolls the group into view (design review R7: under the plan's Checks
  // the regions were below the fold); a result already there when the panel mounts does not
  const groupRef = useRef<HTMLElement>(null)
  const shownResult = useRef(result)
  const reduced = useReducedMotion()
  useEffect(() => {
    if (result === shownResult.current) return
    shownResult.current = result
    if (result === undefined) return
    groupRef.current?.scrollIntoView?.({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
  }, [result, reduced])
  const heading = (
    <span className={styles['deviationHeading']}>
      <Icon name="deviation" />
      {m.title}
    </span>
  )

  if (ref === undefined)
    return (
      <InspectorGroup title={m.title} heading={heading} info={m.info}>
        <p className={styles['muted']}>{m.noReference}</p>
      </InspectorGroup>
    )

  const compare = () =>
    void store.getState().compareDeviation({
      planId: plan.id,
      partId,
      ...(references.length > 1 ? { referenceId: ref.id } : {}),
      threshold,
      basis,
    })

  return (
    <InspectorGroup
      ref={groupRef}
      title={m.title}
      heading={heading}
      info={m.info}
      aria-busy={running !== undefined}
    >
      {references.length > 1 ? (
        <Field label={m.reference}>
          <Select
            value={ref.id}
            options={references.map((r) => ({ value: r.id, label: r.name }))}
            onValueChange={setReferenceId}
          />
        </Field>
      ) : null}
      <QuantityInput
        label={m.threshold}
        stepKind="fit"
        kind="length"
        defaultUnit={defaultUnit('length', units)}
        value={lengthQuantity(threshold, units)}
        onCommit={(q) =>
          setThreshold(Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, q.canonical)))
        }
      />
      <div className={styles['deviationActions']}>
        {running === undefined ? (
          <Button icon={<Icon name="deviation" />} onClick={compare}>
            {result === undefined ? m.compare : m.compareAgain}
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => store.getState().cancelDeviation()}>
            {m.cancel}
          </Button>
        )}
      </div>
      {running !== undefined ? (
        <>
          <p className={styles['muted']} role="status">
            {m.comparing}
          </p>
          <Progress
            label={m.progress}
            value={running.progress?.total === undefined ? null : running.progress.done}
            {...(running.progress?.total === undefined ? {} : { max: running.progress.total })}
          />
        </>
      ) : result === undefined && run?.error === undefined ? (
        <p className={styles['muted']}>{m.hint}</p>
      ) : null}
      {run?.error !== undefined ? <ErrorMessage error={run.error} message={m.failed} /> : null}
      {result === undefined ? null : (
        <DeviationResult
          plan={plan}
          result={result}
          units={units}
          stale={run?.basis !== basis}
          chosen={run?.chosen}
          L={L}
          onChoose={(i, r) => {
            const stock = planStockSize(doc, plan)
            store
              .getState()
              .chooseDeviationRegion(i, stock === undefined ? undefined : regionBox(r, stock))
            if (r.operationId !== undefined) select(r.operationId)
          }}
        />
      )}
    </InspectorGroup>
  )
}

function DeviationResult({
  plan,
  result,
  units,
  stale,
  chosen,
  L,
  onChoose,
}: {
  plan: PlanDTO
  result: DeviationResultView
  units: UnitSystem
  stale: boolean
  chosen: number | undefined
  L: (mm: number) => string
  onChoose: (index: number, region: DeviationRegionView) => void
}): React.JSX.Element {
  const ops = allPlanOperations(plan)
  const opName = (id: string | undefined) => {
    const op = id === undefined ? undefined : ops.find((o) => o.id === id)
    return op === undefined ? undefined : planOperationName(plan, op)
  }
  const n = result.regions.length + (result.more ?? 0)
  const s = result.stats
  const stats: [string, string][] = [
    [m.stat.mean, L(s.mean)],
    [m.stat.p95, L(s.p95)],
    [m.stat.p99, L(s.p99)],
    [m.stat.max, L(s.max)],
    [m.stat.overcutMax, L(s.overcutMax)],
    [m.stat.undercutMax, L(s.undercutMax)],
    [m.stat.areaOver, areaText(s.areaOver, units)],
    [m.stat.edgeBand, areaText(result.excluded.edgeBand, units)],
  ]
  return (
    <div className={styles['deviationResult']}>
      <p className={styles['deviationSummary']} role="status">
        {n === 0
          ? m.within(L(result.threshold))
          : m.summary(n, L(result.threshold), result.unexplained)}
      </p>
      {stale ? <p className={styles['muted']}>{m.outdated}</p> : null}
      {result.regions.length > 0 ? (
        <ul className={styles['deviationList']} aria-label={m.regions}>
          {result.regions.map((r, i) => {
            const op = opName(r.operationId)
            const row = m.region(r.sign, L(r.maxDev), op)
            const unexplained = r.cause === undefined && r.maxDev > UNEXPLAINED_MM
            const cause =
              r.cause !== undefined ? m.cause[r.cause] : unexplained ? m.unexplained : m.noCause
            const name = m.regionName(
              row,
              faceName(r.face).toLowerCase(),
              areaText(r.area, units),
              cause,
            )
            const content = (
              <>
                <span className={styles['deviationKind']}>
                  <span className={styles['swatch']} data-sign={r.sign} aria-hidden="true" />
                  <span className={styles['deviationText']}>{row}</span>
                </span>
                <span
                  className={styles['deviationCause']}
                  data-unexplained={unexplained ? '' : undefined}
                >
                  {cause}
                </span>
              </>
            )
            // every row marks and frames its region; one with an operation also selects it
            return (
              <li key={i}>
                <button
                  type="button"
                  className={styles['deviationRow']}
                  aria-pressed={chosen === i}
                  aria-label={name}
                  onClick={() => onChoose(i, r)}
                >
                  {content}
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
      {result.more ? <p className={styles['muted']}>{m.more(result.more)}</p> : null}
      {/* R7: the numbers after the regions the user acts on, closed by default */}
      <InspectorGroup
        title={m.statistics}
        level={4}
        collapsible
        rememberKey="deviation.statistics"
        summary={m.statisticsSummary(L(s.max), L(s.p95))}
      >
        <dl className={styles['deviationStats']}>
          {stats.map(([term, value]) => (
            <div key={term} className={styles['calcRow']}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {result.faces.length > 1
          ? result.faces.map((f) => (
              <p key={f.face} className={styles['deviationFace']}>
                {m.face(faceName(f.face), L(f.p99), L(f.max))}
              </p>
            ))
          : null}
      </InspectorGroup>
    </div>
  )
}
