/* global console */
// Rewrites the icon sheet of docs/conventions/ui-design-system.html (the block between
// `icons:begin` and `icons:end`) from the single source, src/renderer/src/ui/icons/iconSet.ts.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON design/icons/b22/sync-page.mjs
// ui/icons/icons.test.tsx fails while the page is out of date. Doc: design/icons/README.md
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ICON_SET } from '../../../src/renderer/src/ui/icons/iconSet.ts'

const ROOT = resolve(import.meta.dirname, '../../..')
const inner = (parts) =>
  parts
    .map((p) => {
      const cls = [p.a ? 'hi' : '', p.fill ? 'f' : ''].filter(Boolean).join(' ')
      const c = cls ? ` class="${cls}"` : ''
      const dash = p.dash ? ` stroke-dasharray="${p.dash}"` : ''
      if (p.d) return `<path${c} d="${p.d}"${dash}/>`
      if (p.rect) {
        const [x, y, w, h, r] = p.rect
        return `<rect${c} x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"${dash}/>`
      }
      const [cx, cy, r] = p.circle
      return `<circle${c} cx="${cx}" cy="${cy}" r="${r}"${dash}/>`
    })
    .join('')
const lines = Object.entries(ICON_SET)
  .filter(([, i]) => !i.reserved)
  .map(([k, i]) => `  '${k}': ['${i.label.replace(/'/g, "\\'")}', '${inner(i.parts)}'],`)
const block = `/* icons:begin, generated from src/renderer/src/ui/icons/iconSet.ts (B22, D33); checked by ui/icons/icons.test.tsx */\nconst I = {\n${lines.join('\n')}\n};\n/* icons:end */`
const file = ROOT + '/docs/conventions/ui-design-system.html'
let s = readFileSync(file, 'utf8')
const start = s.indexOf('/* icons:begin')
const end = s.indexOf('/* icons:end */') + '/* icons:end */'.length
if (start < 0 || end < start) throw new Error('icons:begin / icons:end markers not found')
writeFileSync(file, s.slice(0, start) + block + s.slice(end))
console.log(`${lines.length} icons written to ${file}`)
