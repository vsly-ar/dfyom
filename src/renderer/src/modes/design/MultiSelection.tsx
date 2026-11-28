// The Design navigator's multi-selection (hardening DF135): the current selection of top-level
// rows, its bulk actions – Mark N as already cut / not cut, Disable / Enable N (each one
// `design.part.update` with the new list), Remove N items (one compound gesture, later rows
// first; a refusal cancels it, nothing is removed) – for the row menu and the inspector, which
// shows "N items selected", the names and the same actions as buttons. Each action is one undo
// step. Doc: docs/conventions/ui.md#multi-select-in-the-design-navigator-df135
import { useState } from 'react'
import { surfaceOfReference } from '../../../../core/design/surfaces'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { ERROR_CODES } from '../../../../shared/errors/codes'
import { designMessages } from '../../messages/design'
import { useCancelGesture } from '../../shell/hooks'
import { useUi } from '../../shell/ShellContext'
import type { DesignMulti } from '../../state/ui-store'
import { Button, Icon, newGestureId, PanelHeader, type MenuEntry, type MenuItem } from '../../ui'
import styles from './Design.module.css'
import { featureRemoveBlocked, operationUnits } from './feature-view'
import { disabledOf, itemName, surfaceLabel, type DesignPart } from './model'
import { bulkPlan, inOrder } from './multi-select'
import { useCommand } from './useDesign'

const m = designMessages
const t = m.navigator.multi

/** The top-level row ids of the part, in design order (what can be selected together). */
export function topLevelIds(part: Pick<DesignPart, 'dto'>): string[] {
  return operationUnits(part as DesignPart).map((u) => u.id)
}

/**
 * The window's multi-selection on this part: two or more of its top-level rows (ids that left the
 * part dropped), or null.
 */
export function useDesignMulti(part: DesignPart | undefined): DesignMulti | null {
  const multi = useUi((s) => s.designMulti)
  if (multi === null || part === undefined) return null
  const ids = inOrder(topLevelIds(part), multi.ids)
  if (ids.length < 2) return null
  return ids.length === multi.ids.length ? multi : { ids, anchor: multi.anchor }
}

/** Why a bulk removal was refused, naming the item outside the selection that needs it. */
export function removeRefusal(part: Pick<DesignPart, 'dto'>, error: AppErrorData): string {
  const issue = error.issues?.[0]
  const user = String(issue?.params?.['operationId'] ?? '')
  const reference = String(issue?.params?.['reference'] ?? '')
  if (error.code === 'design.referenced' && user.length > 0 && reference.length > 0) {
    const edge = part.dto.operations.some((o) => o.id === reference)
    const used = edge
      ? itemName(part.dto, reference)
      : surfaceLabel(part.dto, surfaceOfReference(reference))
    return t.refused(t.usedBy(itemName(part.dto, user), used))
  }
  return t.refused(ERROR_CODES[error.code]?.userMessage ?? error.message)
}

/**
 * The bulk actions on `ids` (top-level rows in design order), as menu entries: the marks, the
 * switches, a separator and Remove. `onRefused` gets a refused removal's reason.
 */
