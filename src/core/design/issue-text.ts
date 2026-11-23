/**
 * Readable text of a part's validation issues: the owning item by its name and the field in plain
 * words ("Pocket 1 depth: must end above the stock bottom"), never an id or a raw path (DF43,
 * docs/conventions/ui.md#selection-and-picking). The issue keeps its `path` and `params` for agents;
 * only the visible sentence is built here.
 */
import type { Issue } from '../../shared/errors/app-error'
import type { PartDTO } from './part.dto'

/** Fields whose words are not their key split at capitals. */
const WORDS: Readonly<Record<string, string>> = {
  on: 'start surface',
  edgeOf: 'edge',
  'shape.center.0': "shape's centre X",
  'shape.center.1': "shape's centre Y",
  'shape.cornerRadius': 'corner radius',
  'tabs.count': 'tab count',
  'tabs.width': 'tab width',
  'tabs.thickness': 'tab thickness',
  'tabs.positions': 'tab positions',
}

/** `slotWidth` → "slot width". */
const spaced = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()

/**
 * A field path in plain words: "depth", "corner radius", "tab 2 position", "shape's centre X";
 * the empty path is "".
 */
export function fieldWords(path: readonly (string | number)[]): string {
  const key = path.join('.')
  const known = WORDS[key]
  if (known !== undefined) return known
  const tab = /^tabs\.positions\.(\d+)$/.exec(key)
  if (tab) return `tab ${Number(tab[1]) + 1} position`
  return path
    .map((s) => (typeof s === 'number' || /^\d+$/.test(s) ? `${Number(s) + 1}` : spaced(s)))
    .join(' ')
}

type Named = { readonly id: string; readonly name?: string }

/** The collections an issue path may start with, and the word for an item no longer there. */
const OWNERS: Readonly<Record<string, readonly [(p: PartDTO) => readonly Named[], string]>> = {
  operations: [(p) => p.operations, 'An operation'],
  features: [(p) => p.features ?? [], 'A feature'],
  shapes: [(p) => (p as { shapes?: readonly Named[] }).shapes ?? [], 'A shape'],
}

/**
 * The issue as one sentence fragment: "Pocket 1 depth: must be greater than 0",
 * "Chamfer 1 edge: must be an earlier drilling…"; a reference to a surface the part no longer
 * has (`referenced`) reads "Pocket 2 depth: refers to a surface that is not on the stock or an
 * earlier operation". Paths outside a named item read "<field words>: <message>".
 */
export function partIssueText(
  part: PartDTO,
  issue: Pick<Issue, 'path' | 'message'> & { readonly rule?: string },
): string {
  const [head, id, ...rest] = issue.path
  const owner = typeof head === 'string' ? OWNERS[head] : undefined
  const message =
    issue.rule === 'referenced'
      ? rest.length === 1 && rest[0] === 'on'
        ? 'is not a surface of the stock or an earlier operation'
        : 'refers to a surface that is not on the stock or an earlier operation'
      : issue.message
  if (owner !== undefined && typeof id === 'string') {
    const [items, unknown] = owner
    const name = items(part).find((o) => o.id === id)?.name ?? unknown
    const field = fieldWords(rest)
    return field === '' ? `${name}: ${message}` : `${name} ${field}: ${message}`
  }
  const field = fieldWords(issue.path)
  return field === '' ? message : `${field}: ${message}`
}
