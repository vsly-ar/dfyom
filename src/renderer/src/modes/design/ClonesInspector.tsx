// Clones in the inspector (v0.4 task U3, ui.md § Clones): the "Make Clones…" draft (`ClonesDraft`:
// Source checkboxes, the rows editor, the read-out from `design.clones.preview` re-asked at most
// every 100 ms, Make clones / Cancel with Escape; nothing is written until Make clones, which is
// one `design.clones.add`), the Clones inspector (`ClonesInspector`: name, read-out with the
// 100-instance error, its warnings with "Skip them", the Source group with "Add to source…" and
// remove, the rows editor where each change is one `design.clones.update`, findings of the
// instances) and the instance inspector (`CloneInstanceInspector`: "Clone 3 of Clones 1", its
// position read-only, Skip this clone / Restore, one collapsed read-only group per source
// operation). `useSkipToggle` is the one skip command (viewport markers, instance rows, the
// inspector) and announces it politely.
// Doc: docs/conventions/ui.md#clones, #owned-operations-and-clone-instances
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { CLONES_MAX } from '../../../../core/design/clones/clones'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import type { OperationDTO } from '../../../../core/design/part.dto'
import type { UnitSystem } from '../../../../core/project/document'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { useCancelGesture } from '../../shell/hooks'
import { useShell, useUi, useReplica } from '../../shell/ShellContext'
import type { ClonesDraftState } from '../../state/ui-store'
import {
  Button,
  Checkbox,
  ErrorMessage,
  Icon,
  IconButton,
  Menu,
  PanelHeader,
  ReadOnlyReason,
  WarningList,
} from '../../ui'
import type { ClonePathData } from '../../viewport/clone-path'
import { CloneRowList } from './CloneRowList'
import {
  clonesSourceOf,
  draftSource,
  featurePathData,
  instanceId,
  isSkipped,
  pointOf,
  readoutOf,
  rowArgsOf,
  toggleSkip,
  type Readout,
  type RowArg,
} from './clones-view'
import { warningLabels, warningView } from './DesignInspector'
import styles from './Design.module.css'
import { operationUnits } from './feature-view'
import { NameField } from './NameField'
import { OperationFields, placeErrors, type FieldError } from './OperationFields'
import type { DesignPart } from './model'
import { useCommand, useDesignSelection, type DesignWarnings } from './useDesign'

const m = designMessages
const f = m.features
const c = f.clones

/** "9.00 mm" / `0.354"`: a position in the inspector and the viewport's marker names. */
export function positionText(mm: number, units: UnitSystem): string {
  return units === 'inch' ? `${(mm / 25.4).toFixed(3)}"` : `${mm.toFixed(2)} mm`
}

/** Toggles instance `n`'s skip: one `design.clones.update` (one undo step), announced politely. */
export function useSkipToggle(
  part: DesignPart | undefined,
): (feature: FeatureDTO, n: number) => void {
  const call = useCommand()
  const announce = useUi((s) => s.announce)
  return useCallback(
    (feature, n) => {
      if (part === undefined) return
      const data = featurePathData(part, feature.id)
      if (data === undefined || pointOf(data, n) === undefined) return
      const skipped = !isSkipped(data, n)
      void call('design.clones.update', {
        partId: part.dto.id,
        featureId: feature.id,
        rows: toggleSkip(rowArgsOf(feature), data, n),
      }).then((r) => {
        if (r.ok) announce(c.announceSkip(n, skipped))
      })
    },
    [part, call, announce],
  )
}

/** The read-out at the top of the rows group: counts, or the 100-instance error (D36). */
function ReadoutLine({ readout }: { readout: Readout | undefined }): React.JSX.Element {
  const text =
    readout === undefined
      ? ''
      : readout.over !== undefined
        ? c.overLimit(readout.over.actual, CLONES_MAX, readout.over.excess)
        : c.readout(readout.clones, readout.instances, readout.skipped)
  return (
    <p
      className={styles['clonesReadout']}
      data-invalid={readout?.over !== undefined || undefined}
      aria-live="polite"
    >
      {readout?.over !== undefined ? <Icon name="error" size="sm" /> : null}
      <span>{text}</span>
    </p>
  )
}

/** The face-frame position (mm) where a new point row jumps from: the path's last position. */
function lastPosition(data: ClonePathData | undefined): { u: number; v: number } {
  const last = data?.rows.at(-1)?.points.at(-1)?.at ?? data?.instances[0]?.at ?? [0, 0]
  return { u: last[0], v: last[1] }
}

