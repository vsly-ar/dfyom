// B22 icon set proposal (draft, pending user approval in L3). Not wired into the app.
// One source for every icon of the specimen: 16 px grid, 1.35 px stroke, round caps and joins.
// `a: true` marks the accent part (amber while active / in a primary control).
// `src` records provenance: "approved" = shape already in src/renderer/src/ui/icons (own, GPL),
// "new" = drawn for this proposal (own, GPL-3.0-or-later), "lucide" = Lucide 1.77.0 (ISC).
// Doc: design/icons/README.md, docs/conventions/ui.md#icon-set-proposal-v03-b22

/** @typedef {{ d?: string, rect?: number[], circle?: number[], a?: boolean, fill?: boolean, dash?: string }} Part */
/** @typedef {{ id: string, label: string, group: string, src: string, parts: Part[], grid?: number }} Icon */

/** @type {Icon[]} */
export const ICONS = [
  // Operations
  {
    id: 'facing',
    label: 'Facing',
    group: 'Operations',
    src: 'approved',
    parts: [{ rect: [2, 9, 12, 4.5, 1] }, { d: 'M2 6.5h12M2 4h12', a: true }],
  },
  {
    id: 'pocket',
    label: 'Pocket',
    group: 'Operations',
    src: 'approved',
    parts: [{ rect: [2.5, 2.5, 11, 11, 1.5] }, { d: 'M5 6h6M5 8h6M5 10h6', a: true }],
  },
  {
    id: 'profile',
    label: 'Profile',
    group: 'Operations',
    src: 'approved',
    parts: [{ rect: [4.5, 4.5, 7, 7, 1] }, { rect: [2, 2, 12, 12, 3], a: true, dash: '2 2' }],
  },
  {
    id: 'groove',
    label: 'Groove (on)',
    group: 'Operations',
    src: 'new',
    parts: [
      { d: 'M2 4.5h6a5.5 5.5 0 0 1 5.5 5.5v4M2 9.5h6a.5.5 0 0 1 .5.5v4' },
      { d: 'M2 7h6a3 3 0 0 1 3 3v4', a: true },
    ],
  },
  {
    id: 'drilling',
    label: 'Drilling',
    group: 'Operations',
    src: 'approved',
    parts: [{ circle: [8, 8, 3.5] }, { d: 'M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3', a: true }],
  },
  {
    id: 'shape-import',
    label: 'Import shape (SVG)',
    group: 'Operations',
    src: 'new',
    parts: [
      { d: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3' },
      { d: 'M5.5 12.5C5.5 9 10.5 10 10.5 6.5', a: true },
    ],
  },
  {
    id: 'fillet',
    label: 'Fillet',
    group: 'Operations',
    src: 'new',
    parts: [
      { d: 'M2.5 14V8.5M8.5 2.5H14' },
      { d: 'M2.5 8.5V2.5h6', dash: '1 2' },
      { d: 'M2.5 8.5a6 6 0 0 1 6-6', a: true },
    ],
  },
  {
    id: 'tabs',
    label: 'Tabs',
    group: 'Operations',
    src: 'approved',
    parts: [{ d: 'M1.5 10h4M10.5 10h4' }, { d: 'M5.5 10V8h5v2', a: true }],
  },
  // Tools (side view; the cutting end that tells the type apart is the accent)
  {
    id: 'flat-end-mill',
    label: 'Flat end mill',
    group: 'Tools',
    src: 'new',
    parts: [{ d: 'M5 14.5V1.5h6v13M5 6h6M5 11l6-3' }, { d: 'M5 14.5h6', a: true }],
  },
  {
    id: 'bull-nose',
    label: 'Bull nose end mill',
    group: 'Tools',
    src: 'new',
    parts: [
      { d: 'M5 12.5V1.5h6v11M5 6h6M5 11l6-3' },
      { d: 'M5 12.5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2', a: true },
    ],
  },
  {
    id: 'ball-end-mill',
    label: 'Ball end mill',
    group: 'Tools',
    src: 'new',
    parts: [{ d: 'M5 11.5V1.5h6v10M5 6h6M5 10l6-3' }, { d: 'M5 11.5a3 3 0 0 0 6 0', a: true }],
  },
  {
    id: 'v-bit',
    label: 'V-bit',
    group: 'Tools',
    src: 'new',
    parts: [{ d: 'M6 7V1.5h4V7M3.5 7h9' }, { d: 'M3.5 7L8 14.5 12.5 7', a: true }],
  },
  {
    id: 'drill',
    label: 'Drill',
    group: 'Tools',
    src: 'new',
    parts: [{ d: 'M5 11V1.5h6V11M5 7l6-3M5 10.5l6-3' }, { d: 'M5 11l3 3.5 3-3.5', a: true }],
  },
  // UI
  {
    id: 'settings',
    label: 'Settings',
    group: 'UI',
    src: 'lucide',
    grid: 24,
    parts: [
      {
        d: 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915',
      },
      { circle: [12, 12, 3] },
    ],
  },
  {
    id: 'undo',
    label: 'Undo',
    group: 'UI',
    src: 'lucide',
    grid: 24,
    parts: [
      { d: 'M9 14 4 9l5-5' },
      { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11' },
    ],
  },
  {
    id: 'redo',
    label: 'Redo',
    group: 'UI',
    src: 'lucide',
    grid: 24,
    parts: [
      { d: 'm15 14 5-5-5-5' },
      { d: 'M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13' },
    ],
  },
  {
    id: 'library',
    label: 'Library',
    group: 'UI',
    src: 'lucide',
    grid: 24,
    parts: [{ d: 'm16 6 4 14' }, { d: 'M12 6v14' }, { d: 'M8 8v12' }, { d: 'M4 4v16' }],
  },
  {
    id: 'measure',
    label: 'Measure',
    group: 'UI',
    src: 'approved',
    parts: [
      { d: 'M2 11.5L11.5 2 14 4.5 4.5 14z' },
      { d: 'M5 8.5l1.3 1.3M7 6.5l1 1M9 4.5l1.3 1.3', a: true },
    ],
  },
  {
    id: 'snap',
    label: 'Snap',
    group: 'UI',
    src: 'new',
    parts: [
      { circle: [3, 3, 0.9], fill: true },
      { circle: [13, 3, 0.9], fill: true },
      { circle: [3, 13, 0.9], fill: true },
      { circle: [13, 13, 0.9], fill: true },
      { circle: [8, 8, 0.9], fill: true },
      { rect: [5, 5, 6, 6, 0.5], a: true },
    ],
  },
  {
    id: 'setups',
    label: 'Setups',
    group: 'UI',
    src: 'new',
    parts: [
      { d: 'M8 1v3.5M6.5 3L8 4.5 9.5 3M3 8.5V12l5 2.5 5-2.5V8.5M8 11v3.5' },
      { d: 'M3 8.5L8 6l5 2.5L8 11z', a: true },
    ],
  },
  {
    id: 'export-gcode',
    label: 'Export gCode',
    group: 'UI',
    src: 'new',
    parts: [
      { d: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3' },
      { d: 'M10.2 8.25A2.5 2.5 0 1 0 10.5 10H8.5', a: true },
    ],
  },
  {
    id: 'run',
    label: 'Run',
    group: 'UI',
    src: 'new',
    parts: [{ circle: [8, 8, 6.5] }, { d: 'M6.5 5.3l4 2.7-4 2.7z', a: true }],
  },
  {
    id: 'reference',
    label: 'Reference model',
    group: 'UI',
    src: 'new',
    parts: [{ d: 'M8 2.5l6 11H2z' }, { d: 'M5 8h6l-3 5.5z', a: true }],
  },
  {
    id: 'work-zero',
    label: 'Work zero',
    group: 'UI',
    src: 'approved',
    parts: [{ d: 'M2 14V2M2 14h12M6 10l3-3' }, { circle: [2, 14, 1.6], a: true }],
  },
]

const STROKE_16 = 1.35

/**
 * One icon as SVG markup.
 * @param {Icon} icon
 * @param {{ size?: number, accent?: string, color?: string, standalone?: boolean }} [o]
 */
export function iconSvg(icon, o = {}) {
  const grid = icon.grid ?? 16
  const size = o.size ?? 16
  // Stroke stays 1.35 px at 16 px whatever the grid: Lucide's 2 on 24 is 1.333 at 16.
  const sw = +((STROKE_16 * grid) / 16).toFixed(3)
  const color = o.color ?? 'currentColor'
  const accent = o.accent ?? color
  const el = (p) => {
    const stroke = p.a ? accent : color
    const common = p.fill
      ? `fill="${stroke}" stroke="none"`
      : `fill="none" stroke="${stroke}"${p.dash ? ` stroke-dasharray="${p.dash}"` : ''}`
    const tag = p.a ? ' data-accent=""' : ''
    if (p.d) return `<path${tag} d="${p.d}" ${common}/>`
    if (p.rect) {
      const [x, y, w, h, r] = p.rect
      return `<rect${tag} x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ${common}/>`
    }
    const [cx, cy, r] = p.circle
    return `<circle${tag} cx="${cx}" cy="${cy}" r="${r}" ${common}/>`
  }
  const ns = o.standalone ? ' xmlns="http://www.w3.org/2000/svg"' : ''
  return (
    `<svg${ns} viewBox="0 0 ${grid} ${grid}" width="${size}" height="${size}" stroke-width="${sw}" ` +
    `stroke-linecap="round" stroke-linejoin="round" data-icon="${icon.id}">${icon.parts.map(el).join('')}</svg>`
  )
}
