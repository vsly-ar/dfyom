// User-facing strings of design mode (task 3.6). Labels follow the parameter tables of
// docs/modes/design.md; terms from docs/glossary.md. Doc: docs/conventions/ui.md#internationalization
import type { EvaluationStatus } from '../../../core/design/evaluation'
import type { AnchorDTO, OperationKind } from '../../../core/design/part.dto'
import type { Direction } from '../../../core/geometry/face'
import type { MaterialClass } from '../../../core/library/item'

export const designMessages = {
  kinds: {
    facing: 'Facing',
    pocket: 'Pocket',
    drilling: 'Drilling',
    profile: 'Profile',
  } satisfies Record<OperationKind, string>,
  add: (kind: OperationKind) =>
    ({
      facing: 'Add facing',
      pocket: 'Add pocket',
      drilling: 'Add drilling',
      profile: 'Add profile',
    })[kind],
  addOperation: 'Add operation',

  stock: {
    title: 'Stock',
    setupTitle: 'Set up the part',
    setupDescription:
      'Pick the stock the part is cut from. The part starts as the whole stock; operations remove material from it.',
    partName: 'Part name',
    defaultPartName: 'Part',
    source: 'Stock',
    newStock: 'New block',
    fromLibrary: 'From library',
    libraryItem: 'Library stock',
    noLibrary: 'The stock library is empty: define a new block.',
    name: 'Stock name',
    defaultName: (l: string, w: string, t: string) => `Block ${l} × ${w} × ${t}`,
    length: 'Length (X)',
    width: 'Width (Y)',
    thickness: 'Thickness (Z)',
    material: 'Material',
    materialName: 'Material name',
    materialClass: 'Material class',
    classes: {
      softwood: 'Softwood',
      hardwood: 'Hardwood',
      sheetGood: 'Sheet good',
      plastic: 'Plastic',
      aluminum: 'Aluminium',
      brass: 'Brass',
      steel: 'Steel',
      other: 'Other',
    } satisfies Record<MaterialClass, string>,
    create: 'Create part',
    summary: (l: string, w: string, t: string) => `${l} × ${w} × ${t}`,
    material_: (name: string) => `Material: ${name}`,
  },

  navigator: {
    operations: 'Operations',
    listLabel: 'Operations in design order',
    empty: {
      title: 'No operations yet',
      description: 'Add an operation to remove material from the stock, starting with facing.',
    },
    moveUp: (name: string) => `Move ${name} up`,
    moveDown: (name: string) => `Move ${name} down`,
    remove: (name: string) => `Remove ${name}`,
    actions: (name: string) => `Actions for ${name}`,
    warnings: (n: number) => (n === 1 ? '1 warning' : `${n} warnings`),
    failed: 'Evaluation failed here',
    removed: (name: string) => `Removed ${name}`,
    undo: 'Undo',
    undoAlt: 'Undo with Ctrl or Cmd+Z',
  },

  inspector: {
    part: 'Part',
    partSummary: (n: number) => (n === 1 ? '1 operation' : `${n} operations`),
    noPart: 'Set up the part in the navigator to start.',
    operation: (kind: string) => kind,
    name: 'Name',
    groups: {
      shape: 'Shape',
      position: 'Position',
      depth: 'Depth',
      corners: 'Corners',
      hole: 'Hole',
      slot: 'Slot',
      tabs: 'Tabs',
      tolerance: 'Tolerance',
      tool: 'Tool',
    },
    generalTolerance: 'General tolerance (length)',
    /** The empty field's placeholder: no scope sets one, so untoleranced lengths are exact. */
    generalToleranceNone: 'None: lengths are exact',
    shapeKind: 'Shape',
    shapes: { rectangle: 'Rectangle', circle: 'Circle' },
    centerX: 'Center X',
    centerY: 'Center Y',
    length: 'Length (X)',
    width: 'Width (Y)',
    /**
     * Position and size labels in the face frame: the top face reads X and Y (its `u` and `v`),
     * every other face `u` and `v` (design-v0.2.md#face-frame). `point` is "Center" for a
     * drilling (a hole is a point), "Position" for an anchored shape.
     */
    position: (point: 'Center' | 'Position', axis: string) => `${point} ${axis}`,
    lengthAlong: (axis: string) => `Length (${axis})`,
    widthAlong: (axis: string) => `Width (${axis})`,
    anchor: 'Anchor',
    anchorFormula: 'Remove the formula to change the anchor.',
    diameter: 'Diameter',
    cornerRadius: 'Corner radius',
    depth: 'Depth',
    floorRadius: 'Floor fillet radius',
    on: 'On',
    /** `on` dropdown groups, in the order of ui.md#design-and-plan-controls-v02. */
    directions: {
      '+z': 'Top',
      '-z': 'Bottom',
      '-y': 'Front side',
      '+x': 'Right side',
      '+y': 'Back side',
      '-x': 'Left side',
    } satisfies Record<Direction, string>,
    /** Face-frame axis labels in the viewport. */
    frameAxes: { u: 'u', v: 'v' },
    pickOn: 'Pick the surface in the viewport',
    bottom: 'Bottom',
    bottoms: { through: 'Through', flat: 'Flat', drillPoint: 'Drill point' },
    pointAngle: 'Point angle',
    side: 'Side',
    sides: { outside: 'Outside', inside: 'Inside', on: 'On line' },
    slotWidth: 'Slot width',
    tabsCount: 'Tab count',
    tabsWidth: 'Tab width',
    tabsThickness: 'Tab thickness',
    surface: (id: string, label: string) => `${label} · ${id}`,
    commandFailed: 'The change was not applied.',
    /** The shape picker and placement of a pocket or profile (task U2, ui.md § Shapes v0.3). */
    picker: {
      label: 'Shape',
      inline: 'Inline',
      named: 'Shapes',
      newShape: 'New shape…',
      usedBy: (n: number) => (n === 0 ? 'Not used' : `Used by ${n}`),
      editShape: 'Edit shape',
      convert: 'Convert to shape',
      converted: (name: string) => `Converted to ${name}`,
      rotation: 'Rotation',
      rotationNone: '0°',
      mirror: 'Mirror (flip x)',
      roundCorners: (r: string) => `Round corners to ≥ ${r}`,
      roundCornersFit: (r: string) => `Round corners to ${r} (largest that fits)`,
      roundFitSmaller: (fit: string, tool: string) =>
        `The corner takes at most ${fit}, less than the tool radius ${tool}: the warning stays.`,
      roundAtLargest: (tool: string) =>
        `The corner already has the largest radius that fits, less than the tool radius ${tool}: use a smaller tool or change the shape.`,
      sideSetOn: 'Side set to On line: an open path is cut on the line.',
      noRoundFix: 'Round the corner in the Shape Editor: it is made where items meet.',
      roundTooLarge:
        'The fillet does not fit between the neighbouring segments: round the corner with a smaller radius in the Shape Editor.',
    },
    openNeedsOn: 'An open path can only be cut on the line.',
    useSideOn: 'Use side On',
    grooveDepth: 'Depth',
    grooveThrough: 'Through',
    tabs: {
      entered: 'Positions entered by you.',
      spaceEvenly: 'Space evenly',
      add: 'Add tab',
      remove: (n: number) => `Remove tab ${n}`,
      position: (n: number) => `Tab ${n}`,
      /** The marker's and the field's accessible name. */
      at: (n: number, distance: string) => `Tab ${n}, ${distance} from the start`,
      notAllowed: 'Tabs hold a through cut of a closed loop only.',
      unknownLength: 'The loop length is not known yet.',
    },
  },

  /** Human names of surfaces (ui.md#selection-and-picking: id plus operation name). */
  surfaceLabel: (operationName: string, role: string) => `${operationName} ${role}`,
  surfaceRoles: {
    top: 'top',
    bottom: 'bottom',
    floor: 'floor',
    tabTop: (i: number) => `tab ${i + 1} top`,
    'side[0]': 'front side',
    'side[1]': 'right side',
    'side[2]': 'back side',
    'side[3]': 'left side',
  },

  /**
   * Names of the nine anchor points, seen from outside the face (ui.md: "Front left", "Centre").
   * `v` reads front/back on the top and bottom (the bottom is rolled over X, so its low `v` is
   * the back), bottom/top on the sides; `u` reads left/right.
   */
  anchorPoint: (direction: Direction, a: AnchorDTO): string => {
    const vNames: Record<'min' | 'max', string> =
      direction === '+z'
        ? { min: 'Front', max: 'Back' }
        : direction === '-z'
          ? { min: 'Back', max: 'Front' }
          : { min: 'Bottom', max: 'Top' }
    const uNames = { min: 'left', max: 'right' }
    if (a.u === 'centre' && a.v === 'centre') return 'Centre'
    if (a.v === 'centre') return `Centre ${uNames[a.u as 'min' | 'max']}`
    if (a.u === 'centre') return `${vNames[a.v]} centre`
    return `${vNames[a.v]} ${uNames[a.u]}`
  },
  stockName: 'Stock',

  /** The operation's tool field (task F5, docs/modes/design-v0.2.md#operation-tool). */
  tool: {
    label: 'Tool',
    lock: 'Lock tool',
    placeholder: 'No tool yet',
    noChoice: 'No tool can make this operation.',
    groups: {
      generalized: 'Generalized tool',
      library: 'Library tools that fit',
      current: 'Current tool',
      add: 'Add',
    },
    newTool: 'New tool…',
    newToolNote: 'Adds a tool to the library and locks it here.',
    addToLibrary: 'Add to library',
    generalizedNote: 'Type and size only: Plan uses a matching library tool.',
    library: (name: string, diameter: string) => `${name} · Ø ${diameter}`,
    current: (label: string) => `${label} (current)`,
    currentUnfit: 'Doesn’t fit this operation.',
    /** The source note (ui.md § Design and plan controls (v0.2): tool field). */
    chosenByYou: 'Chosen by you.',
    chosenAuto: 'Chosen automatically.',
    chosenAutoBecause: (why: string) => `Chosen automatically: ${why}.`,
    chosenAgain: 'Chosen again on Apply.',
    lockNoTool: 'No tool yet. Apply chooses one, or pick one from the list.',
    use: (label: string) => `Use ${label}`,
    unlock: 'Unlock',
    previousTool: 'previous tool',
    /** Why an automatic swap happened, by the old tool's failed fit rule. */
    why: {
      cornerRadius: (tool: string, corner: string | undefined) =>
        `the ${tool} didn’t fit the ${corner === undefined ? '' : `${corner} `}corner`,
      pocket: (tool: string) => `the ${tool} didn’t fit the pocket`,
      slot: (tool: string, width: string | undefined) =>
        `the ${tool} was wider than the ${width === undefined ? '' : `${width} `}slot`,
      floorRadius: (tool: string, radius: string | undefined) =>
        radius === undefined
          ? `the ${tool} left a fillet on the sharp floor`
          : `the ${tool} didn’t match the ${radius} floor radius`,
      diameter: (tool: string, hole: string | undefined) =>
        `the ${tool} didn’t fit the ${hole === undefined ? '' : `Ø ${hole} `}hole`,
      type: (tool: string, kind: string) => `the ${tool} can’t make a ${kind}`,
      reach: (tool: string) => `the ${tool} didn’t reach the depth`,
      unresolved: 'the previous tool could not be read',
      other: (tool: string) => `the ${tool} didn’t fit`,
    },
  },

  evaluation: {
    updating: 'Updating…',
    done: 'Part up to date',
    failed: 'Evaluation failed',
    status: (s: EvaluationStatus) =>
      s === 'pending' ? 'Updating…' : s === 'failed' ? 'Evaluation failed' : 'Part up to date',
    failedAt: (name: string) => `Evaluation failed at ${name}`,
  },

  /** The selected operation in the viewport's text summary (face frame and anchor shown). */
  selectionSummary: (p: { name: string; on: string; anchor: string | undefined }) =>
    `Selected: ${p.name} on ${p.on}, face axes u and v shown${
      p.anchor === undefined ? '' : `, anchor ${p.anchor}`
    }.`,

  viewportSummary: (p: { operations: number; warnings: number; status: EvaluationStatus }) => {
    const ops = p.operations === 1 ? '1 operation' : `${p.operations} operations`
    const warns =
      p.warnings === 0 ? '' : `, ${p.warnings === 1 ? '1 warning' : `${p.warnings} warnings`}`
    const state =
      p.status === 'pending' ? ', updating' : p.status === 'failed' ? ', evaluation failed' : ''
    return `Part with ${ops}${warns}${state}.`
  },
} as const
