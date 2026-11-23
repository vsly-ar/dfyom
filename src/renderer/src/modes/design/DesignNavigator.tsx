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
import { useShell, useUi } from '../../shell/ShellContext'
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
import { failingOperation, type DesignPart } from './model'
import { useAddOperation } from './useAddOperation'
import { OperationList } from './OperationList'
import { operationUnits } from './feature-view'
import { stockReadout } from './PartSetupDialogs'
import { useDesignEvaluation, useDesignSelection, useDesignWarnings } from './useDesign'

export { operationIcon } from './OperationList'

const m = designMessages
const f = m.features
/**
 * The Add menu's Operations group (ui.md § Feature rows and Add); the empty list's buttons follow
 * the same order, then Add bolt hole (DF48).
 */
const MENU_KINDS: readonly OperationKind[] = ['facing', 'pocket', 'profile', 'drilling']
const ICON: Record<OperationKind, IconName> = {
  facing: 'facing',
  pocket: 'pocket',
  drilling: 'drilling',
  profile: 'profile',
  // not in MENU_KINDS: a chamfer needs an edge (the row menu's Chamfer, DF16)
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

function PartNavigator({ part }: { part: DesignPart }): React.JSX.Element {
  const { bridge } = useShell()
  const [selected, select] = useDesignSelection()
  const { warnings } = useDesignWarnings(part)
  const evaluation = useDesignEvaluation(part)
  // the undo toast lives in the ui store: the inspector's segment table removes rows too
  const removed = useUi((st) => st.removedToast)
  const setRemovedToast = useUi((st) => st.setRemovedToast)
  const ops = part.dto.operations
  const ids = ops.map((o) => o.id)
  const failedAt =
    evaluation?.status === 'failed' && evaluation.error !== undefined
      ? failingOperation(evaluation.error, ids)
      : undefined

  // Add puts operations on the selected face, if any (DF22; useAddOperation; DF4 facing depth inside)
  const { add, addHole } = useAddOperation(part)
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
  // the list's rows: plain operations and features (a hole's or a Clones' operations nest)
  const rows = operationUnits(part).length
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
        meta={
          ops.length > 0 ? (
            <span title={m.navigator.countTip(rows, ops.length)}>{rows}</span>
          ) : undefined
        }
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
            {MENU_KINDS.map((k) => (
              <Button key={k} size="sm" icon={<Icon name={ICON[k]} />} onClick={() => void add(k)}>
                {m.add(k)}
              </Button>
            ))}
            <Button
              size="sm"
              icon={<Icon name="hole-counterbore" />}
              onClick={() => void addHole()}
            >
              {m.navigator.empty.addHole}
            </Button>
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
