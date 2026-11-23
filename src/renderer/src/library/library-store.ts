// State of the Library window (Zustand, per window): the tab, each kind's listing, the selected
// item and its local draft (L3: Save sends one `library.<kind>.add` / `.update` with the read
// revision, Revert drops it), the leave prompt that guards switching away from a draft, the close
// request from main, a stale revision (`command.conflict`, or a write by someone else to the item
// being edited) with Reload / Overwrite, and the unit system (L5). The window calls the app-scope
// library commands like agents do; main pushes library writes (`onChanged`) and the context.
// Doc: docs/conventions/ui-library-window.md#decisions-assumed, #behaviour-with-projects
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { LibraryItemKind } from '../../../core/library/item'
import type { LibraryChange } from '../../../core/library/library'
import type { LibraryItemDTO } from '../../../core/library/library-item'
import type { UnitSystem } from '../../../core/project/document'
import type { AppErrorData } from '../../../shared/errors/app-error'
import type {
  CallReply,
  LibraryCloseRequest,
  LibraryContext,
  PreloadApi,
} from '../../../shared/preload-api'
import { libraryMessages } from '../messages/library'
import type { SettingsStore } from '../state/settings'
import {
  commandInput,
  copyName,
  defaultValues,
  draftIssues,
  itemValues,
  toolName,
  uniqueName,
  type DraftValues,
} from './form'

export const KINDS: readonly LibraryItemKind[] = ['machine', 'tool', 'stock']

export interface Listing {
  readonly items: readonly LibraryItemDTO[]
  readonly errors: readonly { id: string; code: string; message: string }[]
  readonly loaded: boolean
}

export interface Draft {
  readonly kind: LibraryItemKind
  /** null: a new item, not in the library yet. */
  readonly id: string | null
  readonly revision: number | null
  readonly values: DraftValues
  /** The stored values (unchanged = not dirty); null for a new item. */
  readonly base: DraftValues | null
  /** A new tool's empty name means the suggested one ("Flat 6"). */
  readonly autoName: boolean
  /** A stock variant's parent (DF13): kept by updates, sent with the add of a new variant. */
  readonly parentId?: string | undefined
}

export type Conflict = 'stale' | 'removed'

/** Selected row of a kind: an item id, or `NEW` while a new item is drafted. */
export const NEW = '\u0000new'

export interface LibraryState {
  readonly tab: LibraryItemKind
  readonly lists: Readonly<Record<LibraryItemKind, Listing>>
  readonly selected: Readonly<Record<LibraryItemKind, string | null>>
  readonly draft: Draft | null
  readonly saving: boolean
  /** The last failed save or remove (issues show at their field). */
  readonly error: AppErrorData | undefined
  /** Bumped on each failed save: the editor focuses the first invalid field. */
  readonly failures: number
  readonly conflict: Conflict | null
  readonly search: string
  readonly context: LibraryContext
  /** The mm / in control's choice; null follows the project, else the setting (L5). */
  readonly unitsOverride: UnitSystem | null
  /** Switching away from a draft: Save / Discard / Cancel, then `next`. */
  readonly prompt: { readonly name: string; readonly next: () => void } | null
  readonly closeRequest: LibraryCloseRequest | null
  /** The remove confirmation is open. */
  readonly removing: boolean
  /** The tool form's Details group is open (DF1): kept across items and tabs in this window. */
  readonly toolDetailsOpen: boolean
}

export interface LibraryActions {
  start(): () => void
  units(): UnitSystem
  setUnits(units: UnitSystem): void
  setSearch(search: string): void
  setTab(tab: LibraryItemKind): void
  select(kind: LibraryItemKind, id: string): void
  newItem(kind?: LibraryItemKind): void
  duplicate(): void
  /** A new stock variant of the selected stock (or a sibling of the selected variant), DF13. */
  newVariant(): void
  edit(values: DraftValues, opts?: { nameTyped?: boolean }): void
  revert(): void
  save(): Promise<boolean>
  reload(): Promise<void>
  overwrite(): Promise<boolean>
  setRemoving(open: boolean): void
  setToolDetailsOpen(open: boolean): void
  remove(): Promise<void>
  promptSave(): Promise<void>
  promptDiscard(): void
  promptCancel(): void
  closeSave(): Promise<void>
  closeDiscard(): void
  closeCancel(): void
  isDirty(): boolean
  draftName(): string
  /** The names of the draft kind's other items (all of them for a new item; DF47). */
  otherNames(): readonly string[]
  /** The item list's rows: the kind's items, filtered by the search. */
  load(kind: LibraryItemKind): Promise<void>
}

