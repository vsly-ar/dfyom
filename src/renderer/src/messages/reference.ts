// User-facing strings of the reference model UI (task R3; the Reference panel, dogfood DF2–DF8).
// Terms from docs/glossary.md.
// Doc: docs/modes/reference-model.md#display, docs/conventions/ui.md#reference-panel-hardening-df2df8,
// docs/conventions/ui.md#internationalization
import type { FitAxis, FitZ, SourceUnit } from '../../../core/design/reference'

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
  replace: 'Replace STL…',
  replacing: 'Replacing…',
  replaceFailed: 'The STL could not be replaced.',
  remove: 'Remove reference',
  hidden: 'hidden',
  triangles: (n: number) => `${count(n)} triangles`,

  panel: {
    noPart: 'Set up the stock first.',
    setUpStock: 'Set up stock…',
    choose: 'Reference',
    seeThrough: 'See through stock',
    size: 'Size',
    source: 'File',
    sourceSize: (size: string, unit: SourceUnit) => `${size} ${unit === 'mm' ? 'mm' : 'in'}`,
    fitOpen: 'Fit to stock…',
  },

  fit: {
    region: 'Fit to stock',
    title: 'Fit to stock',
    scaleToFit: 'Scale to fit',
    scaleHint: 'Scales the model to the largest size that fits the checked stock dimensions.',
    within: 'Fit within',
    axes: {
      x: 'Length (X)',
      y: 'Width (Y)',
      z: 'Thickness (Z)',
    } satisfies Record<FitAxis, string>,
    margin: 'Margin',
    marginHint: 'Kept free on each side in X and Y.',
    result: (scale: string, size: string) => `Scale ${scale} · ${size}`,
    problems: {
      marginTooLarge: 'The margin leaves no room on the stock.',
      zeroExtent: 'The model has no size along the checked dimensions.',
    },
    apply: 'Apply',
    cancel: 'Cancel',
  },

  inspector: {
    meta: 'Reference',
    file: (triangles: number) => `STL · ${count(triangles)} triangles`,
    sourceUnit: 'Source unit',
    units: { mm: 'mm', inch: 'inch' } satisfies Record<SourceUnit, string>,
    guess: (reason: string) => `Unit guess: ${reason}`,
    scale: 'Scale',
    scaleGroup: 'Scale',
    rotation: 'Rotation',
    rotationAxis: (axis: string) => `Rotation ${axis.toUpperCase()}`,
    turn: (axis: string, turns: -1 | 1) =>
      `Turn ${turns < 0 ? '−90°' : '+90°'} about ${axis.toUpperCase()}`,
    position: 'Position (min corner)',
    positionAxis: (axis: string) => `Position ${axis.toUpperCase()}`,
    anchor: 'Anchor',
    anchorHint:
      'The point of the model that stays in place when the scale changes. Fit puts it on the same point of the stock.',
    height: 'Height',
    heightHint:
      "Which face of the model lines up with the same face of the stock. Top: the model's top at the stock's top.",
    heights: { top: 'Top', centre: 'Centre', bottom: 'Bottom' } satisfies Record<FitZ, string>,
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

  /** The Levels and Section rows (DF60 P1, ui.md § Reference tools). */
  tools: {
    face: 'Read from',
    faces: {
      'stock.top': 'Top',
      'stock.bottom': 'Bottom',
      'stock.side[0]': 'Front',
      'stock.side[1]': 'Right',
      'stock.side[2]': 'Back',
      'stock.side[3]': 'Left',
    } as Record<string, string>,
    levels: 'Levels',
    levelsHint: 'Flat floors of the model. Choose one to cut the section just inside it.',
    fromFace: (face: string) => `From ${face.toLowerCase()}`,
    finding: 'Reading the model…',
    findFailed: 'The model could not be read.',
    noLevels: 'No flat floors on this axis.',
    more: (n: number) => `${n} smaller levels not shown.`,
    level: (depth: string, area: string, visible: string) =>
      `Depth ${depth}, area ${area}, visible ${visible}`,
    undercut: 'Undercut: not reachable from this side',
    area: (mm2: number) => `${count(Math.round(mm2))} mm²`,
    section: 'Section',
    depth: 'Section depth',
    loops: 'Loops',
    loopKinds: { all: 'All', outer: 'Outlines', holes: 'Cavities' } as Record<string, string>,
    noLoops: 'The plane misses the model at this depth.',
    loop: (role: 'outer' | 'hole', size: string) =>
      `${role === 'outer' ? 'Outline' : 'Cavity'} ${size}`,
    circle: (d: string) => `Circle Ø ${d}`,
    corners: 'Inside corners',
    radiusChip: (r: string) => `r ${r}`,
    sharpChip: (n: number) => (n === 1 ? 'r 0' : `r 0 × ${n}`),
    noInsideCorners: 'none',
    fit: (elements: number, dev: string) => `${elements} elements, within ${dev}`,
    roundInside: 'Round sharp inside corners to',
    roundHint: 'Default: the smallest end mill in the library. Off: the section as the model is.',
    createShape: 'Create shape',
    createShapes: 'Create shapes',
    createHint: 'One shape with its holes, or one shape per outline.',
    created: (n: number) => (n === 1 ? 'Shape created.' : `${n} shapes created.`),
    createFailed: 'The shape could not be created.',
    /** The viewport's text summary while the section is drawn on the ghost. */
    viewportSection: (loops: number, sharp: number) =>
      `Section on the reference: ${loops === 1 ? '1 loop' : `${loops} loops`}` +
      (sharp === 0
        ? '.'
        : `, ${sharp === 1 ? '1 sharp inside corner' : `${sharp} sharp inside corners`}.`),
  },

  /** The viewport's text summary for the visible references. */
  viewport: (name: string, state: 'loading' | 'done' | 'failed') =>
    state === 'done'
      ? `Reference ${name} shown as a ghost.`
      : state === 'loading'
        ? `Reference ${name} loading.`
        : `Reference ${name} could not be shown.`,
} as const
