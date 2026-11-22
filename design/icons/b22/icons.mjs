// The B22 icon set for the specimen sheets and the standalone SVG exports. The single source is
// src/renderer/src/ui/icons/iconSet.ts (also rendered by the app's Icon component); Node strips its
// types, so this module only adapts it. Doc: design/icons/README.md, docs/conventions/ui.md#icons
import { ICON_SET } from '../../../src/renderer/src/ui/icons/iconSet.ts'

/** @typedef {{ d?: string, rect?: readonly number[], circle?: readonly number[], a?: boolean, fill?: boolean, dash?: string }} Part */
/** @typedef {{ id: string, label: string, group: string, src: string, reserved?: string, parts: readonly Part[] }} Icon */

/** @type {Icon[]} */
export const ICONS = Object.entries(ICON_SET).map(([id, icon]) => ({ id, ...icon }))

const STROKE_16 = 1.35

/**
 * One icon as SVG markup.
 * @param {Icon} icon
 * @param {{ size?: number, accent?: string, color?: string, standalone?: boolean }} [o]
 */
export function iconSvg(icon, o = {}) {
  const size = o.size ?? 16
  const color = o.color ?? 'currentColor'
  const accent = o.accent ?? color
  /** @param {Part} p */
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
    const [cx, cy, r] = p.circle ?? []
    return `<circle${tag} cx="${cx}" cy="${cy}" r="${r}" ${common}/>`
  }
  const ns = o.standalone ? ' xmlns="http://www.w3.org/2000/svg"' : ''
  return (
    `<svg${ns} viewBox="0 0 16 16" width="${size}" height="${size}" stroke-width="${STROKE_16}" ` +
    `stroke-linecap="round" stroke-linejoin="round" data-icon="${icon.id}">${icon.parts.map(el).join('')}</svg>`
  )
}
