// User-facing strings of plan mode (task 3.7). Labels follow docs/modes/plan-v0.1.md; terms from
// docs/glossary.md. Doc: docs/conventions/ui.md#internationalization, #plan-mode-task-37
import type { OperationKind } from '../../../core/design/part.dto'
import type { FeedField, PlanStatus } from '../../../core/plan/plan.dto'
import type { WarningTier } from '../ui'

export type FeedSource = 'override' | 'preset' | 'calculator' | 'strategy'
export type ToolpathState = 'ready' | 'stale' | 'none' | 'failed'

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`)

export const planMessages = {
  title: 'Plan',
  statuses: {
    draft: 'Draft',
    settledDesign: 'Settled design',
    finalized: 'Finalized',
    inUse: 'In use',
    archived: 'Archived',
  } satisfies Record<PlanStatus, string>,
  statusLabel: 'Plan status',
  unarchive: 'Restore from archive',

  empty: {
    title: 'Plan the part',
    description:
      'A plan turns the part into toolpaths: one setup, a tool for every operation, feeds and speeds.',
    action: 'Create plan',
  },

  picker: {
    label: 'Plan',
    actions: 'Plan actions',
    create: 'New plan',
    duplicate: 'Duplicate plan',
    remove: 'Remove plan…',
    removeTitle: (name: string) => `Remove “${name}”?`,
    removeDescription:
      'The plan, its tool assignments and its feeds and speeds are removed from the project. You can undo it.',
    removeAction: 'Remove plan',
    cancel: 'Cancel',
  },

  readOnly: (status: PlanStatus) =>
    status === 'archived'
      ? 'Archived plans are read-only. Restore the plan from the archive to change it.'
      : status === 'inUse'
        ? 'Plans in use are read-only. Duplicate the plan to change it.'
        : 'Finalized plans are read-only. Set the status to settled design to edit, or duplicate the plan.',

  stale: {
    design: 'The design changed since this plan was made.',
    partRemoved: 'The part of this plan was removed from the design.',
    rebuild: 'Rebuild plan',
    blocked: (why: string) => `The plan cannot follow the design: ${why}`,
    library: (kind: string, name: string) => `Library ${kind} “${name}” changed.`,
    libraryRemoved: (kind: string, name: string) => `Library ${kind} “${name}” was removed.`,
    libraryUnreadable: (kind: string, name: string) => `Library ${kind} “${name}” cannot be read.`,
    update: 'Update from library',
    kinds: { stock: 'stock', tool: 'tool', machine: 'machine' } as Record<string, string>,
    rowChanged: 'Changed in design',
    rowRemoved: 'Removed from design',
    rowEdited: 'Edited in plan',
  },

  machine: {
    title: 'Machine',
    label: 'Machine',
    placeholder: 'Choose a machine',
    empty: 'The machine library is empty. Add a machine to export gCode.',
  },

  setup: {
    title: 'Setup',
    workOffset: 'Work zero',
    workOffsetValue: 'G54 · stock top, front-left corner',
    clearanceHeight: 'Clearance height',
    retractHeight: 'Retract height',
  },

  operations: {
    title: 'Operations',
    listLabel: 'Plan operations in machining order',
    noTool: 'No tool',
    moveUp: (name: string) => `Move ${name} up`,
    moveDown: (name: string) => `Move ${name} down`,
    errors: (n: number) => plural(n, 'error', 'errors'),
    warnings: (n: number) => plural(n, 'warning', 'warnings'),
  },

  toolpaths: {
    title: 'Toolpaths',
    generate: 'Generate toolpaths',
    generating: 'Generating toolpaths…',
    progress: 'Toolpath progress',
    state: {
      ready: 'Toolpath ready',
      stale: 'Toolpath outdated',
      none: 'No toolpath yet',
      failed: 'Toolpath failed',
    } satisfies Record<ToolpathState, string>,
    summary: (ready: number, total: number) =>
      ready === total ? 'All toolpaths up to date.' : `${ready} of ${total} toolpaths up to date.`,
    blocked: 'Fix the errors before generating toolpaths.',
    failed: 'Toolpaths could not be generated.',
    someFailed: (n: number) => `${plural(n, 'toolpath', 'toolpaths')} failed.`,
  },

  export: {
    action: 'Export gCode…',
    busy: 'Exporting…',
    noMachine: 'Choose a machine to export gCode.',
    archived: 'Archived plans cannot be exported.',
    blocked: 'Fix the errors before exporting.',
    doneTitle: 'gCode exported',
    doneDescription: (file: string) => `The GRBL program was written to ${file}.`,
    failedTitle: 'The gCode could not be exported',
    lines: (n: number) => `${n} lines`,
    time: (seconds: number) => `About ${formatDuration(seconds)} without tool changes`,
    toolChanges: (n: number) => plural(n, 'tool change', 'tool changes'),
    softLimitChecked: 'Soft limits checked at the connected machine’s work zero.',
    softLimitNotChecked:
      'Soft limits are checked when you start a run on a connected machine with its work zero set.',
    warnings: 'Export warnings',
    noWarnings: 'No machine warnings.',
    close: 'Close',
    regenerated: (n: number) => `${plural(n, 'toolpath was', 'toolpaths were')} generated first.`,
  },

  inspector: {
    plan: 'Plan',
    name: 'Plan name',
    noSelection: 'Select a plan operation to choose its tool and feeds and speeds.',
    summary: (n: number) => plural(n, 'operation', 'operations'),
    commandFailed: 'The change was not applied.',
    groups: { tool: 'Tool', feeds: 'Feeds and speeds' },
    tool: 'Tool',
    toolPlaceholder: 'Choose a tool',
    noSuggestion: 'No library tool can make this operation. Add a fitting one with “New tool…”.',
    suggestion: (name: string, diameter: string) => `${name} · Ø ${diameter}`,
    reasons: 'Why this tool',
    otherTool: (name: string) => `${name} (current)`,
    stickout: 'Stickout',
    preset: 'Cutting preset',
    presetDefault: (name: string | null, auto: boolean) =>
      name !== null
        ? `Default (${name})`
        : auto
          ? 'Default (auto)'
          : 'Default (none for this material)',
    presetAuto: 'Auto (calculator)',
    autoUnavailable: (reason: string) => `Auto (calculator) is unavailable. ${reason}`,
    noPresets: 'The tool has no cutting presets.',
    machines: (names: string) => `Machines: ${names}`,
    chipLoad: (mm: string) => `Chip load ${mm} per tooth`,
    feeds: {
      spindleSpeed: 'Spindle speed',
      feedRate: 'Feed rate',
      plungeRate: 'Plunge rate',
      stepdown: 'Stepdown',
      stepover: 'Stepover',
    } satisfies Record<FeedField, string>,
    source: (source: FeedSource, preset: string | null) =>
      ({
        override: 'Entered by you.',
        preset: preset === null ? 'From the tool’s cutting preset.' : `From preset “${preset}”.`,
        calculator: 'Recommended by the calculator.',
        strategy: 'Strategy default.',
      })[source],
    entered: (recommended: string) => `Entered by you. Recommended ${recommended}.`,
    useRecommended: (value: string) => `Use ${value}`,
    locked: 'Locked: the other values follow it.',
    reset: 'Reset',
    useToolDefault: 'Use tool default',
    unlock: 'Unlock',
    unresolved: 'No value: enter one, or add a cutting preset to the tool.',
  },

  warnings: {
    title: 'Plan checks',
    none: 'No errors or warnings.',
    count: (errors: number, warnings: number) =>
      errors > 0
        ? `${plural(errors, 'error', 'errors')}${warnings > 0 ? `, ${plural(warnings, 'warning', 'warnings')}` : ''}`
        : plural(warnings, 'warning', 'warnings'),
    severity: { soft: 'Note', hard: 'Warning', error: 'Error' } satisfies Record<
      WarningTier,
      string
    >,
  },

  kinds: {
    facing: 'Facing',
    pocket: 'Pocket',
    drilling: 'Drilling',
    profile: 'Profile',
  } satisfies Record<OperationKind, string>,
}

/** "12 min 5 s", "45 s". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h} h ${m} min`
  if (m > 0) return r > 0 ? `${m} min ${r} s` : `${m} min`
  return `${r} s`
}

/** Sentence case of a core message (the core writes them lower case: "no tool assigned"). */
export function sentence(text: string): string {
  const t = text.trim()
  if (t.length === 0) return t
  const s = t[0]!.toUpperCase() + t.slice(1)
  return /[.!?]$/.test(s) ? s : `${s}.`
}
