// User-facing strings of the 3D viewport. Doc: docs/conventions/ui.md#internationalization
import type { ViewPreset } from '../viewport/camera'

export const viewportMessages = {
  region: '3D viewport',
  toolbar: 'View',
  preset: {
    top: 'Top',
    front: 'Front',
    right: 'Right',
    iso: 'Isometric',
  } satisfies Record<ViewPreset, string>,
  fit: 'Fit',
  pickCancel: 'Esc to cancel',
  keys: 'Keys: 1 to 4 view presets, F fit, arrows orbit, Shift and arrows pan, plus and minus zoom.',
  /** Default text summary (the shell may pass a richer one, ui.md#accessibility). */
  summary: (p: { operations: number; status: 'done' | 'pending' | 'failed' | 'empty' }): string => {
    if (p.status === 'empty') return 'Nothing to show yet.'
    const part = `Part with ${p.operations} ${p.operations === 1 ? 'operation' : 'operations'}`
    if (p.status === 'pending') return `${part}, updating.`
    if (p.status === 'failed') return `${part}, evaluation failed: showing the last result.`
    return `${part}.`
  },
  pickPrompt: (field: string): string => `Pick a surface for ${field}`,
} as const
