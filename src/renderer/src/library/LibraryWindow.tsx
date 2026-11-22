// The Library window (one per app instance, L1): banner toolbar (search, mm / in, "New <kind>",
// the machine group with Stop while a connection is open), navigation tabs Machines | Tools |
// Stock, and the main region with the item list and the item editor. Keys: Ctrl/Cmd+S and
// Ctrl/Cmd+Enter save the draft, F6 cycles toolbar, tabs, list and editor. Leaving a draft asks
// "Save changes to …?"; closing the window with one asks the same (main's close request).
// Doc: docs/conventions/ui-library-window.md
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useStore } from 'zustand'
import type { LibraryItemKind } from '../../../core/library/item'
import type { UnitSystem } from '../../../core/project/document'
import type { MenuAction } from '../../../shared/preload-api'
import { libraryMessages } from '../messages/library'
import { MachineToolbar } from '../modes/run'
import { isKeyEcho, noteKeyAction } from '../shell/key-echo'
import { useShell } from '../shell/ShellContext'
import { cycleRegion, IS_MAC, isEditableTarget, REGION_ATTR } from '../shell/shortcuts'
import {
  Icon,
  ApplyScope,
  Button,
  Dialog,
  DialogClose,
  SegmentedControl,
  modalDialogOpen,
} from '../ui'
import { ItemEditor } from './ItemEditor'
import { ItemTable } from './ItemTable'
import { createLibraryStore, KINDS, NEW, type LibraryStore } from './library-store'
import styles from './LibraryWindow.module.css'

const w = libraryMessages.window
const region = { [REGION_ATTR]: '' }

/** The draft's Save / Discard / Cancel prompt (switching items, closing the window). */
function SavePrompt({
  name,
  open,
  onSave,
  onDiscard,
  onCancel,
}: {
  name: string
  open: boolean
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <Dialog
      title={w.leaveTitle(name)}
      description={w.leaveDescription}
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel()
      }}
      footer={
        <>
          <DialogClose>
            <Button variant="ghost">{libraryMessages.cancel}</Button>
          </DialogClose>
          <Button variant="danger" onClick={onDiscard}>
            {w.leaveDiscard}
          </Button>
          <Button variant="primary" icon={<Icon name="save" />} onClick={onSave}>
            {w.leaveSave}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  )
}

function useLibraryKeys(store: LibraryStore): void {
  const { bridge } = useShell()
  useEffect(() => {
    const save = () => {
      if (modalDialogOpen()) return
      // a field holding typed text commits it first (blur), as Enter would
      const field = document.activeElement
      if (field instanceof HTMLElement && isEditableTarget(field)) {
        field.blur()
        field.focus()
      }
      if (store.getState().isDirty()) void store.getState().save()
    }
    const run = (action: MenuAction) => {
      if (action === 'project.save' || action === 'project.apply') save()
    }
    const offMenu = bridge.menu.onAction((action) => {
      if (!isKeyEcho(action)) run(action)
    })
    const onKey = (e: globalThis.KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (e.key === 'F6') {
        e.preventDefault()
        cycleRegion(document, e.shiftKey)
        return
      }
      if (!mod || e.altKey || e.shiftKey) return
      if (e.key === 'Enter' || e.key.toLowerCase() === 's') {
        e.preventDefault()
        const action = e.key === 'Enter' ? 'project.apply' : 'project.save'
        noteKeyAction(action)
        run(action)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offMenu()
      window.removeEventListener('keydown', onKey)
    }
  }, [bridge, store])
}

function LibraryTabs({
  tab,
  onTab,
}: {
  tab: LibraryItemKind
  onTab: (tab: LibraryItemKind) => void
}): React.JSX.Element {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = KINDS.indexOf(tab)
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const next = KINDS[(at + step + KINDS.length) % KINDS.length]!
    onTab(next)
    requestAnimationFrame(() => document.getElementById(`library-tab-${next}`)?.focus())
  }
  return (
    <nav aria-label={w.tabsLabel} className={styles['tabsNav']} {...region}>
      <div role="tablist" aria-label={w.tabsLabel} className={styles['tabs']} onKeyDown={onKey}>
        {KINDS.map((k) => (
          <button
            key={k}
            id={`library-tab-${k}`}
            type="button"
            role="tab"
            aria-selected={k === tab}
            aria-controls="library-panel"
            tabIndex={k === tab ? 0 : -1}
            className={styles['tab']}
            onClick={() => onTab(k)}
          >
            {w.tabs[k]}
          </button>
        ))}
      </div>
    </nav>
  )
}

