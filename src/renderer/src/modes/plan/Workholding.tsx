// "Workholding" in the setup inspector (docs/modes/workholding.md#ui-summary): the setup's items
// (icon, name, one-line summary), an Add menu, the margin, and the open item's fields. Every
// change is one `plan.workholding.set` with the whole list; items keep their ids, so the open
// item survives the edit. Opening an item shows its keep-out zone in the viewport (plan store).
// Doc: docs/conventions/ui.md#workholding
import { useState } from 'react'
import {
  defaultMargin,
  EDGES,
  itemSummary,
  nextItemId,
  type WorkholdingItemDTO,
} from '../../../../core/plan/workholding/items'
import { setupWorkholding } from '../../../../core/plan/workholding/setup'
import type { PlanDTO, SetupDTO } from '../../../../core/plan/plan.dto'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import type { AppErrorData, Issue } from '../../../../shared/errors/app-error'
import { planMessages, sentence } from '../../messages/plan'
import { useCancelGesture } from '../../shell/hooks'
import {
  Button,
  ErrorMessage,
  Field,
  Icon,
  Menu,
  QuantityInput,
  SegmentedControl,
  Select,
  Switch,
  type FieldMessage,
  type MenuEntry,
} from '../../ui'
import { defaultUnit, quantityOf } from '../design/model'
import { allows, planPart } from './model'
import { usePlanCommand, usePlanState, usePlanStore } from './plan-store'
import { NameField } from './PlanInspector'
import styles from './Workholding.module.css'

const m = planMessages.workholding

type AddKind = keyof typeof m.kinds
type Item = WorkholdingItemDTO

/** The args of a new item of `kind` (the command fills every other default). */
function newItem(kind: AddKind, items: readonly Item[], stock: { length: number; width: number }) {
  const mm = (v: number) => `${Math.round(v * 10) / 10} mm`
  switch (kind) {
    case 'toeClamp': {
      // the next edge without a clamp, front first
      const used = new Set(items.flatMap((i) => (i.kind === 'toeClamp' ? [i.edge] : [])))
      const order = ['vMin', 'vMax', 'uMin', 'uMax'] as const
      return { kind, edge: order.find((e) => !used.has(e)) ?? 'vMin' }
    }
    case 'vise':
      return { kind }
    case 'screw':
      return { kind, center: [mm(-10), mm(stock.width / 2)] }
    case 'block':
      return {
        kind,
        center: [mm(-15), mm(stock.width / 2)],
        length: '20 mm',
        width: '20 mm',
        top: '10 mm',
      }
    case 'spoilboard':
    case 'fixturePlate':
      return { kind: 'base', type: kind }
    case 'tape':
    case 'vacuum':
      return { kind: 'surface', type: kind }
  }
}

/** Which Add entries the setup still allows (one vise, one base, one surface). */
function allowed(kind: AddKind, items: readonly Item[]): boolean {
  const has = (k: Item['kind']) => items.some((i) => i.kind === k)
  if (kind === 'vise') return !has('vise')
  if (kind === 'spoilboard' || kind === 'fixturePlate') return !has('base')
  if (kind === 'tape' || kind === 'vacuum') return !has('surface')
  return true
}

const iconOf = (item: Item) => (item.kind === 'base' || item.kind === 'surface' ? 'stock' : 'clamp')

