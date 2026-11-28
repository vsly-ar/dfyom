// User-facing strings of the library forms: the Library window (tabs, lists, item editor, its
// prompts) and the quick "New tool" and "New machine" dialogs, which share the form components.
// Field names follow docs/architecture/library.md (ISO 13399 symbols in the drawing); terms from
// docs/glossary.md. Doc: docs/conventions/ui-library-window.md, docs/conventions/ui.md#plan-mode-task-37,
// #internationalization
import type { LibraryTabKind, MaterialClass } from '../../../core/library/item'
import type { HolderSize } from '../../../core/library/holder'
import type { HolderPresetId } from '../../../core/library/holder.dto'
import type { HomingCorner, ProbeKind, Rigidity } from '../../../core/library/machine.dto'
import type { ToolMaterial, ToolType } from '../../../core/library/tool.dto'
import type { BaseType, SurfaceType, WorkholdingType } from '../../../core/library/workholding.dto'

const classes = {
  softwood: 'Softwood',
  hardwood: 'Hardwood',
  sheetGood: 'Sheet good',
  plastic: 'Plastic',
  aluminum: 'Aluminium',
  brass: 'Brass',
  steel: 'Steel',
  other: 'Other',
} satisfies Record<MaterialClass, string>

const kindWord: Record<LibraryTabKind, string> = {
  tool: 'tool',
  machine: 'machine',
  stock: 'stock',
  workholding: 'workholding device',
}

const workholdingPlural: Record<WorkholdingType, string> = {
  toeClamp: 'Toe clamps',
  vise: 'Vises',
  screw: 'Screws',
  block: 'Blocks',
  base: 'Bases',
  surface: 'Surface holds',
}