export function useBulkActions(
  part: DesignPart,
  ids: readonly string[],
  onRefused: (why: string) => void,
): BulkActions {
  const call = useCommand()
  const cancelGesture = useCancelGesture()
  const select = useUi((s) => s.select)
  const setRemovedToast = useUi((s) => s.setRemovedToast)
  const partId = part.dto.id
  const plan = bulkPlan(ids, part.dto.alreadyCut ?? [], part.dto.disabled ?? [], disabledOf(part))
  const update = (args: object) => void call('design.part.update', { partId, ...args })

  const remove = async () => {
    const gesture = newGestureId()
    const isFeature = featureIds(part)
    let done = 0
    for (const id of plan.removeOrder) {
      const r = isFeature.has(id)
        ? await call('design.feature.remove', { partId, featureId: id }, { gesture })
        : await call('design.operation.remove', { partId, operationId: id }, { gesture })
      if (!r.ok) {
        // nothing removed: the steps so far are one entry, reverted and discarded
        if (done > 0) await cancelGesture(gesture)
        onRefused(removeRefusal(part, r.error))
        return
      }
      done += 1
    }
    select('design', null)
    setRemovedToast(t.removed(ids.length))
  }

  const items: MenuItem[] = []
  if (plan.markCut !== undefined) {
    const { list, count } = plan.markCut
    items.push({
      label: t.markCut(count),
      icon: <Icon name="success" />,
      onSelect: () => update({ alreadyCut: list }),
    })
  }
  if (plan.unmarkCut !== undefined) {
    const { list, count } = plan.unmarkCut
    items.push({
      label: t.unmarkCut(count),
      icon: <Icon name="undo" />,
      onSelect: () => update({ alreadyCut: list }),
    })
  }
  if (plan.disable !== undefined) {
    const { list, count } = plan.disable
    items.push({
      label: t.disable(count),
      icon: <Icon name="eye-off" />,
      onSelect: () => update({ disabled: list }),
    })
  }
  if (plan.enable !== undefined) {
    const { list, count } = plan.enable
    items.push({
      label: t.enable(count),
      icon: <Icon name="eye" />,
      onSelect: () => update({ disabled: list }),
    })
  }
  const isFeature = featureIds(part)
  const blocked = ids
    .map((id) => (isFeature.has(id) ? featureRemoveBlocked(part, id) : undefined))
    .find((x) => x !== undefined)
  const removeItem: MenuItem = {
    label: t.remove(ids.length),
    icon: <Icon name="delete" />,
    danger: true,
    disabledReason: blocked,
    onSelect: () => void remove(),
  }
  return {
    entries: [...items, 'separator', removeItem],
    items: [...items, removeItem],
    remove: () => {
      if (blocked === undefined) void remove()
    },
  }
}

export interface BulkActions {
  /** The row menu's entries. */
  readonly entries: MenuEntry[]
  /** The same actions without the separator (the inspector's buttons). */
  readonly items: MenuItem[]
  /** Remove N items (Delete on a selected row); nothing while a feature among them is blocked. */
  remove(): void
}

const featureIds = (part: DesignPart): Set<string> =>
  new Set((part.dto.features ?? []).map((f) => f.id))

/**
 * The inspector of a multi-selection: "N items selected", the names in design order (with their
 * Cut / Off markers as words) and the bulk actions as buttons.
 */
export function MultiInspector({
  part,
  multi,
}: {
  part: DesignPart
  multi: DesignMulti
}): React.JSX.Element {
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const { items } = useBulkActions(part, multi.ids, setRefusal)
  const off = disabledOf(part)
  const cut = new Set(part.dto.alreadyCut ?? [])
  return (
    <div className={styles['inspector']}>
      <PanelHeader title={t.selected(multi.ids.length)} />
      <div className={styles['fields']}>
        <ul className={styles['multiNames']} aria-label={t.names}>
          {multi.ids.map((id) => (
            <li key={id}>
              <span className={styles['opName']}>{itemName(part.dto, id)}</span>
              {cut.has(id) ? <span className={styles['multiTag']}>{m.navigator.cut}</span> : null}
              {off.roots.has(id) || off.dependants.has(id) ? (
                <span className={styles['multiTag']}>{m.navigator.off}</span>
              ) : null}
            </li>
          ))}
        </ul>
        <div className={styles['addRow']}>
          {items.map((e) => (
            <Button
              key={e.label}
              size="sm"
              variant={e.danger === true ? 'danger' : 'default'}
              icon={e.icon}
              disabled={e.disabledReason !== undefined}
              onClick={() => {
                setRefusal(undefined)
                e.onSelect()
              }}
            >
              {e.label}
            </Button>
          ))}
        </div>
        {items.map((e) =>
          e.disabledReason !== undefined ? (
            <p key={e.label} className={styles['muted']}>
              {e.disabledReason}
            </p>
          ) : null,
        )}
        {refusal !== undefined ? (
          <p className={styles['note']} role="alert">
            {refusal}
          </p>
        ) : null}
        <p className={styles['muted']}>{t.hint}</p>
      </div>
    </div>
  )
}
