// Which window shows a project the user opens or creates, and where a new window goes
// (docs/conventions/ui.md#project-files): kept free of Electron so it is unit-tested;
// src/main/ipc.ts wires it to `window.openProject`, src/main/index.ts to window creation.

/** The opening commands a window routes through `window.openProject`. */
export const OPENING_COMMANDS = [
  'project.open',
  'project.create',
  'project.recovery.resolve',
] as const
export type OpeningCommand = (typeof OPENING_COMMANDS)[number]

export function isOpeningCommand(name: unknown): name is OpeningCommand {
  return (OPENING_COMMANDS as readonly unknown[]).includes(name)
}

/** Where an opening command runs. */
export type OpenTarget =
  /** A window already shows the project: bring it to the front, run nothing. */
  | { readonly kind: 'focus'; readonly key: string }
  /** The asking window (it has no project, or the command binds none). */
  | { readonly kind: 'here' }
  /** A new window, bound by the command. */
  | { readonly kind: 'newWindow' }

export interface OpenRequest {
  readonly name: OpeningCommand
  /** The asking window's bound project. */
  readonly senderKey: string | undefined
  /** `project.open` only: the key of its file when already open in this instance. */
  readonly openKey: string | undefined
  /** Every window's bound project, the asking window's included. */
  readonly windowKeys: readonly (string | undefined)[]
  /** `project.recovery.resolve` with `discard` binds no project. */
  readonly bindsNone: boolean
}

/**
 * One window per project: a project a window already shows is focused there; otherwise an empty
 * asking window is reused and a window with a project gets a new one.
 */
export function openTarget(r: OpenRequest): OpenTarget {
  if (r.openKey !== undefined && r.windowKeys.includes(r.openKey))
    return { kind: 'focus', key: r.openKey }
  if (r.senderKey === undefined || r.bindsNone) return { kind: 'here' }
  return { kind: 'newWindow' }
}

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The cascade step of a new window from the window it was opened from (macOS-like). */
export const CASCADE_OFFSET = 22

/**
 * A new window's bounds: `from` moved right and down by the cascade step with its size, back to
 * the work area's top-left corner when it would leave the work area; never larger than the work
 * area. Undefined without a source window (the default size, centred).
 */
export function cascadeBounds(from: Rect | undefined, workArea: Rect): Rect | undefined {
  if (from === undefined) return undefined
  const width = Math.min(from.width, workArea.width)
  const height = Math.min(from.height, workArea.height)
  let x = from.x + CASCADE_OFFSET
  let y = from.y + CASCADE_OFFSET
  const fits =
    x >= workArea.x &&
    y >= workArea.y &&
    x + width <= workArea.x + workArea.width &&
    y + height <= workArea.y + workArea.height
  if (!fits) {
    x = workArea.x
    y = workArea.y
  }
  return { x, y, width, height }
}
