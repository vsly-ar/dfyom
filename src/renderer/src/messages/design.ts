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
    },
    generalTolerance: 'General tolerance (length)',
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
    sides: { outside: 'Outside', inside: 'Inside' },
    slotWidth: 'Slot width',
    tabsCount: 'Tab count',
    tabsWidth: 'Tab width',
    tabsThickness: 'Tab thickness',
    surface: (id: string, label: string) => `${label} · ${id}`,
    commandFailed: 'The change was not applied.',
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
