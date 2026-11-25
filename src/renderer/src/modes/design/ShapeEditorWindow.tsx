// The Shape Editor window (DF94, one per project): toolbar (undo/redo, the part, the machine group
// with Stop), the part's shape rows ("Shapes": Add shape, Import SVG…, the row menu), the flat view
// of the chosen shape and its inspector. A session bound to the same project as its project
// window: edits are the same `design.shape.*` commands and undo is the project's one history.
// Main tells it which part and shape to show (`shapeEditor.target`, again on every open); the
// view takes the focus then. Keys: Ctrl/Cmd+Z and Shift+Z (Ctrl+Y) undo and redo, F6 cycles
// toolbar, list, view and inspector; other menu items go to the project window (main routes them).
// Doc: docs/conventions/ui.md#shape-editor-window-df94, #shape-editor
import { useEffect, useRef } from 'react'
import type { ShapeEditorTarget } from '../../../../shared/preload-api'
import { designMessages } from '../../messages/design'
import { shapeMessages } from '../../messages/shape'
import { shellMessages } from '../../messages/shell'
import { useHistorySteps } from '../../shell/hooks'
import { isKeyEcho, noteKeyAction } from '../../shell/key-echo'
import { useReplica, useShell, useUi } from '../../shell/ShellContext'
import {
  cycleRegion,
  IS_MAC,
  isEditableTarget,
  REGION_ATTR,
  shortcutLabel,
} from '../../shell/shortcuts'
import {
  ApplyScope,
  EmptyState,
  Icon,
  Toast,
  ToastAnchor,
  ToastRegion,
  Toolbar,
  UndoRedo,
} from '../../ui'
import { MachineToolbar } from '../run'
import { ShapeEditorLayer } from './ShapeEditorView'
import { ShapeInspector } from './ShapeInspector'
import { ShapeList } from './ShapeList'
import styles from './ShapeEditorWindow.module.css'
import { useDesignPart, useDesignSelection } from './useDesign'

const w = shapeMessages.window
const region = { [REGION_ATTR]: '', tabIndex: -1 }
const VIEW_SELECTOR = `[role="region"][aria-label="${shapeMessages.view.region}"]`

/** Follows main's target: the part and shape to show; the view takes the focus on each. */
function useShapeEditorTarget(): void {
  const { bridge, ui } = useShell()
  useEffect(() => {
    let live = true
    let seen = 0
    const apply = (t: ShapeEditorTarget | null, focus: boolean) => {
      if (!live || t === null || t.seq <= seen) return
      seen = t.seq
      const s = ui.getState()
      s.setDesignPart(t.partId)
      if (t.shapeId === null) s.select('design', null)
      else {
        s.selectShapeItem(t.shapeId, 0)
        s.select('design', t.shapeId)
      }
      // after the view for the new shape has rendered
      if (focus)
        requestAnimationFrame(() => document.querySelector<HTMLElement>(VIEW_SELECTOR)?.focus())
    }
    void bridge.shapeEditor.target().then((t) => apply(t, true))
    const off = bridge.shapeEditor.onTarget((t) => apply(t, true))
    return () => {
      live = false
      off()
    }
  }, [bridge, ui])
}

