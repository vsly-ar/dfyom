// The open arrow-key run of a tab marker (useTabMarkers.ts), reachable from the Tabs fields
// (TabsFields.tsx): a typed position first ends the run, so the run's last step cannot land after
// the typed one and overwrite it (X2 finding). Ending sends the run's pending step, waits for its
// replies and gives the positions it left (sources), which the typed edit builds on.
// Doc: docs/conventions/ui.md#tab-markers

/** Ends the run; resolves to the positions it sent last, or undefined when it sent none. */
export type SettleKeyRun = () => Promise<readonly string[] | undefined>

let current: { readonly operationId: string; readonly settle: SettleKeyRun } | null = null

/** The markers of `operationId` register their run's end; the returned function unregisters. */
export function registerTabKeyRun(operationId: string, settle: SettleKeyRun): () => void {
  const entry = { operationId, settle }
  current = entry
  return () => {
    if (current === entry) current = null
  }
}

/** Ends the profile's key run, if one is open; its positions, or undefined. */
export async function settleTabKeyRun(operationId: string): Promise<readonly string[] | undefined> {
  if (current === null || current.operationId !== operationId) return undefined
  return current.settle()
}
