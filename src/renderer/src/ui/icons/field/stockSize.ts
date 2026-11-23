// Field illustrations of the stock's size (dogfood DF11): one oblique block (front face, top and
// right side, viewBox 20) with the measured edge as the amber line – the front bottom edge (X),
// the receding bottom edge on the right (Y), the front right vertical edge (Z); the three meet at
// one corner. Plain data, so design/icons/render.mjs draws the review sheet from the same source.
// Doc: docs/conventions/ui.md#stock-dialog-df11df13, #field

/** The block's outline: front face, top face, right side. */
const BLOCK = 'M2 10H14V16H2Z M2 10L7 5H19L14 10 M19 5V11L14 16'

export const STOCK_SIZE_ICONS = {
  'stock-length': { d: BLOCK, accent: 'M2 16H14' },
  'stock-width': { d: BLOCK, accent: 'M14 16L19 11' },
  'stock-thickness': { d: BLOCK, accent: 'M14 10V16' },
} as const satisfies Record<string, { d: string; accent: string }>
