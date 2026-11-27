// "Workholding" in the setup inspector (docs/modes/workholding.md#ui-summary): the setup's items
// (icon, name, one-line summary), an Add menu, the margin, and the open item's fields. Every
// change is one `plan.workholding.set` with the whole list ("Copy from…" sends its `copyFrom`,
// X2-5); items keep their ids, so the open item survives the edit. Opening an item shows its
// keep-out zone in the viewport (plan store). DF121 WL4: the Add menu places the type's library
// devices (the default first, built-ins included; a submenu when a type has several), an item placed
// from the library shows its device with "Edit in library", the detach note after a device edit,
// "Library changed · Update from library" for a stale copy and the range warning under its field.
// Q131 (design review, decided by the user): the generic dimension illustrations on every size
// field, an open toe clamp's front view (`clampSection`) highlighting the focused size, the open
// item renamed in place in its row (R12), a kind mark per base and surface type (R2), a text-only
// "Arrange automatically" (R4) and its result line under the buttons (R13). DF125: an open toe
// clamp, screw or block reads its X/Y from the stock corner or the work zero and its heights from
// the stock top or bottom (`workholding-from.ts`; stored values unchanged).
// Doc: docs/conventions/ui.md#workholding, docs/modes/workholding-library.md#implementation-wl4,
// docs/modes/workholding.md#measured-from-df125
import { useEffect, useRef, useState } from 'react'
import {
  builtinWorkholding,
  isBuiltinWorkholding,
} from '../../../../core/library/workholding-builtins'
import type { WorkholdingValuesDTO } from '../../../../core/library/workholding.dto'
import { deviceLabel } from '../../../../core/plan/workholding/devices'
import {
  defaultMargin,
  EDGES,
  itemSummary,
  nextItemId,
  type ResolvedItem,
  type WorkholdingItemDTO,
} from '../../../../core/plan/workholding/items'
import { setupWorkholding } from '../../../../core/plan/workholding/setup'
import type { PlanWarning } from '../../../../core/plan/checks'
import { planOpLabel } from '../../../../core/plan/labels'
import type { PlanDTO, SetupDTO } from '../../../../core/plan/plan.dto'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import type { AppErrorData, Issue } from '../../../../shared/errors/app-error'
import type { LibraryTarget } from '../../../../shared/preload-api'
import { LibraryLink } from '../../library/LibraryLink'
import { planMessages, sentence } from '../../messages/plan'
import { useCancelGesture } from '../../shell/hooks'
import { useLibraryVersion, useShell } from '../../shell/ShellContext'
import {
  Button,
  ErrorMessage,
  Field,
  FieldIcon,
  Icon,
  Menu,
  QuantityInput,
  SegmentedControl,
  Select,
  Switch,
  type FieldIconName,
  type FieldMessage,
  type IconName,
  type MenuEntry,
  type MenuItem,
  InspectorGroup,
  useApplyOnEnter,
} from '../../ui'
import { defaultUnit, quantityOf } from '../design/model'
import { allows, planPart, setupZeroOf, snapshotName, type PlanStale } from './model'
import { SketchView } from '../../viewport/SketchView'
import { clampSection, type ClampSectionPart } from './clamp-section'
import { usePlanCommand, usePlanState, usePlanStore } from './plan-store'
import styles from './Workholding.module.css'
import {
  shownQuantity,
  storedSource,
  storeOffset,
  useMeasuredFrom,
  type MeasuredAxis,
  type MeasuredFrom,
  type SetupReferences,
  type XyFrom,
  type ZFrom,
} from './workholding-from'

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
    case 'glue':
      return { kind: 'surface', type: kind }
  }
}

/** A library device as `library.workholding.list` returns it (flat values and flags). */
export type Device = WorkholdingValuesDTO & {
  readonly id: string
  readonly builtIn?: true
  readonly isDefault?: true
}

