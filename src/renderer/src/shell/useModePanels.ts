// Mode switch of the side panels (DF30): the panels' content follows the mode with a short slide
// (the old mode's content slides out toward the window edge, then the new one slides in), and
// each mode remembers which side panels it shows (`sidePanels` in the settings, written by the
// panel toggles). The toolbar, viewport and dialogs switch at once; only the side panels' content
// lags by --motion-fast. Reduced motion (tokens zero the durations): the content swaps at once.
// Doc: docs/conventions/ui.md#mode-switching (Side panels per mode, DF30)
import { useEffect, useState } from 'react'
import type { AppMode } from '../../../core/modes'
import type { AppSettings } from '../../../shared/settings'
import { motionMs } from '../ui'

/** `out`: the old mode's content leaves; `in`: the new one arrives; null: at rest. */
export type PanelPhase = 'out' | 'in' | null

/** Both side panels show in a mode the user never toggled in. */
export const DEFAULT_SIDE_PANELS = { navigator: true, inspector: true } as const

export function sidePanelsOf(
  settings: Pick<AppSettings, 'sidePanels'>,
  mode: AppMode,
): { navigator: boolean; inspector: boolean } {
  return settings.sidePanels[mode] ?? DEFAULT_SIDE_PANELS
}

/**
 * The mode the side panels show and the slide phase. `onShown` runs when a new mode's content
 * comes in (and at mount): the shell opens or closes the panels for that mode there.
 */
export function useModePanels(
  mode: AppMode,
  onShown: (mode: AppMode) => void,
): {
  panelMode: AppMode
  phase: PanelPhase
  onAnimationEnd: (e: React.AnimationEvent<HTMLElement>) => void
} {
  const [panel, setPanel] = useState<{ mode: AppMode; phase: PanelPhase }>({ mode, phase: null })
  // a new mode: slide out first, or swap at once without motion (state adjusted during render)
  if (panel.mode !== mode && panel.phase !== 'out')
    setPanel(
      motionMs('--motion-fast') > 0 ? { mode: panel.mode, phase: 'out' } : { mode, phase: null },
    )
  useEffect(() => {
    if (panel.phase !== 'out') return
    const t = setTimeout(() => setPanel({ mode, phase: 'in' }), motionMs('--motion-fast'))
    return () => clearTimeout(t)
  }, [panel.phase, mode])
  const shown = panel.mode
  useEffect(() => onShown(shown), [shown]) // only when the shown mode changes
  return {
    panelMode: shown,
    phase: panel.phase,
    onAnimationEnd: (e) => {
      // the side element's own slide only (the content's animations bubble up too)
      if (e.target === e.currentTarget && panel.phase === 'in')
        setPanel((p) => (p.phase === 'in' ? { ...p, phase: null } : p))
    },
  }
}
