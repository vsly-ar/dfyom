// User-facing strings of plan mode (task 3.7). Labels follow docs/modes/plan-v0.1.md; terms from
// docs/glossary.md. Doc: docs/conventions/ui.md#internationalization, #plan-mode-task-37
import type { OperationKind } from '../../../core/design/part.dto'
import type { PlanWarning } from '../../../core/plan/checks'
import type { FeedField, PlanStatus } from '../../../core/plan/plan.dto'
import type { StrategyKey } from '../../../core/plan/strategy'
import type { UnitSystem } from '../../../core/project/document'
import type { WarningTier } from '../ui'
import { lengthText } from './shape'

export type FeedSource = 'override' | 'preset' | 'calculator' | 'strategy'
export type ToolpathState = 'ready' | 'stale' | 'none' | 'failed'

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`)
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export const planMessages = {
  title: 'Plan',
  /** An id a finding names that the plan no longer has (DF43: never shown as the id). */
  unknownOperation: 'Unknown operation',
  unknownSetup: 'Unknown',
  /** The description of a setup panel row with a row menu (DF70, as the design list's). */
  rowMenuHint: 'Right-click or Shift+F10 for actions.',
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
    navigator: 'No plan yet: create one in the view.',
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
    /** A copy whose snapshot has no name (never its library id, DF43). */
    unnamed: 'unnamed',
  },

  machine: {
    title: 'Machine',
    /** A machine copy whose snapshot has no name (never its library id, DF43). */
    unnamed: 'Unnamed machine',
    label: 'Machine',
    placeholder: 'Choose a machine',
    /** Plan start card, several machines and none remembered (DF45): why Create plan waits. */
    choose: 'Choose the machine to plan for.',
    // dogfood re-report of DF29: the machine is needed to plan, not only to export
    empty:
      'The machine library is empty. Add a machine: the plan checks the stock and clearance height against its travel and the feeds against its limits, and exports gCode for it.',
    /** The plan inspector without a machine (DF29). */
    missing: 'No machine: the plan cannot check travel and feed limits or export gCode.',
  },

  /** Drag to reorder setups and plan operations (hardening U3, ui.md § Reordering lists). */
  reorder: {
    grip: 'Drag to reorder (Alt+↑/↓)',
    /** "Moved Top to position 1 of 2." */
    moved: (name: string, position: number, of: number) =>
      `Moved ${name} to position ${position} of ${of}.`,
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
    /** N6 (DF78): the corner only when the zero is one, else the offset from it or the point. */
    workOffsetValue: (
      zero: {
        readonly corner: string
        readonly offset?: readonly [string, string]
        readonly point?: string
      },
      face: string,
    ) =>
      zero.point !== undefined
        ? `G54 on ${zero.point}.`
        : zero.offset !== undefined
          ? `G54 at X ${zero.offset[0]}, Y ${zero.offset[1]} from the ${zero.corner} corner of the ${face} (front left on the machine).`
          : `G54 at the ${zero.corner} corner of the ${face}; on the machine, the front-left corner of the top.`,
    /** A setup row's work zero: "front left", "X 40 mm Y 25 mm", "on Hole 1". */
    rowZero: (zero: {
      readonly corner: string
      readonly offset?: readonly [string, string]
      readonly point?: string
    }) =>
      zero.point !== undefined
        ? `on ${zero.point}`
        : zero.offset !== undefined
          ? `X ${zero.offset[0]} Y ${zero.offset[1]}`
          : zero.corner,
    /** The face is left out when the setup's name already says it ("Top" over "G54 front left · 0°"). */
    rowMeta: (face: string, corner: string | undefined, rotation: number, name?: string) =>
      [
        name?.trim().toLowerCase() === face.toLowerCase() ? undefined : capital(face),
        corner === undefined ? undefined : `G54 ${corner}`,
        `${rotation}°`,
      ]
        .filter((x) => x !== undefined)
        .join(' · '),
    /** DF45: a field label, not only the group's name (the control had no visible label). */
    rotation: 'Rotation on the table',
    rotationHint:
      'About the spindle axis; the work zero keeps its offset from the new front-left corner.',
    // DF78: docs/modes/alignment.md#plan-ui
    zeroTitle: 'Work zero',
    zeroX: 'Work zero X',
    zeroY: 'Work zero Y',
    zeroHint:
      'From the front-left corner of the up face on the machine; negative or past the stock is fine.',
    zeroOnPoint: (name: string) => `On ${name}; a new X or Y takes it off the point.`,
    zeroReset: 'Reset to corner',
    zeroResetDone: 'The work zero is at the corner',
    pointsTitle: 'Alignment points',
    pointsEmpty:
      'None. After zeroing, the spindle points at each one in turn so you can line up the stock.',
    pointsList: 'Alignment points in the order the spindle visits them',
    pointAdd: 'Add point',
    pointAddLabel: 'Add an alignment point',
    pointAddNone: 'Nothing to add',
    pointGroupStock: 'Stock corners and edges',
    pointGroupHoles: 'Holes cut before this setup',
    pointGroupVertices: 'Outline corners cut before this setup',
    pointName: (n: number) => `Point ${n} name`,
    pointAt: (x: string, y: string) => `X ${x}  Y ${y}`,
    pointMissing: 'Its source is gone',
    pointIsZero: 'Work zero',
    pointActions: (name: string) => `Actions for ${name}`,
    pointZeroHere: 'Zero on this point',
    pointMoveUp: 'Move up',
    pointMoveDown: 'Move down',
    pointRemove: 'Remove',
    pointRemoveZero: 'The work zero is on it: move the zero first',
    clearanceHeight: 'Clearance height',
    /** DF59: the note on the clearance field while the setup has no workholding, with its value. */
    clampNote: (height: string) =>
      `Keep clamps lower than ${height} above the stock top, or add them under Workholding.`,
    /** DF59: how far the tool reaches past the stock sides on the machine. */
    reach: 'Past the stock',
    reachValue: (sides: readonly string[]) =>
      `${capital(sides.join(', '))}; keep clamps clear of these sides.`,
    reachSide: (side: 'left' | 'right' | 'front' | 'back', length: string) => `${side} ${length}`,
    reachNone: 'The tool stays within the stock outline.',
    reachUnknown: 'Generate toolpaths to see where the tool leaves the stock.',
    retractHeight: 'Retract height',
    shown: 'Shown in the viewport and exported',
    moveUpItem: 'Move up',
    moveDownItem: 'Move down',
    actions: (name: string) => `Actions for setup ${name}`,
    merge: (name: string) => `Merge with ${name}`,
    noMerge: 'No other setup of this face to merge with',
    findings: 'Setup checks',
    /** DF68: the Z headroom estimate of this setup (the warnings are in the setup checks). */
    zHeadroom: 'Z headroom',
    zHeadroomOk: 'Enough above the clearance height for every tool.',
    zHeadroomShort: 'Too little for a tool: see the setup checks.',
    zHeadroomUnknown: (missing: readonly string[]) =>
      `Not checked: enter ${missing.join(' and ')} in the machine.`,
    zHeadroomPartly: (missing: readonly string[], short: boolean) =>
      `${short ? 'Too little for a tool: see the setup checks' : 'Enough if there is no spoilboard'}; enter ${missing.join(' and ')} in the machine.`,
  },

  // workholding per setup (docs/modes/workholding.md#ui-summary, ui.md#workholding)
  workholding: {
    title: 'Workholding',
    count: (n: number) => (n === 0 ? 'None' : plural(n, 'item', 'items')),
    listLabel: (setup: string) => `Workholding of ${setup}`,
    empty: 'Nothing holds the stock yet: rapids and cuts are not checked against clamps.',
    add: 'Add',
    addMenu: 'Add workholding',
    kinds: {
      toeClamp: 'Toe clamp',
      vise: 'Vise',
      screw: 'Screw',
      block: 'Block',
      spoilboard: 'Spoilboard',
      fixturePlate: 'Fixture plate',
      tape: 'Tape',
      vacuum: 'Vacuum',
    },
    kindHints: {
      toeClamp: 'A toe or strap clamp on one stock edge',
      vise: 'Machine vise jaws on two stock sides',
      screw: 'A hold-down screw through the waste',
      block: 'A fixture block, stop or dowel',
      spoilboard: 'What the stock sits on; cutting into it is fine',
      fixturePlate: 'What the stock sits on; cutting into it is an error',
      tape: 'Double-sided tape under the stock: no obstacle',
      vacuum: 'A vacuum table under the stock: no obstacle',
    },
    item: (name: string) => `Item ${name}`,
    remove: 'Remove',
    removeItem: (name: string) => `Remove ${name}`,
    name: 'Name',
    edge: 'Edge',
    edges: { uMin: 'Left', uMax: 'Right', vMin: 'Front', vMax: 'Back' },
    at: 'Position along the edge',
    width: 'Width',
    grip: 'Grip on the stock',
    reach: 'Reach past the edge',
    top: 'Top above Z0',
    axis: 'Jaws close along',
    protrusion: 'Stock above the jaws',
    jawLength: 'Jaw length',
    jawThickness: 'Jaw thickness',
    soft: 'Soft jaws',
    centerX: 'Centre X',
    centerY: 'Centre Y',
    headDiameter: 'Head diameter',
    length: 'Length',
    rotation: 'Rotation',
    bottom: 'Bottom',
    type: 'Type',
    margin: 'Margin',
    marginHint: 'Kept clear around every item, sideways and above.',
    /** The derived clearance height's note: "From Toe clamp 2 + 2 mm." */
    clearanceFrom: (item: string, margin: string) => `From ${item} + ${margin}.`,
    clearanceAuto: 'Follow the workholding',
    clearanceAutoHint: 'Use the highest item + the margin, at least the default.',
  },

  // the setup's tool runs (hardening DF66): docs/modes/plan-v0.4.md#tool-changes-per-setup-hardening-df66
  toolChanges: {
    title: 'Tool changes',
    count: (n: number) => (n === 0 ? 'No tool change' : plural(n, 'tool change', 'tool changes')),
    listLabel: (setup: string) => `Tool runs of ${setup} in machining order`,
    /** "Ø 6 mm · Flat end mill" */
    toolMeta: (diameter: string | undefined, type: string | undefined) =>
      [diameter === undefined ? undefined : `Ø ${diameter}`, type]
        .filter((x) => x !== undefined)
        .join(' · '),
    noTool: 'No tool',
    time: (seconds: number) => formatDuration(seconds),
    timeTitle: 'Estimated time, without tool changes',
    noTime: 'Generate toolpaths to see the time.',
    carried: (setup: string) => `Stays in the spindle from ${setup}: no change at the setup start.`,
    refused: (message: string) => `Not moved: ${message}`,
    /** DF69: the tool run's Z reference surface (docs/modes/z-reference.md#ui). */
    zFrom: 'Z from',
    /** "Facing 1 floor · −0.5 mm" */
    zValue: (label: string, level: string) => `${label} · ${level}`,
    zNone: 'No flat surface',
    zButton: (tool: string, value: string, chosen: boolean) =>
      `Z from for ${tool}: ${value}${chosen ? '' : ' (default)'}. Choose the surface`,
    zDefault: (value: string | undefined) =>
      value === undefined ? 'Default' : `Default (${value})`,
    zDefaultHint: 'The top face, else the last facing floor, else the largest flat floor',
    zCandidate: (area: string, spot: string, small: boolean) =>
      `Touch off at ${spot}, flat patch ${area}${small ? ', too small for the touch plate' : ''}`,
    zSurfaces: 'Flat surfaces',
    zRefused: (message: string) => `Not changed: ${message}`,
    /** The viewport's chip beside the touch-off spot: "X 50 mm  Y 30 mm". */
    zSpotCaption: (x: string, y: string) => `X ${x}  Y ${y}`,
    /** Operation inspector (DF69): the touch-off spot's coordinates. */
    zSpotX: 'Touch-off X',
    zSpotY: 'Touch-off Y',
    zSpotMoved: 'Moved by you.',
    zSpotDefault: 'Use default spot',
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
    /** A row's error or warning count: its tooltip (DF67, the count shows the findings). */
    findingsTip: (count: string) => `${count}: click to show them in the inspector`,
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
    /** DF48: the file name here; its folder on its own line, the full path as its tooltip. */
    doneDescription: (file: string) => `The GRBL program was written to ${file}.`,
    folder: (folder: string) => `In ${folder}`,
    /** DF48: reveals the file; "Show in folder" off macOS. */
    showInFolder: (mac: boolean) => (mac ? 'Show in Finder' : 'Show in folder'),
    failedTitle: 'The gCode could not be exported',
    lines: (n: number) => `${n} lines`,
    time: (seconds: number) => `About ${formatDuration(seconds)} without tool changes`,
    toolChanges: (n: number) => plural(n, 'tool change', 'tool changes'),
    softLimitChecked: 'Soft limits checked at the connected machine’s work zero.',
    softLimitNotChecked:
      'Soft limits are checked when you start a run on a connected machine with its work zero set.',
    /** DF68: the Z headroom estimate (any shortfall is an export warning). */
    zHeadroomChecked: 'Z headroom checked from the machine’s Z height.',
    zHeadroomNotChecked: (missing: readonly string[]) =>
      `Z headroom not checked: enter ${missing.join(' and ')} in the machine.`,
    zHeadroomPartly: (missing: readonly string[]) =>
      `Z headroom checked as if there were no spoilboard: enter ${missing.join(' and ')} in the machine.`,
    warnings: 'Export warnings',
    noWarnings: 'No machine warnings.',
    close: 'Close',
    /** DF45: Export works with outdated toolpaths; its hint says it regenerates them. */
    generatesFirst: (n: number) =>
      `Export generates the ${plural(n, 'missing or outdated toolpath', 'missing or outdated toolpaths')} first.`,
    regenerated: (n: number) => `${plural(n, 'toolpath was', 'toolpaths were')} generated first.`,
  },

  inspector: {
    plan: 'Plan',
    name: 'Plan name',
    noSelection: 'Select a plan operation to choose its tool and feeds and speeds.',
    noPlan: 'Create the plan in the view to start.',
    summary: (n: number) => plural(n, 'operation', 'operations'),
    /** The count's tooltip (DF44): equal holes and chamfers share one plan operation. */
    summaryTip: (n: number, design: number) =>
      n === design
        ? `${plural(n, 'plan operation', 'plan operations')}, one per design operation.`
        : `${plural(n, 'plan operation', 'plan operations')} from the design's ${plural(design, 'operation', 'operations')}: equal holes and chamfers (clones too) are machined together as one.`,
    commandFailed: 'The change was not applied.',
    groups: { tool: 'Tool', strategy: 'Strategy', feeds: 'Feeds and speeds' },
    // plan-only edits (task E3b): docs/modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene
    planCopy: {
      title: 'Part (plan copy)',
      edited: 'Edited in plan',
      revert: 'Revert to design',
      // DF48: what the draft does first, then how to edit (UX audit: it read twice-over)
      draftHint:
        'This plan follows the design while it is a draft. To edit this operation for this plan only, set the plan status to settled design.',
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
    /** The operation's findings at the top of its inspector (DF67). */
    checks: 'Checks',
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
        entry: { helix: 'Helix', ramp: 'Ramp', plunge: 'Plunge', contour: 'Contour' },
        cycle: { simple: 'Simple', peck: 'Peck', chipBreak: 'Chip break', helix: 'Helical boring' },
      } as Record<string, Record<string, string>>,
      /** DF23: a through profile's depth, linked to its breakthrough. */
      cutDepth: 'Cut depth',
      cutDepthNote: (material: string) =>
        `Or enter the depth: the breakthrough follows. The material is ${material}.`,
      cutDepthTooShallow: (material: string) =>
        `A through cut goes at least through the material, ${material}.`,
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
      finish: 'Finishing pass',
      finishAllowance: 'Radial engagement (allowance)',
      finishFeed: 'Finishing feed',
      finishClamped: '(machine feed limit)',
      finishChipLoad: 'Finishing chip load',
      finishChipThinning: 'Finishing chip thinning',
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
    chamfer: 'Chamfer',
  } satisfies Record<OperationKind, string>,
}

