// Panel, PanelGroup, PanelResizeHandle, PanelHeader: resizable, collapsible shell regions on
// react-resizable-panels (decision 13). Panels are flat and bordered (no shadow); a hairline
// separator with a wider hit area turns amber while dragged. Only ui/ imports the library.
// Doc: docs/conventions/ui.md#app-shell, #inventory-v01
import {
  Group,
  Panel as RrpPanel,
  Separator,
  usePanelRef,
  type Layout,
  type PanelImperativeHandle,
} from 'react-resizable-panels'
import { useRef, type ReactNode, type Ref } from 'react'
import styles from './Panel.module.css'

export { usePanelRef }
/** Imperative API of a panel: `collapse()`, `expand()`, `isCollapsed()`, `resize(size)`. */
export type PanelHandle = PanelImperativeHandle
/** Panel id → size in % of the group. */
export type PanelGroupLayout = Layout

export interface PanelGroupProps {
  /** Unique id; also the key the layout is saved under. */
  id: string
  children: ReactNode
  orientation?: 'horizontal' | 'vertical'
  /** Layout to start from (a saved one); panels fall back to their `defaultSize`. */
  defaultLayout?: PanelGroupLayout | undefined
  /** After a resize ends (pointer released, key pressed, collapse/expand). */
  onLayoutChanged?: (layout: PanelGroupLayout, byUser: boolean) => void
  className?: string | undefined
}

export function PanelGroup({
  id,
  children,
  orientation = 'horizontal',
  defaultLayout,
  onLayoutChanged,
  className,
}: PanelGroupProps): React.JSX.Element {
  return (
    <Group
      id={id}
      orientation={orientation}
      {...(defaultLayout ? { defaultLayout } : {})}
      {...(onLayoutChanged
        ? {
            onLayoutChanged: (layout: Layout, meta: { isUserInteraction: boolean }) =>
              onLayoutChanged(layout, meta.isUserInteraction),
          }
        : {})}
      className={[styles['group'], className].filter(Boolean).join(' ')}
    >
      {children}
    </Group>
  )
}

/** Sizes: number = px, string = % ("20") or with a unit ("16rem"). */
type Size = number | string

export interface PanelProps {
  id: string
  children: ReactNode
  defaultSize?: Size
  minSize?: Size
  maxSize?: Size
  /** Collapses when dragged below `minSize` (and by `collapse()`). */
  collapsible?: boolean
  panelRef?: Ref<PanelHandle | null>
  /** Called when the panel collapses or expands (drag, keyboard or the imperative API). */
  onCollapsedChange?: (collapsed: boolean) => void
  /** Keep the size in px when the window resizes (side panels); default: keep the %. */
  fixedOnResize?: boolean
  className?: string | undefined
}

export function Panel({
  id,
  children,
  defaultSize,
  minSize,
  maxSize,
  collapsible = false,
  panelRef,
  onCollapsedChange,
  fixedOnResize = false,
  className,
}: PanelProps): React.JSX.Element {
  const collapsed = useRef<boolean | undefined>(undefined)
  return (
    <RrpPanel
      id={id}
      {...(defaultSize !== undefined ? { defaultSize } : {})}
      {...(minSize !== undefined ? { minSize } : {})}
      {...(maxSize !== undefined ? { maxSize } : {})}
      collapsible={collapsible}
      {...(panelRef ? { panelRef } : {})}
      groupResizeBehavior={fixedOnResize ? 'preserve-pixel-size' : 'preserve-relative-size'}
      onResize={(size) => {
        const now = size.asPercentage === 0
        if (collapsed.current !== now) {
          collapsed.current = now
          onCollapsedChange?.(now)
        }
      }}
      className={[styles['panel'], className].filter(Boolean).join(' ')}
    >
      {children}
    </RrpPanel>
  )
}

export interface PanelResizeHandleProps {
  /** Accessible name ("Resize navigator"). */
  label: string
  className?: string | undefined
}

/** Keyboard: focus it, then arrow keys resize; Enter collapses/expands a collapsible neighbour. */
export function PanelResizeHandle({ label, className }: PanelResizeHandleProps): React.JSX.Element {
  return (
    <Separator
      aria-label={label}
      className={[styles['handle'], className].filter(Boolean).join(' ')}
    />
  )
}

export interface PanelHeaderProps {
  /** Panel title, shown as an eyebrow ("Operations"). */
  title: string
  /** Muted count or note after the title ("5"); never the item's id (use `itemId`). */
  meta?: ReactNode
  /**
   * The shown item's id (`chamfer1`): not shown, but the heading's tooltip ("Id: chamfer1") and
   * `data-item-id`, for agents and assistive tech (ui.md#panels-and-inspectors, D45).
   */
  itemId?: string | undefined
  /** Icon buttons at the end. */
  actions?: ReactNode
  /** Heading level within the page outline. */
  headingLevel?: 2 | 3
}

export function PanelHeader({
  title,
  meta,
  itemId,
  actions,
  headingLevel = 2,
}: PanelHeaderProps): React.JSX.Element {
  const Heading = `h${headingLevel}` as const
  return (
    <div className={styles['header']}>
      <Heading
        className={styles['title']}
        {...(itemId !== undefined ? { title: `Id: ${itemId}`, 'data-item-id': itemId } : {})}
      >
        {title}
      </Heading>
      {meta !== undefined ? <span className={styles['meta']}>{meta}</span> : null}
      {actions ? <span className={styles['actions']}>{actions}</span> : null}
    </div>
  )
}
