// The design navigator's row menu (dogfood DF16): the actions on a row's item – Chamfer on a
// drilling, circle pocket or inside circle profile (its edge), Make Clones… on anything that can be
// a Clones source, Remove on top-level rows. The same entries open by right-click, Shift+F10 / the
// Menu key and the row's actions (…) button; only applicable items are listed.
// Doc: docs/conventions/ui.md#feature-rows-and-add (Row menu), #clones
import { useCallback } from 'react'
import { designMessages } from '../../messages/design'
import { useUi } from '../../shell/ShellContext'
import { Icon, type MenuEntry, type MenuItem } from '../../ui'
import { isChamferEdge } from './chamfer-view'
import { draftSource, draftSourceOptions, firstRow, firstRowGap } from './clones-view'
import { clonesSource } from './feature-view'
import type { DesignPart } from './model'
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

  return (id, remove) => {
    const items: MenuItem[] = []
    const op = part.dto.operations.find((o) => o.id === id)
    if (op !== undefined && isChamferEdge(op))
      items.push({
        label: f.chamfer,
        icon: <Icon name="chamfer" />,
        onSelect: () => void chamfer(op.id),
      })
    // Make Clones… opens the draft in the inspector for this row (ui.md § Clones): nothing is
    // written until "Make clones"; its first row puts one clone beside the source, a tool
    // diameter apart
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
    const removeItem: MenuItem = {
      label: m.navigator.removeItem,
      icon: <Icon name="delete" />,
      danger: true,
      onSelect: remove.onRemove,
      disabledReason: remove.blocked,
    }
    return items.length > 0 ? [...items, 'separator', removeItem] : [removeItem]
  }
}
