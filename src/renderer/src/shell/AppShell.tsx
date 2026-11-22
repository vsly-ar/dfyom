// The window layout (task 3.3b): main toolbar (undo/redo and mode tools · mode switcher in the
// centre · Apply (P3), machine group, panel toggles and settings), navigator | viewport | inspector in resizable, collapsible
// panels, the Library window and settings), status bar. Below 1280 px the inspector overlays the viewport instead of shrinking it.
// Landmarks: banner, navigation (modes, navigator), main (viewport), complementary (inspector),
// contentinfo (status bar); F6 cycles them. Doc: docs/conventions/ui.md#app-shell
import { Library, PanelLeft, PanelRight, Settings } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppMode } from '../../../core/modes'
import { shellMessages as m } from '../messages/shell'
import { ModeInspector, ModeNavigator } from '../modes/ModePanels'
import { MachineToolbar } from '../modes/run'
import {
  ApplyScope,
  ModeSwitcher,
  Panel,
  PanelGroup,
  PanelResizeHandle,
  Toolbar,
  ToolbarButton,
  ToolbarSeparator,
  UndoRedo,
  usePanelRef,
  type PanelGroupLayout,
} from '../ui'
import { ApplyControl } from './ApplyControl'
import styles from './AppShell.module.css'
import { CloseProjectDialog } from './CloseProjectDialog'
import { useHistorySteps, useMediaQuery, useWindowTitle } from './hooks'
import { SettingsDialog } from './SettingsDialog'
import { useReplica, useSettings, useShell, useUi } from './ShellContext'
import { REGION_ATTR, shortcutLabel, useShellShortcuts } from './shortcuts'
import { StatusBar } from './StatusBar'
import { ProjectDialogs } from './project/ProjectDialogs'
import { ShellViewport } from './ShellViewport'
import { ShortcutsDialog } from './ShortcutsDialog'
import { useAppCommands } from './useAppCommands'

/** Below this width the inspector overlays the viewport (ui.md#app-shell). */
export const WIDE_QUERY = '(min-width: 1280px)'
/** Saved layouts wait this long after the last resize. */
const LAYOUT_SAVE_MS = 400

/** F6 target: marked, and focusable itself when it has no control yet. */
const region = { [REGION_ATTR]: '', tabIndex: -1 }