/** Whether `d` is a device the Add entry `kind` places (bases and surfaces by their own type). */
function devicePlaces(kind: AddKind, d: Device): boolean {
  switch (kind) {
    case 'spoilboard':
    case 'fixturePlate':
      return d.type === 'base' && d.baseType === kind
    case 'tape':
    case 'vacuum':
    case 'glue':
      return d.type === 'surface' && d.surfaceType === kind
    default:
      return d.type === kind
  }
}

/** The Add entry's devices: the type's default first, then the user's, then the built-ins. */
export function devicesFor(kind: AddKind, devices: readonly Device[]): Device[] {
  const rank = (d: Device) => (d.isDefault === true ? 0 : d.builtIn === true ? 2 : 1)
  return devices
    .filter((d) => devicePlaces(kind, d))
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i)
    .map((x) => x.d)
}

/**
 * The library's workholding devices with the built-ins of the project's unit system, read again
 * on every library write; the built-ins alone until the first read answers (or without a library).
 */
function useDevices(units: UnitSystem): readonly Device[] {
  const { bridge } = useShell()
  const library = useLibraryVersion()
  const [devices, setDevices] = useState<readonly Device[] | undefined>(undefined)
  useEffect(() => {
    let live = true
    void bridge.call('library.workholding.list', { units }).then((r) => {
      if (live && r.ok) setDevices((r.value as { items: Device[] }).items)
    })
    return () => {
      live = false
    }
  }, [bridge, units, library])
  return (
    devices ??
    builtinWorkholding(units).map((i): Device => ({
      ...(i.toDTO() as WorkholdingValuesDTO),
      id: i.id,
      builtIn: true,
    }))
  )
}

/** The Library window on a device, in its Workholding tab (workholding-library.md § Implementation (WL4)). */
const deviceTarget = (itemId: string): LibraryTarget => ({ kind: 'workholding', itemId })

/** Which Add entries the setup still allows (one vise, one base, one surface). */
function allowed(kind: AddKind, items: readonly Item[]): boolean {
  const has = (k: Item['kind']) => items.some((i) => i.kind === k)
  if (kind === 'vise') return !has('vise')
  if (kind === 'spoilboard' || kind === 'fixturePlate') return !has('base')
  if (kind === 'tape' || kind === 'vacuum' || kind === 'glue') return !has('surface')
  return true
}

/**
 * Each Add entry's icon (v0.4-llm-first L1, ui.md § Icons (workholding)); the base and surface
 * types with their kind mark (design review R2, Q131), the spoilboard the plain base.
 */
const ADD_ICON = {
  toeClamp: 'toe-clamp',
  vise: 'vise',
  screw: 'screw',
  block: 'block',
  spoilboard: 'base',
  fixturePlate: 'fixture-plate',
  tape: 'tape',
  vacuum: 'vacuum',
  glue: 'glue',
} as const satisfies Record<AddKind, IconName>

/** An item row's icon: its kind's, a base or surface by its type (as the Add menu). */
const itemIcon = (item: Item): IconName =>
  item.kind === 'base' || item.kind === 'surface' ? ADD_ICON[item.type] : ADD_ICON[item.kind]

