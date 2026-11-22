/**
 * GRBL `$$` setting lines (`$110=5000.000`), read tolerantly: the sender's handshake classifies
 * each received line with `parseSettingLine` (status.ts `parseLine`), and the library's `$$` import
 * reads text pasted from any sender with `parseSettingsText`. Pure; values as printed (GRBL
 * settings are always mm, mm/min, mm/s², rpm).
 * Docs: docs/architecture/library.md#grbl--import, docs/modes/run-v0.1.md#sender
 *
 * Origin: the line rule is ported from cnc-code `src/core/model/grblSettings.ts` (same author,
 * relicensed under GPL-3.0-or-later for DFYOM).
 */
import { None, Some, type Option } from '../../../shared/result'

export interface GrblSetting {
  readonly n: number
  readonly value: number
}

/**
 * `$<n>=<number>` at the line start or after a space, ending at the line end, a space, `(` or `;`.
 * Sender prefixes (`>>> `, `[rx] `) and GRBL builds' descriptions (`(x max rate, mm/min)`) differ.
 */
const SETTING = /(?:^|\s)\$(\d+)\s*=\s*([-+]?(?:\d+\.?\d*|\.\d+))(?=[\s(;]|$)/

/** One line → its setting, or None (any other line: `ok`, the banner, `[MSG:…]`, junk). */
export function parseSettingLine(line: string): Option<GrblSetting> {
  const m = SETTING.exec(line)
  if (m === null) return None
  const n = Number(m[1])
  const value = Number(m[2])
  return Number.isSafeInteger(n) && Number.isFinite(value) ? Some({ n, value }) : None
}

/** Pasted `$$` output: every setting found (a later duplicate wins) and the lines ignored. */
export interface SettingsText {
  readonly settings: ReadonlyMap<number, number>
  /** Non-blank lines that held no setting. */
  readonly ignoredLines: number
}

export function parseSettingsText(text: string): SettingsText {
  const settings = new Map<number, number>()
  let ignoredLines = 0
  for (const line of text.split(/\r\n|\r|\n/)) {
    const s = parseSettingLine(line)
    if (s.isSome()) settings.set(s.unwrap().n, s.unwrap().value)
    else if (line.trim() !== '') ignoredLines++
  }
  return { settings, ignoredLines }
}
