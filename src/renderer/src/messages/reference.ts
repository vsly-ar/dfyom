// User-facing strings of the reference model UI (task R3). Terms from docs/glossary.md.
// Doc: docs/modes/reference-model.md#display, docs/conventions/ui.md#internationalization
import type { FitZ, SourceUnit } from '../../../core/design/reference'

const count = (n: number) => n.toLocaleString('en-US').replaceAll(',', ' ')

export const referenceMessages = {
  title: 'Reference',
  listLabel: 'References',
  import: 'Import reference…',
  importStl: 'Import STL…',
  importing: 'Importing…',
  empty: 'Import an STL to show it on the stock as a ghost. It never changes the part.',
  importFailed: 'The reference could not be imported.',
  show: 'Show reference',
  remove: (name: string) => `Remove ${name}`,
  hidden: 'hidden',
  triangles: (n: number) => `${count(n)} triangles`,

  inspector: {
    meta: 'Reference',
    name: 'Name',
    file: (triangles: number, size: string) => `STL · ${count(triangles)} triangles · ${size}`,
    sourceUnit: 'Source unit',
    units: { mm: 'mm', inch: 'inch' } satisfies Record<SourceUnit, string>,
    guess: (reason: string) => `Unit guess: ${reason}`,
    scale: 'Scale',
    rotation: 'Rotation',
    rotationAxis: (axis: string) => `Rotation ${axis.toUpperCase()}`,
    turn: (axis: string, turns: -1 | 1) =>
      `Turn ${turns < 0 ? '−90°' : '+90°'} about ${axis.toUpperCase()}`,
    position: 'Position (min corner)',
    positionAxis: (axis: string) => `Position ${axis.toUpperCase()}`,
    fit: 'Fit to stock',
    anchor: 'Anchor',
    height: 'Height',
    heights: { top: 'Top', centre: 'Centre', bottom: 'Bottom' } satisfies Record<FitZ, string>,
    fitButton: 'Fit to stock',
    fitHint: 'Places the reference once; changing the stock later does not move it.',
    warnings: 'Reference warnings',
    noWarnings: 'The reference fits inside the stock.',
    commandFailed: 'The change was not applied.',
    mesh: {
      loading: 'Loading the mesh…',
      failed: 'The mesh could not be read for the viewport.',
      hidden: 'Hidden in this window.',
    },
  },

  /** The viewport's text summary for the visible references. */
  viewport: (name: string, state: 'loading' | 'done' | 'failed') =>
    state === 'done'
      ? `Reference ${name} shown as a ghost.`
      : state === 'loading'
        ? `Reference ${name} loading.`
        : `Reference ${name} could not be shown.`,
} as const