/** A failed plan check of the design's tool, by its rule (`params.check` of the E4 findings). */
const CHECK: Readonly<Record<string, string>> = {
  toolType: 'is the wrong tool type for the operation',
  stickoutRange: 'has a stickout out of range',
  fluteLength: 'has too short a flute',
  cornerRadius: 'is too wide for the corner radius',
  pocketSize: 'is too wide for the pocket',
  /** T3: an inside profile's opening narrower than the tool. */
  openingSize: 'is too wide for the opening',
  floorRadius: 'does not match the floor radius',
  drillDiameter: 'does not match the hole diameter',
  pointAngle: 'does not match the hole’s point angle',
  flatBottom: 'cannot make a flat bottom',
  helixDiameter: 'does not suit helical boring of the hole',
  drillPoint: 'cannot make a drill point',
  slotWidth: 'is wider than the slot',
  reach: 'does not reach the depth with its stickout',
  // chamfer mills (v0.4 T1)
  angle: 'does not match the chamfer angle',
  tip: 'has a tip too wide for the edge',
  slant: 'has too short a cutting edge for the chamfer',
}

const FIXES =
  'Assign another tool here, change the machine, extend the stickout, or change the design.'

/** "Tools that fit: Flat 3, Flat 4." or "No library tool fits." */
const fitting = (alternatives: unknown): string =>
  typeof alternatives === 'string' && alternatives.length > 0
    ? `Tools that fit: ${alternatives}.`
    : 'No library tool fits.'

