// App-wide UI context: tooltip timing, the portal container overlays render into, and theme
// scopes. Doc: docs/conventions/ui.md#radix-wrapping-pattern
import { Tooltip } from 'radix-ui'
import { createContext, useContext, useState, type ReactNode } from 'react'

/** `--delay-tooltip` (tokens.css); Radix takes it as a number. */
export const TOOLTIP_DELAY_MS = 450

const PortalContainerContext = createContext<HTMLElement | null>(null)

/**
 * Where overlays (tooltips, popovers, menus, dialogs) portal to. `null` = `document.body`,
 * which inherits the root's `data-theme`; a `ThemeScope` provides its own element instead.
 */
export function usePortalContainer(): HTMLElement | null {
  return useContext(PortalContainerContext)
}

/** Wrap the app (and component tests) once. */
export function UiProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return <Tooltip.Provider delayDuration={TOOLTIP_DELAY_MS}>{children}</Tooltip.Provider>
}

export interface ThemeScopeProps {
  theme: 'light' | 'dark'
  children: ReactNode
  className?: string | undefined
}

/**
 * Applies a theme to a subtree (`.t-light` / `.t-dark`, tokens.css) and makes overlays opened
 * inside it portal into it, so they keep the theme. Used by the gallery.
 */
export function ThemeScope({ theme, children, className }: ThemeScopeProps): React.JSX.Element {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  return (
    <div ref={setEl} className={[`t-${theme}`, className].filter(Boolean).join(' ')}>
      <PortalContainerContext.Provider value={el}>{children}</PortalContainerContext.Provider>
    </div>
  )
}

/** Portal container override for a subtree (e.g. a gallery stage that contains fixed overlays). */
export function PortalContainer({
  container,
  children,
}: {
  container: HTMLElement | null
  children: ReactNode
}): React.JSX.Element {
  return (
    <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>
  )
}
