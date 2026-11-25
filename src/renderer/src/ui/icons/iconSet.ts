// The one source of DFYOM's own icon set (B22, decision D33): every icon the app shows outside the
// field illustrations, as plain data. `Icon.tsx` renders it in the app; design/icons/render.mjs
// imports this file directly (Node strips the types) for the specimen sheets and the SVG exports.
// Rules: 16 px grid, 1.35 px stroke (`--icon-stroke`), round caps and joins, 1.5 px margin, no
// fills except dots ≤ 1.8 px; `a` marks the one accent part (amber only while active or in a
// primary button). All drawings are original works for DFYOM, GPL-3.0-or-later.
// Doc: docs/conventions/ui.md#icons, provenance: design/icons/README.md
// Keep this file free of imports and non-erasable TypeScript (it runs under plain Node).

/** One drawn element; exactly one of `d`, `rect` [x, y, w, h, rx] or `circle` [cx, cy, r]. */
export interface IconPart {
  readonly d?: string
  readonly rect?: readonly [number, number, number, number, number]
  readonly circle?: readonly [number, number, number]
  /** The accent part (amber while active, in a primary button). */
  readonly a?: true
  /** A small filled dot instead of a stroke. */
  readonly fill?: true
  readonly dash?: string
}

export type IconGroup =
  'operation' | 'feature' | 'tool' | 'shape' | 'cnc' | 'view' | 'action' | 'status'

export interface IconDef {
  readonly label: string
  readonly group: IconGroup
  /**
   * approved: shape approved with the design system (task 1.16) or earlier; b22: drawn for the
   * B22 proposal; redraw: drawn for B22-1 b (replaces a former Lucide glyph).
   */
  readonly src: 'approved' | 'b22' | 'redraw'
  readonly parts: readonly IconPart[]
  /** Drawn but not shown in the app until the feature exists (reason). */
  readonly reserved?: string
}

const DOC = 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3'
const CUBE = 'M8 2l5.5 3v6L8 14l-5.5-3V5z'
/** An accent dot of a Clones row-kind icon (the fill exception, r 1.3). */
const dot = (cx: number, cy: number) => ({ circle: [cx, cy, 1.3], a: true, fill: true }) as const

