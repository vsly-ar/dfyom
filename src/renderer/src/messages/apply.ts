// User-facing strings of Apply (task P3): the toolbar button, its tooltip and live region, the
// pending marks on warnings, plans and toolpaths. Doc: docs/architecture/apply.md#ui,
// docs/conventions/ui.md#internationalization

/** "3 changes", "1 change". */
const changes = (n: number) => (n === 1 ? '1 change' : `${n} changes`)

/** Who applied, for "Applied by agent" (the source kinds other than a window). */
const BY: Readonly<Record<string, string>> = {
  agent: 'agent',
  cli: 'command line',
  automation: 'automation',
  system: 'DFYOM',
}

/** A dotted, camel-cased field path as words: `shape.cornerRadius` → "corner radius". */
export function fieldWords(field: string): string {
  if (!/^[A-Za-z0-9.]+$/.test(field)) return field
  const last = field.split('.').at(-1) ?? field
  return last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
}

/** At most this many groups in the tooltip's list, then "(and n more)". */
export const LIST_MAX = 4

/**
 * The tooltip's list from the core labels ("Pocket 1: depth", "Pocket 1: shape.cornerRadius",
 * "Drilling 2 added"): fields of one subject joined ("Pocket 1: depth, corner radius").
 */
export function pendingList(labels: readonly string[]): string {
  const groups = new Map<string, string[]>()
  for (const label of labels) {
    const at = label.indexOf(': ')
    if (at < 0) {
      groups.set(label, [])
      continue
    }
    const subject = label.slice(0, at)
    const field = fieldWords(label.slice(at + 2))
    const list = groups.get(subject) ?? []
    if (!list.includes(field)) list.push(field)
    groups.set(subject, list)
  }
  const items = [...groups].map(([subject, fields]) =>
    fields.length === 0 ? subject : `${subject}: ${fields.join(', ')}`,
  )
  const shown = items.slice(0, LIST_MAX)
  const more = items.length - shown.length
  return [...shown, ...(more > 0 ? [`(and ${more} more)`] : [])].join(' · ')
}

export const applyMessages = {
  /** Button label: "Apply" with the count as a badge. */
  label: 'Apply',
  applying: 'Applying…',
  failed: 'Apply failed',
  appliedBy: (kind: string) => `Applied by ${BY[kind] ?? kind}`,
  /** Accessible name: "Apply 3 changes". */
  name: (n: number) => `Apply ${changes(n)}`,
  applyingName: (n: number) => (n > 0 ? `Applying… Apply ${changes(n)}` : 'Applying…'),
  progress: 'Apply progress',

  tooltip: {
    title: 'Apply changes',
    pending: (n: number) => `${changes(n)} not applied yet.`,
    concept:
      'Your edits are already in the model: the preview, warnings and undo follow as you type. Apply runs the follow-up work: it chooses tools, updates draft plans and regenerates toolpaths.',
    how: (shortcut: string) =>
      `Press Enter in a field, or ${shortcut}, to apply. Saving and exporting apply first.`,
    applying: 'Regenerating toolpaths. The job list can cancel it.',
    failedRetry: 'Click to try again.',
  },

  /** Polite live region. */
  live: {
    pending: (n: number) => `${changes(n)} not applied`,
    applied: 'Changes applied',
    appliedBy: (kind: string) => `Changes applied by ${BY[kind] ?? kind}`,
    failed: 'Apply failed',
  },

  /** A warning against an unlocked tool with pending changes (soft tier, clock icon). */
  warningPending: 'May change on Apply: the tool is chosen again.',
  /** Plan checks of a plan with pending inputs. */
  checksOutdated: 'Outdated until Apply.',
  /** Draft plan notice instead of the stale notice. */
  planPending: 'Design changes not applied yet. This draft plan updates on Apply.',
  /** Kept-current plan with pending plan inputs. */
  planInputsPending: 'Changes not applied yet. The toolpaths regenerate on Apply.',
  applyNow: 'Apply now',
  /** Shortcut list. */
  shortcut: 'Apply changes',
} as const
