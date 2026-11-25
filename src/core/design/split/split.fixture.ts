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
