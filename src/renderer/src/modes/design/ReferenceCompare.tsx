// The Reference panel's Compare region and the viewport's compare legend (DF60 P5): a switch
// turns the overlay on for this reference (`referenceCompare`; `useReferenceCompare` runs it), a
// threshold, the summary and the regions list (choosing one frames it and selects its operation).
// The legend shows over the viewport while the overlay is on, with Hide, since choosing a region
// selects its operation and the panel closes.
// Doc: docs/conventions/ui.md#reference-tools-df60, docs/modes/reference-tools.md#overlay-ui
import { useState } from 'react'
import type { ReferenceDTO } from '../../../../core/design/reference.dto'
import { referenceMessages } from '../../messages/reference'
import { useUi } from '../../shell/ShellContext'
import { Button, ErrorMessage, InspectorGroup, QuantityInput, Switch } from '../../ui'
import styles from './Design.module.css'
import { defaultUnit, type DesignPart } from './model'
import {
  COMPARE_THRESHOLD_MM,
  regionFrame,
  worstRegion,
  type CompareRegion,
} from './reference-compare-state'
import { lengthQuantity, lengthSource } from './reference-view'
import { useDesignPart, useDesignSelection } from './useDesign'

const c = referenceMessages.compare
const THRESHOLD_MIN = 0.001
const THRESHOLD_MAX = 10

export function ReferenceCompare({
  part,
  reference: ref,
}: {
  part: DesignPart
  reference: ReferenceDTO
}): React.JSX.Element {
  const settings = useUi((s) => s.referenceCompare)
  const setSettings = useUi((s) => s.setReferenceCompare)
  const state = useUi((s) => s.compareResult)
  const chosen = useUi((s) => s.compareRegion)
  const choose = useUi((s) => s.setCompareRegion)
  const focus = useUi((s) => s.focusViewport)
  const [, select] = useDesignSelection()
  const on = settings !== null && settings.referenceId === ref.id && settings.partId === part.dto.id
  // the threshold while off: the next switch-on starts from it
  const [offThreshold, setThreshold] = useState(settings?.threshold ?? COMPARE_THRESHOLD_MM)
  const threshold = on ? settings.threshold : offThreshold
  const units = part.units
  const L = (mm: number) => lengthSource(mm, units)
  const result = on ? state.result : undefined
  const worst = result === undefined ? undefined : worstRegion(result)
  const opName = (r: CompareRegion) =>
    part.dto.operations.find((o) => o.id === r.operationIds[0])?.name

  const pick = (r: CompareRegion, i: number) => {
    choose(i)
    focus(regionFrame(r))
    const op = r.operationIds[0]
    if (op !== undefined) select(op)
  }

  return (
    <InspectorGroup title={c.title} aria-busy={on && state.busy}>
      <Switch
        label={c.show}
        checked={on}
        onCheckedChange={(v) =>
          setSettings(v ? { partId: part.dto.id, referenceId: ref.id, threshold } : null)
        }
      />
      <QuantityInput
        label={c.threshold}
        stepKind="fit"
        kind="length"
        defaultUnit={defaultUnit('length', units)}
        value={lengthQuantity(threshold, units)}
        onCommit={(q) => {
          const mm = Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, q.canonical))
          setThreshold(mm)
          if (on) setSettings({ ...settings, threshold: mm })
        }}
      />
      {!on ? (
        <p className={styles['muted']}>{c.hint}</p>
      ) : result === undefined ? (
        state.error !== undefined ? (
          <ErrorMessage error={state.error} message={c.failed} />
        ) : (
          <p className={styles['muted']} role="status">
            {c.comparing}
          </p>
        )
      ) : (
        <>
          <p className={styles['compareSummary']} role="status">
            {worst === undefined
              ? c.within(L(result.threshold))
              : c.summary(
                  result.regions.length + (result.more ?? 0),
                  L(result.threshold),
                  L(worst.maxDev),
                  worst.kind,
                )}
          </p>
          {result.method === 'heightmap' ? <p className={styles['muted']}>{c.heightmap}</p> : null}
          {state.error !== undefined ? (
            <ErrorMessage error={state.error} message={c.failed} />
          ) : null}
          {result.regions.length > 0 ? (
            <ul className={styles['holeList']} aria-label={c.regions}>
              {result.regions.map((r, i) => {
                const op = opName(r)
                const row = c.region(r.kind, L(r.maxDev), op)
                return (
                  <li key={i}>
                    <button
                      type="button"
                      className={styles['levelRow']}
                      data-compare-row=""
                      aria-pressed={chosen === i}
                      aria-label={c.regionName(row, c.volume(r.volume))}
                      onClick={() => pick(r, i)}
                    >
                      <span className={styles['compareKind']}>
                        <span className={styles['swatch']} data-kind={r.kind} aria-hidden="true" />
                        <span>
                          {c.kind[r.kind]} {L(r.maxDev)}
                          {op === undefined ? null : ` · ${op}`}
                        </span>
                      </span>
                      <span className={styles['levelArea']}>
                        {r.cause === 'cornerRadius'
                          ? c.fillet
                          : op === undefined
                            ? c.noOperation
                            : c.volume(r.volume)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : null}
          {result.more ? <p className={styles['muted']}>{c.more(result.more)}</p> : null}
          {result.below.count > 0 ? (
            <p className={styles['muted']}>{c.below(result.below.count)}</p>
          ) : null}
        </>
      )}
    </InspectorGroup>
  )
}

/** Over the viewport while the compare overlay is on (design mode): the map's legend and Hide. */
export function CompareLegend(): React.JSX.Element | null {
  const part = useDesignPart()
  const settings = useUi((s) => s.referenceCompare)
  const setSettings = useUi((s) => s.setReferenceCompare)
  const state = useUi((s) => s.compareResult)
  if (settings === null || part === undefined || settings.partId !== part.dto.id) return null
  const L = (mm: number) => lengthSource(mm, part.units)
  const r = state.result
  const missing = L(Math.max(r?.stats.maxMissing ?? 0, settings.threshold))
  const extra = L(Math.max(r?.stats.maxExtra ?? 0, settings.threshold))
  const band = L(settings.threshold)
  return (
    <div className={styles['compareLegend']} aria-busy={state.busy}>
      <span className={styles['compareLegendTitle']}>{c.overlayTitle}</span>
      <div role="img" aria-label={`${c.legend}: ${c.legendText(missing, band, extra)}`}>
        <div className={styles['compareBar']} aria-hidden="true" />
        <div className={styles['compareEnds']} aria-hidden="true">
          <span>{c.missingEnd(missing)}</span>
          <span>{c.band(band)}</span>
          <span>{c.extraEnd(extra)}</span>
        </div>
      </div>
      <Button size="sm" variant="ghost" onClick={() => setSettings(null)}>
        {c.hide}
      </Button>
    </div>
  )
}
