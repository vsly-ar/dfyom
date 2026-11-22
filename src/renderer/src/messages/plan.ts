// User-facing strings of plan mode (task 3.7). Labels follow docs/modes/plan-v0.1.md; terms from
// docs/glossary.md. Doc: docs/conventions/ui.md#internationalization, #plan-mode-task-37
import type { OperationKind } from '../../../core/design/part.dto'
import type { PlanWarning } from '../../../core/plan/checks'
import type { FeedField, PlanStatus } from '../../../core/plan/plan.dto'
import type { StrategyKey } from '../../../core/plan/strategy'
import type { WarningTier } from '../ui'

export type FeedSource = 'override' | 'preset' | 'calculator' | 'strategy'
export type ToolpathState = 'ready' | 'stale' | 'none' | 'failed'

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`)
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

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
      'A plan turns the part into toolpaths: a setup per face it is machined from, a tool for every operation, feeds and speeds.',
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
    discardTitle: (n: number) =>
      `Rebuild discards ${plural(n, 'plan-only edit', 'plan-only edits')}`,
    discardDraftTitle: (n: number) =>
      `Back to draft discards ${plural(n, 'plan-only edit', 'plan-only edits')}`,
    discardDescription:
      'The plan is rebuilt from the current design. Edits made to the part in this plan are lost. You can undo it.',
    discardDraftAction: 'Back to draft',
    discardCancel: 'Cancel',
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

  // setup panel (v0.2 task F6): docs/conventions/ui.md#design-and-plan-controls-v02
  setup: {
    title: 'Setups',
    listLabel: 'Setups in machining order',
    inspector: 'Setup',
    name: 'Setup name',
    position: (i: number, n: number) => `${i} of ${n}`,
    direction: 'Up face',
    directionValue: (face: string) => `${capital(face)} face up to the spindle`,
    faceName: (face: string) => capital(face),
    workOffset: 'Work zero',
    workOffsetValue: (corner: string, face: string) =>
      `G54 at the ${corner} corner of the ${face}; on the machine, the front-left corner of the top.`,
    /** The face is left out when the setup's name already says it ("Top" over "G54 front left · 0°"). */
    rowMeta: (face: string, corner: string | undefined, rotation: number, name?: string) =>
      [
        name?.trim().toLowerCase() === face.toLowerCase() ? undefined : capital(face),
        corner === undefined ? undefined : `G54 ${corner}`,
        `${rotation}°`,
      ]
        .filter((x) => x !== undefined)
        .join(' · '),
    rotation: 'Rotation',
    rotationHint: 'About the spindle axis; the work zero moves to the new front-left corner.',
    clearanceHeight: 'Clearance height',
    retractHeight: 'Retract height',
    shown: 'Shown in the viewport and exported',
    moveUpItem: 'Move up',
    moveDownItem: 'Move down',
    actions: (name: string) => `Actions for setup ${name}`,
    merge: (name: string) => `Merge with ${name}`,
    noMerge: 'No other setup of this face to merge with',
    findings: 'Setup checks',
  },

  operations: {
    title: 'Operations',
    listLabel: 'Plan operations in machining order',
    /** With several setups, one list per setup. */
    setupListLabel: (setup: string) => `Plan operations of ${setup} in machining order`,
    noTool: 'No tool',
    moveUpItem: 'Move up',
    moveDownItem: 'Move down',
    actions: (name: string) => `Actions for ${name}`,
    split: 'Move to new setup',
    moveTo: (setup: string) => `Move to ${setup}`,
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
    /** With several setups the panel exports the window's setup (one program per setup). */
    actionSetup: (setup: string) => `Export ${setup} gCode…`,
    setup: (setup: string, i: number, n: number) => `Setup ${setup} (${i} of ${n})`,
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
    noPlan: 'Create the plan in the navigator to start.',
    summary: (n: number) => plural(n, 'operation', 'operations'),
    commandFailed: 'The change was not applied.',
    groups: { tool: 'Tool', strategy: 'Strategy', feeds: 'Feeds and speeds' },
    // plan-only edits (task E3b): docs/modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene
    planCopy: {
      title: 'Part (plan copy)',
      edited: 'Edited in plan',
      revert: 'Revert to design',
      draftHint: 'Set the plan status to settled design to edit this operation for this plan only.',
      settledHint: 'Changes here apply to this plan only, not to the design.',
    },
    tool: 'Tool',
    toolPlaceholder: 'Choose a tool',
    noSuggestion: 'No library tool can make this operation. Add a fitting one with “New tool…”.',
    suggestion: (name: string, diameter: string) => `${name} · Ø ${diameter}`,
    reasons: 'Why this tool',
    /** Where the plan operation's tool came from (`toolSource`, E4; shown by F5). */
    toolSource: {
      design: 'From the design’s tool field.',
      plan: 'Chosen in this plan.',
    } as Record<string, string>,
    /** `designToolChanged` (`plan.stale.list`): the design's tool field differs from the plan's. */
    designToolChanged: (source: string | undefined) =>
      source === 'design'
        ? 'The design’s tool field changed since this plan was made. The tool follows it when the plan is rebuilt.'
        : 'The design’s tool field changed. This plan keeps the tool chosen here.',
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
    /** A recommended preset's second line (library.md#recommended-presets). */
    presetFollows: 'Follows the calculator',
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
    strategy: {
      labels: {
        direction: 'Cut direction',
        pattern: 'Pattern',
        axis: 'Rows along',
        overshoot: 'Overshoot',
        entry: 'Entry',
        helixDiameter: 'Helix diameter',
        rampAngle: 'Ramp angle',
        finishAllowance: 'Finishing allowance',
        finishStepdown: 'Finish stepdown',
        cycle: 'Cycle',
        peckDepth: 'Peck depth',
        chipBreakBack: 'Chip-break retract',
        helixPitch: 'Helix pitch',
        breakthrough: 'Breakthrough',
      } satisfies Record<StrategyKey, string>,
      choices: {
        direction: { climb: 'Climb', conventional: 'Conventional' },
        pattern: { zigzag: 'Zigzag', oneWay: 'One way' },
        axis: { x: 'X', y: 'Y' },
        entry: { helix: 'Helix', ramp: 'Ramp', plunge: 'Plunge' },
        cycle: { simple: 'Simple', peck: 'Peck', chipBreak: 'Chip break', helix: 'Helical boring' },
      } as Record<string, Record<string, string>>,
      notForTool: (label: string) => `${label} (doesn’t fit the tool)`,
      default: 'Default.',
      entered: 'Entered by you.',
      useDefault: 'Use default',
    },
    calc: {
      show: 'Show calculation',
      hide: 'Hide calculation',
      title: 'Calculation',
      loading: 'Calculating…',
      failed: 'The calculation could not be read.',
      inputs: 'Inputs',
      material: 'Material',
      toolMaterial: 'Tool material',
      notSet: 'not set',
      diameter: 'Diameter',
      flutes: 'Flutes',
      cornerRadius: 'Corner radius',
      engagement: 'Engagement',
      engagements: {
        slot: 'Slot (full width)',
        stepover: (ae: string) => `Stepover ${ae}`,
        helix: (ap: string) => `Helix, pitch ${ap}`,
        drill: 'Drilling',
      },
      rigidity: 'Machine rigidity',
      spindlePower: 'Spindle power',
      noPower: 'not set: power check skipped',
      fields: 'Values and derivation',
      fieldValue: (label: string, value: string) => `${label}: ${value}`,
      steps: (label: string) => `How ${label.toLowerCase()} is calculated`,
      used: 'At the values used',
      surfaceSpeed: 'Surface speed',
      effectiveDiameter: 'Effective diameter',
      chipLoad: 'Chip load after chip thinning',
      chipThinning: 'Chip thinning',
      removalRate: 'Material removal rate',
      cuttingPower: 'Cutting power',
      spindleLoad: 'Spindle load',
      noData: (reason: string) => `No calculator data: ${reason}`,
    },
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

/** A failed plan check of the design's tool, by its rule (`params.check` of the E4 findings). */
const CHECK: Readonly<Record<string, string>> = {
  toolType: 'is the wrong tool type for the operation',
  stickoutRange: 'has a stickout out of range',
  fluteLength: 'has too short a flute',
  cornerRadius: 'is too wide for the corner radius',
  pocketSize: 'is too wide for the pocket',
  floorRadius: 'does not match the floor radius',
  drillDiameter: 'does not match the hole diameter',
  pointAngle: 'does not match the hole’s point angle',
  flatBottom: 'cannot make a flat bottom',
  helixDiameter: 'does not suit helical boring of the hole',
  drillPoint: 'cannot make a drill point',
  slotWidth: 'is wider than the slot',
  reach: 'does not reach the depth with its stickout',
}

const FIXES =
  'Assign another tool here, change the machine, extend the stickout, or change the design.'

/** "Tools that fit: Flat 3, Flat 4." or "No library tool fits." */
const fitting = (alternatives: unknown): string =>
  typeof alternatives === 'string' && alternatives.length > 0
    ? `Tools that fit: ${alternatives}.`
    : 'No library tool fits.'

/**
 * A plan finding's text: the design tool findings of E4 worded from their params, every other
 * code the core's message, sentence-cased (docs/modes/plan-v0.2.md § Implementation (task E4)).
 */
export function findingText(w: PlanWarning): string {
  const p = (w.params ?? {}) as Readonly<Record<string, unknown>>
  const tool = String(p['designTool'] ?? 'tool')
  const check = CHECK[String(p['check'])] ?? 'fails a plan check'
  switch (w.code) {
    case 'plan.designToolReplaced':
      return `The design’s tool, the ${tool}, ${check}: ${String(p['tool'])} is used instead.`
    case 'plan.designToolFailed':
      return `The design’s locked tool, the ${tool}, ${check}. ${fitting(p['alternatives'])} ${FIXES}`
    case 'plan.toolUnresolved':
      return `No library tool that matches the design’s locked ${tool} passes the plan checks. ${fitting(p['alternatives'])} Add a matching tool to the library, or assign another tool here.`
    default:
      return sentence(w.message)
  }
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
