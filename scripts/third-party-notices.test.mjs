// The third-party notices script (PK1): the vendored-asset list matches what is vendored, and the
// licence check accepts GPL-3.0-compatible licences only. Doc: docs/conventions/packaging.md#third-party-notices
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  licenceAllowed,
  packageLicence,
  renderNotices,
  ROOT,
  summaryByLicence,
  VENDORED,
} from './third-party-notices.mjs'

const FONT = /\.(woff2?|ttf|otf|eot)$/i

/** Directories under vendor/ and font files under src/ and vendor/: what VENDORED must list. */
function vendoredOnDisk() {
  const found = readdirSync(join(ROOT, 'vendor'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `vendor/${e.name}`)
  for (const dir of ['src', 'vendor'])
    for (const e of readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true }))
      if (e.isFile() && FONT.test(e.name))
        found.push(relative(ROOT, join(e.parentPath, e.name)).replaceAll('\\', '/'))
  return found.sort()
}

describe('vendored assets', () => {
  it('VENDORED lists every vendor/ directory and font file, and nothing else', () => {
    expect(VENDORED.map((v) => v.path).sort()).toEqual(vendoredOnDisk())
  })

  it('each has its notices and an allowed licence', () => {
    for (const v of VENDORED) {
      const notices = join(ROOT, v.notices)
      expect(existsSync(notices), v.notices).toBe(true)
      expect(readFileSync(notices, 'utf8').trim()).not.toBe('')
      expect(licenceAllowed(v.licence), v.licence).toBe(true)
    }
  })
})

describe('licence check', () => {
  it('accepts permissive, weak copyleft and GPL-3.0-compatible GPL licences', () => {
    for (const ok of [
      'MIT',
      'ISC',
      'Apache-2.0',
      'BSD-3-Clause',
      '0BSD',
      'BSL-1.0',
      'GPL-2.0+',
      'GPL-3.0-or-later',
      'LGPL-3.0-only',
      '(MIT OR Apache-2.0)',
      'MIT AND ISC',
      'Apache-2.0 WITH LLVM-exception',
      '(BSD-2-Clause OR Apache-2.0 OR MIT)',
    ])
      expect(licenceAllowed(ok), ok).toBe(true)
  })

  it('refuses GPL-2.0-only, SSPL, proprietary, unknown and malformed', () => {
    for (const bad of [
      'GPL-2.0-only',
      'GPL-2.0',
      'SSPL-1.0',
      'UNLICENSED',
      'SEE LICENSE IN LICENSE.md',
      'MIT AND GPL-2.0-only',
      '(MIT',
      'MIT OR',
      '',
      undefined,
    ])
      expect(licenceAllowed(bad), String(bad)).toBe(false)
  })

  it('an OR needs one allowed side', () => {
    expect(licenceAllowed('(GPL-2.0-only OR MIT)')).toBe(true)
  })

  it('reads the legacy package.json forms', () => {
    expect(packageLicence({ license: 'MIT' })).toBe('MIT')
    expect(packageLicence({ license: { type: 'ISC' } })).toBe('ISC')
    expect(packageLicence({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe(
      '(MIT OR Apache-2.0)',
    )
    expect(packageLicence({})).toBeUndefined()
  })
})

describe('notices text', () => {
  it('summarises by licence and includes each text', () => {
    const entries = [
      { name: 'a', version: '1.0.0', licence: 'MIT', usedIn: ['x'], source: '', texts: ['A'] },
      { name: 'b', version: '2.0.0', licence: 'ISC', usedIn: ['y'], source: 'u', texts: ['B'] },
      { name: 'c', version: '3.0.0', licence: 'MIT', usedIn: ['x'], source: '', texts: ['C'] },
    ]
    expect(summaryByLicence(entries)).toEqual([
      ['MIT', ['a', 'c']],
      ['ISC', ['b']],
    ])
    const text = renderNotices(entries)
    expect(text).toContain('  MIT (2)')
    expect(text).toContain('b 2.0.0\nLicence: ISC\nUsed in: y\nSource: u\n\nB')
  })
})
