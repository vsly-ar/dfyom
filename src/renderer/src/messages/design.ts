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
    chamfer: 'Chamfer',
  } satisfies Record<OperationKind, string>,
  add: (kind: OperationKind) =>
    ({
      facing: 'Add facing',
      pocket: 'Add pocket',
      drilling: 'Add drilling',
      profile: 'Add profile',
      chamfer: 'Add chamfer',
    })[kind],
  /** The operation list's one Add menu (v0.4 task U1: was "Add operation"). */
  addMenu: 'Add',
  /** The Add menu's tooltips (dogfood DF18): what each item makes, one line. */
  describe: {
    facing: 'Flattens the stock top to an even height.',
    pocket: 'Clears the area inside a shape down to a depth.',
    drilling: 'Drills round holes, blind or through.',
    profile: 'Cuts along a shape’s outline: around it, inside it or on the line.',
    chamfer: 'Bevels the top edge of a drilling or round pocket.',
    hole: 'A hole for a screw or bolt: simple, counterbored or countersunk, sized from the fastener.',
  } satisfies Record<OperationKind | 'hole', string>,

  /** Features in the navigator and inspector (v0.4 task U1, ui.md § Features (v0.4)). */
  features: {
    groups: { operations: 'Operations', features: 'Features' },
    /** The Add menu's feature item (DF17: the hole feature is a "Bolt hole"; kind stays `hole`). */
    addHole: 'Bolt hole',
    /** The row menu's actions (dogfood DF16). */
    chamfer: 'Chamfer',
    makeClones: 'Make Clones…',
    cloneReasons: {
      select: 'Select a hole, pocket, drilling, chamfer or inside profile to clone.',
      facing: 'A facing can’t be cloned.',
      outside: 'An outside profile can’t be cloned: that would be a copy of the part.',
      taken: (name: string, clones: string) => `${name} is already cloned by ${clones}.`,
    },
    operations: (n: number) => (n === 1 ? '1 operation' : `${n} operations`),
    /** A feature row's accessible name; `aria-expanded` says collapsed or expanded. */
    rowName: (p: { name: string; readout: string; operations: number; warnings: number }) =>
      [
        p.name,
        p.readout.replace(' · ', ' '),
        p.operations === 1 ? '1 operation' : `${p.operations} operations`,
        ...(p.warnings > 0 ? [p.warnings === 1 ? '1 warning' : `${p.warnings} warnings`] : []),
      ]
        .filter((x) => x.length > 0)
        .join(', '),
    source: 'Source',
    sourceOf: (name: string) => `Source of ${name}`,
    clonesGroup: 'Clones',
    rows: 'Rows',
    instancesOf: (name: string) => `Instances of ${name}`,
    instance: (n: number) => `Clone ${n}`,
    skipped: 'Skipped',
    duplicate: 'Same spot as an earlier clone',
    ownedName: (opName: string, featureName: string) => `${opName}, edited through ${featureName}`,
    expand: (name: string) => `Expand ${name}`,
    collapse: (name: string) => `Collapse ${name}`,
    removed: (name: string, n: number) =>
      `Removed ${name} and its ${n === 1 ? 'operation' : `${n} operations`}`,
    referenced: (surface: string, users: readonly string[]) =>
      `${surface} is used by ${
        users.length <= 2
          ? users.join(' and ')
          : `${users.slice(0, -1).join(', ')} and ${users.at(-1)}`
      }.`,
    breadcrumb: 'Breadcrumb',
    editedThrough: 'Edited through',
    readOnly: (featureName: string, kindLabel: string) =>
      `Part of ${featureName}: change it in the ${kindLabel.toLowerCase()}.`,
    fixIn: (featureName: string) => `Fix in ${featureName}`,
    kindLabel: (kind: string) => ({ hole: 'Bolt hole', clones: 'Clones' })[kind] ?? kind,
    /** The minimal feature inspector until the kind's own (hole: U2). */
    placeholder: 'Its values are shown here; editing them in this panel comes next.',
    findings: 'Findings',
    ownedGroup: 'Operations',
    /** The Clones inspector, draft, instances and clone path (v0.4 task U3, ui.md § Clones). */
    clones: {
      draftTitle: 'New Clones',
      draftMeta: 'Draft',
      make: 'Make clones',
      cancel: 'Cancel',
      source: 'Source',
      rows: 'Rows',
      /** "1 + 5 clones = 6 instances · 0 skipped" */
      readout: (clones: number, instances: number, skipped: number) =>
        `1 + ${clones === 1 ? '1 clone' : `${clones} clones`} = ${
          instances === 1 ? '1 instance' : `${instances} instances`
        } · ${skipped} skipped`,
      overLimit: (actual: number, max: number, excess: number) =>
        `${actual} instances: Clones are limited to ${max}. Remove or skip ${excess}.`,
      addRow: 'Add row',
      kinds: {
        grid: 'Grid',
        offset: 'Offset',
        polar: 'Polar',
        arc: 'Arc',
        point: 'Point',
        along: 'Along',
      } as Record<string, string>,
      alongNoShape: 'Add a path shape first: Along places clones along it.',
      positions: (n: number) => (n === 1 ? '1 position' : `${n} positions`),
      rowName: (i: number, kind: string) => `Row ${i + 1}: ${kind}`,
      rowList: 'Rows in path order',
      rowNamed: (i: number) => `row ${i + 1}`,
      remove: (i: number) => `Remove row ${i + 1}`,
      removeLast: 'A Clones needs at least one row.',
      fields: {
        cols: 'Columns',
        rows: 'Rows',
        du: 'Spacing u',
        dv: 'Spacing v',
        count: 'Count',
        stepU: 'Step u',
        stepV: 'Step v',
        angle: 'Angle per step',
        distance: 'Distance per step',
        radius: 'Radius',
        centreAngle: 'Centre angle',
        arc: 'Sweep',
        step: 'Step angle',
        u: 'u',
        v: 'v',
        shape: 'Shape',
        start: 'Start offset',
        by: 'Place by',
        spacing: 'Spacing',
      },
      countError: 'Enter a whole number from 1 to 100.',
      skipped: 'Skipped',
      restoreChip: (n: number) => `Restore clone ${n}`,
      addToSource: 'Add to source…',
      noneToAdd: 'No other operation on this face can join the source.',
      removeFromSource: (name: string) => `Remove ${name} from the source`,
      removeLastSource: 'Remove the Clones instead: a Clones needs a source.',
      sourceList: 'Source items',
      warnings: 'Warnings',
      skipThem: 'Skip them',
      // instances
      instanceTitle: (n: number, clones: string) => `Clone ${n} of ${clones}`,
      position: 'Position',
      at: (u: string, v: string) => `u ${u}, v ${v}`,
      skipThis: 'Skip this clone',
      restore: 'Restore',
      skippedNote: 'This clone is skipped: nothing is cut here.',
      duplicateNote: 'This position is on an earlier instance: nothing is cut here.',
      cloneOf: 'Clone of',
      followsTool: (name: string) => `Follows ${name}’s tool.`,
      instanceGroup: (op: string, n: number) => `${op} · ${n}`,
      readOnly: (clones: string) => `Part of ${clones}: change it in the source or the Clones.`,
      instanceRow: (n: number, state: 'clone' | 'skipped' | 'duplicate') =>
        state === 'clone'
          ? `Clone ${n}`
          : state === 'skipped'
            ? `Clone ${n}, skipped`
            : `Clone ${n}, same spot as an earlier clone`,
      skipLabel: 'Skip',
      restoreLabel: 'Restore',
      skipN: (n: number) => `Skip clone ${n}`,
      restoreN: (n: number) => `Restore clone ${n}`,
      // the clone path in the viewport
      markerLabel: (n: number, where: string, skipped: boolean) =>
        `${n === 1 ? 'Source' : `Clone ${n}`} at ${where}${skipped ? ', skipped' : ''}`,
      hintSkip: (n: number) => `Clone ${n} · click to skip`,
      hintRestore: 'Skipped · click to restore',
      sourceHint: 'The source can’t be skipped.',
      announceSkip: (n: number, skipped: boolean) =>
        skipped ? `Clone ${n} skipped.` : `Clone ${n} restored.`,
      summary: (name: string, instances: number, skipped: number) =>
        `${name}: ${instances === 1 ? '1 instance' : `${instances} instances`}, ${skipped} skipped.`,
      selectedInstance: (n: number, source: string) => `Selected: clone ${n} of ${source}.`,
      draftSummary: (instances: number) =>
        `New Clones draft: ${instances === 1 ? '1 instance' : `${instances} instances`}.`,
    },
    hole: {
      group: 'Hole',
      type: 'Type',
      types: { simple: 'Simple', counterbore: 'Counterbore', countersink: 'Countersink' } as Record<
        string,
        string
      >,
      fastener: 'Fastener',
      custom: 'Custom',
      purpose: 'Purpose',
      purposes: { clearance: 'Clearance', tapDrill: 'Tap drill' } as Record<string, string>,
      fit: 'Fit',
      fits: { close: 'Close', normal: 'Normal', loose: 'Loose' } as Record<string, string>,
      diameter: 'Diameter',
      depth: 'Depth',
      through: 'Through',
      cbDiameter: 'Counterbore Ø',
      cbDepth: 'Counterbore depth',
      csDiameter: 'Countersink Ø',
      csAngle: 'Countersink angle',
      headSink: 'Head sink',
      // stepped countersink (F7, D41)
      csMethod: 'Countersink method',
      csMethods: { chamfer: 'Chamfer mill', stepped: 'Stepped' } as Record<string, string>,
      csStepdown: 'Stepdown',
      /** Under the countersink's tool field when stepped (ui.md § Hole inspector). */
      sharedTool: {
        same: 'Same end mill as the drill: one tool, no tool change.',
        pending: "Takes the drill's end mill on Apply: one tool, no tool change.",
        other:
          'Stepped with its own end mill: the plan changes tools between bore and countersink.',
      },
      center: 'Position',
      on: 'On',
      // the hole inspector (U2, ui.md § Hole inspector)
      groups: {
        position: 'Position',
        type: 'Type',
        fastener: 'Fastener',
        sizes: 'Sizes',
        defaults: 'Defaults',
        tools: 'Tools',
      },
      size: 'Size',
      bottom: 'Bottom',
      tapDrillSimple: 'A tap drill hole is a simple hole: change the type to Simple first.',
      defaultsHint: 'How far the head sits below the face when sizes are filled from the table.',
      showDefaults: 'Show defaults',
      hideDefaults: 'Hide defaults',
      sourcesLabel: 'Sizes from',
      sourceWhat: { close: 'close', normal: 'normal', loose: 'loose' } as Record<string, string>,
      /** Refill toast: "Sizes set from M4 (2 entered sizes replaced)". */
      refilled: (size: string, n: number) =>
        `Sizes set from ${size} (${n === 1 ? '1 entered size' : `${n} entered sizes`} replaced)`,
      useTable: (source: string) => `Use ${source}`,
      roleLabel: (role: string) =>
        ({ drill: 'Drill', counterbore: 'Counterbore', countersink: 'Countersink' })[role] ??
        role[0]!.toUpperCase() + role.slice(1),
    },
  },

  stock: {
    title: 'Stock',
    setupTitle: 'Set up the part',
    setupDescription:
      'Pick the stock the part is cut from. The part starts as the whole stock; operations remove material from it.',
    partName: 'Part name',
    defaultPartName: 'Part',
    /** DF12: the project name followed by " 1" ("Part 1" without a name). */
    firstPartName: (project: string) => `${project.trim() === '' ? 'Part' : project.trim()} 1`,
    /** DF13: one screen, the library stock optional. */
    fromLibrary: 'From library',
    notSelected: 'Not selected',
    variantOf: (parent: string) => `Variant of ${parent}`,
    materialLocked: 'From the library stock. Choose Not selected to change the material.',
    saveToLibrary: 'Save to library',
    unchanged: 'Matches the library stock.',
    saveTitle: 'Save to library',
    saveDescription: (name: string) =>
      `${name} is changed. Update it in the library, or keep it and save these sizes as a variant of it.`,
    updateStock: 'Update stock',
    saveVariant: 'Save as variant',
    variantName: (parent: string, summary: string) => `${parent} · ${summary}`,
    saveFailed: 'The stock was not saved to the library.',
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

  /** The part-setup toolbar group and its dialogs (D45, ui.md § Design sidebar and setup dialogs). */
  setup: {
    toolbar: 'Part setup',
    stock: 'Stock',
    shapes: 'Shapes',
    reference: 'Reference',
    done: 'Done',
    stockDescription: 'The block the part is cut from.',
    shapesDescription: 'Outlines that pockets and profiles can cut. Choose one to edit it.',
    part: 'Part',
    size: 'Size (X × Y × Z)',
    material: 'Material',
    materialValue: (name: string, cls: string) => (name === cls ? name : `${name} (${cls})`),
    copyNote: 'The part keeps its own copy of the stock; library changes do not change it.',
    showPart: 'Show part',
    noPart: 'Set up the stock first: every part starts from a stock block.',
    setUpStock: 'Set up stock…',
    emptyTitle: 'Set up the stock',
    readout: (summary: string, material: string | undefined) =>
      `Stock: ${summary}${material === undefined ? '' : ` · ${material}`}`,
    cancel: 'Cancel',
  },

  /** Drag to reorder and Alt+↑/↓ in the design lists (D45, ui.md § Reordering lists). */
  reorder: {
    grip: 'Drag to reorder (Alt+↑/↓)',
    /** "Moved Profile 1 to position 1 of 3." */
    moved: (name: string, position: number, of: number) =>
      `Moved ${name} to position ${position} of ${of}.`,
    surfaceFirst: (user: string, reference: string) =>
      `Not moved: ${user} uses ${reference}, which has to come before it.`,
    edgeFirst: (chamfer: string, edge: string) =>
      `Not moved: ${chamfer} chamfers an edge of ${edge}, which has to come before it.`,
    insideFeature: (feature: string) => `Not moved: that position is inside ${feature}.`,
    refused: (message: string) => `Not moved: ${message}`,
  },

  navigator: {
    operations: 'Operations',
    listLabel: 'Operations in design order',
    empty: {
      title: 'No operations yet',
      description: 'Add an operation to remove material from the stock, starting with facing.',
    },
    remove: (name: string) => `Remove ${name}`,
    /** The row menu's Remove (DF16). */
    removeItem: 'Remove',
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
    noPart: 'Set up the stock to start.',
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
    /** A facing's recommended depth (DF4): "0.48 mm, down to the top of Enclosure". */
    facingToReference: (depth: string, reference: string) => `${depth}, down to ${reference}`,
    /** A reference model without a name in `facingToReference` (never its id, DF43). */
    referenceModel: 'the reference model',
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
      convertedUnnamed: 'Converted to a shape',
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

  /** Human names of surfaces (ui.md#selection-and-picking: operation name and role, never the id). */
  surfaceLabel: (operationName: string, role: string) => `${operationName} ${role}`,
  /** Two surfaces that would read the same, told apart by their operation's place (DF43). */
  surfaceAt: (label: string, position: number) => `${label} (operation ${position})`,
  /** An operation id the part no longer has (a stale finding); the id itself is never shown. */
  unknownOperation: 'Unknown operation',
  surfaceRoles: {
    top: 'top',
    bottom: 'bottom',
    floor: 'floor',
    tabTop: (i: number) => `tab ${i + 1} top`,
    'side[0]': 'front side',
    'side[1]': 'right side',
    'side[2]': 'back side',
    'side[3]': 'left side',
    unknown: 'surface',
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
    lockOf: (role: string) => `Lock ${role.toLowerCase()} tool`,
    placeholder: 'No tool yet',
    noChoice: 'No tool can make this operation.',
    groups: {
      generalized: 'Generalized tool',
      library: 'Library',
      current: 'Current tool',
      add: 'Add',
    },
    newTool: 'New tool…',
    newToolNote: 'Adds a tool to the library and locks it here.',
    addToLibrary: 'Add to library',
    generalizedNote: 'Type and size only: Plan uses a matching library tool.',
    library: (name: string, diameter: string) => `${name} · Ø ${diameter}`,
    /** A library option's geometry (its description's start): "RE 1 mm · 2 flutes". */
    flutes: (n: number) => (n === 1 ? '1 flute' : `${n} flutes`),
    cornerRadius: (radius: string) => `RE ${radius}`,
    /** A library tool of the operation's type that fails another fit rule (DF42). */
    unfit: (why: string) => `Doesn’t fit: ${why}`,
    unfitWhy: {
      slot: (width: string | undefined) =>
        `wider than the ${width === undefined ? '' : `${width} `}slot`,
      pocket: 'wider than the pocket at its narrowest',
      cornerRadius: (corner: string | undefined) =>
        `too wide for the ${corner === undefined ? '' : `${corner} `}corner`,
      floorRadius: (radius: string | undefined) =>
        radius === undefined
          ? 'leaves a fillet on the sharp floor'
          : `doesn’t match the ${radius} floor radius`,
      diameter: (hole: string | undefined) =>
        `doesn’t fit the ${hole === undefined ? '' : `Ø ${hole} `}hole`,
      reach: 'too short for the depth',
      angle: 'another angle',
      other: 'too small for the chamfer',
    },
    /** `dfm.toolNotInLibrary`'s fix: the library's nearest tool of the type (DF42). */
    useNear: (name: string, diameter: string) => `Use ${name} (${diameter})`,
    /** `dfm.toolUnfit` of a locked tool wider than the slot: widen it to the tool (DF42). */
    widenSlot: (width: string) => `Widen slot to ${width}`,
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

  /** A selected face (DF22, ui.md § Selection and picking): the inspector and the summary. */
  face: {
    title: (label: string) => `Face: ${label}`,
    /** "Facing up (+Z)": where the face's outward normal points. */
    direction: (direction: Direction) =>
      ({
        '+z': 'Facing up (+Z)',
        '-z': 'Facing down (−Z)',
        '-y': 'Facing front (−Y)',
        '+x': 'Facing right (+X)',
        '+y': 'Facing back (+Y)',
        '-x': 'Facing left (−X)',
      })[direction],
    /** The face frame's axes in part-frame terms ("u → +X, v → +Y"). */
    axes: (u: string, v: string) => `u → ${u}, v → ${v}`,
    hint: 'Operations you add now start on this face.',
    /** A facing or profile takes a stock face: the one of the same direction. */
    stockFaceNote: (stockFace: string) => `Facings and profiles start on ${stockFace}.`,
    addHere: (kind: OperationKind) =>
      ({
        facing: 'Add facing here',
        pocket: 'Add pocket here',
        drilling: 'Add drilling here',
        profile: 'Add profile here',
        chamfer: 'Add chamfer here',
      })[kind],
    addHole: 'Add bolt hole here',
    /** The empty part inspector: how operations get onto a face. */
    emptyHint: 'Select a face in the viewport (Alt+click for a floor) to add operations on it.',
    summary: (label: string) => `Selected face: ${label}; operations you add start on it.`,
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
