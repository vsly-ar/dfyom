// The window's app commands from the native menu and the keyboard (task 3.6): New / Open / Save /
// Save as (Ctrl/Cmd+N, O, S, Shift+S), undo/redo, modes, panel toggles and the shortcut list
// (`?`). Menu items and keys run the same handlers as the buttons. A key the window handled is not
// run again when the menu's accelerator reports it too (platforms differ in who sees it first).
// Doc: docs/conventions/ui.md#app-shell, #keyboard-shortcuts
import { useEffect, useRef } from 'react'
import type { AppMode } from '../../../core/modes'
import type { MenuAction } from '../../../shared/preload-api'
import { isKeyEcho, noteKeyAction } from './key-echo'
import { useShell } from './ShellContext'
import { IS_MAC, isEditableTarget } from './shortcuts'

export interface AppCommandHandlers {
  onMode(mode: AppMode): void
  onUndo(): void
  onRedo(): void
  onToggleNavigator(): void
  onToggleInspector(): void
}

export function useAppCommands(handlers: AppCommandHandlers): void {
  const { bridge, files, ui } = useShell()
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
      }
    }
    const offMenu = bridge.menu.onAction((action) => {
      if (!isKeyEcho(action)) run(action)
    })

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
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
      window.removeEventListener('keydown', onKey)
    }
  }, [bridge, files, ui])
}
