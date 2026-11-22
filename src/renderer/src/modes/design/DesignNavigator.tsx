// Design navigator (task 3.6): without a part the stock setup; with one the part and its stock,
// and the operation list in design order – add (Facing, Pocket, Drilling, Profile), select (the
// viewport and inspector follow), move up/down by buttons and Alt+↑/↓, remove with an undo toast
// instead of a confirmation. Rows carry warning badges and the error marker of a failed
// evaluation. Between the part and the operations, the reference models (ReferenceRows.tsx, task
// R3), then the named shapes (ShapeList.tsx, task U1). Doc: docs/conventions/ui.md#panels-and-inspectors, #confirmations, #undo-and-redo;
// docs/modes/design.md#ordering-and-composition
import type { OperationKind } from '../../../../core/design/part.dto'
import type { UnitSystem } from '../../../../core/project/document'
import { designMessages } from '../../messages/design'
import { useSettings, useShell, useUi } from '../../shell/ShellContext'
import {
  Button,
  EmptyState,
  IconButton,
  Menu,
  PanelHeader,
  Toast,
  ToastRegion,
  Icon,
  type IconName,
  type MenuEntry,
} from '../../ui'
import styles from './Design.module.css'
import { chamferEdgeChoice } from './chamfer-view'
import { clonesSource } from './feature-view'
import { draftSource, draftSourceOptions, firstRow, firstRowGap } from './clones-view'
import { addArgs, failingOperation, type DesignPart } from './model'
import { OperationList } from './OperationList'
import { ReferenceRows } from './ReferenceRows'
import { ShapeList } from './ShapeList'
import { StockSetup } from './StockSetup'
import { useCommand, useDesignEvaluation, useDesignSelection, useDesignWarnings } from './useDesign'

export { operationIcon } from './OperationList'

const m = designMessages
const f = m.features
/** The empty list's buttons (design order of a typical part). */
const KINDS: readonly OperationKind[] = ['facing', 'pocket', 'drilling', 'profile']
/** The Add menu's Operations group (ui.md § Feature rows and Add). */
const MENU_KINDS: readonly OperationKind[] = ['facing', 'pocket', 'profile', 'drilling']
const ICON: Record<OperationKind, IconName> = {
  facing: 'facing',
  pocket: 'pocket',
  drilling: 'drilling',
  profile: 'profile',
  // not in KINDS: a chamfer needs an edge (the Add menu's Chamfer, task U4)
  chamfer: 'chamfer',
}

export function DesignNavigator({
  part,
  units,
}: {
  part: DesignPart | undefined
  units: UnitSystem
}): React.JSX.Element {
  if (part === undefined)
    return (
      <>
        <PanelHeader title={m.stock.title} />
        <StockSetup units={units} />
      </>
    )
  return <PartNavigator part={part} />
}

/** The stock's size (mm) new operations are placed in; a default block without a stock. */
function stockDims(part: DesignPart): { length: number; width: number; thickness: number } {
  const s = part.loaded?.stock
  return s
    ? { length: s.length.canonical, width: s.width.canonical, thickness: s.thickness.canonical }
    : { length: 100, width: 60, thickness: 20 }
}

function stockSummary(part: DesignPart): string | undefined {
  const s = part.loaded?.stock
  return s === undefined
    ? undefined
    : m.stock.summary(s.length.source, s.width.source, s.thickness.source)
}

