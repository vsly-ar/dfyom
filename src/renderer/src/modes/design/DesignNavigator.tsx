// Design navigator (task 3.6; laid out by D45, DF15): a one-line read-out of the part (selects it)
// and its stock (opens the Stock dialog) first, then the "Operations" header and the operation list
// in design order – Add (what needs no target, DF16: Facing, Pocket, Profile, Drilling, Bolt hole,
// each with a one-line tooltip, DF17/DF18; Chamfer and Make Clones… are in the row menu), select
// (the viewport and inspector follow), move by drag and Alt+↑/↓, remove with an undo toast
// instead of a confirmation. Rows carry warning badges and the error marker of a failed
// evaluation. Without a part an empty state opens the Stock dialog. Stock setup, shapes and
// reference models are in the part-setup dialogs (PartSetupDialogs.tsx, D45).
// Doc: docs/conventions/ui.md#design-sidebar-and-setup-dialogs-v04-d45, #panels-and-inspectors,
// #confirmations, #undo-and-redo; docs/modes/design.md#ordering-and-composition
import type { OperationKind } from '../../../../core/design/part.dto'
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
import { addArgs, failingOperation, type DesignPart } from './model'
import { OperationList } from './OperationList'
import { stockReadout } from './PartSetupDialogs'
import {
  useCommand,
  useDesignEvaluation,
  useDesignReferences,
  useDesignSelection,
  useDesignWarnings,
} from './useDesign'
import { facingDepthSuggestion } from './facing-depth'

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
  // not in KINDS: a chamfer needs an edge (the row menu's Chamfer, DF16)
  chamfer: 'chamfer',
}

export function DesignNavigator({ part }: { part: DesignPart | undefined }): React.JSX.Element {
  if (part === undefined) return <NoPart />
  return <PartNavigator part={part} />
}

/** Without a part: the way to the Stock dialog (it opened by itself for a new project). */
function NoPart(): React.JSX.Element {
  const open = useUi((st) => st.setDesignDialog)
  return (
    <>
      <PanelHeader title={m.navigator.operations} />
      <div className={styles['emptyOps']}>
        <EmptyState
          icon={<Icon name="stock" />}
          title={m.setup.emptyTitle}
          description={m.setup.noPart}
          headingLevel={3}
          action={{
            label: m.setup.setUpStock,
            icon: <Icon name="stock" />,
            onClick: () => open('stock'),
          }}
        />
      </div>
    </>
  )
}

/** The stock's size (mm) new operations are placed in; a default block without a stock. */
function stockDims(part: DesignPart): { length: number; width: number; thickness: number } {
  const s = part.loaded?.stock
  return s
    ? { length: s.length.canonical, width: s.width.canonical, thickness: s.thickness.canonical }
    : { length: 100, width: 60, thickness: 20 }
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
  // the default-anchor setting places new pockets and profiles (design-v0.2.md#placement-anchors)
  const defaultAnchor = useSettings((s) => s.settings.defaultAnchor)
  const ops = part.dto.operations
  const ids = ops.map((o) => o.id)
  const failedAt =
    evaluation?.status === 'failed' && evaluation.error !== undefined
      ? failingOperation(evaluation.error, ids)
      : undefined

  // a new facing faces down to the reference model when there is one (DF4)
  const references = useDesignReferences(part)
  const add = async (kind: OperationKind) => {
    const facingDepth = kind === 'facing' ? facingDepthSuggestion(part, references) : undefined
    const r = await call(`design.${kind}.add`, {
      partId: part.dto.id,
      ...addArgs(kind, stockDims(part), part.units, defaultAnchor),
      ...(facingDepth !== undefined ? { depth: facingDepth.source } : {}),
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
  const addItems: MenuEntry[] = [
    {
      group: f.groups.operations,
      items: [
        // named by the kind alone (DF17), described in a tooltip (DF18)
        ...MENU_KINDS.map((k) => ({
          label: m.kinds[k],
          description: m.describe[k],
          icon: <Icon name={ICON[k]} />,
          onSelect: () => void add(k),
        })),
      ],
    },
    {
      group: f.groups.features,
      items: [
        {
          label: f.addHole,
          description: m.describe.hole,
          icon: <Icon name="hole-counterbore" />,
          onSelect: () => void addHole(),
        },
      ],
    },
  ]

  const readout = stockReadout(part)
  const openDialog = useUi((st) => st.setDesignDialog)

  return (
    <div className={styles['navigator']}>
      {/* the part row heads the sidebar, above Operations: it is not an operation (DF15) */}
      <section className={styles['partLine']} aria-label={m.inspector.part}>
        <button
          type="button"
          className={styles['partName']}
          aria-pressed={selected === null}
          title={part.dto.name}
          onClick={() => select(null)}
        >
          {part.dto.name}
        </button>
        {readout !== undefined ? (
          <button
            type="button"
            className={styles['stockReadout']}
            aria-haspopup="dialog"
            title={readout}
            onClick={() => openDialog('stock')}
          >
            {readout}
          </button>
        ) : null}
      </section>
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
