// APCA lightness contrast (Lc) for the token contrast test. Rules: docs/conventions/ui.md#colour,
// decision: docs/decisions/0017-apca-contrast-for-design-tokens.md
//
// Our own implementation of the published APCA-W3 formula, version 0.0.98G-4g (constants as
// published in the W3C Silver / WCAG 3 draft "Visual Contrast of Text" and in Myndex/apca-w3
// `APCAcontrast` / `sRGBtoY`, https://github.com/Myndex/apca-w3). The `apca-w3` npm package is not
// a dependency: it ships under the "Limited W3 License", which is not GPL-compatible (ADR 0014).
// Test-only: the app never computes contrast at runtime.

/** APCA-W3 0.0.98G-4g constants. */
const MAIN_TRC = 2.4
const [R_CO, G_CO, B_CO] = [0.2126729, 0.7151522, 0.072175]
const NORM_BG = 0.56
const NORM_TXT = 0.57
const REV_TXT = 0.62
const REV_BG = 0.65
const BLK_THRS = 0.022
const BLK_CLMP = 1.414
const SCALE_BOW = 1.14
const SCALE_WOB = 1.14
const LO_BOW_OFFSET = 0.027
const LO_WOB_OFFSET = 0.027
const DELTA_Y_MIN = 0.0005
const LO_CLIP = 0.1

/** Screen luminance Y of an opaque `#rrggbb` colour (APCA's simple 2.4 power curve, not sRGB's piecewise one). */
export function apcaY(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m?.[1]) throw new Error(`not an opaque #rrggbb colour: ${hex}`)
  const h = m[1]
  const [r, g, b] = [0, 2, 4].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255) ** MAIN_TRC) as [
    number,
    number,
    number,
  ]
  return R_CO * r + G_CO * g + B_CO * b
}

/**
 * Signed APCA lightness contrast Lc of `text` on `background` (order matters): positive for dark
 * text on a light background, negative for light text on a dark one; roughly −108 … +106.
 */
export function apcaLc(text: string, background: string): number {
  const clamp = (y: number): number => (y > BLK_THRS ? y : y + (BLK_THRS - y) ** BLK_CLMP)
  const txtY = clamp(apcaY(text))
  const bgY = clamp(apcaY(background))
  if (Math.abs(bgY - txtY) < DELTA_Y_MIN) return 0
  if (bgY > txtY) {
    const sapc = (bgY ** NORM_BG - txtY ** NORM_TXT) * SCALE_BOW
    return sapc < LO_CLIP ? 0 : (sapc - LO_BOW_OFFSET) * 100
  }
  const sapc = (bgY ** REV_BG - txtY ** REV_TXT) * SCALE_WOB
  return sapc > -LO_CLIP ? 0 : (sapc + LO_WOB_OFFSET) * 100
}