function PartNavigator({ part }: { part: DesignPart }): React.JSX.Element {
  const { bridge } = useShell()
  const call = useCommand()
  const [selected, select] = useDesignSelection()
  const { warnings } = useDesignWarnings(part)
  const evaluation = useDesignEvaluation(part)
  // the undo toast lives in the ui store: the inspector's segment table removes rows too
  const removed = useUi((st) => st.removedToast)
  const setRemovedToast = useUi((st) => st.setRemovedToast)
  const setRemoved = (name: string) => setRemovedToast(m.navigator.removed(name))
  // the default-anchor setting places new pockets and profiles (design-v0.2.md#placement-anchors)
  const defaultAnchor = useSettings((s) => s.settings.defaultAnchor)
  const ops = part.dto.operations
  const ids = ops.map((o) => o.id)
  const failedAt =
    evaluation?.status === 'failed' && evaluation.error !== undefined
      ? failingOperation(evaluation.error, ids)
      : undefined

  const add = async (kind: OperationKind) => {
    const r = await call(`design.${kind}.add`, {
      partId: part.dto.id,
      ...addArgs(kind, stockDims(part), part.units, defaultAnchor),
    })
    if (r.ok) select((r.value as { operationId: string }).operationId)
  }
  // a hole with the core defaults (simple, 6 mm / 1/4" through) where a new drilling goes; the
  // feature is selected so its inspector is what the user sees next (ui.md § Feature rows)
  const addHole = async () => {
    const { center } = addArgs('drilling', stockDims(part), part.units) as { center: string[] }
    const r = await call('design.hole.add', { partId: part.dto.id, center })
    if (r.ok) select((r.value as { featureId: string }).featureId)
  }
  // Make Clones… opens the draft in the inspector (ui.md § Clones): nothing is written until
  // "Make clones"; its first row puts one clone beside the source, a tool diameter apart
  const cloneChoice = clonesSource(part, selected)
  const setClonesDraft = useUi((st) => st.setClonesDraft)
  const setClonesRow = useUi((st) => st.setClonesRow)
  const makeClones = () => {
    if (!cloneChoice.ok || selected === null) return
    const options = draftSourceOptions(part, cloneChoice)
    const feature = 'featureId' in cloneChoice.source
    const gap = firstRowGap(part, draftSource(options, new Set(), feature))
    setClonesDraft({
      partId: part.dto.id,
      openedFor: selected,
      options,
      feature,
      unchecked: new Set(),
      rows: [firstRow(cloneChoice.width, gap, part.units)],
      preview: null,
    })
    setClonesRow({ owner: 'draft', row: 0 })
  }
  // Chamfer (task U4): `design.chamfer.add` with the core defaults (edge Ø + 1 mm / 1/32", 90°)
  // on the selected drilling, circle pocket or inside circle profile, else the last one; then its inspector
  const chamferEdge = chamferEdgeChoice(part.dto, selected)
  const addChamfer = async () => {
    if (!chamferEdge.ok) return
    const r = await call('design.chamfer.add', { partId: part.dto.id, edgeOf: chamferEdge.edgeOf })
    if (r.ok) select((r.value as { operationId: string }).operationId)
  }
  const addItems: MenuEntry[] = [
    {
      group: f.groups.operations,
      items: [
        ...MENU_KINDS.map((k) => ({
          label: m.add(k),
          icon: <Icon name={ICON[k]} />,
          onSelect: () => void add(k),
        })),
        // on the selected drilling, circle pocket or inside circle profile, else the last one (task U4)
        {
          label: f.addChamfer,
          icon: <Icon name="chamfer" />,
          onSelect: () => void addChamfer(),
          disabledReason: chamferEdge.ok ? undefined : chamferEdge.reason,
        },
      ],
    },
    {
      group: f.groups.features,
      items: [
        {
          label: f.addHole,
          icon: <Icon name="hole-counterbore" />,
          onSelect: () => void addHole(),
        },
        {
          label: f.makeClones,
          icon: <Icon name="clones" />,
          onSelect: makeClones,
          disabledReason: cloneChoice.ok ? undefined : cloneChoice.reason,
        },
      ],
    },
  ]

  const summary = stockSummary(part)

  return (
    <div className={styles['navigator']}>
      <section className={styles['partHeader']} aria-label={m.inspector.part}>
        <button
          type="button"
          className={styles['partName']}
          aria-pressed={selected === null}
          onClick={() => select(null)}
        >
          {part.dto.name}
        </button>
        {summary !== undefined ? (
          <span className={styles['muted']}>
            {m.stock.title}: {summary}
            {part.loaded ? ` · ${part.loaded.stock.material.name}` : ''}
          </span>
        ) : null}
      </section>
      <ReferenceRows part={part} onRemoved={setRemoved} />
      <ShapeList part={part} onRemoved={setRemoved} />
      <PanelHeader
        title={m.navigator.operations}
        meta={ops.length > 0 ? String(ops.length) : undefined}
        actions={
          <Menu label={m.addMenu} items={addItems}>
            <IconButton label={m.addMenu} icon={<Icon name="add" />} />
          </Menu>
        }
      />
      {ops.length === 0 ? (
        <div className={styles['emptyOps']}>
          <EmptyState
            icon={<Icon name="facing" />}
            title={m.navigator.empty.title}
            description={m.navigator.empty.description}
            headingLevel={3}
          />
          <div className={styles['addRow']}>
            {KINDS.map((k) => (
              <Button key={k} size="sm" icon={<Icon name={ICON[k]} />} onClick={() => void add(k)}>
                {m.add(k)}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <OperationList
          part={part}
          warnings={warnings}
          failedAt={failedAt}
          selected={selected}
          select={select}
          onRemoved={setRemovedToast}
        />
      )}
      <ToastRegion>
        {removed !== null ? (
          <Toast
            key={removed}
            open
            onOpenChange={(o) => {
              if (!o) setRemovedToast(null)
            }}
            message={removed}
            action={{
              label: m.navigator.undo,
              altText: m.navigator.undoAlt,
              onClick: () => {
                void bridge.call('history.undo', {})
                setRemovedToast(null)
              },
            }}
          />
        ) : null}
      </ToastRegion>
    </div>
  )
}