/**
 * Readable names of the ids a plan finding's params carry (DF43: visible text never shows an id):
 * a design operation, a plan operation, a setup.
 */
export interface FindingNames {
  readonly design: (id: string) => string
  readonly planOperation: (id: string) => string
  readonly setup: (id: string) => string
}

/** Without the plan at hand: generic words, never the id. */
const NO_NAMES: FindingNames = {
  design: () => 'an operation',
  planOperation: () => 'an operation',
  setup: () => 'one setup',
}

/** An area (mm²) in the project's units: "12.3 mm²", "0.0191 in²". */
export const areaText = (mm2: number, units: UnitSystem): string =>
  units === 'mm'
    ? `${Math.round(mm2 * 10) / 10} mm²`
    : `${Math.round((mm2 / 645.16) * 10000) / 10000} in²`

/**
 * A plan finding's text: the design tool findings of E4 worded from their params; the findings
 * whose core message names operations or setups by id (order, loose piece, cut-out before a
 * setup, corner radius, rest material) worded from their params with readable names (DF43);
 * every other code the core's message, sentence-cased (docs/modes/plan-v0.2.md § Implementation (task E4));
 * `plan.stepoverClamped` and the region-width `plan.check` errors (`pocketSize`, `openingSize`) in
 * the project's units (ui.md#info-notes, plan-v0.3.md § Tool checks).
 */