/** The step of a new row (mm): the first row's u step when it is an offset, else 10 mm. */
function newRowStep(rows: readonly RowArg[], data: ClonePathData | undefined): number {
  const pts = data?.rows[0]?.points
  const origin = data?.instances[0]?.at
  if (rows[0]?.kind === 'offset' && pts?.[0] !== undefined && origin !== undefined) {
    const d = Math.hypot(pts[0].at[0] - origin[0], pts[0].at[1] - origin[1])
    if (d > 0) return Math.round(d * 1000) / 1000
  }
  return 10
}

/** Where the source starts in design order: references resolve against what comes before it. */
function sourceIndex(part: DesignPart, ids: readonly string[]): number {
  const set = new Set(ids)
  const i = part.dto.operations.findIndex((o) => set.has(o.id) || set.has(o.featureId ?? ''))
  return i < 0 ? part.dto.operations.length : i
}

// ── draft ────────────────────────────────────────────────────────────────────────────────

/** The draft's preview, asked at most every 100 ms; stale replies are dropped. */
function useThrottledPreview(
  part: DesignPart,
  request: { source: unknown; rows: readonly RowArg[] },
  onResult: (data: ClonePathData | null, error: AppErrorData | undefined) => void,
): void {
  const { bridge } = useShell()
  const replica = useReplica()
  const revision = replica.status === 'open' ? replica.revision : -1
  const last = useRef(0)
  const latest = useRef('')
  const key = JSON.stringify(request)
  const result = useRef(onResult)
  useEffect(() => {
    result.current = onResult
  })
  useEffect(() => {
    latest.current = key
    const run = () => {
      last.current = Date.now()
      void bridge
        .call('design.clones.preview', { partId: part.dto.id, ...(JSON.parse(key) as object) })
        .then((r) => {
          if (latest.current !== key) return
          if (r.ok) result.current(r.value as ClonePathData, undefined)
          else result.current(null, r.error)
        })
    }
    const wait = Math.max(0, 100 - (Date.now() - last.current))
    const t = setTimeout(run, wait)
    return () => clearTimeout(t)
  }, [bridge, part.dto.id, key, revision])
}