export type LibraryStore = StoreApi<LibraryState & LibraryActions>

const EMPTY: Listing = { items: [], errors: [], loaded: false }

/** Order-independent equality of plain values (undefined fields count as absent). */
export function sameValues(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm)
    if (v !== null && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => x !== undefined)
          .sort(([x], [y]) => (x < y ? -1 : 1))
          .map(([k, x]) => [k, norm(x)]),
      )
    return v
  }
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

function draftOf(item: LibraryItemDTO): Draft {
  const values = itemValues(item) as DraftValues
  return {
    kind: item.kind,
    id: item.id,
    revision: item.revision,
    values,
    base: values,
    autoName: false,
    parentId: item.parentId,
  }
}

const reply = <T>(r: CallReply): T | undefined => (r.ok ? (r.value as T) : undefined)

export function createLibraryStore(deps: {
  bridge: PreloadApi
  settings: SettingsStore
}): LibraryStore {
  const { bridge, settings } = deps
  const call = (name: string, args: object) => bridge.call(name, args)

  return createStore<LibraryState & LibraryActions>()((set, get) => {
    const report = () => {
      const s = get()
      bridge.library.report({ draft: s.isDirty() ? s.draftName() : null, tab: s.tab })
    }
    const patch = (p: Partial<LibraryState>) => {
      set(p)
      report()
    }
    /** Runs `next` now, or after the user saved or discarded the draft. */
    const guard = (next: () => void) => {
      if (!get().isDirty()) return next()
      set({ prompt: { name: get().draftName(), next } })
    }
    const itemOf = (kind: LibraryItemKind, id: string | null) =>
      id === null ? undefined : get().lists[kind].items.find((i) => i.id === id)

    const showItem = (kind: LibraryItemKind, id: string | null) => {
      const item = itemOf(kind, id)
      patch({
        tab: kind,
        selected: { ...get().selected, [kind]: id },
        draft: item === undefined ? null : draftOf(item),
        error: undefined,
        conflict: null,
      })
    }

    /** Applies a context's target (an "Edit in library" link): tab and item. */
    const follow = (context: LibraryContext, previous: LibraryContext | null) => {
      const t = context.target
      if (t === null || t.seq === previous?.target?.seq) return
      // opened again from a window: its project's unit system applies (L5)
      set({ unitsOverride: null })
      const kind = t.kind ?? get().tab
      guard(() => {
        if (t.itemId !== undefined) {
          void get()
            .load(kind)
            .then(() => showItem(kind, t.itemId!))
        } else if (kind !== get().tab) showItem(kind, get().selected[kind])
      })
    }

    const onChange = (change: LibraryChange) => {
      void get().load(change.kind)
      const s = get()
      if (s.saving || s.draft === null || s.draft.id !== change.id) return
      if (change.change === 'updated' && change.revision === s.draft.revision) return
      if (!s.isDirty()) {
        if (change.change === 'removed') showItem(change.kind, null)
        else void refreshDraft(change.kind, change.id)
        return
      }
      set({ conflict: change.change === 'removed' ? 'removed' : 'stale' })
    }

    const refreshDraft = async (kind: LibraryItemKind, id: string) => {
      const item = reply<LibraryItemDTO>(await call(`library.${kind}.get`, { id }))
      if (item !== undefined && get().draft?.id === id && !get().isDirty())
        set({ draft: draftOf(item) })
    }

    /** Sends the draft (add, or update on `revision`); the result becomes the clean draft. */
    const send = async (revision: number | null): Promise<boolean> => {
      const d = get().draft
      if (d === null) return true
      const issues = draftIssues(d.values, d.autoName)
      if (issues.length > 0) {
        set((s) => ({
          error: {
            code: 'input.malformed',
            message: libraryMessages.saveFailed,
            issues,
            frames: [],
          },
          failures: s.failures + 1,
        }))
        return false
      }
      const input = commandInput(d.values, {
        units: get().units(),
        base: d.base ?? undefined,
        autoName: d.autoName,
        taken: get().otherNames(),
      })
      set({ saving: true, error: undefined })
      const r =
        d.id === null
          ? await call(`library.${d.kind}.add`, {
              ...input,
              ...(d.parentId === undefined ? {} : { parentId: d.parentId }),
            })
          : await call(`library.${d.kind}.update`, { ...input, id: d.id, revision })
      set({ saving: false })
      if (!r.ok) {
        if (r.error.code === 'command.conflict') set({ conflict: 'stale' })
        else set((s) => ({ error: r.error, failures: s.failures + 1 }))
        return false
      }
      const item = r.value as LibraryItemDTO
      await get().load(d.kind)
      patch({
        draft: draftOf(item),
        selected: { ...get().selected, [d.kind]: item.id },
        conflict: null,
        error: undefined,
      })
      return true
    }

    return {
      tab: 'tool',
      lists: { machine: EMPTY, tool: EMPTY, stock: EMPTY },
      selected: { machine: null, tool: null, stock: null },
      draft: null,
      saving: false,
      error: undefined,
      failures: 0,
      conflict: null,
      search: '',
      context: { project: null, target: null, tab: 'tool' },
      unitsOverride: null,
      prompt: null,
      closeRequest: null,
      removing: false,
      toolDetailsOpen: false,
      setToolDetailsOpen: (toolDetailsOpen) => set({ toolDetailsOpen }),

      start() {
        let live = true
        const stops = [
          bridge.library.onChanged(onChange),
          bridge.library.onContext((context) => {
            const previous = get().context
            set({ context })
            follow(context, previous)
          }),
          bridge.library.onCloseRequest((closeRequest) => set({ closeRequest })),
        ]
        void Promise.all(KINDS.map((k) => get().load(k))).then(async () => {
          const context = await bridge.library.context()
          if (!live) return
          set({ context, tab: context.target?.kind ?? context.tab })
          follow(context, null)
          const tab = get().tab
          if (get().selected[tab] === null) {
            const first = get().lists[tab].items[0]
            if (first !== undefined) showItem(tab, first.id)
          }
          report()
        })
        return () => {
          live = false
          for (const stop of stops) stop()
        }
      },

      async load(kind) {
        const r = reply<{ items: LibraryItemDTO[]; errors: Listing['errors'] }>(
          await call(`library.${kind}.list`, {}),
        )
        if (r === undefined) return
        // by name, as the list sorts by default: the first item is the first row
        const items = [...r.items].sort((a, b) => a.name.localeCompare(b.name))
        set({ lists: { ...get().lists, [kind]: { items, errors: r.errors, loaded: true } } })
      },

      units() {
        const s = get()
        return (
          s.unitsOverride ??
          s.context.project?.unitSystem ??
          settings.getState().settings.libraryUnits
        )
      },
      setUnits(units) {
        set({ unitsOverride: units })
        settings.getState().update({ libraryUnits: units })
      },
      setSearch: (search) => set({ search }),

      setTab(tab) {
        if (tab === get().tab) return
        guard(() => {
          const s = get()
          const id = s.selected[tab] ?? s.lists[tab].items[0]?.id ?? null
          showItem(tab, id === NEW ? null : id)
        })
      },

      select(kind, id) {
        const s = get()
        if (s.tab === kind && s.selected[kind] === id && s.draft !== null) return
        guard(() => showItem(kind, id))
      },

      newItem(kind) {
        const k = kind ?? get().tab
        guard(() => {
          const values = defaultValues(k, get().units())
          // a default name never repeats another item's (a tool's follows type and size; DF47)
          const taken = get().lists[k].items.map((i) => i.name)
          patch({
            tab: k,
            selected: { ...get().selected, [k]: NEW },
            draft: {
              kind: k,
              id: null,
              revision: null,
              values: k === 'tool' ? values : { ...values, name: uniqueName(values.name, taken) },
              base: null,
              autoName: k === 'tool',
            },
            error: undefined,
            conflict: null,
          })
        })
      },

      duplicate() {
        const d = get().draft
        if (d === null) return
        guard(() => {
          const taken = get().lists[d.kind].items.map((i) => i.name)
          const values = { ...d.values, name: copyName(get().draftName(), taken) } as DraftValues
          patch({
            selected: { ...get().selected, [d.kind]: NEW },
            // a duplicated variant stays under the same parent
            draft: {
              kind: d.kind,
              id: null,
              revision: null,
              values,
              base: null,
              autoName: false,
              parentId: d.parentId,
            },
            error: undefined,
            conflict: null,
          })
        })
      },

      newVariant() {
        const d = get().draft
        if (d === null || d.kind !== 'stock' || d.id === null) return
        const root = d.parentId ?? d.id
        const rootName = get().lists.stock.items.find((i) => i.id === root)?.name ?? d.values.name
        guard(() => {
          const taken = get().lists.stock.items.map((i) => i.name)
          const name = uniqueName(libraryMessages.window.variantName(rootName), taken)
          const values = { ...d.values, name }
          patch({
            selected: { ...get().selected, stock: NEW },
            draft: {
              kind: 'stock',
              id: null,
              revision: null,
              values: values as DraftValues,
              base: null,
              autoName: false,
              parentId: root,
            },
            error: undefined,
            conflict: null,
          })
        })
      },

      edit(values, opts) {
        const d = get().draft
        if (d === null) return
        const wasDirty = get().isDirty()
        set({
          draft: { ...d, values, autoName: d.autoName && opts?.nameTyped !== true },
          error: undefined,
        })
        if (wasDirty !== get().isDirty()) report()
      },

      revert() {
        const d = get().draft
        if (d === null) return
        if (d.id === null) {
          const first = get().lists[d.kind].items[0]
          showItem(d.kind, first?.id ?? null)
        } else showItem(d.kind, d.id)
      },

      save: () => send(get().draft?.revision ?? null),

      async reload() {
        const d = get().draft
        if (d === null || d.id === null) return
        await get().load(d.kind)
        showItem(d.kind, itemOf(d.kind, d.id) === undefined ? null : d.id)
      },

      async overwrite() {
        const d = get().draft
        if (d === null) return false
        if (get().conflict === 'removed' || d.id === null) {
          // the item is gone: save the draft as a new item (its parent may be gone too)
          const parentId =
            d.parentId !== undefined && get().lists.stock.items.some((i) => i.id === d.parentId)
              ? d.parentId
              : undefined
          set({ draft: { ...d, id: null, revision: null, base: null, parentId }, conflict: null })
          return send(null)
        }
        const current = reply<LibraryItemDTO>(await call(`library.${d.kind}.get`, { id: d.id }))
        if (current === undefined) {
          set({ conflict: 'removed' })
          return false
        }
        set({ draft: { ...d, revision: current.revision }, conflict: null })
        return send(current.revision)
      },

      setRemoving: (removing) => set({ removing }),

      async remove() {
        const d = get().draft
        if (d === null || d.id === null) return
        const r = await call(`library.${d.kind}.remove`, {
          id: d.id,
          revision: d.revision,
          confirm: true,
        })
        set({ removing: false })
        if (!r.ok) {
          set((s) => ({ error: r.error, failures: s.failures + 1 }))
          return
        }
        await get().load(d.kind)
        const first = get().lists[d.kind].items[0]
        showItem(d.kind, first?.id ?? null)
      },

      async promptSave() {
        const p = get().prompt
        if (p === null) return
        set({ prompt: null })
        if (await get().save()) p.next()
      },
      promptDiscard() {
        const p = get().prompt
        if (p === null) return
        set({ prompt: null, draft: null })
        report()
        p.next()
      },
      promptCancel: () => set({ prompt: null }),

      async closeSave() {
        const r = get().closeRequest
        if (r === null) return
        set({ closeRequest: null })
        if (await get().save()) void bridge.library.close(r.quit)
      },
      closeDiscard() {
        const r = get().closeRequest
        if (r === null) return
        set({ closeRequest: null, draft: null })
        report()
        void bridge.library.close(r.quit)
      },
      closeCancel: () => set({ closeRequest: null }),

      isDirty() {
        const d = get().draft
        return d !== null && (d.id === null || !sameValues(d.values, d.base))
      },

      draftName() {
        const d = get().draft
        if (d === null) return ''
        const name = d.values.name.trim()
        if (name !== '') return name
        if (d.values.kind === 'tool' && d.autoName) return toolName(d.values, get().otherNames())
        return libraryMessages.window.newRow(d.kind)
      },

      otherNames() {
        const d = get().draft
        if (d === null) return []
        return get()
          .lists[d.kind].items.filter((i) => i.id !== d.id)
          .map((i) => i.name)
      },
    }
  })
}
