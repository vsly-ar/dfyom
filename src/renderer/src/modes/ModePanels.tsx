// The navigator, inspector, viewport scene and status-bar part per mode. Without a project Design
// and Plan show the start panel (New / Open, recovery); Run is manual machine control (DF80). Design (3.6, modes/design/), plan (3.7,
// modes/plan/) and run (3.12, modes/run/); a mode without its input says so and offers the way
// there (Plan without a part → Design; Run without a plan → Plan). Mode screens use ui/ only. Doc: docs/conventions/ui.md#mode-switching, #panels-and-inspectors
import type { AppMode } from '../../../core/modes'
import type { ProjectDoc } from '../../../core/project/document'
import { shellMessages } from '../messages/shell'
import { StartPanel } from '../shell/project/StartPanel'
import { Icon, EmptyState, PanelHeader } from '../ui'
import { DesignInspector } from './design/DesignInspector'
import { DesignNavigator } from './design/DesignNavigator'
import { DesignStatus } from './design/DesignStatus'
import { PartSetupDialogs, PartSetupTools } from './design/PartSetupDialogs'
import { useDesignPartOf } from './design/useDesign'
import { useDesignScene, type SceneProps } from './design/useDesignScene'
import styles from './ModePanels.module.css'
import {
  PlanInspector,
  PlanNavigator,
  PlanStatus,
  usePlanDeviationScene,
  usePlanPartScene,
  usePlanScene,
} from './plan'
import { JogHotkeys, RunInspector, RunNavigator, useRunScene } from './run'

const m = shellMessages.empty

/** Design's navigator and inspector show the window's part (split parts S0: the part menu's choice). */
function DesignNavigatorOf({ doc }: { doc: ProjectDoc }): React.JSX.Element {
  return <DesignNavigator part={useDesignPartOf(doc)} />
}

function DesignInspectorOf({ doc }: { doc: ProjectDoc }): React.JSX.Element {
  return <DesignInspector part={useDesignPartOf(doc)} />
}

export interface ModePanelProps {
  mode: AppMode
  /** The replica's document; `undefined` without a project. */
  doc: ProjectDoc | undefined
  onMode: (mode: AppMode) => void
}

const NavigatorIcon = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="2.5" y="3.5" width="11" height="9" rx="2" />
    <path data-accent="" d="M5.5 8h5M8 5.5v5" />
  </svg>
)

export function ModeNavigator({ mode, doc, onMode }: ModePanelProps): React.JSX.Element {
  const title = shellMessages.modes[mode]
  // run mode UI (3.12): without a plan it is manual control (DF31), also without a project (DF80)
  if (mode === 'run')
    return (
      <>
        <PanelHeader title={title} />
        <RunNavigator doc={doc} />
      </>
    )
  const body = (() => {
    if (doc === undefined) return <StartPanel />
    const parts = Object.values(doc.parts)
    switch (mode) {
      case 'design':
        return <DesignNavigatorOf doc={doc} />
      case 'plan':
        return parts.length === 0 ? (
          <EmptyState
            icon={NavigatorIcon}
            title={m.plan.noPart.title}
            description={m.plan.noPart.description}
            action={{
              label: m.plan.noPart.action,
              icon: <Icon name="arrow-right" />,
              onClick: () => onMode('design'),
            }}
          />
        ) : (
          <PlanNavigator doc={doc} />
        )
    }
  })()
  return (
    <>
      {/* design with a project starts with its Operations header (D45): no mode eyebrow */}
      {mode === 'design' && doc !== undefined ? null : <PanelHeader title={title} />}
      <div className={styles['body']}>{body}</div>
    </>
  )
}

/** The mode's tools in the main toolbar after undo/redo (design: the part-setup group, D45). */
export function ModeTools({ mode, doc }: Omit<ModePanelProps, 'onMode'>): React.JSX.Element | null {
  return mode === 'design' && doc !== undefined ? <PartSetupTools doc={doc} /> : null
}

/** The mode's dialogs, kept mounted with the shell (design: the part-setup dialogs, D45). */
export function ModeDialogs({
  mode,
  doc,
}: Omit<ModePanelProps, 'onMode'>): React.JSX.Element | null {
  return (
    <>
      {doc === undefined ? null : <PartSetupDialogs doc={doc} active={mode === 'design'} />}
      {/* DF88: jog hotkeys work in Run mode whichever panels are shown */}
      {mode === 'run' ? <JogHotkeys doc={doc} /> : null}
    </>
  )
}

export function ModeInspector({ mode, doc }: Omit<ModePanelProps, 'onMode'>): React.JSX.Element {
  if (mode === 'design' && doc !== undefined) return <DesignInspectorOf doc={doc} />
  if (mode === 'plan' && doc !== undefined && Object.keys(doc.parts).length > 0)
    return <PlanInspector doc={doc} />
  if (mode === 'run') return <RunInspector doc={doc} />
  return (
    <>
      <PanelHeader title={shellMessages.regions.inspector} />
      <div className={styles['body']}>
        <p className={styles['note']}>{doc === undefined ? m.noProject : m[mode].inspector}</p>
      </div>
    </>
  )
}

/** The mode's part of the status bar (design: evaluation status and warning count; plan: checks). */
export function ModeStatus({
  mode,
  doc,
}: Omit<ModePanelProps, 'onMode'>): React.JSX.Element | null {
  if (doc === undefined) return null
  if (mode === 'plan') return Object.keys(doc.parts).length > 0 ? <PlanStatus doc={doc} /> : null
  return mode === 'design' ? <DesignStatus /> : null
}

/**
 * The scene of the one shared viewport per mode (ui.md#app-shell: one canvas, the mode decides
 * the scene). Run (3.12) adds its toolpath playback, tool marker and work zero (`run`); plan
 * (3.7) the plan's toolpaths and work zero on the same layer, without playback, over the plan's
 * own part (snapshot scene, E3b).
 */
export function useModeScene(mode: AppMode): SceneProps {
  const design = useDesignScene()
  const run = useRunScene(mode)
  const plan = usePlanScene(mode)
  const planPart = usePlanPartScene(mode)
  const deviation = usePlanDeviationScene(mode)
  if (mode === 'design') return design
  const base = { mesh: design.mesh, stock: design.stock ?? null, status: design.status ?? 'done' }
  if (mode === 'run') return { ...base, run }
  // snapshot scene (E3b): the plan's own part on its stock copy, edited operations tinted; the
  // deviation panel's chosen region marked and framed (U4 follow-up)
  return { ...(planPart ?? base), run: plan, ...deviation }
}