export function findingText(
  w: PlanWarning,
  units: UnitSystem = 'mm',
  names: FindingNames = NO_NAMES,
): string {
  const p = (w.params ?? {}) as Readonly<Record<string, unknown>>
  const str = (k: string): string | undefined =>
    typeof p[k] === 'string' ? (p[k] as string) : undefined
  const tool = String(p['designTool'] ?? 'tool')
  const check = CHECK[String(p['check'])] ?? 'fails a plan check'
  switch (w.code) {
    case 'plan.alignment': {
      // DF78: the span in project units; the other rules' core text has no lengths
      const x = p['spanX']
      const y = p['spanY']
      if (w.rule !== 'outsideTravel' || typeof x !== 'number' || typeof y !== 'number')
        return sentence(w.message)
      return `The work zero and alignment points span X ${lengthText(x, units)} × Y ${lengthText(y, units)}, more than the machine travel.`
    }
    case 'plan.designToolReplaced':
      return `The design’s tool, the ${tool}, ${check}: ${String(p['tool'])} is used instead.`
    case 'plan.designToolFailed':
      return `The design’s locked tool, the ${tool}, ${check}. ${fitting(p['alternatives'])} ${FIXES}`
    case 'plan.toolUnresolved':
      return `No library tool that matches the design’s locked ${tool} passes the plan checks. ${fitting(p['alternatives'])} Add a matching tool to the library, or assign another tool here.`
    case 'plan.stepoverClamped': {
      // ui.md#info-notes: the effective value in project units; the core's text says which limit
      const effective = p['effective']
      if (typeof effective !== 'number') return sentence(w.message)
      const limit = w.message.includes('flat radius') ? 'the flat radius' : 'half the tool'
      return `Clamped to ${lengthText(effective, units)} (${limit}) for offset clearing.`
    }
    case 'plan.order': {
      const before = str('dependsOn')
      if (before === undefined) return sentence(w.message)
      return w.rule === 'edgeBefore'
        ? `This operation chamfers an edge of ${names.planOperation(before)}, which comes later.`
        : `This operation starts from a surface of ${names.planOperation(before)}, which comes later.`
    }
    case 'plan.loosePiece': {
      const profile = str('profile')
      const inside = str('operation')
      if (profile === undefined || inside === undefined) return sentence(w.message)
      // DF57: an operation after the cut that releases the part
      if (w.rule === 'releaseFirst')
        return `${capital(names.design(profile))} releases the part before ${names.design(inside)}: the part is held only by its tabs.`
      return `${capital(names.design(profile))} is cut before ${names.design(inside)} inside it: the piece may be loose.`
    }
    case 'plan.cutoutBeforeSetup': {
      const profile = str('profile')
      const setup = str('setupId')
      const next = str('nextSetupId')
      if (profile === undefined || setup === undefined || next === undefined)
        return sentence(w.message)
      return `${capital(names.design(profile))} cuts through in setup ${names.setup(setup)} before setup ${names.setup(next)}: held only by its tabs while re-fixtured.`
    }
    case 'plan.restMaterial': {
      const op = str('operation')
      const [area, u, v] = [p['area'], p['u'], p['v']]
      if (
        op === undefined ||
        typeof area !== 'number' ||
        typeof u !== 'number' ||
        typeof v !== 'number'
      )
        return sentence(w.message)
      return `${areaText(area, units)} of ${names.design(op)} near (${lengthText(u, units)}, ${lengthText(v, units)}) stays uncut: a neck is narrower than the tool.`
    }
    case 'plan.check': {
      if (w.rule === 'cornerRadius') {
        const op = str('operation')
        const [radius, corner] = [p['radius'], p['cornerRadius']]
        if (op === undefined || typeof radius !== 'number' || typeof corner !== 'number')
          return sentence(w.message)
        return `Tool radius ${lengthText(radius, units)} is above the smallest inside corner of ${names.design(op)} (${corner === 0 ? 'sharp' : lengthText(corner, units)}): that corner keeps the tool radius.`
      }
      // the width rules carry the tool diameter and the narrowest width (mm) in their params
      const target = w.rule === 'openingSize' ? 'opening' : w.rule === 'pocketSize' ? 'pocket' : ''
      const width = p[target]
      const diameter = p['diameter']
      if (target === '' || typeof width !== 'number' || typeof diameter !== 'number')
        return sentence(w.message)
      return `The tool (${lengthText(diameter, units)}) is too wide for the ${target}: it is ${lengthText(width, units)} at its narrowest.`
    }
    case 'plan.workholding.none':
      // the core's text names the agent tool; the app names the inspector section
      return `No workholding in ${names.setup(String(p['setupId']))}: rapids and cuts are not checked against clamps. Add what holds the stock under Workholding in the setup.`
    case 'plan.machine': {
      // DF68: the Z headroom in the document's units
      const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : undefined)
      const len = (k: string) => lengthText(num(k) ?? 0, units)
      const named = str('tool')
      if (named === undefined || num('stickout') === undefined) return sentence(w.message)
      const head = `${named} at ${len('stickout')} stickout`
      if (w.rule === 'zHeadroom' && num('needed') !== undefined && num('available') !== undefined)
        return `${head}: the clearance height ${len('clearanceHeight')} needs ${len('needed')} above the stock top, but with Z homed the tool tip is only ${len('available')} above it. Retracts and tool changes would hit the Z+ limit: lower the clearance height or use a shorter stickout${num('spoilboardThickness') === undefined ? ', and enter the spoilboard thickness (checked as 0)' : ''}.`
      if (w.rule === 'zReach' && num('zMin') !== undefined && num('lowest') !== undefined)
        return `${head} cannot reach Z${len('zMin')}: the Z travel ends at Z${len('lowest')}. Use a longer stickout or raise the stock on a thicker spoilboard.`
      return sentence(w.message)
    }
    default:
      return sentence(w.message)
  }
}