export const ICON_SET = {
  // ── operations (front or top views; the pass that tells the kind apart is the accent) ──────
  facing: {
    label: 'Facing',
    group: 'operation',
    src: 'approved',
    parts: [{ rect: [2, 9, 12, 4.5, 1] }, { d: 'M2 6.5h12M2 4h12', a: true }],
  },
  pocket: {
    label: 'Pocket',
    group: 'operation',
    src: 'approved',
    parts: [{ rect: [2.5, 2.5, 11, 11, 1.5] }, { d: 'M5 6h6M5 8h6M5 10h6', a: true }],
  },
  profile: {
    label: 'Profile',
    group: 'operation',
    src: 'approved',
    parts: [{ rect: [4.5, 4.5, 7, 7, 1] }, { rect: [2, 2, 12, 12, 3], a: true, dash: '2 2' }],
  },
  // L1 (B22 follow-up): the bent slot 1 px wider and closed by a round cap at its visible end, so
  // it reads as a slot at 16 px, not a signal glyph.
  groove: {
    label: 'Groove',
    group: 'operation',
    src: 'b22',
    parts: [
      { d: 'M1.5 3h5a6.5 6.5 0 0 1 6.5 6.5V11a3 3 0 0 1-6 0V9.5a.5.5 0 0 0-.5-.5h-5' },
      { d: 'M1.5 6h5a3.5 3.5 0 0 1 3.5 3.5V11', a: true },
    ],
  },
  drilling: {
    label: 'Drilling',
    group: 'operation',
    src: 'approved',
    parts: [{ circle: [8, 8, 3.5] }, { d: 'M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3', a: true }],
  },
  'shape-import': {
    label: 'Import shape',
    group: 'operation',
    src: 'b22',
    parts: [{ d: DOC }, { d: 'M5.5 12.5C5.5 9 10.5 10 10.5 6.5', a: true }],
  },
  fillet: {
    label: 'Fillet',
    group: 'operation',
    src: 'b22',
    parts: [
      { d: 'M2.5 14V8.5M8.5 2.5H14' },
      { d: 'M2.5 8.5V2.5h6', dash: '1 2' },
      { d: 'M2.5 8.5a6 6 0 0 1 6-6', a: true },
    ],
  },
  // B22-7 b: the approved bridge on a cut line, taller so it reads alone at 16 px: the stock's top
  // face, the cut's floor on both sides and the tab standing up between them.
  tabs: {
    label: 'Tabs',
    group: 'operation',
    src: 'b22',
    parts: [
      { d: 'M1.5 4h13M1.5 12h3.5M11 12h3.5' },
      { d: 'M5 12V8.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V12', a: true },
    ],
  },
  toolpath: {
    label: 'Toolpath',
    group: 'operation',
    src: 'redraw',
    parts: [
      { circle: [2.5, 13.5, 1], fill: true },
      { d: 'M2.5 13.5V2.5h3.7v11h3.6v-11h3.7v11', a: true },
    ],
  },
  // ── features (v0.4, L1; front sections and top views) ─────────────────────────────────────
  // Hole sections: the plate's top and bottom face either side of the bore; the accent is the
  // part that tells the hole type apart. Doc: docs/conventions/ui.md#icons-v04
  'hole-simple': {
    label: 'Simple hole',
    group: 'feature',
    src: 'b22',
    parts: [{ d: 'M1.5 4H6M10 4h4.5M1.5 12H6M10 12h4.5' }, { d: 'M6 4v8M10 4v8', a: true }],
  },
  'hole-counterbore': {
    label: 'Counterbore',
    group: 'feature',
    src: 'b22',
    parts: [
      { d: 'M1.5 3h2M12.5 3h2M1.5 13H6M10 13h4.5M6 7.5V13M10 7.5V13' },
      { d: 'M3.5 3v4.5H6M12.5 3v4.5H10', a: true },
    ],
  },
  'hole-countersink': {
    label: 'Countersink',
    group: 'feature',
    src: 'b22',
    parts: [
      { d: 'M1.5 3h1M13.5 3h1M1.5 13H6M10 13h4.5M6 6.5V13M10 6.5V13' },
      { d: 'M2.5 3L6 6.5M13.5 3L10 6.5', a: true },
    ],
  },
  // an edge in section: top face, 45° bevel, side face; no bore (unlike the countersink)
  chamfer: {
    label: 'Chamfer',
    group: 'feature',
    src: 'b22',
    parts: [{ d: 'M1.5 4.5H8M11.5 8v6.5' }, { d: 'M8 4.5l3.5 3.5', a: true }],
  },
  // the source (solid), two dashed copies, the dotted path between them
  clones: {
    label: 'Clones',
    group: 'feature',
    src: 'b22',
    parts: [
      { rect: [1.5, 1.5, 4, 4, 1] },
      { rect: [10.5, 1.5, 4, 4, 1], dash: '1.4 1.1' },
      { rect: [10.5, 10.5, 4, 4, 1], dash: '1.4 1.1' },
      { d: 'M7 3.5h2M12.5 7v2', a: true, dash: '0 2' },
    ],
  },
  // DF109 (patterns.md § Icon (DF109)): a honeycomb of small cells sharing their walls, no frame:
  // two rows of two about the middle cell (the accent), the middle row's outer cells cut by the
  // box (wall stubs at the sides). Was round cells in a face outline, which read as a face.
  pattern: {
    label: 'Pattern',
    group: 'feature',
    src: 'b22',
    parts: [
      {
        d: 'M5.75 1.5L8 2.8v2.6L5.75 6.7L3.5 5.4V2.8zM10.25 1.5l2.25 1.3v2.6l-2.25 1.3L8 5.4V2.8z',
      },
      {
        d: 'M5.75 9.3L8 10.6v2.6l-2.25 1.3l-2.25-1.3v-2.6zM10.25 9.3l2.25 1.3v2.6l-2.25 1.3L8 13.2v-2.6z',
      },
      { d: 'M3.5 5.4L1.5 6.55M3.5 10.6L1.5 9.45M12.5 5.4l2 1.15M12.5 10.6l2-1.15' },
      { d: 'M8 5.4l2.25 1.3v2.6L8 10.6L5.75 9.3V6.7z', a: true },
    ],
  },
  // Clones path-row kinds (the Add row menu): dots in the row's layout; may fall back to the label
  // alone if they don't read at 16 px (L2).
  'row-grid': {
    label: 'Grid',
    group: 'feature',
    src: 'b22',
    parts: [
      dot(3.5, 5.5),
      dot(8, 5.5),
      dot(12.5, 5.5),
      dot(3.5, 10.5),
      dot(8, 10.5),
      dot(12.5, 10.5),
    ],
  },
  'row-offset': {
    label: 'Offset',
    group: 'feature',
    src: 'b22',
    parts: [dot(3, 13), dot(8, 8), dot(13, 3)],
  },
  'row-polar': {
    label: 'Polar',
    group: 'feature',
    src: 'b22',
    parts: [
      { d: 'M2.5 13.5l3-3' },
      { circle: [2.5, 13.5, 1], fill: true },
      dot(7.5, 8.5),
      dot(10.5, 5.5),
      dot(13.5, 2.5),
    ],
  },
  'row-arc': {
    label: 'Arc',
    group: 'feature',
    src: 'b22',
    parts: [
      { d: 'M5 6.8v2.4M3.8 8h2.4' },
      dot(5, 2.5),
      dot(8.9, 4.1),
      dot(10.5, 8),
      dot(8.9, 11.9),
      dot(5, 13.5),
    ],
  },
  'row-point': {
    label: 'Point',
    group: 'feature',
    src: 'b22',
    parts: [{ d: 'M2.5 12.5C3.5 6 8 4 11 4.5M9 2.5l2 2-2 2' }, dot(13.5, 4.5)],
  },
  'row-along': {
    label: 'Along a shape',
    group: 'feature',
    src: 'b22',
    parts: [{ d: 'M1.5 12C5 3 10 14 14.5 4' }, dot(3, 9), dot(8, 8.5), dot(12.8, 7)],
  },
  // ── tool types (side views; the cutting end is the accent; always beside the tool's name) ──
  'flat-end-mill': {
    label: 'Flat end mill',
    group: 'tool',
    src: 'b22',
    parts: [{ d: 'M5 14.5V1.5h6v13M5 6h6M5 11l6-3' }, { d: 'M5 14.5h6', a: true }],
  },
  'bull-nose-end-mill': {
    label: 'Bull nose end mill',
    group: 'tool',
    src: 'b22',
    parts: [
      { d: 'M5 12.5V1.5h6v11M5 6h6M5 11l6-3' },
      { d: 'M5 12.5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2', a: true },
    ],
  },
  'ball-end-mill': {
    label: 'Ball end mill',
    group: 'tool',
    src: 'b22',
    parts: [{ d: 'M5 11.5V1.5h6v10M5 6h6M5 10l6-3' }, { d: 'M5 11.5a3 3 0 0 0 6 0', a: true }],
  },
  drill: {
    label: 'Drill',
    group: 'tool',
    src: 'b22',
    parts: [{ d: 'M5 11V1.5h6V11M5 7l6-3M5 10.5l6-3' }, { d: 'M5 11l3 3.5 3-3.5', a: true }],
  },
  'chamfer-mill': {
    label: 'Chamfer mill',
    group: 'tool',
    src: 'b22',
    parts: [{ d: 'M6 7V1.5h4V7M3.5 7h9' }, { d: 'M3.5 7L8 14.5 12.5 7', a: true }],
  },
  // ── drawing tools and shape kinds (top views) ───────────────────────────────────────────────
  select: {
    label: 'Select',
    group: 'shape',
    src: 'approved',
    parts: [{ d: 'M3.5 2.5l8.5 5-3.8 1L6.2 12z' }, { d: 'M8.4 8.6l2.6 4', a: true }],
  },
  rect: {
    label: 'Rectangle',
    group: 'shape',
    src: 'approved',
    parts: [{ rect: [2.5, 4, 11, 8, 0.5] }, { d: 'M1.5 3h2v2h-2zM12.5 11h2v2h-2z', a: true }],
  },
  circle: {
    label: 'Circle',
    group: 'shape',
    src: 'approved',
    parts: [
      { circle: [8, 8, 5.5] },
      { d: 'M8 8l3.9-3.9', a: true },
      { circle: [8, 8, 1], a: true, fill: true },
    ],
  },
  line: {
    label: 'Polyline',
    group: 'shape',
    src: 'approved',
    parts: [
      { d: 'M2.5 12.5L7 4.5l6.5 4' },
      { circle: [7, 4.5, 1.3], a: true },
      { circle: [2.5, 12.5, 1.3], a: true },
      { circle: [13.5, 8.5, 1.3], a: true },
    ],
  },
  shapes: {
    label: 'Shapes',
    group: 'shape',
    src: 'redraw',
    parts: [{ circle: [5.5, 5.5, 3.5] }, { rect: [7.5, 7.5, 6, 6, 1], a: true }],
  },
  'kind-rectangle': {
    label: 'Rectangle',
    group: 'shape',
    src: 'redraw',
    parts: [{ rect: [2, 4, 12, 8, 1] }],
  },
  'kind-circle': {
    label: 'Circle',
    group: 'shape',
    src: 'redraw',
    parts: [{ circle: [8, 8, 6] }],
  },
  'kind-obround': {
    label: 'Obround',
    group: 'shape',
    src: 'redraw',
    parts: [{ rect: [1.5, 4.5, 13, 7, 3.5] }],
  },
  'kind-polygon': {
    label: 'Polygon',
    group: 'shape',
    src: 'redraw',
    parts: [{ d: 'M4.8 2.5h6.4L14.4 8l-3.2 5.5H4.8L1.6 8z' }],
  },
  'kind-path': {
    label: 'Path',
    group: 'shape',
    src: 'redraw',
    parts: [
      { d: 'M2.5 12.5C3 5 7 4 8 8s5 3 5.5-4.5' },
      { circle: [2.5, 12.5, 0.9], fill: true },
      { circle: [13.5, 3.5, 0.9], fill: true },
    ],
  },
  // ── modes (the mode switcher; the run mode shares the Run icon) ───────────────────────────
  design: {
    label: 'Design',
    group: 'cnc',
    src: 'approved',
    parts: [
      { d: 'M2.5 13.5h11M4 11l6.5-6.5 2 2L6 13H4z' },
      { d: 'M10.5 4.5l1-1 2 2-1 1', a: true },
    ],
  },
  plan: {
    label: 'Plan',
    group: 'cnc',
    src: 'approved',
    parts: [{ d: 'M2.5 4h3M2.5 8h3M2.5 12h3' }, { d: 'M8.5 3.5h5v4.5h-5v4.5h5', a: true }],
  },
  // ── CNC actions ─────────────────────────────────────────────────────────────────────────────
  measure: {
    label: 'Measure',
    group: 'cnc',
    src: 'approved',
    parts: [
      { d: 'M2 11.5L11.5 2 14 4.5 4.5 14z' },
      { d: 'M5 8.5l1.3 1.3M7 6.5l1 1M9 4.5l1.3 1.3', a: true },
    ],
  },
  snap: {
    label: 'Snap',
    group: 'cnc',
    src: 'b22',
    parts: [
      { circle: [3, 3, 0.9], fill: true },
      { circle: [13, 3, 0.9], fill: true },
      { circle: [3, 13, 0.9], fill: true },
      { circle: [13, 13, 0.9], fill: true },
      { circle: [8, 8, 0.9], fill: true },
      { rect: [5, 5, 6, 6, 0.5], a: true },
    ],
  },
  // L1 (B22 follow-up): a pointer touching a face, no crosshair, so it no longer resembles drilling
  pick: {
    label: 'Pick in the viewport',
    group: 'cnc',
    src: 'b22',
    parts: [{ d: 'M6.5 6.5l7 4.2-3.3.9-1.7 3.4z' }, { d: 'M3.5 2.5h8.5l-2 3.5H1.5z', a: true }],
  },
  setups: {
    label: 'Setups',
    group: 'cnc',
    src: 'b22',
    parts: [
      { d: 'M8 1v3.5M6.5 3L8 4.5 9.5 3M3 8.5V12l5 2.5 5-2.5V8.5M8 11v3.5' },
      { d: 'M3 8.5L8 6l5 2.5L8 11z', a: true },
    ],
  },
  stock: {
    label: 'Stock',
    group: 'cnc',
    src: 'redraw',
    parts: [
      { d: 'M1.5 7.5L8 4.5l6.5 3v3L8 13.5l-6.5-3zM8 10.5v3' },
      { d: 'M1.5 7.5L8 10.5l6.5-3', a: true },
    ],
  },
  clamp: {
    label: 'Workholding',
    group: 'cnc',
    src: 'b22',
    parts: [
      { rect: [1.5, 9.5, 7, 5, 0.5] },
      { d: 'M10.5 2.5v12M13.5 8.5v6' },
      { d: 'M5 6.5h9v2H5z', a: true },
    ],
  },
  reference: {
    label: 'Reference model',
    group: 'cnc',
    src: 'b22',
    parts: [{ d: 'M8 2.5l6 11H2z' }, { d: 'M5 8h6l-3 5.5z', a: true }],
  },
  'export-gcode': {
    label: 'Export gCode',
    group: 'cnc',
    src: 'b22',
    parts: [{ d: DOC }, { d: 'M10.2 8.25A2.5 2.5 0 1 0 10.5 10H8.5', a: true }],
  },
  run: {
    label: 'Run',
    group: 'cnc',
    src: 'b22',
    parts: [{ circle: [8, 8, 6.5] }, { d: 'M6.5 5.3l4 2.7-4 2.7z', a: true }],
  },
  simulate: {
    label: 'Simulate',
    group: 'cnc',
    src: 'approved',
    parts: [{ d: 'M5 3.3l8 4.7-8 4.7z' }, { d: 'M2.5 5v6', a: true }],
  },
  'work-zero': {
    label: 'Work zero',
    group: 'cnc',
    src: 'approved',
    parts: [{ d: 'M2 14V2M2 14h12M6 10l3-3' }, { circle: [2, 14, 1.6], a: true }],
  },
  jog: {
    label: 'Jog',
    group: 'cnc',
    src: 'approved',
    parts: [
      { rect: [6, 6, 4, 4, 1] },
      {
        d: 'M8 1.5v3M6.5 3L8 1.5 9.5 3M8 14.5v-3M6.5 13L8 14.5 9.5 13M1.5 8h3M3 6.5L1.5 8 3 9.5M14.5 8h-3M13 6.5L14.5 8 13 9.5',
        a: true,
      },
    ],
  },
  probe: {
    label: 'Probe Z',
    group: 'cnc',
    src: 'approved',
    parts: [{ d: 'M8 2v7M5.5 6.5L8 9l2.5-2.5' }, { d: 'M2.5 13.5h11', a: true }],
  },
  home: {
    label: 'Home',
    group: 'cnc',
    src: 'redraw',
    parts: [{ d: 'M1.5 7.5L8 2l6.5 5.5M3.5 6v7.5h9V6' }, { d: 'M6.5 13.5V10h3v3.5', a: true }],
  },
  machine: {
    label: 'Machine',
    group: 'cnc',
    src: 'redraw',
    parts: [{ d: 'M1.5 14h13M3 14V2.5h10V14M3 5h10' }, { d: 'M7 5v4.5l1 1.5 1-1.5V5', a: true }],
  },
  connect: {
    label: 'Connect',
    group: 'cnc',
    src: 'redraw',
    parts: [{ d: 'M6 1.5v3M10 1.5v3M8 11.5v3' }, { d: 'M4 4.5h8v2.5a4 4 0 0 1-8 0z', a: true }],
  },
  // L1 (B22 follow-up): the plug and its prongs drawn apart, no strike-through (reads at 16 px)
  disconnect: {
    label: 'Disconnect',
    group: 'cnc',
    src: 'b22',
    parts: [{ d: 'M6 1.5v2.5M10 1.5v2.5M4.5 4h7M4 7h8v1a4 4 0 0 1-8 0zM8 12v2.5' }],
  },
  play: {
    label: 'Resume',
    group: 'cnc',
    src: 'redraw',
    parts: [{ d: 'M4.5 2.8l8.5 5.2-8.5 5.2z' }],
  },
  pause: {
    label: 'Pause',
    group: 'cnc',
    src: 'redraw',
    parts: [{ d: 'M5.5 3v10M10.5 3v10' }],
  },
  // ── views ───────────────────────────────────────────────────────────────────────────────────
  fit: {
    label: 'Fit',
    group: 'view',
    src: 'approved',
    parts: [
      { d: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10' },
      { rect: [5.5, 5.5, 5, 5, 0.5], a: true },
    ],
  },
  iso: {
    label: 'Isometric',
    group: 'view',
    src: 'approved',
    parts: [{ d: CUBE }, { d: 'M8 8l5.5-3M8 8L2.5 5M8 8v6', a: true }],
  },
  top: {
    label: 'Top',
    group: 'view',
    src: 'approved',
    parts: [{ d: `${CUBE}M8 8v6` }, { d: 'M2.5 5L8 8l5.5-3L8 2z', a: true }],
  },
  front: {
    label: 'Front',
    group: 'view',
    src: 'approved',
    parts: [{ d: `${CUBE}M8 8l5.5-3` }, { d: 'M2.5 5L8 8v6l-5.5-3z', a: true }],
  },
  right: {
    label: 'Right',
    group: 'view',
    src: 'approved',
    parts: [{ d: `${CUBE}M8 8L2.5 5` }, { d: 'M13.5 5L8 8v6l5.5-3z', a: true }],
  },
  grid: {
    label: 'Grid',
    group: 'view',
    src: 'approved',
    parts: [
      { rect: [2.5, 2.5, 11, 11, 1] },
      { d: 'M6.2 2.5v11M9.8 2.5v11M2.5 6.2h11M2.5 9.8h11', a: true },
    ],
  },
  eye: {
    label: 'Show',
    group: 'view',
    src: 'redraw',
    parts: [
      { d: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z' },
      { circle: [8, 8, 2], a: true },
    ],
  },
  'eye-off': {
    label: 'Hidden',
    group: 'view',
    src: 'redraw',
    parts: [
      { d: 'M6.3 3.7A6.6 6.6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a12 12 0 0 1-1.6 2.2' },
      { d: 'M10.5 11.9A5.9 5.9 0 0 1 8 12.5C4 12.5 1.5 8 1.5 8a12 12 0 0 1 2.6-3.1' },
      { d: 'M2 2l12 12' },
    ],
  },
  // panel toggles are pressed most of the time: no accent part, so the toolbar stays grey
  'panel-left': {
    label: 'Left panel',
    group: 'view',
    src: 'redraw',
    parts: [{ rect: [1.5, 2.5, 13, 11, 1.5] }, { d: 'M5.5 2.5v11' }],
  },
  'panel-right': {
    label: 'Right panel',
    group: 'view',
    src: 'redraw',
    parts: [{ rect: [1.5, 2.5, 13, 11, 1.5] }, { d: 'M10.5 2.5v11' }],
  },
  // ── generic actions (no accent part: whole icon amber in a primary button) ─────────────────
  add: { label: 'Add', group: 'action', src: 'redraw', parts: [{ d: 'M8 3v10M3 8h10' }] },
  delete: {
    label: 'Delete',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M2.5 4h11M6 4V2.5h4V4M3.8 4l.7 9.5h7l.7-9.5M6.6 6.8v4M9.4 6.8v4' }],
  },
  close: { label: 'Close', group: 'action', src: 'redraw', parts: [{ d: 'M4 4l8 8M12 4l-8 8' }] },
  check: { label: 'Done', group: 'action', src: 'redraw', parts: [{ d: 'M3 8.5l3.2 3.2L13 4.8' }] },
  'check-all': {
    label: 'Apply all',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M1.5 8.5l3 3L11 5M8 11l.5.5L14.5 5' }],
  },
  undo: {
    label: 'Undo',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M5.5 9.5L2 6l3.5-3.5M2 6h7.75a3.75 3.75 0 0 1 0 7.5H7' }],
  },
  redo: {
    label: 'Redo',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M10.5 9.5L14 6l-3.5-3.5M14 6H6.25a3.75 3.75 0 0 0 0 7.5H9' }],
  },
  'rotate-ccw': {
    label: 'Turn counter-clockwise',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9L2.5 5.8M2.5 2.5v3.3h3.3' }],
  },
  'rotate-cw': {
    label: 'Turn clockwise',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9l1.6 1.7M13.5 2.5v3.3h-3.3' }],
  },
  refresh: {
    label: 'Regenerate',
    group: 'action',
    src: 'redraw',
    parts: [
      {
        d: 'M13.2 6.2A5.5 5.5 0 0 0 3.3 5M2.8 9.8a5.5 5.5 0 0 0 9.9 1.2M13.5 2.5v3.8H9.7M2.5 13.5V9.7h3.8',
      },
    ],
  },
  history: {
    label: 'History',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9L2.5 5.8M2.5 2.5v3.3h3.3M8 5v3l2 1.5' }],
  },
  edit: {
    label: 'Edit',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M10.5 2.5l3 3-8 8h-3v-3zM9 4l3 3' }],
  },
  copy: {
    label: 'Duplicate',
    group: 'action',
    src: 'redraw',
    parts: [
      { rect: [5.5, 5.5, 8, 8, 1] },
      { d: 'M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2' },
    ],
  },
  paste: {
    label: 'Paste',
    group: 'action',
    src: 'redraw',
    parts: [
      { d: 'M5.5 3H4a1 1 0 0 0-1 1v9.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-1.5' },
      { rect: [5.5, 1.5, 5, 3, 0.75] },
      { d: 'M5.5 8h5M5.5 10.5h3.5' },
    ],
  },
  merge: {
    label: 'Merge',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M3.5 2v2a4.5 4.5 0 0 0 4.5 4.5A4.5 4.5 0 0 0 12.5 4V2M8 8.5V14M6 12l2 2 2-2' }],
  },
  split: {
    label: 'Split',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M8 14.5V9L3.5 3.5M8 9l4.5-5.5M3.5 6.5v-3h3M9.5 3.5h3v3' }],
  },
  'move-to': {
    label: 'Move to',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M3 2.5v5a2 2 0 0 0 2 2h8.5M10.5 6.5l3 3-3 3' }],
  },
  more: {
    label: 'More',
    group: 'action',
    src: 'redraw',
    parts: [
      { circle: [3.5, 8, 1.1], fill: true },
      { circle: [8, 8, 1.1], fill: true },
      { circle: [12.5, 8, 1.1], fill: true },
    ],
  },
  search: {
    label: 'Search',
    group: 'action',
    src: 'redraw',
    parts: [{ circle: [7, 7, 4.5] }, { d: 'M10.4 10.4l3.6 3.6' }],
  },
  settings: {
    label: 'Settings',
    group: 'action',
    src: 'redraw',
    parts: [
      {
        d: 'M6.65 3.29L7.11 1.66h1.78l.46 1.63 1.03.42 1.47-.82 1.26 1.26-.82 1.47.42 1.03 1.63.46v1.78l-1.63.46-.42 1.03.82 1.47-1.26 1.26-1.47-.82-1.03.42-.46 1.63H7.11l-.46-1.63-1.03-.42-1.47.82-1.26-1.26.82-1.47-.42-1.03-1.63-.46V7.11l1.63-.46.42-1.03-.82-1.47 1.26-1.26 1.47.82z',
      },
      { circle: [8, 8, 2.1] },
    ],
  },
  library: {
    label: 'Library',
    group: 'action',
    src: 'redraw',
    parts: [
      { d: 'M1.5 14h13M2.5 14V2.5H5V14M5 14V4.5h2.5V14' },
      { d: 'M8.6 5l2.4-.6 2.5 9-2.4.6z' },
    ],
  },
  save: {
    label: 'Save',
    group: 'action',
    src: 'redraw',
    parts: [
      { d: 'M2.5 3.5a1 1 0 0 1 1-1H11l2.5 2.5v8.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z' },
      { d: 'M5 13.5v-4h6v4M5.5 2.5V5h4' },
    ],
  },
  'file-new': {
    label: 'New project',
    group: 'action',
    src: 'redraw',
    parts: [{ d: DOC }, { d: 'M8 7v5M5.5 9.5h5' }],
  },
  open: {
    label: 'Open',
    group: 'action',
    src: 'redraw',
    parts: [
      {
        d: 'M1.5 4a1 1 0 0 1 1-1H6l1.5 1.5h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z',
      },
    ],
  },
  import: {
    label: 'Import',
    group: 'action',
    src: 'redraw',
    parts: [{ d: DOC }, { d: 'M8 12.5V7M5.8 9.2L8 7l2.2 2.2' }],
  },
  report: {
    label: 'Report',
    group: 'action',
    src: 'redraw',
    parts: [{ d: DOC }, { d: 'M5.5 8h5M5.5 10.5h5' }],
  },
  download: {
    label: 'Apply to the library',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M8 2v8M4.8 6.8L8 10l3.2-3.2M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2' }],
  },
  agent: {
    label: 'Agent',
    group: 'action',
    src: 'redraw',
    parts: [
      { rect: [2.5, 5, 11, 8.5, 2] },
      { d: 'M8 5V2.5' },
      { circle: [6, 9.2, 0.9], fill: true },
      { circle: [10, 9.2, 0.9], fill: true },
    ],
  },
  'arrow-up': {
    label: 'Move up',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M8 13V3M4 7l4-4 4 4' }],
  },
  'arrow-down': {
    label: 'Move down',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M8 3v10M4 9l4 4 4-4' }],
  },
  'arrow-right': {
    label: 'Go to',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M3 8h10M9 4l4 4-4 4' }],
  },
  'chevron-down': {
    label: 'Open list',
    group: 'action',
    src: 'redraw',
    parts: [{ d: 'M4 6l4 4 4-4' }],
  },
  // ── status (colour comes from the status, never amber) ──────────────────────────────────────
  error: {
    label: 'Error',
    group: 'status',
    src: 'redraw',
    parts: [{ circle: [8, 8, 6.5] }, { d: 'M8 4.7v3.9' }, { circle: [8, 11.2, 0.9], fill: true }],
  },
  warning: {
    label: 'Warning',
    group: 'status',
    src: 'redraw',
    parts: [
      { d: 'M6.8 2.7a1.4 1.4 0 0 1 2.4 0l5.1 9a1.4 1.4 0 0 1-1.2 2.1H2.9a1.4 1.4 0 0 1-1.2-2.1z' },
      { d: 'M8 6v3.3' },
      { circle: [8, 11.6, 0.85], fill: true },
    ],
  },
  info: {
    label: 'Note',
    group: 'status',
    src: 'redraw',
    parts: [{ circle: [8, 8, 6.5] }, { d: 'M8 7.3v4' }, { circle: [8, 4.9, 0.9], fill: true }],
  },
  success: {
    label: 'Done',
    group: 'status',
    src: 'redraw',
    parts: [{ circle: [8, 8, 6.5] }, { d: 'M5.2 8.2l2 2 3.6-3.8' }],
  },
  'not-started': {
    label: 'Not started',
    group: 'status',
    src: 'redraw',
    parts: [{ circle: [8, 8, 6.5], dash: '2.55 2.55' }],
  },
  busy: {
    label: 'Working',
    group: 'status',
    src: 'redraw',
    parts: [{ d: 'M14.5 8A6.5 6.5 0 1 1 8 1.5' }],
  },
  clock: {
    label: 'Waiting',
    group: 'status',
    src: 'redraw',
    parts: [{ circle: [8, 8, 6.5] }, { d: 'M8 4.5V8l2.5 1.5' }],
  },
  lock: {
    label: 'Locked',
    group: 'status',
    src: 'redraw',
    parts: [{ rect: [3, 7, 10, 7.5, 1.5] }, { d: 'M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2M8 10v1.5' }],
  },
} as const satisfies Record<string, IconDef>

export type IconName = keyof typeof ICON_SET

/** Every icon name, in source order (the gallery and the specimen list them in this order). */
export const ICON_NAMES = Object.keys(ICON_SET) as IconName[]