/** Undo / redo from the keys and the Edit menu (text undo in a field); F6 cycles the regions. */
function useShapeEditorKeys(onUndo: () => void, onRedo: () => void): void {
  const { bridge } = useShell()
  const latest = useRef({ onUndo, onRedo })
  useEffect(() => {
    latest.current = { onUndo, onRedo }
  })
  useEffect(() => {
    const offMenu = bridge.menu.onAction((action) => {
      if (isKeyEcho(action)) return
      if (action === 'window.shapeEditor')
        return document.querySelector<HTMLElement>(VIEW_SELECTOR)?.focus()
      if (action !== 'edit.undo' && action !== 'edit.redo') return
      if (isEditableTarget(document.activeElement)) {
        document.execCommand(action === 'edit.undo' ? 'undo' : 'redo')
        return
      }
      if (action === 'edit.undo') latest.current.onUndo()
      else latest.current.onRedo()
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F6' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        cycleRegion(document, e.shiftKey)
        return
      }
      const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!mod || e.altKey || e.defaultPrevented || isEditableTarget(e.target)) return
      const key = e.key.toLowerCase()
      const redo = (key === 'z' && e.shiftKey) || (!IS_MAC && key === 'y' && !e.shiftKey)
      if (key !== 'z' && !redo) return
      e.preventDefault()
      noteKeyAction(redo ? 'edit.redo' : 'edit.undo')
      if (redo) latest.current.onRedo()
      else latest.current.onUndo()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offMenu()
      window.removeEventListener('keydown', onKey)
    }
  }, [bridge])
}

export function ShapeEditorWindow(): React.JSX.Element {
  const { pending } = useShell()
  const replica = useReplica()
  const part = useDesignPart()
  const [selected] = useDesignSelection()
  const history = useHistorySteps()
  const removed = useUi((s) => s.removedToast)
  const setRemovedToast = useUi((s) => s.setRemovedToast)
  const partId = useUi((s) => s.designPart)
  useShapeEditorTarget()
  useShapeEditorKeys(
    () => history.step('undo'),
    () => history.step('redo'),
  )
  const project = replica.status === 'open' ? replica.doc.name : null
  useEffect(() => {
    document.title = w.title(project)
  }, [project])

  // the window's part is the target's; a removed part shows the empty state, not another part
  const shown = part !== undefined && part.dto.id === partId ? part : undefined
  const shape = shown?.dto.shapes?.find((s) => s.id === selected)
  const empty =
    shown === undefined ? (
      <EmptyState
        icon={<Icon name="shapes" />}
        title={replica.status === 'open' ? w.noPart : w.noProject}
        description={w.noPartDescription}
      />
    ) : (
      <EmptyState
        icon={<Icon name="shapes" />}
        title={w.noShape}
        description={w.noShapeDescription}
      />
    )

  return (
    <ApplyScope onApply={() => void pending.apply()}>
      <div className={styles['window']}>
        <header className={styles['toolbar']} aria-label={w.toolbar} {...region}>
          <Toolbar label={w.edit}>
            <UndoRedo
              undo={history.undo}
              redo={history.redo}
              onUndo={() => history.step('undo')}
              onRedo={() => history.step('redo')}
              undoShortcut={shortcutLabel('Z')}
              redoShortcut={shortcutLabel('Z', { shift: true })}
            />
          </Toolbar>
          {shown === undefined ? null : (
            <span className={styles['part']}>{w.part(shown.dto.name)}</span>
          )}
          <span className={styles['spacer']} />
          <div className={styles['machine']}>
            <MachineToolbar />
          </div>
        </header>
        <nav aria-label={w.list} className={styles['list']} {...region}>
          {shown === undefined ? null : (
            <ShapeList
              part={shown}
              onRemoved={(name) => setRemovedToast(shapeMessages.navigator.removed(name))}
              onChosen={() => {}}
            />
          )}
        </nav>
        <main aria-label={w.view} className={styles['view']}>
          {shape === undefined ? <div className={styles['empty']}>{empty}</div> : null}
          <ShapeEditorLayer />
          <ToastAnchor />
        </main>
        <aside
          aria-label={shellMessages.regions.inspector}
          className={styles['inspector']}
          {...region}
        >
          {shown !== undefined && shape !== undefined ? (
            <ShapeInspector key={shape.id} part={shown} shape={shape} />
          ) : null}
        </aside>
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
                label: designMessages.navigator.undo,
                altText: designMessages.navigator.undoAlt,
                onClick: () => {
                  history.step('undo')
                  setRemovedToast(null)
                },
              }}
            />
          ) : null}
        </ToastRegion>
      </div>
    </ApplyScope>
  )
}