export function Workholding({
  doc,
  plan,
  setup,
  warnings = [],
}: {
  doc: ProjectDoc
  plan: PlanDTO
  setup: SetupDTO
  /** The setup's findings: an item's own ones (W5 `inPart`) show under its fields. */
  warnings?: readonly PlanWarning[]
}): React.JSX.Element {
  const call = usePlanCommand()
  const store = usePlanStore()
  const cancelGesture = useCancelGesture()
  const open = usePlanState((s) =>
    s.workholdingItem?.setupId === setup.id ? s.workholdingItem.itemId : undefined,
  )
  const [errors, setErrors] = useState<readonly Issue[]>([])
  const [failed, setFailed] = useState<AppErrorData | undefined>(undefined)
  const [arrangeError, setArrangeError] = useState<string | undefined>(undefined)
  /** R13: the toe clamps the last "Arrange automatically" placed (cleared by the next edit). */
  const [arranged, setArranged] = useState<number | undefined>(undefined)
  const units = doc.unitSystem
  const readOnly = !allows(plan, 'plan.workholding.set')
  const items = setup.workholding ?? []
  const stock = planPart(doc, plan).loaded?.stock
  const holding = stock === undefined ? undefined : setupWorkholding(setup, stock)
  const summaryUnits = units === 'inch' ? 'in' : 'mm'
  // DF125: where the fields and summaries measure from (the viewer's choice)
  const alignment = usePlanState((s) => s.data?.alignment.find((a) => a.setupId === setup.id))
  const zero = setupZeroOf(setup, alignment)
  const measured = useMeasuredFrom()
  const refs: SetupReferences | undefined =
    holding === undefined ? undefined : { zero, thickness: holding.stock.thickness }
  const devices = useDevices(units)
  const stale = usePlanState((s) =>
    s.data?.planId === plan.id ? s.data.stale?.libraryCopies : undefined,
  )
  /** Items a device edit detached here (Q138), with the device they followed: the note. */
  const [detached, setDetached] = useState<Readonly<Record<string, string>>>({})

  const set = async (args: object, gesture?: string): Promise<boolean> =>
    (await setReply(args, gesture)).ok
  const setReply = async (args: object, gesture?: string) => {
    const r = await call(
      'plan.workholding.set',
      { planId: plan.id, setupId: setup.id, ...args },
      gesture === undefined ? undefined : { gesture },
    )
    setArrangeError(undefined)
    setArranged(undefined)
    setErrors(r.ok ? [] : r.error.issues)
    setFailed(r.ok || r.error.issues.length > 0 ? undefined : r.error)
    return r
  }
  /** The whole list with item `id` changed by `patch` (every other item by id only). */
  const edit = async (id: string, patch: object, gesture?: string) => {
    const before = items.find((i) => i.id === id)
    const device = before?.copyId === undefined ? undefined : snapshotName(plan, before.copyId)
    const r = await setReply(
      {
        items: items.map((i) =>
          i.id === id ? { id, kind: i.kind, ...patch } : { id: i.id, kind: i.kind },
        ),
      },
      gesture,
    )
    // Q138: an edit of a device value made it an own item (the result no longer names a device)
    if (!r.ok || device === undefined) return
    const after = (r.value as { items?: { id: string; libraryItemId?: string }[] }).items
    const item = after?.find((i) => i.id === id)
    if (item !== undefined && item.libraryItemId === undefined)
      setDetached((d) => ({ ...d, [id]: device }))
  }
  const add = async (kind: AddKind, libraryItemId?: string) => {
    if (holding === undefined) return
    // ids are per plan: the command gives the new item the next one, which opens it
    const id = nextItemId(plan.setups.flatMap((s) => (s.workholding ?? []).map((i) => i.id)))
    const placed: Record<string, unknown> = { ...newItem(kind, items, holding.stock) }
    if (libraryItemId !== undefined) {
      // the device gives the sizes: a block's own sizes would detach it
      delete placed['length']
      delete placed['width']
      delete placed['top']
      placed['libraryItemId'] = libraryItemId
    }
    const ok = await set({
      items: [...items.map((i) => ({ id: i.id, kind: i.kind })), placed],
    })
    if (ok) store.getState().selectWorkholding({ setupId: setup.id, itemId: id })
  }
  const remove = (id: string) => {
    if (open === id) store.getState().selectWorkholding(undefined)
    void set({ items: items.filter((i) => i.id !== id).map((i) => ({ id: i.id, kind: i.kind })) })
  }
  /** W6: four toe clamps placed by the core; a refusal names every edge's room in one line. */
  const arrange = async () => {
    const r = await call('plan.workholding.set', {
      planId: plan.id,
      setupId: setup.id,
      auto: 'toeClamps',
    })
    setErrors([])
    setFailed(undefined)
    setArranged(
      r.ok
        ? (r.value as { items?: { kind: string }[] }).items?.filter((i) => i.kind === 'toeClamp')
            .length
        : undefined,
    )
    // the core names the agent tool; the UI names its own button
    setArrangeError(
      r.ok
        ? undefined
        : r.error.issues[0]?.rule === 'noToolpaths'
          ? m.arrangeNeedsToolpaths(setup.name)
          : r.error.message,
    )
  }
  /** X2-5: another setup's items, same edges and positions (the agent's `copyFrom`). */
  const copyFrom = async (from: SetupDTO) => {
    const r = await call('plan.workholding.set', {
      planId: plan.id,
      setupId: setup.id,
      copyFrom: from.id,
    })
    setErrors([])
    setFailed(undefined)
    setArranged(undefined)
    setArrangeError(r.ok ? undefined : r.error.message)
  }
  const others = plan.setups.filter((s) => s.id !== setup.id)
  const copyItems: MenuEntry[] = others.map((s) => {
    const n = s.workholding?.length ?? 0
    return {
      label: s.name,
      description: m.count(n),
      onSelect: () => void copyFrom(s),
      ...(n === 0 ? { disabled: true, disabledReason: m.copyNothing } : {}),
    }
  })
  const issueAt = (n: number, param: string): FieldMessage[] =>
    errors
      .filter((i) => i.path[0] === 'items' && i.path[1] === n && i.path[2] === param)
      .map((i, k) => ({ id: `${param}-${k}`, severity: 'error', text: sentence(i.message) }))
  const listErrors = errors.filter((i) => i.path[0] !== 'items' || typeof i.path[1] !== 'number')

  // WL4: each type places its default device; a type with several devices (or a block with the
  // user's) opens a submenu of them, the default first, and "Own item" last
  const addItems: MenuEntry[] = (Object.keys(m.kinds) as AddKind[]).map((kind): MenuEntry => {
    const icon = <Icon name={ADD_ICON[kind]} />
    const choices = devicesFor(kind, devices)
    if (!allowed(kind, items))
      return {
        label: m.kinds[kind],
        description: m.kindHints[kind],
        icon,
        onSelect: () => undefined,
        disabled: true,
        disabledReason: m.onePerSetup,
      }
    const only = choices.length === 1 && kind !== 'block' ? choices[0] : undefined
    if (choices.length === 0 || only !== undefined)
      return {
        label: m.kinds[kind],
        description: m.kindHints[kind],
        icon,
        onSelect: () => void add(kind, only?.id),
      }
    const sub: MenuItem[] = [
      ...choices.map((d) => ({
        id: d.id,
        label: m.deviceChoice(d.name, d.builtIn === true, d.isDefault === true),
        onSelect: () => void add(kind, d.id),
      })),
      { id: 'own', label: m.ownItem, description: m.ownItemHint, onSelect: () => void add(kind) },
    ]
    return { label: m.kinds[kind], icon, sub }
  })
  /** An item's findings under its fields: W5 `inPart` under its centre, WL2's range ones. */
  const findingsAt = (item: Item, param: string): FieldMessage[] =>
    warnings
      .filter(
        (w) =>
          w.params['itemId'] === item.id &&
          ((w.code === 'plan.workholding.inPart' && param === 'center') ||
            (w.code === 'plan.workholding.outOfRange' &&
              ((w.params['rule'] === 'grip' && param === 'grip') ||
                (w.params['rule'] === 'opening' && param === 'axis')))),
      )
      .map((w) => ({ id: w.code, severity: 'soft' as const, text: sentence(w.message) }))

  /** An item row's one-line summary, with the device of the user's library. */
  const summaryOf = (n: number, item: Item) => {
    const resolved = holding?.items[n]
    return resolved === undefined
      ? ''
      : withDevice(
          itemSummary(
            resolved,
            summaryUnits,
            measured.from.xy === 'zero' ? zero : [0, 0],
            measured.from.z === 'bottom' ? refs?.thickness : undefined,
          ),
          deviceLabel(plan.snapshots, item),
        )
  }
  /** R13: what Arrange automatically did, and what the facing leaves under the clamps. */
  const arrangedLine = () => {
    if (arranged === undefined) return undefined
    const uncut = new Set(
      warnings
        .filter((w) => w.code === 'plan.workholding.unmachined' && w.planOperationId !== undefined)
        .map((w) => w.planOperationId!),
    )
    const names = setup.operations
      .filter((o) => uncut.has(o.id))
      .map((o) => planOpLabel(plan.design.part, { designOperationIds: o.designOperationIds }))
    return m.arranged(arranged, names)
  }
  const arrangedText = arrangedLine()

  return (
    <InspectorGroup title={m.title} meta={m.count(items.length)} className={styles['section']}>
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
            const expanded = open === item.id
            return (
              <li key={item.id} className={styles['item']} data-open={expanded || undefined}>
                {expanded ? (
                  // R12 (Q131): the open item is renamed in place in its row; the row stays the
                  // toggle (a button under the row, its text the name and summary for assistive
                  // tech), the name field sits over it
                  <div className={styles['row']} data-open="">
                    <button
                      type="button"
                      className={styles['rowToggle']}
                      aria-expanded
                      aria-controls={`wh-${setup.id}-${item.id}`}
                      onClick={() => store.getState().selectWorkholding(undefined)}
                    >
                      <span className={styles['srOnly']}>
                        {item.name} {summaryOf(n, item)}
                      </span>
                    </button>
                    <Icon name={itemIcon(item)} className={styles['icon']} />
                    <RowName
                      name={item.name}
                      label={m.rename(item.name)}
                      readOnly={readOnly}
                      onCommit={(name) => void edit(item.id, { name })}
                    />
                    <span className={styles['summary']} aria-hidden="true">
                      {summaryOf(n, item)}
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={styles['row']}
                    aria-expanded={false}
                    aria-controls={`wh-${setup.id}-${item.id}`}
                    onClick={() =>
                      store.getState().selectWorkholding({ setupId: setup.id, itemId: item.id })
                    }
                  >
                    <Icon name={itemIcon(item)} className={styles['icon']} />
                    <span className={styles['name']}>{item.name}</span>
                    <span className={styles['summary']}>{summaryOf(n, item)}</span>
                  </button>
                )}
                {expanded ? (
                  <div
                    id={`wh-${setup.id}-${item.id}`}
                    role="group"
                    aria-label={m.item(item.name)}
                    className={styles['fields']}
                  >
                    <DeviceLine
                      plan={plan}
                      item={item}
                      readOnly={readOnly}
                      stale={stale?.find((c) => c.snapshotId === item.copyId)}
                      detachedFrom={item.copyId === undefined ? detached[item.id] : undefined}
                      onUpdate={(snapshotId) =>
                        void call('plan.libraryItem.update', { planId: plan.id, snapshotId })
                      }
                    />
                    <ItemFields
                      item={item}
                      resolved={holding?.items[n]}
                      stockThickness={holding?.stock.thickness}
                      from={measured.from}
                      refs={refs}
                      onXyFrom={measured.setXy}
                      onZFrom={measured.setZ}
                      units={units}
                      readOnly={readOnly}
                      messages={(param) => [...issueAt(n, param), ...findingsAt(item, param)]}
                      onCommit={(patch, gesture) => void edit(item.id, patch, gesture)}
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
        {readOnly ? null : (
          // R4 (Q131): text only, so it does not read as another item row
          <Button size="sm" variant="ghost" title={m.arrangeHint} onClick={() => void arrange()}>
            {m.arrange}
          </Button>
        )}
        {readOnly || others.length === 0 ? null : (
          <Menu label={m.copyFromMenu} items={copyItems} align="start">
            <Button size="sm" variant="ghost" title={m.copyFromHint}>
              <Icon name="copy" />
              {m.copyFrom}
            </Button>
          </Menu>
        )}
      </div>
      {arrangeError === undefined ? null : (
        <p role="alert" className={styles['error']} data-arrange-error>
          {sentence(arrangeError)}
        </p>
      )}
      {arrangedText === undefined ? null : (
        // R13 (Q131): what the action did, so the expected uncut findings do not read as a failure
        <p role="status" className={styles['result']} data-arrange-result>
          {arrangedText}
        </p>
      )}
      {items.length > 0 ? (
        // design review R10: the rarely changed margin in a More row under the buttons, so it no
        // longer reads as a property of the last item or of Arrange automatically
        <InspectorGroup.More
          fields={[m.margin]}
          rememberKey="workholding.more"
          forceOpen={errors.some((i) => i.path[0] === 'margin')}
        >
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
        </InspectorGroup.More>
      ) : null}
    </InspectorGroup>
  )
}

/**
 * Each size's illustration (Q131: the generic dimension glyphs, ui.md § Field): no two sizes of
 * one kind share one; Top above Z0 and the vise's Stock above the jaws are both a top above a
 * reference (never in one item).
 */
const SIZE_ICON: Partial<Record<string, FieldIconName>> = {
  at: 'positionX',
  width: 'width',
  grip: 'overlap',
  reach: 'overhang',
  top: 'topZ',
  protrusion: 'topZ',
  jawLength: 'length',
  jawThickness: 'thickness',
  headDiameter: 'diameter',
  length: 'length',
}

/** The open item's own fields by kind. */
function ItemFields({
  item,
  resolved,
  stockThickness,
  from,
  refs,
  onXyFrom,
  onZFrom,
  units,
  readOnly,
  messages,
  onCommit,
  onCancelGesture,
}: {
  item: Item
  /** The item in mm (the toe clamp's front view), undefined while the stock does not load. */
  resolved: ResolvedItem | undefined
  stockThickness: number | undefined
  /** DF125: where positions and heights are measured from, and the setup's references. */
  from: MeasuredFrom
  refs: SetupReferences | undefined
  onXyFrom: (xy: XyFrom) => void
  onZFrom: (z: ZFrom) => void
  units: UnitSystem
  readOnly: boolean
  messages: (param: string) => FieldMessage[]
  onCommit: (patch: object, gesture?: string) => void
  onCancelGesture: (gesture: string) => Promise<boolean>
}): React.JSX.Element {
  // R12: the focused toe clamp size is the amber part of the front view
  const [focused, setFocused] = useState<ClampSectionPart | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)
  const track = (param: string) =>
    param === 'grip' || param === 'reach' || param === 'top'
      ? {
          'data-clamp-field': param,
          onFocus: () => setFocused(param),
          onBlur: (e: React.FocusEvent<HTMLElement>) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null))
              setFocused((f) => (f === param ? undefined : f))
          },
        }
      : {}
  /** DF125: stored = shown + offset for a position (X/Y) or a height (Z); 0 for a size. */
  const offsetOf = (axis: MeasuredAxis | undefined) =>
    axis === undefined || refs === undefined ? 0 : storeOffset(axis, from, refs)
  /** DF125: a position's or height's (i): what it is measured from. */
  const fromInfo = (axis: MeasuredAxis | undefined) =>
    axis === undefined ? undefined : axis === 'z' ? m.zFromInfo[from.z] : m.xyFromInfo[from.xy]
  const length = (
    param: string,
    label: string,
    dto: Parameters<typeof quantityOf>[0],
    axis?: MeasuredAxis,
    resolvedMm?: number,
  ) => {
    const icon = SIZE_ICON[param]
    const offset = offsetOf(axis)
    const info = fromInfo(axis)
    return (
      <div key={param} className={styles['size']} {...track(param)}>
        <QuantityInput
          label={axis === 'z' && from.z === 'bottom' ? m.topFromBottom : label}
          kind="length"
          dense
          stepKind="xy"
          defaultUnit={defaultUnit('length', units)}
          value={shownQuantity(dto, resolvedMm, offset, units)}
          readOnly={readOnly}
          {...(info === undefined ? {} : { info })}
          illustration={icon === undefined ? undefined : <FieldIcon name={icon} />}
          messages={messages(param)}
          onCommit={(q, gesture) => onCommit({ [param]: storedSource(q, offset, units) }, gesture)}
          onCancelGesture={onCancelGesture}
        />
      </div>
    )
  }
  const centre = (
    c: readonly [Parameters<typeof quantityOf>[0], Parameters<typeof quantityOf>[0]],
    at: readonly [number, number] | undefined,
  ) => {
    const [ox, oy] = [offsetOf('x'), offsetOf('y')]
    const info = fromInfo('x')
    return (
      <>
        <QuantityInput
          label={m.centerX}
          stepKind="xy"
          kind="length"
          dense
          defaultUnit={defaultUnit('length', units)}
          value={shownQuantity(c[0], at?.[0], ox, units)}
          readOnly={readOnly}
          info={info}
          illustration={<FieldIcon name="positionX" />}
          messages={messages('center')}
          onCommit={(q, gesture) =>
            onCommit({ center: [storedSource(q, ox, units), c[1].source] }, gesture)
          }
          onCancelGesture={onCancelGesture}
        />
        <QuantityInput
          label={m.centerY}
          stepKind="xy"
          kind="length"
          dense
          defaultUnit={defaultUnit('length', units)}
          value={shownQuantity(c[1], at?.[1], oy, units)}
          readOnly={readOnly}
          info={info}
          illustration={<FieldIcon name="positionY" />}
          messages={[]}
          onCommit={(q, gesture) =>
            onCommit({ center: [c[0].source, storedSource(q, oy, units)] }, gesture)
          }
          onCancelGesture={onCancelGesture}
        />
      </>
    )
  }
  /** DF125: the two choices at the top of an item with a position (the viewer's, app-wide). */
  const measuredFrom = (
    <>
      <Field label={m.xyFrom} kind="toggle" info={m.xyFromHint}>
        <SegmentedControl<XyFrom>
          label={m.xyFrom}
          options={[
            { value: 'corner', label: m.xyFromOptions.corner },
            { value: 'zero', label: m.xyFromOptions.zero },
          ]}
          value={from.xy}
          onValueChange={onXyFrom}
        />
      </Field>
      <Field label={m.zFrom} kind="toggle" info={m.zFromHint}>
        <SegmentedControl<ZFrom>
          label={m.zFrom}
          options={[
            { value: 'top', label: m.zFromOptions.top },
            { value: 'bottom', label: m.zFromOptions.bottom },
          ]}
          value={from.z}
          onValueChange={onZFrom}
        />
      </Field>
    </>
  )
  switch (item.kind) {
    case 'toeClamp': {
      const clamp = resolved?.kind === 'toeClamp' ? resolved : undefined
      return (
        <div ref={rootRef} className={styles['kindFields']}>
          {clamp === undefined || stockThickness === undefined ? null : (
            <SketchView
              sketch={clampSection(
                {
                  grip: clamp.grip,
                  reach: clamp.reach,
                  top: clamp.top,
                  stockThickness,
                  invalid: (['grip', 'reach', 'top'] as const).filter((p) =>
                    messages(p).some((x) => x.severity === 'error'),
                  ),
                },
                units,
              )}
              highlighted={focused}
              onPartClick={(part) =>
                rootRef.current
                  ?.querySelector<HTMLElement>(`[data-clamp-field="${part}"] input`)
                  ?.focus()
              }
              className={styles['sketch']}
            />
          )}
          {measuredFrom}
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
          {length(
            'at',
            m.at,
            item.at,
            item.edge === 'uMin' || item.edge === 'uMax' ? 'y' : 'x',
            clamp?.at,
          )}
          {length('width', m.width, item.width)}
          {length('grip', m.grip, item.grip)}
          {length('reach', m.reach, item.reach)}
          {length('top', m.top, item.top, 'z', clamp?.top)}
        </div>
      )
    }
    case 'vise':
      return (
        <>
          <Field label={m.axis} kind="toggle" readOnly={readOnly} messages={messages('axis')}>
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
    case 'screw': {
      const screw = resolved?.kind === 'screw' ? resolved : undefined
      return (
        <>
          {measuredFrom}
          {centre(item.center, screw?.center)}
          {length('headDiameter', m.headDiameter, item.headDiameter)}
          {length('top', m.top, item.top, 'z', screw?.top)}
        </>
      )
    }
    case 'block': {
      const block = resolved?.kind === 'block' ? resolved : undefined
      return (
        <>
          {measuredFrom}
          {centre(item.center, block?.center)}
          {length('length', m.length, item.length)}
          {length('width', m.width, item.width)}
          {length('top', m.top, item.top, 'z', block?.top)}
        </>
      )
    }
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
        // design review R11: the static note is the Type's (i), boxes are for findings
        <Field label={m.type} readOnly={readOnly} info={m.surfaceNote}>
          <Select
            options={[
              { value: 'tape', label: m.kinds.tape },
              { value: 'vacuum', label: m.kinds.vacuum },
              { value: 'glue', label: m.kinds.glue },
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

/** The row's summary with the device of the user's library (WL2's `deviceLabel`; not a built-in). */
const withDevice = (summary: string, device: string | undefined) =>
  device === undefined ? summary : `${summary} · ${device}`

/**
 * Under an open item's name (WL4): the device it follows ("Strap clamp M8 · from library", a
 * built-in "Toe clamp · built-in") with "Edit in library"; a stale copy's "Library changed" with
 * "Update from library"; after a device edit here the detach note instead.
 */
function DeviceLine({
  plan,
  item,
  readOnly,
  stale,
  detachedFrom,
  onUpdate,
}: {
  plan: PlanDTO
  item: Item
  readOnly: boolean
  stale: PlanStale['libraryCopies'][number] | undefined
  detachedFrom: string | undefined
  onUpdate: (snapshotId: string) => void
}): React.JSX.Element | null {
  if (item.copyId === undefined)
    return detachedFrom === undefined ? null : (
      <p className={styles['note']} role="status">
        {m.detached(detachedFrom)}
      </p>
    )
  const copy = plan.snapshots.find((s) => s.id === item.copyId)
  const name = snapshotName(plan, item.copyId) ?? m.unnamedDevice
  const libraryItemId = copy?.libraryItemId
  const builtIn = libraryItemId !== undefined && isBuiltinWorkholding(libraryItemId)
  return (
    <div className={styles['device']}>
      <div className={styles['deviceRow']}>
        <span className={styles['deviceName']}>
          {builtIn ? m.fromBuiltIn(name) : m.fromLibrary(name)}
        </span>
        {libraryItemId !== undefined && stale?.status !== 'libraryRemoved' ? (
          <LibraryLink target={deviceTarget(libraryItemId)} />
        ) : null}
      </div>
      {stale === undefined ? null : (
        <div className={styles['stale']} role="status">
          <span>{m.copyStatus[stale.status]}</span>
          {stale.blocked !== null ? (
            <span className={styles['why']}>{sentence(stale.blocked)}</span>
          ) : null}
          {stale.status === 'libraryChanged' &&
          stale.blocked === null &&
          !readOnly &&
          allows(plan, 'plan.libraryItem.update') ? (
            <Button
              size="sm"
              icon={<Icon name="history" />}
              onClick={() => onUpdate(stale.snapshotId)}
            >
              {m.updateFromLibrary}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}

/**
 * R12 (Q131): the open item's name, renamed in place in its row (it was a Name field over the
 * item's fields). A borderless text field that shows its box on hover and focus; Enter or leaving
 * it commits (Enter also applies, as every field), Escape and an empty name put the name back.
 * Read-only plans show the name as text.
 */
function RowName({
  name,
  label,
  readOnly,
  onCommit,
}: {
  name: string
  label: string
  readOnly: boolean
  onCommit: (name: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(name)
  const [seen, setSeen] = useState(name)
  if (name !== seen) {
    setSeen(name)
    setDraft(name)
  }
  const applyOnEnter = useApplyOnEnter()
  if (readOnly) return <span className={styles['name']}>{name}</span>
  const commit = () => {
    const v = draft.trim()
    if (v.length > 0 && v !== name) onCommit(v)
    else setDraft(name)
  }
  return (
    <input
      type="text"
      className={styles['nameInput']}
      aria-label={label}
      value={draft}
      maxLength={60}
      spellCheck={false}
      style={{ width: `${Math.max(draft.length, 6)}ch` }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          // commit and apply (apply.md#field-rule)
          e.preventDefault()
          commit()
          applyOnEnter?.()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setDraft(name)
        }
      }}
    />
  )
}
