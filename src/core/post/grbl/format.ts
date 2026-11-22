/**
 * Number, comment and line formatting of the GRBL post-processor.
 * Doc: docs/architecture/grbl.md#numbers-lines-and-comments
 */

/** DFYOM rule: every line ≤ 70 bytes (GRBL's line buffer is 80). */
export const MAX_LINE_BYTES = 70

/** Largest magnitude the post writes (keeps every number free of exponents and lines short). */
export const MAX_ABS_VALUE = 99_999

/**
 * `v` rounded to `decimals` places, half away from zero from its shortest decimal form (so
 * 1.0005 → 1.001 although the double is slightly below), without trailing zeros, a trailing `.`,
 * an exponent or `-0`, with the leading `0` kept (`0.5`). `v` must be finite and
 * |v| ≤ MAX_ABS_VALUE (the post checks this first).
 */
export function formatNumber(v: number, decimals: number): string {
  const abs = Math.abs(v)
  // Below 1e-6 the shortest form has an exponent; such values round to 0 at ≤ 5 decimals.
  if (abs < 1e-6) return '0'
  const [int = '0', frac = ''] = String(abs).split('.')
  let n = BigInt(int + frac.padEnd(decimals, '0').slice(0, decimals))
  if ((frac[decimals] ?? '0') >= '5') n += 1n
  if (n === 0n) return '0'
  const digits = n.toString().padStart(decimals + 1, '0')
  const head = digits.slice(0, digits.length - decimals)
  const tail = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${v < 0 ? '-' : ''}${head}${tail === '' ? '' : `.${tail}`}`
}

const REPLACE: Readonly<Record<string, string>> = {
  '″': 'in',
  ø: 'dia',
  Ø: 'dia',
  '⌀': 'dia',
  '°': ' deg',
}

/**
 * Comment text as printable ASCII GRBL cannot mistake for realtime commands: drops `?!~()` and
 * `;`, maps `″` → `in`, `ø`/`Ø`/`⌀` → `dia`, `°` → ` deg` ("90 deg chamfer mill"), other
 * whitespace → space, anything else → `_`.
 */
export function sanitizeComment(text: string): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if ('?!~();'.includes(ch)) continue
    if (c >= 0x20 && c < 0x7f) out += ch
    else if (REPLACE[ch] !== undefined) out += REPLACE[ch]
    else if (/\s/u.test(ch)) out += ' '
    else out += '_'
  }
  return out.replace(/ {2,}/g, ' ').trim()
}

/** A comment line `(text)`, sanitized and truncated to MAX_LINE_BYTES. */
export function commentLine(text: string): string {
  return `(${sanitizeComment(text)
    .slice(0, MAX_LINE_BYTES - 2)
    .trimEnd()})`
}

/** Marker of a DFYOM tool change (the whole line; the sender rule in grbl.md matches it). */
export function toolChangeMarker(number: number, name: string): string {
  const head = `DFYOM TOOL CHANGE ${number}: `
  const room = MAX_LINE_BYTES - 2 - head.length
  return `(${head}${sanitizeComment(name).slice(0, Math.max(0, room)).trimEnd()})`
}
