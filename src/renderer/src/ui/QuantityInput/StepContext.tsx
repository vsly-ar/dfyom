// What a value field's steps scale to and where a chosen step is remembered (DF104 rules 4, 5):
// inspectors provide the stock and machine limits of what they show (`StepScaleProvider`); the
// shell provides the session memory backed by the renderer ui store (`StepMemoryProvider`).
// Without providers: no caps, and a module-level session memory (component tests, gallery).
// Doc: docs/conventions/inspector-layout.md#field-step-model-df104
import { createContext, useContext, type ReactNode } from 'react'
import type { StepScale } from './steps'

/** Remembered steps per field role (`pocket.depth`), for the session; never saved. */
export interface StepMemory {
  get(key: string): string | undefined
  set(key: string, step: string): void
}

const sessionSteps = new Map<string, string>()

/** The fallback memory (no shell): this window's session. */
export const SESSION_STEP_MEMORY: StepMemory = {
  get: (key) => sessionSteps.get(key),
  set: (key, step) => void sessionSteps.set(key, step),
}

/** Tests: forget the fallback memory's steps. */
export function resetSessionSteps(): void {
  sessionSteps.clear()
}

const ScaleContext = createContext<StepScale | undefined>(undefined)
const MemoryContext = createContext<StepMemory>(SESSION_STEP_MEMORY)

export function StepScaleProvider({
  scale,
  children,
}: {
  scale: StepScale | undefined
  children: ReactNode
}): React.JSX.Element {
  return <ScaleContext.Provider value={scale}>{children}</ScaleContext.Provider>
}

export function StepMemoryProvider({
  memory,
  children,
}: {
  memory: StepMemory
  children: ReactNode
}): React.JSX.Element {
  return <MemoryContext.Provider value={memory}>{children}</MemoryContext.Provider>
}

export const useStepScale = (): StepScale | undefined => useContext(ScaleContext)
export const useStepMemory = (): StepMemory => useContext(MemoryContext)