export function LibraryWindow(): React.JSX.Element {
  const shell = useShell()
  const [store] = useState(() =>
    createLibraryStore({ bridge: shell.bridge, settings: shell.settings }),
  )
  useEffect(() => store.getState().start(), [store])
  useLibraryKeys(store)
  const s = useStore(store)
  const settingsUnits = useStore(shell.settings, (x) => x.settings.libraryUnits)
  const units: UnitSystem = s.unitsOverride ?? s.context.project?.unitSystem ?? settingsUnits
  const used = useMemo(() => new Set(s.context.project?.used ?? []), [s.context.project])
  const editorRef = useRef<HTMLElement>(null)

  useEffect(() => {
    document.title = w.title
  }, [])

  const dirty = s.isDirty()
  const unsavedId = dirty ? (s.draft?.id ?? NEW) : null

  return (
    <div className={styles['window']}>
      <header className={styles['toolbar']} {...region}>
        <label className={styles['search']}>
          <Icon name="search" />
          <input
            type="search"
            aria-label={w.search}
            placeholder={w.searchPlaceholder(s.tab)}
            value={s.search}
            onChange={(e) => s.setSearch(e.target.value)}
          />
        </label>
        <SegmentedControl<UnitSystem>
          label={w.units}
          size="sm"
          options={[
            { value: 'mm', label: w.unitOptions.mm },
            { value: 'inch', label: w.unitOptions.inch },
          ]}
          value={units}
          onValueChange={(u) => s.setUnits(u)}
        />
        <Button variant="primary" size="sm" icon={<Icon name="add" />} onClick={() => s.newItem()}>
          {w.newItem[s.tab]}
        </Button>
        <span className={styles['spacer']} />
        {s.context.project !== null ? (
          <span className={styles['project']}>{w.projectNote(s.context.project.name)}</span>
        ) : null}
        <div className={styles['machine']}>
          <MachineToolbar />
        </div>
      </header>
      <LibraryTabs tab={s.tab} onTab={(t) => s.setTab(t)} />
      <main className={styles['main']}>
        <div
          id="library-panel"
          role="tabpanel"
          aria-labelledby={`library-tab-${s.tab}`}
          className={styles['panel']}
        >
          <section aria-label={w.list(s.tab)} className={styles['listRegion']} {...region}>
            <ItemTable
              key={s.tab}
              kind={s.tab}
              listing={s.lists[s.tab]}
              search={s.search}
              selected={s.selected[s.tab]}
              used={used}
              unsavedId={unsavedId}
              newName={s.draftName()}
              onSelect={(id) => (id === NEW ? undefined : s.select(s.tab, id))}
              onEnter={() =>
                editorRef.current
                  ?.querySelector<HTMLElement>('input:not([readonly]), button, select, textarea')
                  ?.focus()
              }
            />
          </section>
          <section
            aria-label={w.editor}
            className={styles['editorRegion']}
            ref={editorRef}
            {...region}
          >
            {/* Enter in a field commits it only; Ctrl/Cmd+Enter saves (useLibraryKeys) */}
            <ApplyScope onApply={null}>
              <ItemEditor store={store} used={used} projectName={s.context.project?.name} />
            </ApplyScope>
          </section>
        </div>
      </main>
      <SavePrompt
        name={s.prompt?.name ?? ''}
        open={s.prompt !== null}
        onSave={() => void s.promptSave()}
        onDiscard={() => s.promptDiscard()}
        onCancel={() => s.promptCancel()}
      />
      <SavePrompt
        name={s.closeRequest?.name ?? ''}
        open={s.closeRequest !== null}
        onSave={() => void s.closeSave()}
        onDiscard={() => s.closeDiscard()}
        onCancel={() => s.closeCancel()}
      />
    </div>
  )
}