export function Workholding({
  doc,
  plan,
  setup,
}: {
  doc: ProjectDoc
  plan: PlanDTO
  setup: SetupDTO
}): React.JSX.Element {
  const call = usePlanCommand()
  const store = usePlanStore()
  const cancelGesture = useCancelGesture()
  const open = usePlanState((s) =>
    s.workholdingItem?.setupId === setup.id ? s.workholdingItem.itemId : undefined,
  )
  const [errors, setErrors] = useState<readonly Issue[]>([])
  const [failed, setFailed] = useState<AppErrorData | undefined>(undefined)
  const units = doc.unitSystem
  const readOnly = !allows(plan, 'plan.workholding.set')
  const items = setup.workholding ?? []
  const stock = planPart(doc, plan).loaded?.stock
  const holding = stock === undefined ? undefined : setupWorkholding(setup, stock)
  const summaryUnits = units === 'inch' ? 'in' : 'mm'

  const set = async (args: object, gesture?: string): Promise<boolean> => {
    const r = await call(
      'plan.workholding.set',
      { planId: plan.id, setupId: setup.id, ...args },
      gesture === undefined ? undefined : { gesture },
    )
    setErrors(r.ok ? [] : r.error.issues)
    setFailed(r.ok || r.error.issues.length > 0 ? undefined : r.error)
    return r.ok
  }
  /** The whole list with item `id` changed by `patch` (every other item by id only). */
  const edit = (id: string, patch: object, gesture?: string) =>
    void set(
      {
        items: items.map((i) =>
          i.id === id ? { id, kind: i.kind, ...patch } : { id: i.id, kind: i.kind },
        ),
      },
      gesture,
    )
  const add = async (kind: AddKind) => {
    if (holding === undefined) return
    // ids are per plan: the command gives the new item the next one, which opens it
    const id = nextItemId(plan.setups.flatMap((s) => (s.workholding ?? []).map((i) => i.id)))
    const ok = await set({
      items: [
        ...items.map((i) => ({ id: i.id, kind: i.kind })),
        newItem(kind, items, holding.stock),
      ],
    })
    if (ok) store.getState().selectWorkholding({ setupId: setup.id, itemId: id })
  }
  const remove = (id: string) => {
    if (open === id) store.getState().selectWorkholding(undefined)
    void set({ items: items.filter((i) => i.id !== id).map((i) => ({ id: i.id, kind: i.kind })) })
  }
  const issueAt = (n: number, param: string): FieldMessage[] =>
    errors
      .filter((i) => i.path[0] === 'items' && i.path[1] === n && i.path[2] === param)
      .map((i, k) => ({ id: `${param}-${k}`, severity: 'error', text: sentence(i.message) }))
  const listErrors = errors.filter((i) => i.path[0] !== 'items' || typeof i.path[1] !== 'number')

  const addItems: MenuEntry[] = (Object.keys(m.kinds) as AddKind[]).map((kind) => ({
    label: m.kinds[kind],
    description: m.kindHints[kind],
    onSelect: () => void add(kind),
    ...(allowed(kind, items) ? {} : { disabled: true, disabledReason: 'One per setup' }),
  }))

  return (
    <section aria-labelledby={`workholding-${setup.id}`} className={styles['section']}>
      <h3 id={`workholding-${setup.id}`} className={styles['title']}>
        <span>{m.title}</span>
        <span className={styles['count']}>{m.count(items.length)}</span>
      </h3>
      {failed ? (
        <ErrorMessage error={failed} message={planMessages.inspector.commandFailed} />
      ) : null}
      {listErrors.map((i, k) => (
        <p key={k} role="alert" className={styles['error']}>
          {sentence(i.message)}
        </p>
      ))}
      {items.length === 0 ? (
        <p className={styles['empty']}>{m.empty}</p>
      ) : (
        <ul className={styles['items']} aria-label={m.listLabel(setup.name)}>
          {items.map((item, n) => {
            const resolved = holding?.items[n]
            const expanded = open === item.id
            return (
              <li key={item.id} className={styles['item']} data-open={expanded || undefined}>
                <button
                  type="button"
                  className={styles['row']}
                  aria-expanded={expanded}
                  aria-controls={`wh-${setup.id}-${item.id}`}
                  onClick={() =>
                    store
                      .getState()
                      .selectWorkholding(
                        expanded ? undefined : { setupId: setup.id, itemId: item.id },
                      )
                  }
                >
                  <Icon name={iconOf(item)} className={styles['icon']} />
                  <span className={styles['name']}>{item.name}</span>
                  <span className={styles['summary']}>
                    {resolved === undefined ? '' : itemSummary(resolved, summaryUnits)}
                  </span>
                </button>
                {expanded ? (
                  <div
                    id={`wh-${setup.id}-${item.id}`}
                    role="group"
                    aria-label={m.item(item.name)}
                    className={styles['fields']}
                  >
                    <NameField
                      label={m.name}
                      name={item.name}
                      readOnly={readOnly}
                      onCommit={(name) => edit(item.id, { name })}
                    />
                    <ItemFields
                      item={item}
                      units={units}
                      readOnly={readOnly}
                      messages={(param) => issueAt(n, param)}
                      onCommit={(patch, gesture) => edit(item.id, patch, gesture)}
                      onCancelGesture={cancelGesture}
                    />
                    {readOnly ? null : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className={styles['remove']}
                        aria-label={m.removeItem(item.name)}
                        onClick={() => remove(item.id)}
                      >
                        <Icon name="delete" />
                        {m.remove}
                      </Button>
                    )}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <div className={styles['footer']}>
        {readOnly ? null : (
          <Menu label={m.addMenu} items={addItems} align="start">
            <Button size="sm" variant="default">
              <Icon name="add" />
              {m.add}
            </Button>
          </Menu>
        )}
      </div>
      {items.length > 0 ? (
        <QuantityInput
          label={m.margin}
          stepKind="xy"
          info={m.marginHint}
          kind="length"
          defaultUnit={defaultUnit('length', units)}
          value={quantityOf(setup.workholdingMargin ?? defaultMargin(units))}
          readOnly={readOnly}
          messages={[
            ...errors
              .filter((i) => i.path[0] === 'margin')
              .map((i, k) => ({
                id: `margin-${k}`,
                severity: 'error' as const,
                text: sentence(i.message),
              })),
          ]}
          onCommit={(q, gesture) => void set({ margin: q.source }, gesture)}
          onCancelGesture={cancelGesture}
        />
      ) : null}
    </section>
  )
}

/** The open item's own fields by kind. */
function ItemFields({
  item,
  units,
  readOnly,
  messages,
  onCommit,
  onCancelGesture,
}: {
  item: Item
  units: UnitSystem
  readOnly: boolean
  messages: (param: string) => FieldMessage[]
  onCommit: (patch: object, gesture?: string) => void
  onCancelGesture: (gesture: string) => Promise<boolean>
}): React.JSX.Element {
  const length = (param: string, label: string, dto: Parameters<typeof quantityOf>[0]) => (
    <QuantityInput
      key={param}
      label={label}
      kind="length"
      dense
      stepKind="xy"
      defaultUnit={defaultUnit('length', units)}
      value={quantityOf(dto)}
      readOnly={readOnly}
      messages={messages(param)}
      onCommit={(q, gesture) => onCommit({ [param]: q.source }, gesture)}
      onCancelGesture={onCancelGesture}
    />
  )
  const centre = (
    c: readonly [Parameters<typeof quantityOf>[0], Parameters<typeof quantityOf>[0]],
  ) => (
    <>
      <QuantityInput
        label={m.centerX}
        stepKind="xy"
        kind="length"
        dense
        defaultUnit={defaultUnit('length', units)}
        value={quantityOf(c[0])}
        readOnly={readOnly}
        messages={messages('center')}
        onCommit={(q, gesture) => onCommit({ center: [q.source, c[1].source] }, gesture)}
        onCancelGesture={onCancelGesture}
      />
      <QuantityInput
        label={m.centerY}
        stepKind="xy"
        kind="length"
        dense
        defaultUnit={defaultUnit('length', units)}
        value={quantityOf(c[1])}
        readOnly={readOnly}
        messages={[]}
        onCommit={(q, gesture) => onCommit({ center: [c[0].source, q.source] }, gesture)}
        onCancelGesture={onCancelGesture}
      />
    </>
  )
  switch (item.kind) {
    case 'toeClamp':
      return (
        <>
          <Field label={m.edge} readOnly={readOnly}>
            <Select
              options={EDGES.map((e) => ({ value: e, label: m.edges[e] }))}
              value={item.edge}
              disabled={readOnly}
              onValueChange={(edge) => {
                if (edge !== item.edge) onCommit({ edge })
              }}
            />
          </Field>
          {length('at', m.at, item.at)}
          {length('width', m.width, item.width)}
          {length('grip', m.grip, item.grip)}
          {length('reach', m.reach, item.reach)}
          {length('top', m.top, item.top)}
        </>
      )
    case 'vise':
      return (
        <>
          <Field label={m.axis} kind="toggle" readOnly={readOnly}>
            <SegmentedControl<string>
              label={m.axis}
              options={[
                { value: 'u', label: 'X' },
                { value: 'v', label: 'Y' },
              ]}
              value={item.axis}
              disabled={readOnly}
              onValueChange={(axis) => {
                if (axis !== item.axis) onCommit({ axis })
              }}
            />
          </Field>
          {length('protrusion', m.protrusion, item.protrusion)}
          {length('jawLength', m.jawLength, item.jawLength)}
          {length('jawThickness', m.jawThickness, item.jawThickness)}
          {/* a toggle Field as every inspector switch: label and switch on one row (U9 Q130) */}
          <Field label={m.soft} kind="toggle" readOnly={readOnly}>
            <Switch
              label={m.soft}
              hideLabel
              checked={item.soft}
              disabled={readOnly}
              onCheckedChange={(soft) => onCommit({ soft })}
            />
          </Field>
        </>
      )
    case 'screw':
      return (
        <>
          {centre(item.center)}
          {length('headDiameter', m.headDiameter, item.headDiameter)}
          {length('top', m.top, item.top)}
        </>
      )
    case 'block':
      return (
        <>
          {centre(item.center)}
          {length('length', m.length, item.length)}
          {length('width', m.width, item.width)}
          {length('top', m.top, item.top)}
        </>
      )
    case 'base':
      return (
        <Field label={m.type} readOnly={readOnly}>
          <Select
            options={(['spoilboard', 'fixturePlate'] as const).map((t) => ({
              value: t,
              label: m.kinds[t],
            }))}
            value={item.type}
            disabled={readOnly}
            onValueChange={(type) => {
              if (type !== item.type) onCommit({ type })
            }}
          />
        </Field>
      )
    case 'surface':
      return (
        <Field label={m.type} readOnly={readOnly}>
          <Select
            options={[
              { value: 'tape', label: m.kinds.tape },
              { value: 'vacuum', label: m.kinds.vacuum },
              { value: 'glue', label: 'Glue' },
            ]}
            value={item.type}
            disabled={readOnly}
            onValueChange={(type) => {
              if (type !== item.type) onCommit({ type })
            }}
          />
        </Field>
      )
  }
}
