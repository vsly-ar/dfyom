// Suggested gCode file names. Spec: docs/architecture/grbl.md#file-name-hardening-df62
import { describe, expect, it } from 'vitest'
import type { ProjectDoc } from '../project/document'
import { FILE_STEM_MAX, fileSlug, gcodeFileStem } from './file-name'

/** Just the fields the file name reads: project name, plans and their setups' ids. */
function doc(name: string, plans: Record<string, number>): ProjectDoc {
  const entries = Object.entries(plans).map(([id, n]) => [
    id,
    { setups: Array.from({ length: n }, (_, k) => ({ id: `${id}-s${k}` })) },
  ])
  return { name, plans: Object.fromEntries(entries) } as unknown as ProjectDoc
}

describe('gcodeFileStem', () => {
  it('shortens the real cut: project slug + setup number, at most 24 characters', () => {
    const d = doc('enclosure-hardwood-250x100x40-two-setups', { a: 2 })
    expect(gcodeFileStem(d, 'a', 'a-s0')).toBe('enclosure-hardwood-s1')
    expect(gcodeFileStem(d, 'a', 'a-s1')).toBe('enclosure-hardwood-s2')
  })

  it('adds suffixes only where needed to tell files apart', () => {
    expect(gcodeFileStem(doc('Bracket', { a: 1 }), 'a', 'a-s0')).toBe('bracket')
    expect(gcodeFileStem(doc('Bracket', { a: 1 }), 'a')).toBe('bracket')
    const two = doc('Bracket', { a: 1, b: 3 })
    expect(gcodeFileStem(two, 'a', 'a-s0')).toBe('bracket-p1')
    expect(gcodeFileStem(two, 'b', 'b-s2')).toBe('bracket-p2-s3')
  })

  it('is unique per setup and never longer than the limit', () => {
    const d = doc('Ein sehr langer Projektname mit Überlänge 1/4" Platte', { a: 2, b: 12 })
    const names = [
      ...[0, 1].map((k) => gcodeFileStem(d, 'a', `a-s${k}`)),
      ...Array.from({ length: 12 }, (_, k) => gcodeFileStem(d, 'b', `b-s${k}`)),
    ]
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(FILE_STEM_MAX)
      expect(n).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
    expect(names[0]).toBe('ein-sehr-langer-p1-s1')
  })

  it('cuts a long word hard and falls back for names without ASCII letters', () => {
    expect(gcodeFileStem(doc('x'.repeat(40), { a: 1 }), 'a')).toBe('x'.repeat(24))
    expect(gcodeFileStem(doc('ステンレス', { a: 1 }), 'a')).toBe('program')
  })
})

describe('fileSlug', () => {
  it('keeps letters and digits, inches after a digit, accents dropped', () => {
    expect(fileSlug('Lid 1/4″ (v2) – Ålu')).toBe('lid-1-4in-v2-alu')
    expect(fileSlug('Panel 3" wide')).toBe('panel-3in-wide')
    expect(fileSlug('--')).toBe('')
  })
})
