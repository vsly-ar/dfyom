/**
 * The suggested gCode file name of one setup's program: short, and unique per setup within the
 * project. Doc: docs/architecture/grbl.md#file-name-hardening-df62
 */
import type { ProjectDoc } from '../project/document'

/** Longest suggested file name, without extension. */
export const FILE_STEM_MAX = 24

/** Stem when the project name has no ASCII letter or digit. */
const FALLBACK = 'program'

/** Lower-case ASCII letters and digits; every other run one `-` (`1/4″`, `1/4"` → `1-4in`). */
export function fileSlug(name: string): string {
  return name
    .replace(/(\d)\s*["\u2033]/g, '$1in')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * `<project slug>[-p<k>][-s<n>]`, at most FILE_STEM_MAX characters: `-p` when the project has
 * several plans (k: the plan's position), `-s` when the plan has several setups (n: machining
 * order). An unknown plan or setup gets no suffix for it.
 */
export function gcodeFileStem(doc: ProjectDoc, planId: string, setupId?: string): string {
  const planIds = Object.keys(doc.plans)
  const plan = doc.plans[planId]
  let suffix = ''
  const k = planIds.indexOf(planId)
  if (planIds.length > 1 && k >= 0) suffix += `-p${k + 1}`
  const setups = plan?.setups ?? []
  const n = setups.findIndex((s) => s.id === setupId)
  if (setups.length > 1 && n >= 0) suffix += `-s${n + 1}`
  const slug = fileSlug(doc.name) || FALLBACK
  const room = FILE_STEM_MAX - suffix.length
  if (slug.length <= room) return slug + suffix
  const cut = slug.slice(0, room)
  const dash = slug[room] === '-' ? room : cut.lastIndexOf('-')
  const head = dash >= room / 2 ? cut.slice(0, dash) : cut
  return head.replace(/-+$/, '') + suffix
}
