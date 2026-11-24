// Setup inspector, alignment phase 1 (hardening DF78): the setup's work zero (X/Y from the
// front-left corner of the up face, negative valid; reset to the corner) and its alignment points
// in cycle order (add from a menu of the sources this setup can use, rename, reorder, remove,
// put the zero on one). Each change is one command: `plan.setup.update { zero }` or
// `plan.alignment.set` with the whole list. Focusing a point marks it in the viewport. The aids
// section's helpers place two marks or holes for the next setup with the chosen edges, holes on
// the flip axis or at corners, and an inset (DF83; `plan.aid.set { place, edges, holesAt, inset }`).
// Doc: docs/modes/alignment.md#plan-ui, docs/conventions/ui.md#design-and-plan-controls-v02
import { useEffect, useState } from 'react'
import type { AlignmentPointDTO } from '../../../../core/plan/alignment.dto'
import type { PlanWarning } from '../../../../core/plan/checks'
import type { PlanDTO, SetupDTO } from '../../../../core/plan/plan.dto'
import type { UnitSystem } from '../../../../core/project/document'
import { fieldContext } from '../../../../core/design/operation'
import { Quantity } from '../../../../core/quantity/quantity'
import type { AppErrorData, Issue } from '../../../../shared/errors/app-error'
import { lengthSource } from '../../messages/dfm'
import { findingText, planMessages, sentence } from '../../messages/plan'
import { useCancelGesture } from '../../shell/hooks'
import {
  Button,
  ErrorMessage,
  FieldIcon,
  Icon,
  IconButton,
  Menu,
  QuantityInput,
  SegmentedControl,
  type FieldMessage,
  type MenuEntry,
} from '../../ui'
import { defaultUnit } from '../design/model'
import { pointsWithAdded, setupZeroOf } from './model'
import {
  usePlanCommand,
  usePlanState,
  usePlanStore,
  type AlignmentSourceView,
  type SetupAlignmentView,
} from './plan-store'
import styles from './Plan.module.css'
import { NameField } from './PlanInspector'

const m = planMessages.setup

/** Whether `later` turns the stock over against `setup` (opposite up faces: a flip axis, Q106). */
const flips = (setup: SetupDTO, later: SetupDTO): boolean => {
  const a = setup.direction ?? '+z'
  const b = later.direction ?? '+z'
  return a[1] === b[1] && a[0] !== b[0]
}

