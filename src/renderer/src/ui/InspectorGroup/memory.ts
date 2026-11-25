// Remembered inspector chrome state and the reveal event (DF110). Accordions, More rows and tabs
// keep their open state / selected tab per inspector kind and group id (`pocket.corners`,
// `plan.op`) across selections and launches: the shell backs this with the app settings
// (`inspectorGroups`, `inspectorTabs`); without a shell (component tests, gallery) a module-level
// memory for this window's session. A field that must be shown (a message's target, a pick)
// is revealed with `revealInInspector`: every closed accordion, More row and tab around it opens.
// Doc: docs/conventions/inspector-layout.md#inspector-structure-df110
import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

export interface InspectorMemory {
  /** Open state of an accordion or More row by key; undefined = never toggled. */
  group(key: string): boolean | undefined
  setGroup(key: string, open: boolean): void
  /** Selected tab of a tab set by key; undefined = never chosen. */
  tab(key: string): string | undefined
  setTab(key: string, value: string): void
  /** Calls back on any change; returns the stop function. */
  subscribe(onChange: () => void): () => void
}

/** A memory over two plain records and a change signal (the shell's settings, the fallback). */
export function inspectorMemory(store: {
  groups: () => Readonly<Record<string, boolean>>
  tabs: () => Readonly<Record<string, string>>
  setGroup: (key: string, open: boolean) => void
  setTab: (key: string, value: string) => void
  subscribe: (onChange: () => void) => () => void
}): InspectorMemory {
  return {
    group: (key) => store.groups()[key],
    tab: (key) => store.tabs()[key],
    setGroup: store.setGroup,
    setTab: store.setTab,
    subscribe: store.subscribe,
  }
}

let sessionGroups: Record<string, boolean> = {}
let sessionTabs: Record<string, string> = {}
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

/** The fallback memory (no shell): this window's session. */
export const SESSION_INSPECTOR_MEMORY: InspectorMemory = inspectorMemory({
  groups: () => sessionGroups,
  tabs: () => sessionTabs,
  setGroup: (key, open) => {
    sessionGroups = { ...sessionGroups, [key]: open }
    notify()
  },
  setTab: (key, value) => {
    sessionTabs = { ...sessionTabs, [key]: value }
    notify()
  },
  subscribe: (l) => {
    listeners.add(l)
    return () => listeners.delete(l)
  },
})

/** Tests: forget the fallback memory. */
export function resetInspectorMemory(): void {
  sessionGroups = {}
  sessionTabs = {}
  notify()
}

const MemoryContext = createContext<InspectorMemory>(SESSION_INSPECTOR_MEMORY)

export function InspectorMemoryProvider({
  memory,
  children,
}: {
  memory: InspectorMemory
  children: ReactNode
}): React.JSX.Element {
  return createElement(MemoryContext.Provider, { value: memory }, children)
}

export const useInspectorMemory = (): InspectorMemory => useContext(MemoryContext)

/** The remembered open state of `key` (undefined: none, or no key). */
export function useRememberedGroup(key: string | undefined): boolean | undefined {
  const memory = useInspectorMemory()
  return useSyncExternalStore(memory.subscribe, () =>
    key === undefined ? undefined : memory.group(key),
  )
}

/** The remembered tab of `key` (undefined: none, or no key). */
export function useRememberedTab(key: string | undefined): string | undefined {
  const memory = useInspectorMemory()
  return useSyncExternalStore(memory.subscribe, () =>
    key === undefined ? undefined : memory.tab(key),
  )
}

/** The DOM event a revealed element sends up to the accordions, More rows and tabs around it. */
export const REVEAL_EVENT = 'dfyom-inspector-reveal'

/**
 * Opens every closed accordion and More row around `el` and selects the tabs it sits in,
 * synchronously, so the caller can focus it right after ("never hides a problem", DF110).
 * Does nothing outside an inspector.
 */
export function revealInInspector(el: Element | null | undefined): void {
  el?.dispatchEvent(new CustomEvent(REVEAL_EVENT, { bubbles: true }))
}
