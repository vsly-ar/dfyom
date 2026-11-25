// Test-only: an enclosure like the user's (docs/modes/split-parts.md#user-story-the-enclosure),
// built from scratch (the user's file is never copied): a 250 × 200 × 80 block faced 9.738 mm on
// both sides, a 249.5 × 177 outline, a cavity 56.29 mm deep with 7 mm walls (11 mm at the back)
// and four rim holes. Not app code. Doc: docs/modes/split-parts.md#implementation-4a

/** The block, as `library.stock.add` / `design.part.add { stock }` values. */
export const ENCLOSURE_STOCK = {
  name: 'Block 250 × 200 × 80',
  shape: 'block' as const,
  length: '250',
  width: '200',
  thickness: '80',
  material: { name: 'Eucalyptus', class: 'hardwood' as const },
}

/** Faced 9.738 mm on both sides: the part spans z −70.262 … −9.738; mid-height −40. */
export const ENCLOSURE_LEVEL = '-40'

/** The design commands (name, args) after the part exists. */
export function enclosureCommands(partId: string): [string, object][] {
  const hole = (x: string, y: string) => [
    'design.drilling.add',
    {
      partId,
      on: 'facing2.floor',
      center: [x, y],
      diameter: '5',
      bottom: 'flat',
      depth: '10',
    },
  ]
  return [
    ['design.facing.add', { partId, on: 'stock.bottom', depth: '9.738' }],
    ['design.facing.add', { partId, depth: '9.738' }],
    [
      'design.pocket.add',
      {
        partId,
        on: 'facing2.floor',
        shape: {
          kind: 'rectangle',
          center: ['125', '98'],
          length: '235.5',
          width: '159',
          cornerRadius: '4',
        },
        depth: '56.29',
      },
    ],
    hole('51.5', '15'),
    hole('198.5', '15'),
    hole('44.5', '183'),
    hole('205.5', '183'),
    [
      'design.profile.add',
      {
        partId,
        shape: {
          kind: 'rectangle',
          center: ['125', '100'],
          length: '249.5',
          width: '177',
          cornerRadius: '4',
        },
        slotWidth: '6',
        tabs: { count: '4', width: '6', thickness: '2' },
      },
    ],
  ] as [string, object][]
}

// ── the proposal's exit part (split parts 4b-2) ──────────────────────────────────────────────

/**
 * A 600 × 400 mm panel of 18 mm plywood (the proposal's exit, docs/modes/split-parts.md#slices):
 * a 610 × 410 sheet with a 600 × 400 outline, two 8 mm holes and a pocket. Split by one line at
 * x = 305 with a key; its two pieces fit an 800 × 800 machine.
 */
export const PANEL_STOCK = {
  name: 'Plywood 610 × 410 × 18',
  shape: 'block' as const,
  length: '610',
  width: '410',
  thickness: '18',
  material: { name: 'Birch plywood', class: 'sheetGood' as const },
}

/** The panel's line: through the middle, away from its features. */
export const PANEL_LINE = { axis: 'x' as const, at: '305' }

export function panelCommands(partId: string): [string, object][] {
  const hole = (x: string, y: string) => [
    'design.drilling.add',
    { partId, center: [x, y], diameter: '8', bottom: 'through' },
  ]
  return [
    hole('60', '60'),
    hole('550', '350'),
    [
      'design.pocket.add',
      {
        partId,
        shape: {
          kind: 'rectangle',
          center: ['150', '205'],
          length: '120',
          width: '80',
          cornerRadius: '5',
        },
        depth: '6',
      },
    ],
    [
      'design.profile.add',
      {
        partId,
        shape: {
          kind: 'rectangle',
          center: ['305', '205'],
          length: '600',
          width: '400',
          cornerRadius: '3',
        },
        slotWidth: '6',
        tabs: { count: '6', width: '6', thickness: '2' },
      },
    ],
  ] as [string, object][]
}

// ── the 4d exit part ─────────────────────────────────────────────────────────────────────────

/**
 * A 1000 × 300 mm shelf of 18 mm plywood (split parts 4d exit, docs/modes/split-parts.md#slices):
 * a 1010 × 310 board, longer than the 800 mm travel of the test machine, with a 1000 × 300
 * outline, two 8 mm holes and a pocket. Split by one line at x = 505 with a finger joint; its two
 * pieces fit the machine.
 */
export const LONG_PANEL_STOCK = {
  name: 'Plywood 1010 × 310 × 18',
  shape: 'block' as const,
  length: '1010',
  width: '310',
  thickness: '18',
  material: { name: 'Birch plywood', class: 'sheetGood' as const },
}

/** The shelf's line: through the middle, away from its features. */
export const LONG_PANEL_LINE = { axis: 'x' as const, at: '505' }

export function longPanelCommands(partId: string): [string, object][] {
  const hole = (x: string, y: string) => [
    'design.drilling.add',
    { partId, center: [x, y], diameter: '8', bottom: 'through' },
  ]
  return [
    hole('40', '40'),
    hole('970', '270'),
    [
      'design.pocket.add',
      {
        partId,
        shape: {
          kind: 'rectangle',
          center: ['250', '155'],
          length: '160',
          width: '80',
          cornerRadius: '5',
        },
        depth: '6',
      },
    ],
    [
      'design.profile.add',
      {
        partId,
        shape: {
          kind: 'rectangle',
          center: ['505', '155'],
          length: '1000',
          width: '300',
          cornerRadius: '3',
        },
        slotWidth: '6',
        tabs: { count: '6', width: '6', thickness: '2' },
      },
    ],
  ] as [string, object][]
}
