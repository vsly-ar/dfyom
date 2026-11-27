// The window layout (task 3.3b): main toolbar (File: New / Open / Save, DF14; undo/redo and mode tools – design's part setup, D45 – · mode switcher in the
// centre · Apply (P3), machine group, panel toggles and settings), navigator | viewport | inspector in resizable, collapsible
// panels, the Library window and settings), status bar. Below 1280 px the inspector overlays the viewport instead of shrinking it.
// Landmarks: banner, navigation (modes, navigator), main (viewport), complementary (inspector),
// contentinfo (status bar); F6 cycles them. Doc: docs/conventions/ui.md#app-shell
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppMode } from '../../../core/modes'
import { shellMessages as m } from '../messages/shell'
import { snapMessages } from '../messages/snap'
import { ModeDialogs, ModeInspector, ModeNavigator, ModeTools } from '../modes/ModePanels'
import { MachineToolbar } from '../modes/run'
import {
  Icon,
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
import { isDirty } from '../state/replica'
import { useReplica, useSettings, useShell, useUi } from './ShellContext'
import { REGION_ATTR, shortcutLabel, useShellShortcuts } from './shortcuts'
import { StatusBar } from './StatusBar'
import { ProjectDialogs } from './project/ProjectDialogs'
import { ShellViewport } from './ShellViewport'
import { ShortcutsDialog } from './ShortcutsDialog'
import { ConnectAgentDialog } from './ConnectAgentDialog'
import { useAppCommands } from './useAppCommands'
import { sidePanelsOf, useModePanels } from './useModePanels'

/** Below this width the inspector overlays the viewport (ui.md#app-shell). */
export const WIDE_QUERY = '(min-width: 1280px)'
/**
 * The side panels' minimum widths (hardening DF140, measured in the app, ui.md#app-shell): the
 * navigator holds Run's jog pad (172 px) inside its padding; the inspector holds Run's Position
 * table with three-digit coordinates in both columns, "=0" and "→0" (248 px, plus 8 px slack).
 * Design's and Plan's panels lay out narrower than both.
 */
export const SIDE_MIN = { navigator: '12rem', inspector: '16rem' } as const
/** Saved layouts wait this long after the last resize. */
const LAYOUT_SAVE_MS = 400

/** F6 target: marked, and focusable itself when it has no control yet. */
const region = { [REGION_ATTR]: '', tabIndex: -1 }

export function AppShell(): React.JSX.Element {
  const { settings, pending, bridge, files } = useShell()
  const replica = useReplica()
  const doc = replica.status === 'open' ? replica.doc : undefined
  const dirty = replica.status === 'open' && isDirty(replica)
  const mode = useUi((s) => s.mode)
  const setMode = useUi((s) => s.setMode)
  const openSettings = useUi((s) => s.setSettingsOpen)
  const layouts = useSettings((s) => s.settings.layouts)
  const measuring = useUi((s) => s.measuring)
  const setMeasuring = useUi((s) => s.setMeasuring)
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
    // remembered for this mode (DF30); the narrow window's inspector overlay is not a panel
    const current = sidePanelsOf(settings.getState().settings, mode)
    const side = ref === navigator ? 'navigator' : 'inspector'
    settings.getState().update({ sidePanels: { [mode]: { ...current, [side]: !open } } })
  }
  // the side panels' content follows the mode with a slide, and each mode opens its panels (DF30)
  const { panelMode, phase, onAnimationEnd } = useModePanels(mode, (shown) => {
    const want = sidePanelsOf(settings.getState().settings, shown)
    const apply = (ref: typeof navigator, open: boolean) => {
      const collapsed = ref.current?.isCollapsed()
      if (collapsed === undefined) return
      if (open && collapsed) ref.current?.expand()
      else if (!open && !collapsed) ref.current?.collapse()
    }
    apply(navigator, want.navigator)
    if (wide) apply(inspector, want.inspector)
  })
  const slide = (side: 'navigator' | 'inspector') => ({
    'data-side': side,
    ...(phase === null ? {} : { 'data-phase': phase }),
    onAnimationEnd,
  })
  // a panel that lives in the inspector opened (the Reference panel, ui.md § Reference panel):
  // show a collapsed inspector or the narrow window's overlay
  const inspectorRequest = useUi((s) => s.inspectorRequest)
  const [seenRequest, setSeenRequest] = useState(inspectorRequest)
  if (inspectorRequest !== seenRequest) {
    setSeenRequest(inspectorRequest)
    if (!wide) setOverlayOpen(true)
  }
  const expandedFor = useRef(inspectorRequest)
  useEffect(() => {
    if (inspectorRequest === expandedFor.current) return
    expandedFor.current = inspectorRequest
    if (wide && inspector.current?.isCollapsed()) inspector.current.expand()
  }, [inspectorRequest, wide, inspector])

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
  const inspectorContent = <ModeInspector mode={panelMode} doc={doc} />

  return (
    <ApplyScope onApply={apply}>
      <div className={styles['shell']}>
        <header className={styles['toolbar']} aria-label={m.regions.toolbar} {...region}>
          <div className={styles['toolbarStart']}>
            {/* the File menu's New / Open / Save, same handlers and shortcuts (DF14) */}
            <Toolbar label={m.file.toolbar}>
              <ToolbarButton
                label={m.file.newProject}
                shortcut={shortcutLabel('N')}
                icon={<Icon name="file-new" />}
                onClick={() => files.getState().newProject()}
              />
              <ToolbarButton
                label={m.file.open}
                shortcut={shortcutLabel('O')}
                icon={<Icon name="open" />}
                onClick={() => void files.getState().open()}
              />
              <ToolbarButton
                label={dirty ? m.file.saveDirty : m.file.save}
                shortcut={shortcutLabel('S')}
                icon={
                  <span className={styles['saveIcon']} data-dirty={dirty || undefined}>
                    <Icon name="save" />
                  </span>
                }
                disabled={doc === undefined}
                onClick={() => void files.getState().save()}
              />
            </Toolbar>
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
            <ModeTools mode={mode} doc={doc} />
            {/* the viewport's tools (DF19): Measure, not in Run */}
            {mode === 'run' ? null : (
              <Toolbar label={m.viewTools}>
                <ToolbarButton
                  label={snapMessages.measure.tool}
                  shortcut="D"
                  icon={<Icon name="measure" />}
                  pressed={measuring}
                  // nothing to measure without a project (DF48)
                  disabled={doc === undefined}
                  onClick={() => setMeasuring(!measuring)}
                />
              </Toolbar>
            )}
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
                icon={<Icon name="panel-left" />}
                pressed={navOpen}
                onClick={() => toggle(navigator, navOpen)}
              />
              <ToolbarButton
                label={m.toggles.inspector}
                icon={<Icon name="panel-right" />}
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
                icon={<Icon name="library" />}
                onClick={() => void bridge.library.open()}
              />
              <ToolbarButton
                label={m.settings}
                shortcut={shortcutLabel(',')}
                icon={<Icon name="settings" />}
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
              minSize={SIDE_MIN.navigator}
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
                {...slide('navigator')}
              >
                <ModeNavigator mode={panelMode} doc={doc} onMode={onMode} />
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
                  minSize={SIDE_MIN.inspector}
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
                    {...slide('inspector')}
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
              {...slide('inspector')}
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
        <ConnectAgentDialog />
        <ModeDialogs mode={mode} doc={doc} />
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
