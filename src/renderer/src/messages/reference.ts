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
    stockGroup: 'Stock',
    setupsGroup: 'Setups',
    /** A setup in "Read from": "Bottom · Plan 1". */
    setupFace: (setup: string, plan: string) => `${setup} · ${plan}`,
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
    /** X2-1: a level's depth at full precision (the row's tooltip). */
    exactDepth: (depth: string) => `Depth ${depth}`,
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
    holes: 'Holes',
    noHoles: 'No round holes open towards this face.',
    holesMore: (n: number) => `${n} more holes not shown.`,
    holesHint:
      'Round holes along the face normal, grouped by size. Nothing is added until you add it.',
    /** "4 × Ø 2.447 mm countersunk Ø 4.861 mm 82°, 3.944 mm deep, grid 2 × 2". */
    holeGroup: (g: {
      count: number
      diameter: string
      mouth?: string
      bottom: string
      pattern?: string
    }) =>
      `${g.count} × Ø ${g.diameter}${g.mouth ? ` ${g.mouth}` : ''}, ${g.bottom}${g.pattern ? `, ${g.pattern}` : ''}`,
    countersunk: (d: string, angle: string) => `countersunk Ø ${d} ${angle}`,
    counterbored: (d: string, depth: string) => `counterbored Ø ${d} × ${depth}`,
    stepped: (n: number) => `stepped (${n} diameters)`,
    through: 'through',
    deep: (depth: string) => `${depth} deep`,
    pointed: (depth: string, angle: string) => `${depth} deep, ${angle} point`,
    grid: (nu: number, nv: number) => `grid ${nu} × ${nv}`,
    boltCircle: (n: number, d: string) => `${n} on a circle Ø ${d}`,
    noToolChip: (d: string) => `No tool under Ø ${d}`,
    addBoltHole: 'Add as Bolt hole',
    /** X2-1: a mouth below the face, on the floor at its depth. */
    addBoltHoleOn: (floor: string) => `Add as Bolt hole on ${floor}`,
    /** X2-1: where a group's holes are, face frame, full precision. */
    gridAt: (first: string, pitch: string) => `First at ${first} · pitch ${pitch}`,
    circleAt: (centre: string, pitch: string) => `Centre ${centre} · pitch Ø ${pitch}`,
    holesAt: (shown: readonly string[], more: number) =>
      `At ${shown.join('; ')}${more > 0 ? ` and ${more} more` : ''}`,
    /** X2-3: "Inset from" in the Section group (reference-tools.md § UI reach). */
    insetFrom: 'Inset from',
    insetChoose: 'Choose a shape',
    insetHint:
      'For a shape made from a section of this face: its coordinates are read on this face.',
    /** "4.821 mm inside Section 22.5 mm (sides 4.81–4.83 mm)"; `lo` without its unit. */
    inset: (d: string, inside: boolean, shape: string, lo: string, hi: string) =>
      `${d} ${inside ? 'inside' : 'outside'} ${shape} (sides ${lo}–${hi})`,
    noOutline: 'The section has no outline.',
    createOffset: 'Create offset',
    offsetMade: (name: string) => `${name} created.`,
    offsetFailed: 'The offset was not made.',
    addDrilling: 'Add as Drilling',
    belowFace: (depth: string, face: string) =>
      `The mouth is ${depth} below ${face.toLowerCase()}: add the facing or pocket that makes that floor, then a Bolt hole on it.`,
    added: (n: number, bolt: boolean) =>
      n === 1
        ? bolt
          ? 'Bolt hole added.'
          : 'Drilling added.'
        : `${n} ${bolt ? 'Bolt holes' : 'drillings'} added.`,
    addFailed: 'The holes could not be added.',
    /** The viewport's text summary while the hole rings are drawn. */
    viewportHoles: (n: number) => `${n === 1 ? '1 hole' : `${n} holes`} marked on the reference.`,
    /** The viewport's text summary while the section is drawn on the ghost. */
    viewportSection: (loops: number, sharp: number) =>
      `Section on the reference: ${loops === 1 ? '1 loop' : `${loops} loops`}` +
      (sharp === 0
        ? '.'
        : `, ${sharp === 1 ? '1 sharp inside corner' : `${sharp} sharp inside corners`}.`),
  },

  /** The compare overlay (DF60 P5, ui.md § Reference tools). */
  compare: {
    title: 'Compare',
    show: 'Show on the part',
    hint: 'Colours the part where it differs from the reference: red where material is missing, blue where there is extra. Updates after each edit.',
    threshold: 'Threshold',
    comparing: 'Comparing with the reference…',
    failed: 'The design could not be compared.',
    within: (threshold: string) => `The design matches the reference within ${threshold}.`,
    /** "2 regions over 0.1 mm · worst 0.42 mm missing". */
    summary: (n: number, threshold: string, worst: string, kind: 'missing' | 'extra') =>
      `${n === 1 ? '1 region' : `${n} regions`} over ${threshold} · worst ${worst} ${kind}`,
    heightmap: 'Height maps: the reference mesh is open. Walls and undercuts are not compared.',
    regions: 'Regions',
    kind: { missing: 'Missing', extra: 'Extra' } as Record<'missing' | 'extra', string>,
    noOperation: 'no operation',
    fillet: 'fillet by design',
    /** A region row: "Missing 0.42 mm · Pocket 1". */
    region: (kind: 'missing' | 'extra', dev: string, op: string | undefined) =>
      `${kind === 'missing' ? 'Missing' : 'Extra'} ${dev}${op === undefined ? '' : ` · ${op}`}`,
    regionName: (row: string, volume: string) => `${row}, ${volume}`,
    volume: (mm3: number) => `${count(Math.round(mm3))} mm³`,
    more: (n: number) => `${n} more regions not shown.`,
    below: (n: number) =>
      `${n === 1 ? '1 smaller deviation' : `${n} smaller deviations`} under the threshold.`,
    /** The viewport's legend (`role="img"`): its accessible name and the end labels. */
    legend: 'Compare legend',
    legendText: (missing: string, threshold: string, extra: string) =>
      `Missing up to ${missing} in red, within ± ${threshold} unchanged, extra up to ${extra} in blue.`,
    missingEnd: (v: string) => `Missing ${v}`,
    extraEnd: (v: string) => `Extra ${v}`,
    band: (v: string) => `± ${v}`,
    overlayTitle: 'Compare with reference',
    hide: 'Hide',
    /** The viewport's text summary while the overlay is on. */
    viewport: (
      n: number,
      threshold: string,
      worst?: { readonly dev: string; readonly kind: 'missing' | 'extra'; readonly op?: string },
    ) =>
      n === 0 || worst === undefined
        ? `Compare: within ${threshold} of the reference.`
        : `Compare: ${n === 1 ? '1 region' : `${n} regions`} over ${threshold}, worst ${worst.dev} ${worst.kind}${worst.op === undefined ? '' : ` at ${worst.op}`}.`,
  },

  /** The viewport's text summary for the visible references. */
  viewport: (name: string, state: 'loading' | 'done' | 'failed') =>
    state === 'done'
      ? `Reference ${name} shown as a ghost.`
      : state === 'loading'
        ? `Reference ${name} loading.`
        : `Reference ${name} could not be shown.`,
} as const