export function AppShell(): React.JSX.Element {
  const { settings, pending, bridge } = useShell()
  const replica = useReplica()
  const doc = replica.status === 'open' ? replica.doc : undefined
  const mode = useUi((s) => s.mode)
  const setMode = useUi((s) => s.setMode)
  const openSettings = useUi((s) => s.setSettingsOpen)
  const layouts = useSettings((s) => s.settings.layouts)
  const history = useHistorySteps()
  const wide = useMediaQuery(WIDE_QUERY)
  useWindowTitle()
  useShellShortcuts({
    onMode: setMode,
    onUndo: () => history.step('undo'),
    onRedo: () => history.step('redo'),
  })

  const navigator = usePanelRef()
  const inspector = usePanelRef()
  const [navOpen, setNavOpen] = useState(true)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  // narrow windows: the overlaid inspector starts closed and is opened on demand
  const [overlayOpen, setOverlayOpen] = useState(false)
  // its width: the view cube and its toolbar move left beside it (ui-view-cube.md § Rendering)
  const [overlayWidth, overlayRef] = useWidth()

  // Save a layout the user made (drag, keyboard, toggles), not the one restored at mount; wide
  // and narrow windows keep their own (different panel sets).
  const groupId = wide ? 'shell-wide' : 'shell-narrow'
  const userLayout = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(saveTimer.current), [])
  const onLayoutChanged = useCallback(
    (layout: PanelGroupLayout, byUser: boolean) => {
      if (!byUser && !userLayout.current) return
      userLayout.current = false
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(
        () => settings.getState().update({ layouts: { [groupId]: layout } }),
        LAYOUT_SAVE_MS,
      )
    },
    [settings, groupId],
  )
  const toggle = (ref: typeof navigator, open: boolean) => {
    userLayout.current = true
    if (open) ref.current?.collapse()
    else ref.current?.expand()
  }

  const onMode = (next: AppMode) => setMode(next)
  // Enter in a field, Cmd/Ctrl+Enter, Edit → Apply changes and the button (apply.md#ui)
  const apply = useCallback(() => void pending.apply(), [pending])
  // native menu items and the file shortcuts (task 3.6)
  useAppCommands({
    onMode: setMode,
    onUndo: () => history.step('undo'),
    onRedo: () => history.step('redo'),
    onToggleNavigator: () => toggle(navigator, navOpen),
    onToggleInspector: () => (wide ? toggle(inspector, inspectorOpen) : setOverlayOpen((o) => !o)),
    onApply: apply,
  })
  const inspectorShown = wide ? inspectorOpen : overlayOpen
  const inspectorContent = <ModeInspector mode={mode} doc={doc} />

  return (
    <ApplyScope onApply={apply}>
      <div className={styles['shell']}>
        <header className={styles['toolbar']} aria-label={m.regions.toolbar} {...region}>
          <div className={styles['toolbarStart']}>
            <Toolbar label="Edit">
              <UndoRedo
                undo={history.undo}
                redo={history.redo}
                onUndo={() => history.step('undo')}
                onRedo={() => history.step('redo')}
                undoShortcut={shortcutLabel('Z')}
                redoShortcut={shortcutLabel('Z', { shift: true })}
              />
            </Toolbar>
          </div>
          <nav aria-label="Modes" className={styles['modes']}>
            <ModeSwitcher value={mode} onValueChange={onMode} />
          </nav>
          <div className={styles['toolbarEnd']}>
            {/* first in the end column: appearing never moves the controls to its right */}
            <ApplyControl />
            <MachineToolbar />
            <Toolbar label="Window">
              <ToolbarButton
                label={m.toggles.navigator}
                icon={<PanelLeft aria-hidden="true" />}
                pressed={navOpen}
                onClick={() => toggle(navigator, navOpen)}
              />
              <ToolbarButton
                label={m.toggles.inspector}
                icon={<PanelRight aria-hidden="true" />}
                pressed={inspectorShown}
                onClick={() =>
                  wide ? toggle(inspector, inspectorOpen) : setOverlayOpen((o) => !o)
                }
              />
              <ToolbarSeparator />
              {/* the Library window (ui-library-window.md L2); Window → Library in the menu */}
              <ToolbarButton
                label={m.library}
                shortcut={shortcutLabel('L', { shift: true })}
                icon={<Library aria-hidden="true" />}
                onClick={() => void bridge.library.open()}
              />
              <ToolbarButton
                label={m.settings}
                shortcut={shortcutLabel(',')}
                icon={<Settings aria-hidden="true" />}
                onClick={() => openSettings(true)}
              />
            </Toolbar>
          </div>
        </header>

        <div className={styles['workspace']}>
          {/* one group across widths, so the viewport is never remounted (no WebGL churn) */}
          <PanelGroup id="shell" defaultLayout={layouts[groupId]} onLayoutChanged={onLayoutChanged}>
            <Panel
              id="navigator"
              defaultSize="16rem"
              minSize="12rem"
              maxSize="40%"
              collapsible
              fixedOnResize
              panelRef={navigator}
              onCollapsedChange={(c) => setNavOpen(!c)}
            >
              <nav
                aria-label={m.regions.navigator}
                className={styles['side']}
                {...region}
                {...(navOpen ? {} : { 'data-collapsed': '' })}
              >
                <ModeNavigator mode={mode} doc={doc} onMode={onMode} />
              </nav>
            </Panel>
            <PanelResizeHandle label={m.resize.navigator} />
            <Panel id="viewport" minSize="20rem">
              <main aria-label={m.regions.viewport} className={styles['viewport']} {...region}>
                <ShellViewport mode={mode} insetRight={!wide && overlayOpen ? overlayWidth : 0} />
              </main>
            </Panel>
            {wide ? (
              <>
                <PanelResizeHandle label={m.resize.inspector} />
                <Panel
                  id="inspector"
                  defaultSize="20rem"
                  minSize="15rem"
                  maxSize="45%"
                  collapsible
                  fixedOnResize
                  panelRef={inspector}
                  onCollapsedChange={(c) => setInspectorOpen(!c)}
                >
                  <aside
                    aria-label={m.regions.inspector}
                    className={styles['side']}
                    {...region}
                    {...(inspectorOpen ? {} : { 'data-collapsed': '' })}
                  >
                    {inspectorContent}
                  </aside>
                </Panel>
              </>
            ) : null}
          </PanelGroup>
          {!wide && overlayOpen ? (
            <aside
              ref={overlayRef}
              aria-label={m.regions.inspector}
              className={[styles['side'], styles['overlay']].join(' ')}
              {...region}
            >
              {inspectorContent}
            </aside>
          ) : null}
        </div>

        <footer className={styles['status']} aria-label={m.regions.statusBar} {...region}>
          <StatusBar />
        </footer>

        <SettingsDialog />
        <CloseProjectDialog />
        <ProjectDialogs />
        <ShortcutsDialog />
      </div>
    </ApplyScope>
  )
}

/** An element's border-box width, followed with a ResizeObserver; 0 while it is not mounted. */
function useWidth(): [number, (el: HTMLElement | null) => (() => void) | undefined] {
  const [width, setWidth] = useState(0)
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return undefined
    const read = (): void => setWidth(el.offsetWidth)
    read()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(read)
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      setWidth(0)
    }
  }, [])
  return [width, ref]
}
