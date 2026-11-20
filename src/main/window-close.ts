// Closing a project with its last window (docs/conventions/ui.md#app-shell): the decision, kept
// free of Electron so it is unit-tested; src/main/ipc.ts wires it to the window events.

/**
 * The project a closing window must close first: its bound project when no other window is bound
 * to it; `undefined` when the window can just close (no project, or another window keeps it).
 * Agent sessions never keep a project open on their own: the GUI user owns it.
 */
export function closeNeedsProject(
  key: string | undefined,
  otherWindowKeys: readonly (string | undefined)[],
): string | undefined {
  if (key === undefined || otherWindowKeys.includes(key)) return undefined
  return key
}
