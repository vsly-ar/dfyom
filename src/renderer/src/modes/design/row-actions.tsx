// The design navigator's row menu (dogfood DF16): the actions on a row's item – Chamfer on a
// drilling, circle pocket or inside circle profile (its edge), Make Clones… on anything that can be
// a Clones source, Disable / Enable and Remove on top-level rows. On a pattern's pocket Chamfer
// turns the pattern's chamfer on (patterns P3). A row that is off (DF106) offers nothing that
// builds on it: no Chamfer, no Make Clones…. The same entries open by right-click, Shift+F10 / the
// Menu key and the row's actions (…) button; only applicable items are listed.
// Doc: docs/conventions/ui.md#feature-rows-and-add (Row menu), #clones,
// docs/modes/design.md#disabling-operations-and-features-df106
import { useCallback } from 'react'
import { isDisabled } from '../../../../core/design/disabled'
import { designMessages } from '../../messages/design'
import { useUi } from '../../shell/ShellContext'
import { Icon, type MenuEntry, type MenuItem } from '../../ui'
import { isChamferEdge } from './chamfer-view'
import { draftSource, draftSourceOptions, firstRow, firstRowGap } from './clones-view'
import { clonesSource } from './feature-view'
import { disabledOf, type DesignPart } from './model'
import { useCommand } from './useDesign'

const m = designMessages
const f = m.features

export interface RowRemove {
  readonly name: string
  onRemove(): void
  /** Why remove is refused (the item stays, `aria-disabled` with the reason). */
  readonly blocked?: string | undefined
}

/** The row menu's entries of row `id` (an operation or feature id); `remove` on top-level rows. */
export type RowActions = (id: string, remove?: RowRemove) => MenuEntry[]

export function useRowActions(part: DesignPart): RowActions {
  const call = useCommand()
  const select = useUi((s) => s.select)
  const setClonesDraft = useUi((s) => s.setClonesDraft)
  const setClonesRow = useUi((s) => s.setClonesRow)
  const partId = part.dto.id

  // Chamfer: `design.chamfer.add` with the core defaults (width 0.5 mm / 1/64″, 90°) on this edge,
  // then its inspector
  const chamfer = useCallback(
    async (edgeOf: string) => {
      const r = await call('design.chamfer.add', { partId, edgeOf })
      if (r.ok) select('design', (r.value as { operationId: string }).operationId)
    },
    [call, partId, select],
  )

  // patterns P3: on a pattern's pocket, Chamfer turns the pattern's own chamfer on (the owned
  // chamfer round every cell), then selects the pattern
  const patternChamfer = useCallback(
    async (featureId: string, on: boolean) => {
      const r = on
        ? { ok: true }
        : await call('design.pattern.update', { partId, featureId, chamfer: {} })
      if (r.ok) select('design', featureId)
    },
    [call, partId, select],
  )

  // DF106: one design.part.update with the new list (one undo step)
  const setDisabled = useCallback(
    (list: readonly string[]) => void call('design.part.update', { partId, disabled: list }),
    [call, partId],
  )

  return (id, remove) => {
    const items: MenuItem[] = []
    const off = disabledOf(part)
    const toggle =
      remove === undefined
        ? []
        : disableItems(part.dto.disabled ?? [], id, off.roots.has(id), setDisabled)
    if (isDisabled(off, id)) {
      if (remove === undefined) return []
      return [...toggle, 'separator', removeItem(remove)]
    }
    const op = part.dto.operations.find((o) => o.id === id)
    const pattern =
      op?.featureRole === 'pocket'
        ? part.dto.features?.find((x) => x.id === op.featureId && x.kind === 'pattern')
        : undefined
    if (op !== undefined && pattern !== undefined)
      items.push({
        label: f.chamfer,
        icon: <Icon name="chamfer" />,
        onSelect: () => void patternChamfer(pattern.id, pattern['chamfer'] !== undefined),
      })
    else if (op !== undefined && isChamferEdge(op))
      items.push({
        label: f.chamfer,
        icon: <Icon name="chamfer" />,
        onSelect: () => void chamfer(op.id),
      })
    // Make Clones… opens the draft in the inspector for this row (ui.md § Clones): nothing is
    // written until "Make clones"; its first row puts one clone beside the source, a tool
    // diameter apart
    // (DF122 R5: a pocket or profile with roughing is a source like any other; its roughing
    // comes with it, and the roughing row offers its owner)
    const choice = clonesSource(part, id)
    if (choice.ok)
      items.push({
        label: f.makeClones,
        icon: <Icon name="clones" />,
        onSelect: () => {
          const options = draftSourceOptions(part, choice)
          const feature = 'featureId' in choice.source
          const gap = firstRowGap(part, draftSource(options, new Set(), feature))
          select('design', id)
          setClonesDraft({
            partId,
            openedFor: id,
            options,
            feature,
            unchecked: new Set(),
            rows: [firstRow(choice.width, gap, part.units)],
            preview: null,
          })
          setClonesRow({ owner: 'draft', row: 0 })
        },
      })
    if (remove === undefined) return items
    return [...items, ...toggle, 'separator', removeItem(remove)]
  }
}

function removeItem(remove: RowRemove): MenuItem {
  return {
    label: m.navigator.removeItem,
    icon: <Icon name="delete" />,
    danger: true,
    onSelect: remove.onRemove,
    disabledReason: remove.blocked,
  }
}

/**
 * Disable, or Enable on a row switched off itself (DF106). A row off only as a dependant may be
 * switched off itself too (it then stays off when what it builds on is enabled).
 */
function disableItems(
  list: readonly string[],
  id: string,
  root: boolean,
  set: (list: readonly string[]) => void,
): MenuItem[] {
  if (root)
    return [
      {
        label: m.navigator.enableItem,
        icon: <Icon name="eye" />,
        onSelect: () => set(list.filter((x) => x !== id)),
      },
    ]
  return [
    {
      label: m.navigator.disableItem,
      icon: <Icon name="eye-off" />,
      onSelect: () => set([...list, id]),
    },
  ]
}
