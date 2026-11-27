// User-facing strings of the 3D viewport. Doc: docs/conventions/ui.md#internationalization
import type { ViewPreset } from '../viewport/camera'
import type { RegionKind, RegionWord } from '../viewport/view-cube'

const WORDS: Record<RegionWord, string> = {
  top: 'top',
  bottom: 'bottom',
  front: 'front',
  back: 'back',
  left: 'left',
  right: 'right',
}
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export const viewportMessages = {
  region: '3D viewport',
  toolbar: 'View',
  preset: {
    top: 'Top',
    front: 'Front',
    right: 'Right',
    iso: 'Isometric',
    bottom: 'Bottom',
    back: 'Back',
    left: 'Left',
  } satisfies Record<ViewPreset, string>,
  fit: 'Fit',
  /** The Views menu (the view cube's keyboard and screen-reader equivalent, ui-view-cube.md). */
  views: 'Views',
  setupView: 'Setup view',
  /** A view cube region: "Top", "Top front edge", "Top front right corner". */
  cubeRegion: (kind: RegionKind, words: readonly RegionWord[]): string =>
    capital(kind === 'face' ? WORDS[words[0]!] : `${words.map((w) => WORDS[w]).join(' ')} ${kind}`),
  /** Tooltip of the setup's up face, which carries the spindle glyph (Plan, Run). */
  setupRegion: (face: string): string => `Setup view · ${face} up to the spindle`,
  /** The current view at the end of the text summary, announced politely when it changes. */
  shownView: (name: string | null): string => `View: ${name ?? 'custom'}.`,
  pickCancel: 'Esc to cancel',
  /** Announced politely when pick mode ends without a pick (Escape, the pick toggle again). */
  pickCancelled: 'Pick cancelled.',
  /** DF122: added to the text summary while the plan scene shades a rest region. */
  restShaded: 'Shaded: what the roughing left for this operation.',
  keys: 'Keys: 1 to 4 Top, Front, Right and Isometric view, Shift and 1 to 3 Bottom, Back and Left view, F fit, arrows orbit, Shift and arrows pan, plus and minus zoom.',
  /** Default text summary (the shell may pass a richer one, ui.md#accessibility). */
  summary: (p: { operations: number; status: 'done' | 'pending' | 'failed' | 'empty' }): string => {
    if (p.status === 'empty') return 'Nothing to show yet.'
    const part = `Part with ${p.operations} ${p.operations === 1 ? 'operation' : 'operations'}`
    if (p.status === 'pending') return `${part}, updating.`
    if (p.status === 'failed') return `${part}, evaluation failed: showing the last result.`
    return `${part}.`
  },
  pickPrompt: (field: string): string => `Pick a surface for ${field}`,
  /** Pick mode with no eligible surface facing the camera (design review R18). */
  pickNoneFacing: 'none face you: turn the view',
} as const
