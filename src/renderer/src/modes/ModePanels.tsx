// The navigator, inspector, viewport scene and status-bar part per mode. Without a project every
// mode shows the start panel (New / Open, recovery). Design is built (3.6, modes/design/); plan
// (3.7) and run (3.12) are empty states until theirs exist: a mode without its input says so and
// offers the way there (Plan without a part → Design; Run without a plan → Plan). Mode screens
// use ui/ only. Doc: docs/conventions/ui.md#mode-switching, #panels-and-inspectors
import { ArrowRight } from 'lucide-react'
import type { AppMode } from '../../../core/modes'
import type { ProjectDoc } from '../../../core/project/document'
import { shellMessages } from '../messages/shell'
import { StartPanel } from '../shell/project/StartPanel'
import { EmptyState, PanelHeader } from '../ui'
import { DesignInspector } from './design/DesignInspector'
import { DesignNavigator } from './design/DesignNavigator'
import { DesignStatus } from './design/DesignStatus'
import { designPart } from './design/model'
import { useDesignScene, type SceneProps } from './design/useDesignScene'
import styles from './ModePanels.module.css'

const m = shellMessages.empty

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
  const body = (() => {
    if (doc === undefined) return <StartPanel />
    const parts = Object.values(doc.parts)
    switch (mode) {
      case 'design':
        return <DesignNavigator part={designPart(doc)} units={doc.unitSystem} />
      case 'plan':
        return parts.length === 0 ? (
          <EmptyState
            icon={NavigatorIcon}
            title={m.plan.noPart.title}
            description={m.plan.noPart.description}
            action={{
              label: m.plan.noPart.action,
              icon: <ArrowRight aria-hidden="true" />,
              onClick: () => onMode('design'),
            }}
          />
        ) : (
          <EmptyState icon={NavigatorIcon} {...m.plan.ready} />
        )
      case 'run':
        return Object.keys(doc.plans).length === 0 ? (
          <EmptyState
            icon={NavigatorIcon}
            title={m.run.noPlan.title}
            description={m.run.noPlan.description}
            action={{
              label: m.run.noPlan.action,
              icon: <ArrowRight aria-hidden="true" />,
              onClick: () => onMode('plan'),
            }}
          />
        ) : (
          <EmptyState icon={NavigatorIcon} {...m.run.ready} />
        )
    }
  })()
  return (
    <>
      <PanelHeader title={title} />
      <div className={styles['body']}>{body}</div>
    </>
  )
}

export function ModeInspector({ mode, doc }: Omit<ModePanelProps, 'onMode'>): React.JSX.Element {
  if (mode === 'design' && doc !== undefined) return <DesignInspector part={designPart(doc)} />
  return (
    <>
      <PanelHeader title={shellMessages.regions.inspector} />
      <div className={styles['body']}>
        {doc === undefined ? null : <p className={styles['note']}>{m[mode].inspector}</p>}
      </div>
    </>
  )
}

/** The mode's part of the status bar (design: evaluation status and warning count). */
export function ModeStatus({
  mode,
  doc,
}: Omit<ModePanelProps, 'onMode'>): React.JSX.Element | null {
  if (doc === undefined) return null
  return mode === 'design' ? <DesignStatus /> : null
}

/**
 * The scene of the one shared viewport per mode (ui.md#app-shell: one canvas, the mode decides
 * the scene). Plan (3.7) and run (3.12) show the design part until their scenes exist.
 */
export function useModeScene(mode: AppMode): SceneProps {
  const design = useDesignScene()
  if (mode === 'design') return design
  return { mesh: design.mesh, stock: design.stock ?? null, status: design.status ?? 'done' }
}
