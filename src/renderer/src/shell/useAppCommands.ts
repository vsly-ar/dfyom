// The window's app commands from the native menu and the keyboard (task 3.6): New / Open / Save /
// Save as (Ctrl/Cmd+N, O, S, Shift+S), undo/redo, modes, panel toggles, the shortcut list (`?`)
// Apply (Ctrl/Cmd+Enter, task P3), Settings (Ctrl/Cmd+,), Help → Connect an agent… (A4), Window →
// Shape Editor (DF94: the project's Shape Editor window on the shown part) and files
// handed over by main to open (U5). Menu items and keys run the same handlers as the buttons. A key the window handled is not
// run again when the menu's accelerator reports it too (platforms differ in who sees it first).
// Doc: docs/conventions/ui.md#app-shell, #keyboard-shortcuts
import { useEffect, useRef } from 'react'
import type { AppMode } from '../../../core/modes'
import type { MenuAction } from '../../../shared/preload-api'
import { isKeyEcho, noteKeyAction } from './key-echo'
import { modalDialogOpen } from '../ui'
import { designPart } from '../modes/design/model'
import { useShell } from './ShellContext'
import { IS_MAC, isEditableTarget } from './shortcuts'

export interface AppCommandHandlers {
  onMode(mode: AppMode): void
  onUndo(): void
  onRedo(): void
  onToggleNavigator(): void
  onToggleInspector(): void
  /** Cmd/Ctrl+Enter and Edit → Apply changes (task P3). */
  onApply(): void
}

export function useAppCommands(handlers: AppCommandHandlers): void {
  const { bridge, files, ui, replica } = useShell()
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })

  useEffect(() => {
    const run = (action: MenuAction): void => {
      const h = latest.current
      const f = files.getState()
      switch (action) {
        case 'project.new':
          return f.newProject()
        case 'project.open':
          return void f.open()
        case 'project.save':
          return void f.save()
        case 'project.saveAs':
          return void f.saveAs()
        case 'edit.undo':
        case 'edit.redo':
          // in a text field the menu edits the text, as the keys do there (ui.md#undo-and-redo)
          if (isEditableTarget(document.activeElement)) {
            document.execCommand(action === 'edit.undo' ? 'undo' : 'redo')
            return
          }
          return action === 'edit.undo' ? h.onUndo() : h.onRedo()
        case 'mode.design':
        case 'mode.plan':
        case 'mode.run':
          return h.onMode(action.slice(5) as AppMode)
        case 'view.navigator':
          return h.onToggleNavigator()
        case 'view.inspector':
          return h.onToggleInspector()
        case 'help.shortcuts':
          return ui.getState().setShortcutsOpen(true)
        case 'help.connectAgent':
          return ui.getState().setConnectAgentOpen(true)
        case 'app.settings':
          return ui.getState().setSettingsOpen(true)
        case 'window.shapeEditor': {
          // the shown part; main reopens the last shape of the project, if any (DF94)
          const state = replica.getState()
          if (state.status !== 'open') return
          const part = designPart(state.doc, ui.getState().designPart)
          if (part !== undefined)
            void bridge.shapeEditor.open({ partId: part.dto.id, shapeId: null })
          return
        }
        case 'project.apply': {
          // inactive while a modal dialog is open (apply.md#keyboard)
          if (modalDialogOpen()) return
          // the menu took the key from a field: commit its text first (blur), as Enter would
          const field = document.activeElement
          if (field instanceof HTMLElement && isEditableTarget(field)) {
            field.blur()
            field.focus()
          }
          return h.onApply()
        }
      }
    }
    const offMenu = bridge.menu.onAction((action) => {
      if (!isKeyEcho(action)) run(action)
    })
    // Files from Finder, launch arguments or a second launch (ui.md#project-files, U5) take File →
    // Open's own path, one after the other: each sees the window as the one before left it.
    let opening: Promise<void> = Promise.resolve()
    const offOpenFile = bridge.window.onOpenFile((file) => {
      opening = opening.then(() => files.getState().openFile(file))
    })

    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      // Cmd/Ctrl+Enter anywhere = Apply; a field already applied it with its commit (it
      // prevented the default), so only the menu's echo is noted then
      if (mod && !e.altKey && !e.shiftKey && e.key === 'Enter') {
        noteKeyAction('project.apply')
        if (e.defaultPrevented) return
        e.preventDefault()
        run('project.apply')
        return
      }
      if (e.defaultPrevented) return
      if (mod && !e.altKey) {
        const key = e.key.toLowerCase()
        const action: MenuAction | undefined =
          key === 'n' && !e.shiftKey
            ? 'project.new'
            : key === 'o' && !e.shiftKey
              ? 'project.open'
              : key === 's'
                ? e.shiftKey
                  ? 'project.saveAs'
                  : 'project.save'
                : key === ',' && !e.shiftKey
                  ? 'app.settings'
                  : undefined
        if (action === undefined) return
        e.preventDefault()
        noteKeyAction(action)
        run(action)
        return
      }
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditableTarget(e.target)) {
        e.preventDefault()
        noteKeyAction('help.shortcuts')
        run('help.shortcuts')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offMenu()
      offOpenFile()
      window.removeEventListener('keydown', onKey)
    }
  }, [bridge, files, ui, replica])
}