export const libraryMessages = {
  cancel: 'Cancel',
  name: 'Name',
  notes: 'Notes',
  notesHint: 'Vendor, product number, where it is stored.',
  failed: 'The item was not added to the library.',
  saveFailed: 'The item was not saved.',
  unnamed: 'Name it, or leave it empty for the suggested name.',
  copySuffix: 'copy',
  /** A typed name that repeats another item's (DF47): allowed, with this soft warning. */
  nameTaken: (kind: LibraryTabKind, name: string) =>
    `Another ${kind === 'stock' ? 'stock block' : kindWord[kind]} is already named ${name}: a different name tells them apart in lists.`,
  /** Context links that open the Library window (L2). */
  links: { edit: 'Edit in library', open: 'Open library' },
  classes,

  // ── the Library window ──────────────────────────────────────────────────────────────────
  window: {
    title: 'Library',
    toolbar: 'Library',
    tabsLabel: 'Library items',
    tabs: {
      machine: 'Machines',
      tool: 'Tools',
      stock: 'Stock',
      workholding: 'Workholding',
    } satisfies Record<LibraryTabKind, string>,
    search: 'Search',
    searchPlaceholder: (kind: LibraryTabKind) =>
      `Search ${kind === 'stock' ? 'stock' : kind === 'workholding' ? 'workholding' : `${kindWord[kind]}s`} by name or notes`,
    units: 'Units',
    unitOptions: { mm: 'mm', inch: 'in' },
    newItem: {
      tool: 'New tool',
      machine: 'New machine',
      stock: 'New stock',
      workholding: 'New workholding',
    } satisfies Record<LibraryTabKind, string>,
    newShortcut: 'New',
    list: (kind: LibraryTabKind) =>
      kind === 'tool'
        ? 'Tools'
        : kind === 'machine'
          ? 'Machines'
          : kind === 'stock'
            ? 'Stock'
            : 'Workholding',
    editor: 'Item editor',
    used: 'Used in this project',
    /** the item grid's short form of `used` (its tooltip is `used`) */
    usedShort: 'Used',
    usedHint: (project: string) => `“${project}” has a copy of this item.`,
    unsaved: 'Unsaved',
    unreadable: 'Does not load',
    unreadableHint: (message: string) =>
      `This file does not load, so it cannot be edited: ${message} The app never changes or deletes it.`,
    newRow: (kind: LibraryTabKind) => `New ${kindWord[kind]}`,
    count: (kind: LibraryTabKind, n: number) =>
      kind === 'stock'
        ? `${n} stock ${n === 1 ? 'item' : 'items'}`
        : kind === 'workholding'
          ? `${n} ${n === 1 ? 'device' : 'devices'}`
          : `${n} ${kindWord[kind]}${n === 1 ? '' : 's'}`,
    unreadableCount: (n: number) => `${n} unreadable ${n === 1 ? 'file' : 'files'}`,
    shown: (n: number) => `${n} shown`,
    noProject: 'No project',
    empty: (kind: LibraryTabKind) =>
      kind === 'stock' ? 'The stock library is empty.' : `No ${kindWord[kind]}s yet.`,
    emptyHint: (kind: LibraryTabKind) => `Create one with “New ${kindWord[kind]}”.`,
    noMatch: (query: string) => `Nothing matches “${query}”.`,
    noSelection: 'Select an item to edit it.',
    columns: {
      type: 'Type',
      name: 'Name',
      diameter: 'Ø',
      angle: 'Angle',
      cornerRadius: 'Corner R',
      flutes: 'Flutes',
      fluteLength: 'Flute length',
      presets: 'Presets',
      controller: 'Controller',
      travel: 'Travel X × Y × Z',
      spindle: 'Spindle',
      shape: 'Shape',
      size: 'L × W × T',
      material: 'Material',
      deviceSize: 'Size',
      deviceDetails: 'Details',
    },
    sortBy: (column: string) => `Sort by ${column}`,
    /** Header tooltips where the header is short (DF48). */
    columnTips: { cornerRadius: 'Corner radius (RE)', diameter: 'Diameter (DC)' } as Record<
      string,
      string
    >,
    allTypes: 'All types',
    typeFilter: 'Tool type',
    duplicate: 'Duplicate',
    /** Stock variants (DF13, ui-library-window.md#stock-variants-df13). */
    newVariant: 'New variant',
    variantName: (parent: string) => `${parent} variant`,
    variantOf: (parent: string) => `Variant of ${parent}`,
    variantRow: (name: string, parent: string) => `${name}, variant of ${parent}`,
    hasVariants: 'Remove its variants first.',
    remove: 'Remove…',
    revert: 'Revert',
    save: 'Save',
    saved: 'Saved',
    actions: 'Item actions',
    removeTitle: (name: string) => `Remove ${name} from the library?`,
    removeDescription: 'Projects keep their copies. Library changes are not undoable.',
    removeConfirm: (kind: LibraryTabKind) => `Remove ${kindWord[kind]}`,
    leaveTitle: (name: string) => `Save changes to ${name}?`,
    leaveDescription:
      'Your changes are not saved yet. Library changes apply to every project and are not undoable.',
    leaveSave: 'Save',
    leaveDiscard: 'Discard',
    conflictStale:
      'This item was changed elsewhere since you opened it. Reload it, or overwrite it with your changes.',
    conflictRemoved: 'This item was removed from the library elsewhere.',
    reload: 'Reload',
    overwrite: 'Overwrite',
    discard: 'Discard changes',
    controllers: { grbl: 'GRBL' },
    spindleSummary: (max: string, control: 'manual' | 'gcode') =>
      `${max}${control === 'manual' ? ' · dial' : ''}`,
    shapes: { block: 'Block' },
    groups: {
      geometry: 'Geometry',
      presets: 'Presets',
      notes: 'Notes',
      /** The tool form's collapsed group of secondary fields (DF1): material, coating, notes. */
      details: 'Details',
      travel: 'Travel',
      feedRates: 'Feed rates',
      spindle: 'Spindle',
      controller: 'Controller',
      size: 'Size',
      material: 'Material',
      device: 'Device',
      range: 'Range',
    },
    /** The full machine form's tabs (DF110, inspector-layout.md § Per-inspector target layout). */
    machineTabs: {
      label: 'Machine sections',
      machine: 'Machine',
      motion: 'Motion',
      spindle: 'Spindle',
    },
    /** A closed Notes accordion's summary: the first line, shortened. */
    notesSummary: (notes: string | undefined): string | undefined => {
      const line = notes?.trim().split('\n')[0]?.trim()
      if (line === undefined || line === '') return undefined
      return line.length > 32 ? `${line.slice(0, 31)}…` : line
    },
    machineRegion: 'Machine',
  },

  tool: {
    open: 'New tool…',
    title: 'New tool',
    description:
      'Adds a tool to the library and assigns it to this operation. Feeds and speeds come from the calculator, or type them in the inspector.',
    designDescription:
      'Adds a tool to the library and picks it for this operation (the tool field locks). Feeds and speeds come from the calculator.',
    add: 'Add tool',
    type: 'Type',
    types: {
      flatEndMill: 'Flat end mill',
      bullNoseEndMill: 'Bull nose end mill',
      ballEndMill: 'Ball end mill',
      drill: 'Drill',
      chamferMill: 'Chamfer mill',
      taperedBallEndMill: 'Tapered ball end mill',
    } satisfies Record<ToolType, string>,
    /** The chamfer mill type's hint: one type for chamfer mills and V-bits (H-F, task U4). */
    chamferHint: 'Also V-bits: a 90° V-bit is a 90° chamfer mill.',
    /** Search aliases per type (the item list's search, task U4). */
    typeAliases: {
      chamferMill: ['v-bit', 'vbit', 'v bit', 'chamfer'],
      taperedBallEndMill: ['tapered', 'taper', 'carving'],
    } as Partial<Record<ToolType, readonly string[]>>,
    tipPointed: '0: pointed',
    /** Short type word of the suggested name ("Flat 6"). */
    shortTypes: {
      flatEndMill: 'Flat',
      bullNoseEndMill: 'Bull',
      ballEndMill: 'Ball',
      drill: 'Drill',
      chamferMill: 'Chamfer',
      taperedBallEndMill: 'Tapered ball',
    } satisfies Record<ToolType, string>,
    diameter: 'Diameter',
    cornerRadius: 'Corner radius',
    fluteLength: 'Flute length',
    overallLength: 'Overall length',
    stickout: 'Stickout',
    overallLengthNote: 'The whole tool, shank included: the stickout must be shorter.',
    /** DF48: says what an empty stickout means; the placeholder shows the value it takes. */
    stickoutNote: 'Length below the collet; empty uses the flute length. Plans may override it.',
    /** The empty stickout's value, marked as a default (DF48: "Flute length" read like a value). */
    stickoutPlaceholder: (flute: string | undefined) =>
      flute === undefined ? 'Default' : `Default: ${flute}`,
    shankDiameter: 'Shank diameter',
    shankNote: 'Optional: the collet size.',
    /** The tool's own holder in Details (tool-holder.md § Implementation (H6), DF132). */
    holder: {
      choice: 'Holder',
      choiceNote:
        "Only for a tool that sits in its own holder (an extension or a reducing collet): it replaces the machine's collet nut and body for this tool on every machine. Measure yours with a caliper.",
      none: "Machine's holder",
      noneDescription: 'The collet nut set on the machine',
      /** The Details summary: "ER16 nut holder", "Measured holder". */
      summary: (label: string) => `${label} holder`,
    },
    fluteCount: 'Flutes',
    pointAngle: 'Point angle',
    angle: 'Included angle',
    tipDiameter: 'Tip diameter',
    /** A tapered ball end mill's fields (tapered-ball-nose.md § Library window, DF124 T3). */
    taperAngle: 'Taper angle (per side)',
    ballTip: 'Tip diameter (ball)',
    largeEnd: 'Large end diameter',
    taperAngleNote:
      'The angle of one side to the axis, as vendors quote it: half the included angle.',
    largeEndNote:
      'Where the cone ends, the largest cutting diameter; follows the shank while the two are equal.',
    /** The ball's radius beside its diameter: "R 0.25 mm". */
    ballRadius: (r: string) => `R ${r}`,
    /** The included angle beside the per-side one: "7.2° included". */
    included: (deg: string) => `${deg}° included`,
    /** The cone read-out (`taperHeights`): "Cone reaches Ø 3.175 mm at 21.5 mm". */
    coneReaches: (dc: string, h: string) => `Cone reaches Ø ${dc} at ${h}.`,
    /** DF124 T3 follow-up (`taperedGrooveWidth`): "Cuts a groove 0.6 mm wide at 1 mm deep." */
    grooveWidth: (w: string, d: string) => `Cuts a groove ${w} wide at ${d} deep.`,
    /** Q153: the cone does not fit the flutes, the usual sign of an included angle typed per side. */
    coneMismatch: (h: string, lcf: string, deg: string) =>
      `The cone reaches the large end at ${h}, the flutes end at ${lcf}: is ${deg}° the angle per side?`,
    /** The item list's Angle cell of a tapered ball end mill: "3.6°/side". */
    perSide: (deg: string) => `${deg}°/side`,
    toolMaterial: 'Tool material',
    materials: { carbide: 'Carbide', hss: 'HSS', other: 'Other' } satisfies Record<
      ToolMaterial,
      string
    >,
    noMaterial: 'Not set',
    coating: 'Coating',
    coatingHint: 'Optional, shown only (TiAlN, ZrN, uncoated).',
    drawing: (focused: string | undefined) =>
      focused === undefined ? 'Tool drawing' : `Tool drawing: ${focused} highlighted`,
    /** The drawing label's name of a highlighted dimension (the symbol, unless a word reads better). */
    drawingNames: {
      angle: 'included angle',
      tipDiameter: 'tip diameter',
      taperAngle: 'taper angle',
    } as Record<string, string>,
    /** The legend under the drawing (DF48): each symbol it shows with its field's name. */
    legend: 'Dimensions in the drawing',
    /** ISO 13399 symbols of the drawing's dimensions. */
    symbols: {
      diameter: 'DC',
      cornerRadius: 'RE',
      fluteLength: 'LCF',
      overallLength: 'OAL',
      stickout: 'Stickout',
      shankDiameter: 'DMM',
      pointAngle: 'SIG',
      angle: 'SIG',
      tipDiameter: 'DCN',
      // no ISO 13399 letter; vendors write "TA" (tapered-ball-nose.md § The tool)
      taperAngle: 'TA',
    },
    /** The legend's names that differ for a tapered ball end mill (its DC is the cone's large end). */
    taperedLegend: {
      diameter: 'Large end diameter',
      tipDiameter: 'Tip diameter (ball)',
    } as Record<string, string>,
    presets: {
      caption: 'Cutting presets',
      hint: 'Feeds and speeds per material class; plans pick the one for the stock.',
      empty: 'No presets: plans use the feeds-and-speeds calculator.',
      add: 'Add preset',
      remove: (name: string) => `Remove preset ${name}`,
      defaultName: (n: number) => `Preset ${n}`,
      anyMaterial: 'Any material',
      columns: {
        name: 'Name',
        materialClass: 'Material',
        spindleSpeed: 'Spindle speed',
        feedRate: 'Feed rate',
        plungeRate: 'Plunge rate',
        stepdown: 'Stepdown',
        stepover: 'Stepover',
        chipLoad: 'Chip load',
      },
      /** Compact visible labels for the quantity cells; `columns` holds the full names. */
      short: {
        spindleSpeed: 'Speed',
        feedRate: 'Feed',
        plungeRate: 'Plunge',
        stepdown: 'Stepdown',
        stepover: 'Stepover',
      },
      field: (preset: string, column: string) => `${column} of ${preset}`,
      chipLoad: (value: string) => value,
      chipLoadNone: '–',
      /** library.md#recommended-presets */
      recommended: 'Recommended',
      recommendedHint:
        'Follows the calculator for this tool and material, for no particular machine. In a plan, adapted down to the plan’s machine. Editing a value unticks it.',
      recommendedNoClass: 'Choose a material to follow the calculator.',
      recommendedBadTool: 'Fix the tool’s values to follow the calculator.',
    },
  },

  machine: {
    open: 'New machine…',
    title: 'New machine',
    description:
      'Adds a 3-axis GRBL machine to the library. Its limits are checked by the plan and used for feeds and speeds.',
    add: 'Add machine',
    defaultName: 'My machine',
    travel: 'Travel',
    travelAxis: (axis: string) => `Travel ${axis}`,
    maxFeed: 'Max feed rate',
    maxFeedAxis: (axis: string) => `Max feed rate ${axis}`,
    acceleration: 'Acceleration (mm/s²)',
    accelerationAxis: (axis: string) => `Acceleration ${axis}`,
    accelerationNote: 'Optional, all three axes or none: better run-time estimates ($120–$122).',
    accelerationAll: 'Set the acceleration of all three axes, or of none.',
    motion: 'Motion planning',
    junctionDeviation: 'Junction deviation',
    junctionDeviationNote: 'Optional ($11): how fast GRBL takes corners. Unset: 0.010 mm.',
    arcTolerance: 'Arc tolerance',
    arcToleranceNote: 'Optional ($12): how closely GRBL follows arcs. Unset: 0.002 mm.',
    stepsPerMm: 'Steps per mm',
    stepsPerMmAxis: (axis: string) => `Steps per mm ${axis}`,
    stepsPerMmNote: 'Optional, all three axes or none ($100–$102): recorded, not used for cutting.',
    stepsPerMmAll: 'Set the steps per mm of all three axes, or of none.',
    /** "Import $$…": GRBL settings pasted into a machine (library.md#grbl--import). */
    grblImport: {
      open: 'Import $$…',
      saveFirst: 'Save the machine first; the import changes the saved machine.',
      title: 'Import GRBL settings',
      description:
        'Paste what your controller answers to $$. Only the changes you tick are saved to this machine; nothing is sent to GRBL.',
      text: 'GRBL $$ output',
      textNote: 'From any sender or terminal; other lines are ignored.',
      compare: 'Compare',
      back: 'Back',
      apply: (n: number) => (n === 1 ? 'Apply 1 change' : `Apply ${n} changes`),
      changes: 'Changes',
      notSet: 'not set',
      noChanges: 'This machine already matches these settings.',
      skipped: 'Not imported',
      skipReasons: {
        softLimitsOff:
          'Soft limits are off ($20=0 or missing), so GRBL never uses these values and they may be its defaults. Measure the travel instead.',
        manualSpindle: 'The spindle is set by hand; a dial router ignores spindle speeds.',
        notPositive: 'Zero or less is not a usable value.',
        allAxes: 'All three axes are needed, and the paste does not give all of them.',
        zHomesDown: 'Z homes down on this controller ($23); DFYOM machines home Z up.',
      } satisfies Record<
        'softLimitsOff' | 'manualSpindle' | 'notPositive' | 'allAxes' | 'zHomesDown',
        string
      >,
      onOff: { on: 'on', off: 'off' } as Record<string, string>,
      summary: (read: number, unchanged: number) =>
        `${read} ${read === 1 ? 'setting' : 'settings'} read, ${unchanged} unchanged.`,
      ignored: (list: string) => `Not used by DFYOM: ${list}.`,
      together: 'Applied together: all three axes or none.',
      compareFailed: 'The settings could not be compared.',
      noSettings: 'No GRBL settings found. Paste lines like $110=5000.000.',
      failed: 'The settings were not imported.',
    },
    spindle: 'Spindle',
    control: 'Spindle control',
    controls: { manual: 'Manual dial', gcode: 'By gCode' },
    maxSpeed: 'Max spindle speed',
    minSpeed: 'Min spindle speed',
    power: 'Spindle power',
    controllerMinSpeed: 'Controller $31 (PWM min)',
    controllerMaxSpeed: 'Controller $30 (PWM max)',
    controllerRangeNote:
      'Only if your speed controller needs a $31/$30 different from the usable speed range.',
    minSpeedNote: 'Optional: flags speeds below the spindle’s range.',
    powerNote: 'Optional: enables the feeds-and-speeds power check.',
    homing: 'Homing',
    /** v0.5 RV2: the homing group in Run's "Machine settings". */
    homingLimits: 'Homing and limits',
    homingCorner: 'Homing corner',
    homingCornerNote: 'Where X and Y home ($23); Z always homes up.',
    homingCorners: {
      backRight: 'Back right (GRBL default)',
      backLeft: 'Back left',
      frontRight: 'Front right',
      frontLeft: 'Front left',
    } satisfies Record<HomingCorner, string>,
    pullOff: 'Pull-off',
    pullOffNote: 'Optional ($27): unset = 1 mm.',
    softLimits: 'Soft limits ($20)',
    zHeight: 'Z height',
    /** v0.5 RV2: the Run inspector's probe fields (variant `run`). */
    probe: 'Probe',
    noseToTable: 'Spindle nose to table',
    noseToTableNote:
      'Optional: with Z homed, from the collet nut (where stickout is measured) down to the table. Checks that retracts stay below the Z+ limit.',
    spoilboardThickness: 'Spoilboard thickness',
    spoilboardThicknessNote: 'Optional: the board the stock sits on; 0 if none.',
    probePlateSize: 'Touch plate size',
    probePlateSizeNote:
      'Optional: the largest extent of your Z touch plate. Touch-off spots leave room for it.',
    probePlateThickness: 'Touch plate thickness',
    probePlateThicknessNote: 'Optional: set it to probe Z with a touch plate in Run.',
    /** v0.5 RV4: the probe for X/Y probing (run-probing.md#probe-settings-rv4). */
    probeKind: 'Probe kind',
    probeKinds: {
      zPlate: 'Z touch plate',
      xyzPlate: 'XYZ corner plate',
      tool: 'The bit on the stock',
      '3d': '3D probe',
    } satisfies Record<ProbeKind, string>,
    probeWallOffsetX: 'Plate wall X',
    probeWallOffsetY: 'Plate wall Y',
    probeWallOffsetNote:
      'The corner plate: how far each wall the bit touches sits out from the stock edge the plate hooks on (often the wall thickness). Needed to probe X/Y with it.',
    probeTipDiameter: 'Ball diameter',
    probeTipDiameterNote: 'The 3D probe stylus ball; X/Y results subtract its radius.',
    probeFastFeed: 'Probe seek feed',
    probeFastFeedNote: 'Optional: unset = 100 mm/min. The first move toward the plate or stock.',
    probeSlowFeed: 'Probe slow feed',
    probeSlowFeedNote: 'Optional: unset = 20 mm/min. The re-probes that measure.',
    probeRetract: 'Probe back-off',
    probeRetractNote:
      'Optional: unset = 2 mm. Off the contact before a re-probe and between moves.',
    /** The Spindle tab's "Holder" group (tool-holder.md § Implementation (H1), DF132). */
    holder: {
      title: 'Holder',
      summaryNone: 'None',
      choice: 'Collet nut',
      choiceNote:
        'The nut and the spindle body above it, so the plan can check them against clamps. Pick your collet system, then measure yours with a caliper.',
      none: 'None (not checked)',
      custom: 'Measured',
      customDescription: 'Sizes you measured',
      edited: (label: string) => `${label}, edited`,
      presets: {
        er11: 'ER11 nut (300–500 W spindle)',
        er11Mini: 'ER11 mini nut',
        er16: 'ER16 nut',
        er16Mini: 'ER16 mini nut',
        er20: 'ER20 nut (1.5–2.2 kW)',
        er20Mini: 'ER20 mini nut',
        trimRouter: 'Trim router, 1/4″ collet',
        plungeRouter: 'Full-size router, 1/2″ collet',
      } satisfies Record<HolderPresetId, string>,
      /** A preset option's sizes: "Nut Ø19 × 12 · body Ø52 · shank ≤ 7 mm". */
      presetSizes: (nut: string, length: string, body: string, shank: string) =>
        `Nut Ø${nut} × ${length} · body Ø${body} · shank ≤ ${shank}`,
      labels: {
        nutDiameter: 'Nut diameter',
        nutLength: 'Nut length',
        bodyDiameter: 'Body diameter',
        maxShank: 'Max shank',
      } satisfies Record<HolderSize, string>,
      notes: {
        nutDiameter: 'Across the hex or the round nut, its widest point.',
        nutLength: 'From the nut face (where stickout is measured) up to the spindle body.',
        bodyDiameter: 'The spindle or router body above the nut; at least the nut diameter.',
        maxShank: 'Optional: the largest shank the collet takes.',
      } satisfies Record<HolderSize, string>,
      /** The drawing's short labels, named in its legend. */
      symbols: {
        nutDiameter: 'ØN',
        nutLength: 'LN',
        bodyDiameter: 'ØB',
        maxShank: 'ØS',
      } satisfies Record<HolderSize, string>,
      nose: 'nose',
      legend: 'Dimensions in the holder drawing',
      drawing: (focused: string | undefined) =>
        focused === undefined ? 'Holder drawing' : `Holder drawing: ${focused} highlighted`,
    },
    rigidity: 'Rigidity',
    rigidities: {
      extrusion: 'Aluminium extrusion',
      hobby: 'Hobby router',
      prosumer: 'Prosumer router',
      fixedGantry: 'Fixed gantry, solid frame',
      benchMill: 'Bench mill',
      rigidMill: 'Rigid mill',
    } satisfies Record<Rigidity, string>,
    programUnits: 'gCode units',
    units: { mm: 'mm (G21)', in: 'inch (G20)' },
    controller: 'Controller',
    controllerValue: 'GRBL (also grblHAL, FluidNC)',
    toolChanger: 'Tool change',
    toolChangerValue: 'Manual: the program stops (M0) for each tool change',
  },

  stock: {
    defaultName: (l: string, w: string, t: string) => `Block ${l} × ${w} × ${t}`,
    shape: 'Shape',
    length: 'Length (X)',
    width: 'Width (Y)',
    thickness: 'Thickness (Z)',
    thicknessNote: 'Its tolerance is the real stock variation.',
    materialName: 'Material name',
    materialClass: 'Material class',
  },

  // ── workholding devices (workholding-library.md § Library window tab, WL3) ─────────────────
  workholding: {
    types: {
      toeClamp: 'Toe clamp',
      vise: 'Vise',
      screw: 'Screw',
      block: 'Block',
      base: 'Base',
      surface: 'Surface hold',
    } satisfies Record<WorkholdingType, string>,
    /** List group headings (plural). */
    groups: workholdingPlural,
    /** A new device's suggested name (made unique among the library's and built-in names). */
    defaultNames: {
      toeClamp: 'Toe clamp',
      vise: 'Machine vise',
      screw: 'Screw',
      block: 'Block',
      base: 'Spoilboard',
      surface: 'Double-sided tape',
    } satisfies Record<WorkholdingType, string>,
    baseTypes: { spoilboard: 'Spoilboard', fixturePlate: 'Fixture plate' } satisfies Record<
      BaseType,
      string
    >,
    surfaceTypes: {
      tape: 'Double-sided tape',
      vacuum: 'Vacuum table',
      glue: 'Glue',
    } satisfies Record<SurfaceType, string>,
    newMenu: 'New workholding device',
    typeFilter: 'Device type',
    type: 'Type',
    width: 'Strap width',
    length: 'Strap length',
    top: 'Top above the stock',
    topInfo:
      'The clamp’s highest point above the stock top: it stands the same height on thin and thick stock.',
    gripMin: 'Grip from',
    gripMax: 'Grip to',
    gripRange: 'Grip range',
    gripInfo: 'How far the toe may reach onto the stock. Empty: any grip.',
    stud: 'Stud',
    studInfo: 'The stud thread, shown in the setup summary (M8).',
    jawWidth: 'Jaw width',
    jawThickness: 'Jaw thickness',
    jawHeight: 'Jaw height',
    jawHeightInfo: 'Drawn, and the gripped depth in the summary. Optional.',
    maxOpening: 'Max opening',
    maxOpeningInfo: 'The widest stock the jaws take. Empty: not checked.',
    soft: 'Soft jaws',
    headDiameter: 'Head diameter',
    headHeight: 'Head height',
    headHeightInfo: 'Above the stock top; 0 for a flush or countersunk head.',
    thread: 'Thread',
    threadInfo: 'Shown in the setup summary (4 × 40 wood, M5).',
    blockLength: 'Length',
    blockWidth: 'Width',
    blockHeight: 'Height',
    baseType: 'Base',
    sacrificial: 'Sacrificial',
    sacrificialHint: 'Through cuts may go into it.',
    thickness: 'Thickness',
    thicknessInfo: 'Shown only; the machine’s spoilboard thickness sets the Z headroom.',
    surfaceType: 'Hold',
    rangeEmpty: 'None',
    defaultFor: (type: WorkholdingType) =>
      `Default for ${workholdingPlural[type].toLocaleLowerCase()}`,
    defaultHint: (type: WorkholdingType) =>
      type === 'block'
        ? 'Add uses the default block. Without one, Add makes an own block (blocks have no built-in).'
        : type === 'toeClamp'
          ? 'Add and Arrange automatically use the default. Without one of yours, the built-in is the default.'
          : 'Add uses the default. Without one of yours, the built-in is the default.',
    builtIn: 'Built-in',
    builtInNote: 'Built-in: duplicate it to change the sizes.',
    defaultChip: 'Default',
    drawing: (name: string | undefined) =>
      name === undefined ? 'Device drawing' : `Device drawing: ${name} highlighted`,
    legend: 'Dimensions in the drawing',
    plan: 'Plan',
    side: 'Side',
    stock: 'Stock',
    /** The list's size cell ("30 × 60, top 25 mm"). */
    size: {
      toeClamp: (w: string, l: string, top: string, unit: string) =>
        `${w} × ${l}, top ${top} ${unit}`,
      vise: (jaws: string, unit: string) => `jaws ${jaws} ${unit}`,
      screw: (d: string, unit: string) => `head Ø ${d} ${unit}`,
      block: (l: string, w: string, h: string, unit: string) => `${l} × ${w} × ${h} ${unit}`,
    },
    details: {
      grip: (min: string, max: string, unit: string) => `grip ${min}–${max} ${unit}`,
      soft: 'soft jaws',
      opening: (max: string, unit: string) => `opens ${max} ${unit}`,
      sacrificial: 'sacrificial',
    },
  },
}