export function AlignmentFields({
  plan,
  setup,
  units,
  readOnly,
  info,
  sources,
  warnings,
}: {
  plan: PlanDTO
  setup: SetupDTO
  units: UnitSystem
  readOnly: boolean
  info: SetupAlignmentView | undefined
  sources: readonly AlignmentSourceView[]
  warnings: readonly PlanWarning[]
}): React.JSX.Element {
  const call = usePlanCommand()
  const store = usePlanStore()
  const cancelGesture = useCancelGesture()
  const [errors, setErrors] = useState<readonly Issue[]>([])
  const [failed, setFailed] = useState<AppErrorData | undefined>(undefined)
  const zero = setupZeroOf(setup, info)
  const points = setup.alignment ?? []
  const onPoint = setup.zero !== undefined && 'point' in setup.zero ? setup.zero.point : undefined
  const pointName = (id: string) => info?.points.find((p) => p.id === id)?.name ?? id

  const done = (r: { ok: true } | { ok: false; error: AppErrorData }) => {
    setErrors(r.ok ? [] : r.error.issues)
    setFailed(r.ok || r.error.issues.length > 0 ? undefined : r.error)
  }
  const setZero = async (zeroArg: object | null, gesture?: string) =>
    done(
      await call(
        'plan.setup.update',
        { planId: plan.id, setupId: setup.id, zero: zeroArg },
        gesture === undefined ? undefined : { gesture },
      ),
    )
  const setPoints = async (list: readonly AlignmentPointDTO[]) =>
    done(
      await call('plan.alignment.set', {
        planId: plan.id,
        setupId: setup.id,
        points: list.map((p) => ({
          id: p.id,
          ...(p.name === undefined ? {} : { name: p.name }),
          source: p.source,
        })),
      }),
    )
  const setPointsArgs = (list: readonly { id?: string; name?: string; source: object }[]) =>
    call('plan.alignment.set', { planId: plan.id, setupId: setup.id, points: list })
  // a new point goes last, without an id (the core names it after its source)
  const add = async (s: AlignmentSourceView) =>
    done(await setPointsArgs(pointsWithAdded(setup, s.source)))
  // S22: picking in the viewport (the scene draws the sources as targets while on)
  const picking = usePlanState((st) => st.pickingAlignment) === setup.id
  useEffect(() => {
    if (!picking) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') store.getState().pickAlignment(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      // leaving the setup (or the inspector) ends picking
      store.getState().pickAlignment(undefined)
    }
  }, [picking, store])
  // S18: aids cut here for the next setup
  const index = plan.setups.findIndex((x) => x.id === setup.id)
  const next = plan.setups[index + 1]
  // DF83: the helpers' choices, kept while the setup is shown
  const [edges, setEdges] = useState<'auto' | 'frontBack' | 'leftRight'>('auto')
  const [holesAt, setHolesAt] = useState<'axis' | 'corners'>('axis')
  const [inset, setInset] = useState<string | undefined>(undefined)
  const flipNext = next !== undefined && flips(setup, next)
  const placeAids = async (place: 'marks' | 'holes') => {
    if (next === undefined) return
    done(
      await call('plan.aid.set', {
        planId: plan.id,
        setupId: setup.id,
        place,
        forSetupId: next.id,
        ...(place === 'marks' && edges !== 'auto' ? { edges } : {}),
        ...(place === 'holes' && flipNext ? { holesAt } : {}),
        ...(inset === undefined ? {} : { inset }),
      }),
    )
  }
  const move = (i: number, by: -1 | 1) => {
    const list = [...points]
    const [p] = list.splice(i, 1)
    list.splice(i + by, 0, p!)
    void setPoints(list)
  }

  const length = (mm: number) =>
    Quantity.parse(lengthSource(mm, units), fieldContext('length', units)).unwrap()
  const messages = (k: number): FieldMessage[] =>
    errors
      .filter((i) => i.path[0] === 'zero')
      .filter((i) => i.path[1] !== 'at' || i.path[2] === undefined || i.path[2] === k)
      .map((i, n) => ({ id: `zero-${k}-${n}`, severity: 'error', text: sentence(i.message) }))
  const commitAxis = (k: 0 | 1, source: string, gesture?: string) => {
    const at = [lengthSource(zero[0], units), lengthSource(zero[1], units)]
    at[k] = source
    void setZero({ at }, gesture)
  }

  const groups: MenuEntry[] = (
    [
      [
        m.pointGroupStock,
        sources.filter((s) => !('operation' in s.source) && !('aid' in s.source)),
      ],
      [m.pointGroupAids, sources.filter((s) => 'aid' in s.source)],
      [m.pointGroupHoles, sources.filter((s) => 'hole' in s.source)],
      [m.pointGroupVertices, sources.filter((s) => 'vertex' in s.source)],
    ] as const
  )
    .filter(([, list]) => list.length > 0)
    .map(([group, list]) => ({
      group,
      items: list.map((s) => ({
        label: s.name,
        description: m.pointAt(
          lengthSource(s.at[0] - zero[0], units),
          lengthSource(s.at[1] - zero[1], units),
        ),
        onSelect: () => void add(s),
      })),
    }))

  return (
    <>
      <section aria-labelledby={`zero-${setup.id}`} className={styles['alignGroup']}>
        <h3 id={`zero-${setup.id}`} className={styles['groupTitle']}>
          {m.zeroTitle}
        </h3>
        {failed ? (
          <ErrorMessage error={failed} message={planMessages.inspector.commandFailed} />
        ) : null}
        {([0, 1] as const).map((k) => (
          <QuantityInput
            key={k}
            label={k === 0 ? m.zeroX : m.zeroY}
            kind="length"
            defaultUnit={defaultUnit('length', units)}
            value={length(zero[k])}
            illustration={<FieldIcon name={k === 0 ? 'positionX' : 'positionY'} />}
            readOnly={readOnly}
            messages={[
              ...messages(k),
              ...(k === 1
                ? [
                    {
                      id: 'zeroHint',
                      severity: 'note' as const,
                      text: onPoint === undefined ? m.zeroHint : m.zeroOnPoint(pointName(onPoint)),
                    },
                  ]
                : []),
            ]}
            onCommit={(q, gesture) => commitAxis(k, q.source, gesture)}
            onCancelGesture={cancelGesture}
          />
        ))}
        <div className={styles['alignActions']}>
          <Button
            size="sm"
            variant="default"
            disabled={readOnly || setup.zero === undefined}
            title={setup.zero === undefined ? m.zeroResetDone : undefined}
            onClick={() => void setZero(null)}
          >
            {m.zeroReset}
          </Button>
        </div>
      </section>
      <section aria-labelledby={`points-${setup.id}`} className={styles['alignGroup']}>
        <h3 id={`points-${setup.id}`} className={styles['groupTitle']}>
          {m.pointsTitle}
        </h3>
        {points.length === 0 ? <p className={styles['muted']}>{m.pointsEmpty}</p> : null}
        {points.length > 0 ? (
          <ol className={styles['alignList']} aria-label={m.pointsList}>
            {points.map((p, i) => {
              const view = info?.points.find((x) => x.id === p.id)
              const name = view?.name ?? p.name ?? p.id
              const own = warnings.filter((w) => w.params['alignmentPointId'] === p.id)
              const error = own.find((w) => w.severity === 'error')
              const isZero = onPoint === p.id
              return (
                <li
                  key={p.id}
                  className={styles['alignRow']}
                  data-error={error ? '' : undefined}
                  onFocus={() => store.getState().focusAlignmentPoint(p.id)}
                  onBlur={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                      store.getState().focusAlignmentPoint(undefined)
                  }}
                  onPointerEnter={() => store.getState().focusAlignmentPoint(p.id)}
                  onPointerLeave={() => store.getState().focusAlignmentPoint(undefined)}
                >
                  <span className={styles['alignIndex']} aria-hidden="true">
                    {i + 1}
                  </span>
                  <div className={styles['alignBody']}>
                    <NameField
                      label={m.pointName(i + 1)}
                      name={name}
                      readOnly={readOnly}
                      onCommit={(newName) =>
                        void setPoints(
                          points.map((x) => (x.id === p.id ? { ...x, name: newName } : x)),
                        )
                      }
                    />
                    <p className={styles['alignMeta']}>
                      {view?.wcs == null
                        ? m.pointMissing
                        : m.pointAt(
                            lengthSource(view.wcs[0], units),
                            lengthSource(view.wcs[1], units),
                          )}
                      {isZero ? (
                        <span className={styles['alignZero']}>
                          <Icon name="work-zero" size="sm" /> {m.pointIsZero}
                        </span>
                      ) : null}
                    </p>
                    {own.map((w, n) => (
                      <p
                        key={n}
                        className={styles['alignFinding']}
                        data-severity={w.severity}
                        role={w.severity === 'error' ? 'alert' : undefined}
                      >
                        <Icon name={w.severity === 'error' ? 'error' : 'warning'} size="sm" />{' '}
                        {findingText(w, units)}
                      </p>
                    ))}
                  </div>
                  {readOnly ? null : (
                    <Menu
                      label={m.pointActions(name)}
                      align="end"
                      items={[
                        {
                          label: m.pointZeroHere,
                          icon: <Icon name="work-zero" />,
                          disabled: isZero || view?.wcs == null,
                          onSelect: () => void setZero({ point: p.id }),
                        },
                        'separator',
                        {
                          label: m.pointMoveUp,
                          icon: <Icon name="arrow-up" />,
                          disabled: i === 0,
                          onSelect: () => move(i, -1),
                        },
                        {
                          label: m.pointMoveDown,
                          icon: <Icon name="arrow-down" />,
                          disabled: i === points.length - 1,
                          onSelect: () => move(i, 1),
                        },
                        'separator',
                        {
                          label: m.pointRemove,
                          icon: <Icon name="delete" />,
                          danger: true,
                          disabled: isZero,
                          disabledReason: isZero ? m.pointRemoveZero : undefined,
                          onSelect: () => void setPoints(points.filter((x) => x.id !== p.id)),
                        },
                      ]}
                    >
                      <IconButton label={m.pointActions(name)} icon={<Icon name="more" />} />
                    </Menu>
                  )}
                </li>
              )
            })}
          </ol>
        ) : null}
        {readOnly ? null : (
          <div className={styles['alignActions']}>
            {groups.length === 0 ? (
              <Button size="sm" variant="default" disabled title={m.pointAddNone}>
                <Icon name="add" /> {m.pointAdd}
              </Button>
            ) : (
              <Menu label={m.pointAddLabel} items={groups}>
                <Button size="sm" variant="default" aria-label={m.pointAddLabel}>
                  <Icon name="add" /> {m.pointAdd}
                </Button>
              </Menu>
            )}
            <Button
              size="sm"
              variant="default"
              aria-pressed={picking}
              disabled={groups.length === 0 && !picking}
              onClick={() => store.getState().pickAlignment(picking ? undefined : setup.id)}
            >
              <Icon name="pick" /> {picking ? m.pickStop : m.pickStart}
            </Button>
          </div>
        )}
        {picking ? (
          <p className={styles['muted']} role="status">
            {m.pickHint}
          </p>
        ) : null}
      </section>
      {readOnly ? null : (
        <section aria-labelledby={`aids-${setup.id}`} className={styles['alignGroup']}>
          <h3 id={`aids-${setup.id}`} className={styles['groupTitle']}>
            {m.aidsTitle}
          </h3>
          <p className={styles['muted']}>
            {next === undefined ? m.aidsNone : m.aidsHint(next.name)}
          </p>
          {flipNext ? <p className={styles['muted']}>{m.aidsFlipHint(next.name)}</p> : null}
          {next === undefined ? null : (
            <div className={styles['aidChoices']}>
              <span className={styles['aidChoiceLabel']}>{m.aidEdges}</span>
              <SegmentedControl
                size="sm"
                label={m.aidEdges}
                options={(['auto', 'frontBack', 'leftRight'] as const).map((v) => ({
                  value: v,
                  label: m.aidEdgeChoices[v],
                }))}
                value={edges}
                onValueChange={setEdges}
              />
              {flipNext ? (
                <>
                  <span className={styles['aidChoiceLabel']}>{m.aidHolesAt}</span>
                  <SegmentedControl
                    size="sm"
                    label={m.aidHolesAt}
                    options={(['axis', 'corners'] as const).map((v) => ({
                      value: v,
                      label: m.aidHolesAtChoices[v],
                    }))}
                    value={holesAt}
                    onValueChange={setHolesAt}
                  />
                </>
              ) : null}
            </div>
          )}
          {next === undefined ? null : (
            <QuantityInput
              label={m.aidInset}
              kind="length"
              defaultUnit={defaultUnit('length', units)}
              value={
                inset === undefined
                  ? undefined
                  : Quantity.parse(inset, fieldContext('length', units)).mapOr(undefined, (q) => q)
              }
              messages={[
                {
                  id: 'insetHint',
                  severity: 'note',
                  text: m.aidInsetHint,
                  ...(inset === undefined
                    ? {}
                    : { fix: { label: m.aidInsetDefault, onApply: () => setInset(undefined) } }),
                },
              ]}
              onCommit={(q) => setInset(q.source)}
              onCancelGesture={cancelGesture}
            />
          )}
          {next === undefined ? null : (
            <div className={styles['alignActions']}>
              <Button size="sm" variant="default" onClick={() => void placeAids('marks')}>
                <Icon name="chamfer-mill" /> {m.aidMarks}
              </Button>
              <Button size="sm" variant="default" onClick={() => void placeAids('holes')}>
                <Icon name="drill" /> {m.aidHoles}
              </Button>
            </div>
          )}
        </section>
      )}
    </>
  )
}
