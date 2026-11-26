// What Design can add, in one list (hardening DF98): the navigator's Add menu, the empty
// operation list's buttons and the face inspector's buttons all come from `ADD_ITEMS`, so an
// operation or feature cannot be missing from one of them (Pattern was, from the last two).
// A surface leaves an item out only through `ADD_EXCEPTIONS`, with the reason; design add
// commands without an item are in `NOT_ADDED` (parity tests: add-items.test.ts, Design.test.tsx).
// Doc: docs/conventions/ui.md#add-lists-df98
import type { OperationKind } from '../../../../core/design/part.dto'
import { designMessages } from '../../messages/design'
import type { IconName } from '../../ui'
import type { AddOperation } from './useAddOperation'

const m = designMessages
const f = designMessages.features

/** An operation kind Add makes from the stock (not a chamfer: it needs an edge). */
export type AddKind = Exclude<OperationKind, 'chamfer'>
export type AddItemId = AddKind | 'hole' | 'pattern'
/** Where Add items are offered. */
export type AddSurface = 'menu' | 'empty' | 'face'

export interface AddItem {
  readonly id: AddItemId
  readonly group: 'operations' | 'features'
  readonly icon: IconName
  /** The design command it sends. */
  readonly command: string
}

/** In this order on every surface: operations, then features. */
export const ADD_ITEMS: readonly AddItem[] = [
  { id: 'facing', group: 'operations', icon: 'facing', command: 'design.facing.add' },
  { id: 'pocket', group: 'operations', icon: 'pocket', command: 'design.pocket.add' },
  { id: 'profile', group: 'operations', icon: 'profile', command: 'design.profile.add' },
  { id: 'drilling', group: 'operations', icon: 'drilling', command: 'design.drilling.add' },
  { id: 'line', group: 'operations', icon: 'groove', command: 'design.line.add' },
  { id: 'hole', group: 'features', icon: 'hole-counterbore', command: 'design.hole.add' },
  { id: 'pattern', group: 'features', icon: 'pattern', command: 'design.pattern.add' },
]

/** Items a surface leaves out on purpose, with the reason (none today). */
export const ADD_EXCEPTIONS: Readonly<
  Record<AddSurface, Readonly<Partial<Record<AddItemId, string>>>>
> = { menu: {}, empty: {}, face: {} }

/** `design.<x>.add` commands that are not Add items, and where they are offered instead. */
export const NOT_ADDED: Readonly<Record<string, string>> = {
  'design.part.add': 'the Stock dialog and the part menu (New part…)',
  'design.shape.add': 'the Shapes dialog and the Shape Editor',
  'design.chamfer.add': 'needs an edge: the row menu of a drilling, pocket or profile',
  'design.clones.add': 'repeats a selection: Make Clones… in the row menu',
}

/** The items a surface shows, in `ADD_ITEMS` order. */
export function addItemsFor(surface: AddSurface): readonly AddItem[] {
  return ADD_ITEMS.filter((i) => ADD_EXCEPTIONS[surface][i.id] === undefined)
}

/** The item's label on a surface ("Pocket", "Add pocket", "Add pocket here"). */
export function addItemLabel(id: AddItemId, surface: AddSurface): string {
  if (id === 'hole')
    return surface === 'menu'
      ? f.addHole
      : surface === 'empty'
        ? m.navigator.empty.addHole
        : m.face.addHole
  if (id === 'pattern')
    return surface === 'menu'
      ? f.addPattern
      : surface === 'empty'
        ? m.navigator.empty.addPattern
        : m.face.addPattern
  return surface === 'menu' ? m.kinds[id] : surface === 'empty' ? m.add(id) : m.face.addHere(id)
}

/** The item's one-line description (the menu's tooltip, DF18). */
export function addItemDescription(id: AddItemId): string {
  return m.describe[id]
}

/** Runs the item through `useAddOperation` (on the selected face, if any). */
export function runAddItem(add: AddOperation, id: AddItemId): Promise<void> {
  if (id === 'hole') return add.addHole()
  if (id === 'pattern') return add.addPattern()
  return add.add(id)
}
