// Design navigator (task 3.6): without a part the stock setup; with one the part and its stock,
// and the operation list in design order – add (Facing, Pocket, Drilling, Profile), select (the
// viewport and inspector follow), move up/down by buttons and Alt+↑/↓, remove with an undo toast
// instead of a confirmation. Rows carry warning badges and the error marker of a failed
// evaluation. Between the part and the operations, the reference models (ReferenceRows.tsx, task
// R3), then the named shapes (ShapeList.tsx, task U1). Doc: docs/conventions/ui.md#panels-and-inspectors, #confirmations, #undo-and-redo;
// docs/modes/design.md#ordering-and-composition
import { useRef, type KeyboardEvent } from 'react'
import type { OperationDTO, OperationKind } from '../../../../core/design/part.dto'
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
} from '../../ui'
import styles from './Design.module.css'
import { addArgs, failingOperation, type DesignPart } from './model'
import { ReferenceRows } from './ReferenceRows'
import { ShapeList } from './ShapeList'
import { StockSetup } from './StockSetup'
import { useCommand, useDesignEvaluation, useDesignSelection, useDesignWarnings } from './useDesign'

const m = designMessages
const KINDS: readonly OperationKind[] = ['facing', 'pocket', 'drilling', 'profile']
const ICON: Record<OperationKind, IconName> = {
  facing: 'facing',
  pocket: 'pocket',
  drilling: 'drilling',
  profile: 'profile',
}

/** A profile cut on its line is a groove (B22-5: the bent slot). */
export function operationIcon(op: OperationDTO): IconName {
  return op.kind === 'profile' && op.side === 'on' ? 'groove' : ICON[op.kind]
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
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const ops = part.dto.operations
  const ids = ops.map((o) => o.id)
  const failedAt =
    evaluation?.status === 'failed' && evaluation.error !== undefined
      ? failingOperation(evaluation.error, ids)
      : undefined

  const add = async (kind: OperationKind) => {
    const s = part.loaded?.stock
    const dims = s
      ? { length: s.length.canonical, width: s.width.canonical, thickness: s.thickness.canonical }
      : { length: 100, width: 60, thickness: 20 }
    const r = await call(`design.${kind}.add`, {
      partId: part.dto.id,
      ...addArgs(kind, dims, part.units, defaultAnchor),
    })
    if (r.ok) select((r.value as { operationId: string }).operationId)
  }
  const move = async (op: OperationDTO, by: -1 | 1) => {
    const to = ids.indexOf(op.id) + by
    if (to < 0 || to >= ids.length) return
    const r = await call('design.operation.move', {
      partId: part.dto.id,
      operationId: op.id,
      toIndex: to,
    })
    if (r.ok) rows.current.get(op.id)?.focus()
  }
  const remove = async (op: OperationDTO) => {
    const r = await call('design.operation.remove', { partId: part.dto.id, operationId: op.id })
    if (!r.ok) return
    if (selected === op.id) select(null)
    setRemoved(op.name)
  }
  const onRowKey = (e: KeyboardEvent, op: OperationDTO, index: number) => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      void move(op, e.key === 'ArrowUp' ? -1 : 1)
      return
    }
    if (!e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      const next = ops[index + (e.key === 'ArrowUp' ? -1 : 1)]
      if (next) rows.current.get(next.id)?.focus()
    }
  }

  const count = (id: string) => warnings.filter((w) => w.operation === id).length
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
          <Menu
            label={m.addOperation}
            items={KINDS.map((k) => ({
              label: m.add(k),
              icon: <Icon name={ICON[k]} />,
              onSelect: () => void add(k),
            }))}
          >
            <IconButton label={m.addOperation} icon={<Icon name="add" />} />
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
        <ol className={styles['ops']} aria-label={m.navigator.listLabel}>
          {ops.map((op, i) => {
            const n = count(op.id)
            const failed = failedAt === op.id
            return (
              <li
                key={op.id}
                className={styles['op']}
                data-selected={selected === op.id ? '' : undefined}
              >
                <button
                  type="button"
                  ref={(el) => {
                    if (el) rows.current.set(op.id, el)
                    else rows.current.delete(op.id)
                  }}
                  className={styles['opSelect']}
                  aria-pressed={selected === op.id}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  onClick={() => select(selected === op.id ? null : op.id)}
                  onKeyDown={(e) => onRowKey(e, op, i)}
                >
                  <Icon name={operationIcon(op)} />
                  <span className={styles['opName']}>{op.name}</span>
                  <span className={styles['opId']}>{op.id}</span>
                  {failed ? (
                    <span className={styles['opFailed']} title={m.navigator.failed}>
                      <Icon name="error" />
                      <span className={styles['srOnly']}>{m.navigator.failed}</span>
                    </span>
                  ) : null}
                  {n > 0 ? (
                    <span className={styles['opBadge']}>
                      <Icon name="warning" />
                      <span aria-hidden="true">{n}</span>
                      <span className={styles['srOnly']}>{m.navigator.warnings(n)}</span>
                    </span>
                  ) : null}
                </button>
                <span className={styles['opActions']}>
                  <IconButton
                    label={m.navigator.moveUp(op.name)}
                    icon={<Icon name="arrow-up" />}
                    shortcut="Alt+↑"
                    disabled={i === 0}
                    onClick={() => void move(op, -1)}
                  />
                  <IconButton
                    label={m.navigator.moveDown(op.name)}
                    icon={<Icon name="arrow-down" />}
                    shortcut="Alt+↓"
                    disabled={i === ops.length - 1}
                    onClick={() => void move(op, 1)}
                  />
                  <IconButton
                    label={m.navigator.remove(op.name)}
                    icon={<Icon name="delete" />}
                    onClick={() => void remove(op)}
                  />
                </span>
              </li>
            )
          })}
        </ol>
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