export function ClonesDraft({
  part,
  draft,
}: {
  part: DesignPart
  draft: ClonesDraftState
}): React.JSX.Element {
  const call = useCommand()
  const { ui } = useShell()
  const [, select] = useDesignSelection()
  const cancelGesture = useCancelGesture()
  const [errors, setErrors] = useState<FieldError[]>([])
  const [summary, setSummary] = useState<AppErrorData | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const source = draftSource(draft.options, draft.unchecked, draft.feature)
  const data = draft.preview ?? undefined
  const readout = data === undefined ? undefined : readoutOf(data)

  const patch = (p: Partial<ClonesDraftState>) => {
    const now = ui.getState().clonesDraft
    if (now !== null) ui.getState().setClonesDraft({ ...now, ...p })
  }
  useThrottledPreview(part, { source, rows: draft.rows }, (preview, error) => {
    if (preview !== null) {
      patch({ preview })
      setErrors([])
      setSummary(undefined)
    } else if (error !== undefined) {
      const placed = placeErrors(error, 'rows')
      setErrors(placed.errors)
      setSummary(placed.summary)
    }
  })

  const cancel = () => {
    ui.getState().setClonesDraft(null)
    ui.getState().setClonesRow(null)
  }
  const make = async () => {
    if (busy) return
    setBusy(true)
    const r = await call('design.clones.add', { partId: part.dto.id, source, rows: draft.rows })
    setBusy(false)
    if (!r.ok) {
      const placed = placeErrors(r.error, 'rows')
      setErrors(placed.errors)
      setSummary(placed.summary)
      return
    }
    const id = (r.value as { featureId: string }).featureId
    ui.getState().setClonesDraft(null)
    ui.getState().setClonesRow({ owner: id, row: 0 })
    select(id)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    e.preventDefault()
    cancel()
  }
  const ids = draft.options.map((o) => o.id)
  const resolver = part.table?.resolver(sourceIndex(part, ids))

  return (
    <div className={styles['inspector']} onKeyDown={onKeyDown}>
      <PanelHeader title={c.draftTitle} meta={c.draftMeta} />
      <div className={styles['fields']}>
        {summary ? <ErrorMessage error={summary} message={m.inspector.commandFailed} /> : null}
        <section className={styles['group']} aria-label={c.source}>
          <h3 className={styles['groupTitle']}>{c.source}</h3>
          <ul className={styles['cloneSources']}>
            {draft.options.map((o) =>
              o.fixed ? (
                <li key={o.id} className={styles['cloneSourceFixed']}>
                  <Icon name="clones" size="sm" />
                  {o.label}
                </li>
              ) : (
                <li key={o.id}>
                  <Checkbox
                    label={o.label}
                    checked={!draft.unchecked.has(o.id)}
                    onCheckedChange={(v) => {
                      const next = new Set(draft.unchecked)
                      if (v === true) next.delete(o.id)
                      else next.add(o.id)
                      patch({ unchecked: next })
                    }}
                  />
                </li>
              ),
            )}
          </ul>
          {errors
            .filter((e) => e.path.startsWith('source'))
            .map((e, i) => (
              <p key={i} className={styles['fieldError']}>
                {e.text}
              </p>
            ))}
        </section>
        <section className={styles['group']} aria-label={c.rows}>
          <h3 className={styles['groupTitle']}>{c.rows}</h3>
          <ReadoutLine readout={readout} />
          <CloneRowList
            owner="draft"
            rows={draft.rows}
            units={part.units}
            shapes={part.dto.shapes ?? []}
            resolver={resolver}
            data={data}
            errors={errors}
            over={readout?.over}
            step={newRowStep(draft.rows, data)}
            lastAt={lastPosition(data)}
            onChange={(rows) => patch({ rows })}
            onCancelGesture={cancelGesture}
            onRestore={(n) =>
              data !== undefined && patch({ rows: toggleSkip(draft.rows, data, n) })
            }
          />
        </section>
        <div className={styles['draftActions']}>
          <Button
            variant="primary"
            icon={<Icon name="clones" />}
            onClick={() => void make()}
            disabled={busy}
          >
            {c.make}
          </Button>
          <Button onClick={cancel} aria-keyshortcuts="Escape">
            {c.cancel}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── feature ──────────────────────────────────────────────────────────────────────────────

/** Plain operations on the Clones' face that could join its source ("Add to source…"). */
function addableToSource(part: DesignPart, feature: FeatureDTO, ids: readonly string[]) {
  const nested = new Set<string>()
  for (const u of operationUnits(part))
    if (u.kind === 'feature') for (const n of u.nested) nested.add(n.id)
  const owner = (on: string) => on.slice(0, on.indexOf('.') < 0 ? on.length : on.indexOf('.'))
  const inSource = new Set(ids)
  return part.dto.operations.filter(
    (o) =>
      !inSource.has(o.id) &&
      o.featureId === undefined &&
      !nested.has(o.id) &&
      o.kind !== 'facing' &&
      !(o.kind === 'profile' && o.side === 'outside') &&
      (o.on === feature.on || inSource.has(owner(o.on ?? 'stock.top'))),
  )
}

export function ClonesInspector({
  part,
  feature,
  warnings,
}: {
  part: DesignPart
  feature: FeatureDTO
  warnings: DesignWarnings
}): React.JSX.Element {
  const call = useCommand()
  const { bridge } = useShell()
  const [, select] = useDesignSelection()
  const cancelGesture = useCancelGesture()
  const toggle = useSkipToggle(part)
  const [errors, setErrors] = useState<FieldError[]>([])
  const [summary, setSummary] = useState<AppErrorData | undefined>(undefined)
  // a refused change over the limit: its rows' path, so the read-out says how far over
  const [attempt, setAttempt] = useState<ClonePathData | undefined>(undefined)
  const rows = rowArgsOf(feature)
  const data = featurePathData(part, feature.id)
  const shown = attempt ?? data
  const readout = shown === undefined ? undefined : readoutOf(shown)
  const source = clonesSourceOf(feature)
  const unit = operationUnits(part).find((u) => u.id === feature.id)
  const nested = unit?.kind === 'feature' ? unit.nested : []
  const owned = unit?.kind === 'feature' ? unit.ops : []
  const sourceIds = 'featureId' in source ? [source.featureId] : source.operationIds
  const resolver = part.table?.resolver(sourceIndex(part, sourceIds))
  const own = warnings.warnings.filter((w) => w.operation === feature.id)
  const ownedIds = new Set(owned.map((o) => o.id))
  const findings = warnings.warnings.filter((w) => ownedIds.has(w.operation))

  const update = async (args: Record<string, unknown>, path: string, gesture?: string) => {
    const r = await call(
      'design.clones.update',
      { partId: part.dto.id, featureId: feature.id, ...args },
      gesture === undefined ? undefined : { gesture },
    )
    if (r.ok) {
      setErrors([])
      setSummary(undefined)
      setAttempt(undefined)
      return
    }
    const limit = r.error.issues.some((i) => i.rule === 'clonesLimit')
    if (limit && args['rows'] !== undefined) {
      const p = await bridge.call('design.clones.preview', {
        partId: part.dto.id,
        source,
        rows: args['rows'],
      })
      if (p.ok) {
        setAttempt(p.value as ClonePathData)
        setErrors([])
        setSummary(undefined)
        return
      }
    }
    setAttempt(undefined)
    const placed = placeErrors(r.error, path)
    setErrors(placed.errors)
    setSummary(placed.summary)
  }

  // "Skip them" of dfm.cloneOutsideStock: every listed position skipped in one command
  const skipAll = (numbers: readonly number[]) => {
    if (data === undefined) return
    let next: RowArg[] = rows
    for (const n of numbers) if (!isSkipped(data, n)) next = toggleSkip(next, data, n)
    void update({ rows: next }, 'rows')
  }
  const addable =
    'operationIds' in source ? addableToSource(part, feature, source.operationIds) : []

  return (
    <div className={styles['inspector']}>
      <PanelHeader title={feature.name} meta={feature.id} />
      <div className={styles['fields']}>
        {summary ? <ErrorMessage error={summary} message={m.inspector.commandFailed} /> : null}
        <NameField
          label={m.inspector.name}
          name={feature.name}
          onCommit={(n) => void update({ name: n }, 'name')}
        />
        <section className={styles['group']} aria-label={c.source}>
          <h3 className={styles['groupTitle']}>{c.source}</h3>
          <ul className={styles['cloneSources']} aria-label={c.sourceList}>
            {nested.map((n) => {
              const label = n.kind === 'operation' ? n.op.name : n.feature.name
              const removable = 'operationIds' in source && source.operationIds.length > 1
              return (
                <li key={n.id} className={styles['cloneSourceItem']}>
                  <button
                    type="button"
                    className={styles['inlineLink']}
                    onClick={() => select(n.id)}
                  >
                    {label}
                  </button>
                  {'operationIds' in source ? (
                    <IconButton
                      label={c.removeFromSource(label)}
                      icon={<Icon name="close" />}
                      {...(removable ? {} : { 'aria-disabled': true, title: c.removeLastSource })}
                      onClick={() =>
                        removable
                          ? void update(
                              {
                                source: {
                                  operationIds: source.operationIds.filter((x) => x !== n.id),
                                },
                              },
                              'source',
                            )
                          : undefined
                      }
                    />
                  ) : null}
                </li>
              )
            })}
          </ul>
          {'operationIds' in source ? (
            <Menu
              label={c.addToSource}
              items={
                addable.length > 0
                  ? addable.map((o) => ({
                      label: o.name,
                      onSelect: () =>
                        void update(
                          { source: { operationIds: [...source.operationIds, o.id] } },
                          'source',
                        ),
                    }))
                  : [{ label: c.noneToAdd, onSelect: () => {}, disabledReason: c.noneToAdd }]
              }
            >
              <Button size="sm" icon={<Icon name="add" />}>
                {c.addToSource}
              </Button>
            </Menu>
          ) : null}
          {errors
            .filter((e) => e.path.startsWith('source'))
            .map((e, i) => (
              <p key={i} className={styles['fieldError']}>
                {e.text}
              </p>
            ))}
        </section>
        <section className={styles['group']} aria-label={c.rows} data-feature-field="rows">
          <h3 className={styles['groupTitle']}>{c.rows}</h3>
          <ReadoutLine readout={readout} />
          {own.length > 0 ? (
            <WarningList
              labels={warningLabels}
              items={own.map((w) => {
                const view = warningView(w, part, undefined)
                const numbers = (w.params['numbers'] as number[] | undefined) ?? []
                return w.code === 'dfm.cloneOutsideStock' && numbers.length > 0
                  ? { ...view, fix: { label: c.skipThem, onApply: () => skipAll(numbers) } }
                  : view
              })}
            />
          ) : null}
          <CloneRowList
            owner={feature.id}
            rows={rows}
            units={part.units}
            shapes={part.dto.shapes ?? []}
            resolver={resolver}
            data={data}
            errors={errors}
            over={readout?.over}
            step={newRowStep(rows, data)}
            lastAt={lastPosition(data)}
            onChange={(next, path, gesture) => void update({ rows: next }, path, gesture)}
            onCancelGesture={cancelGesture}
            onRestore={(n) => toggle(feature, n)}
          />
        </section>
        {findings.length > 0 ? (
          <section className={styles['group']} aria-label={f.findings}>
            <h3 className={styles['groupTitle']}>{f.findings}</h3>
            <WarningList
              labels={warningLabels}
              items={findings.map((w) => warningView(w, part, undefined, select))}
            />
          </section>
        ) : null}
      </div>
    </div>
  )
}

// ── instance ─────────────────────────────────────────────────────────────────────────────

export function CloneInstanceInspector({
  part,
  feature,
  n,
}: {
  part: DesignPart
  feature: FeatureDTO
  n: number
}): React.JSX.Element {
  const [, select] = useDesignSelection()
  const toggle = useSkipToggle(part)
  const cancelGesture = useCancelGesture()
  const reasonId = useId()
  const data = featurePathData(part, feature.id)
  const at = data === undefined ? undefined : pointOf(data, n)
  const point = at === undefined ? undefined : data!.rows[at.row]!.points[at.point]!
  const skipped = point?.kind === 'skipped'
  const duplicate = point?.kind === 'duplicate'
  const unit = operationUnits(part).find((u) => u.id === feature.id)
  const nested = unit?.kind === 'feature' ? unit.nested : []
  // the source operations in design order (a feature source: its owned operations)
  const sourceOps: OperationDTO[] = nested.flatMap((u) =>
    u.kind === 'operation' ? [u.op] : [...u.ops],
  )
  const instanceOp = (src: OperationDTO) =>
    part.dto.operations.find((o) => o.id === `${instanceId(feature.id, n)}_${src.id}`)
  const units = part.units

  return (
    <div className={styles['inspector']}>
      <PanelHeader title={c.instanceTitle(n, feature.name)} meta={instanceId(feature.id, n)} />
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
                onClick={() => select(instanceId(feature.id, n))}
              >
                {f.instance(n)}
              </button>
            </li>
          </ol>
        </nav>
        <dl className={styles['featureFacts']}>
          <div className={styles['featureFact']}>
            <dt>{c.position}</dt>
            <dd>
              {point === undefined
                ? '–'
                : c.at(positionText(point.at[0], units), positionText(point.at[1], units))}
            </dd>
          </div>
        </dl>
        {skipped ? <p className={styles['muted']}>{c.skippedNote}</p> : null}
        {duplicate ? <p className={styles['muted']}>{c.duplicateNote}</p> : null}
        {point !== undefined && !duplicate ? (
          <div className={styles['draftActions']}>
            <Button size="sm" onClick={() => toggle(feature, n)}>
              {skipped ? c.restore : c.skipThis}
            </Button>
          </div>
        ) : null}
        {!skipped && !duplicate ? (
          <ReadOnlyReason id={reasonId}>
            <span id={reasonId} className={styles['srOnly']}>
              {c.readOnly(feature.name)}
            </span>
            {sourceOps.map((src) => {
              const op = instanceOp(src)
              return (
                <details key={src.id} className={styles['instanceGroup']}>
                  <summary>{c.instanceGroup(src.name, n)}</summary>
                  <p className={styles['ownedNoteText']}>
                    {c.cloneOf}{' '}
                    <button
                      type="button"
                      className={styles['inlineLink']}
                      onClick={() => select(src.id)}
                    >
                      {src.name}
                    </button>
                  </p>
                  <p className={styles['muted']}>{c.followsTool(src.name)}</p>
                  {op !== undefined ? (
                    <OperationFields
                      level={4}
                      ctx={{
                        part,
                        op,
                        units,
                        warnings: [],
                        errors: [],
                        readOnly: true,
                        pickable: false,
                        send: () => {},
                        cancelGesture,
                      }}
                    />
                  ) : null}
                </details>
              )
            })}
          </ReadOnlyReason>
        ) : null}
      </div>
    </div>
  )
}