/** DF68: the machine fields a `zHeadroomUnknown` finding names, as words. */
const Z_HEADROOM_FIELDS: Readonly<Record<string, string>> = {
  noseToTable: 'the spindle nose to table distance',
  spoilboardThickness: 'the spoilboard thickness (0 if none)',
}

/**
 * DF68: the plan's or export's `zHeadroomUnknown` note: the missing fields as words, and whether
 * only the spoilboard is missing (the top was checked as if there were none); undefined without one.
 */
export function zHeadroomNote(
  warnings: readonly PlanWarning[],
): { readonly missing: readonly string[]; readonly partly: boolean } | undefined {
  const w = warnings.find((x) => x.code === 'plan.machine' && x.rule === 'zHeadroomUnknown')
  if (w === undefined) return undefined
  const keys = String(w.params['missing'] ?? '')
    .split(',')
    .filter((f) => f !== '')
  return {
    missing: keys.map((f) => Z_HEADROOM_FIELDS[f] ?? f),
    partly: !keys.includes('noseToTable'),
  }
}

/** The words of a `zHeadroomUnknown` finding's missing fields, or undefined without one. */
export function zHeadroomMissing(warnings: readonly PlanWarning[]): string[] | undefined {
  const w = warnings.find((x) => x.code === 'plan.machine' && x.rule === 'zHeadroomUnknown')
  if (w === undefined) return undefined
  return String(w.params['missing'] ?? '')
    .split(',')
    .filter((f) => f !== '')
    .map((f) => Z_HEADROOM_FIELDS[f] ?? f)
}

/** "12 min 5 s", "45 s". */
/**
 * A length in the document's units rounded up (the tool reaches at most this far, DF59):
 * 0.1 mm or 0.01 in. "4.3 mm", "0.17 in".
 */
export function formatReach(mm: number, units: UnitSystem): string {
  const [v, step, unit] = units === 'inch' ? [mm / 25.4, 100, 'in'] : [mm, 10, 'mm']
  return `${Math.ceil(v * step - 1e-9) / step || 0} ${unit}`
}

/** A height in the document's units without trailing zeros: "10 mm", "0.394 in". */
export function formatHeight(mm: number, units: UnitSystem): string {
  return units === 'inch' ? `${+(mm / 25.4).toFixed(3)} in` : `${+mm.toFixed(2)} mm`
}

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
