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
  // feature labels (plan-v0.4.md P-E): "Hole 1 · drill × 6" → "Hole 1 - drill x 6"
  '·': '-',
  '×': 'x',
}

/**
 * Comment text as printable ASCII GRBL cannot mistake for realtime commands: drops `?!~()` and
 * `;`, maps `″` → `in`, `ø`/`Ø`/`⌀` → `dia`, `°` → ` deg` ("90 deg chamfer mill"), other
 * whitespace → space, anything else → `_`.
 */
export function sanitizeComment(text: string): string {
  return sanitizeChars(text).replace(/ {2,}/g, ' ').trim()
}

/** `sanitizeComment` per character, spaces kept as they are. */
function sanitizeChars(text: string): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if ('?!~();'.includes(ch)) continue
    if (c >= 0x20 && c < 0x7f) out += ch
    else if (REPLACE[ch] !== undefined) out += REPLACE[ch]
    else if (/\s/u.test(ch)) out += ' '
    else out += '_'
  }
  return out
}

/**
 * A comment line `(text)`, sanitized and truncated to MAX_LINE_BYTES; a cut text ends at its last
 * word boundary (a space, after a comma) instead of mid-word, unless that drops over half of it.
 */
export function commentLine(text: string): string {
  return `(${fitComment(text, MAX_LINE_BYTES - 2)})`
}

/** `text` sanitized and cut to `room` bytes at a word boundary (as `commentLine`). */
function fitComment(text: string, room: number): string {
  const clean = sanitizeComment(text)
  if (clean.length <= room) return clean
  const cut = clean.slice(0, room)
  const space = clean[room] === ' ' ? room : cut.lastIndexOf(' ')
  const head = space > room / 2 ? cut.slice(0, space) : cut
  return head.trimEnd().replace(/,$/, '')
}

/**
 * `head + name + tail` with the name cut (at its end) so the sanitized whole fits `room` bytes;
 * the head and tail (tool number, diameter, type, instruction) always survive.
 */
export function fitName(head: string, name: string, tail: string, room: number): string {
  const h = sanitizeChars(head)
  const t = sanitizeChars(tail)
  const n = sanitizeComment(name)
  const left = room - h.length - t.length
  if (n.length <= left) return `${h}${n}${t}`
  const part = n.slice(0, Math.max(0, left))
  const space = n[left] === ' ' ? left : part.lastIndexOf(' ')
  const cut = (space > left / 2 ? part.slice(0, space) : part).trimEnd()
  return `${h}${cut}${t}`
}

/** Marker of a DFYOM tool change (the whole line; the sender rule in grbl.md matches it). */
export function toolChangeMarker(number: number, name: string, tail = ''): string {
  return `(${fitName(`DFYOM TOOL CHANGE ${number}: `, name, tail, MAX_LINE_BYTES - 2)})`
}

/**
 * A pause: `M0 ;text`, the message senders show at the pause (gSender reads the `M0` line's
 * comment; grbl.md#pause-messages-hardening-df63). Sanitized and cut like `commentLine`.
 */
export function pauseLine(text: string): string {
  const head = 'M0 ;'
  return `${head}${fitComment(text, MAX_LINE_BYTES - head.length)}`
}
