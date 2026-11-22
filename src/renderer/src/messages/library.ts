// User-facing strings of the library forms: the Library window (tabs, lists, item editor, its
// prompts) and the quick "New tool" and "New machine" dialogs, which share the form components.
// Field names follow docs/architecture/library.md (ISO 13399 symbols in the drawing); terms from
// docs/glossary.md. Doc: docs/conventions/ui-library-window.md, docs/conventions/ui.md#plan-mode-task-37,
// #internationalization
import type { LibraryItemKind, MaterialClass } from '../../../core/library/item'
import type { Rigidity } from '../../../core/library/machine.dto'
import type { ToolMaterial, ToolType } from '../../../core/library/tool.dto'

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

const kindWord: Record<LibraryItemKind, string> = {
  tool: 'tool',
  machine: 'machine',
  stock: 'stock',
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
  /** Context links that open the Library window (L2). */
  links: { edit: 'Edit in library', open: 'Open library' },
  classes,

  // ── the Library window ──────────────────────────────────────────────────────────────────
  window: {
    title: 'Library',
    toolbar: 'Library',
    tabsLabel: 'Library items',
    tabs: { machine: 'Machines', tool: 'Tools', stock: 'Stock' } satisfies Record<
      LibraryItemKind,
      string
    >,
    search: 'Search',
    searchPlaceholder: (kind: LibraryItemKind) =>
      `Search ${kind === 'stock' ? 'stock' : `${kindWord[kind]}s`} by name or notes`,
    units: 'Units',
    unitOptions: { mm: 'mm', inch: 'in' },
    newItem: { tool: 'New tool', machine: 'New machine', stock: 'New stock' } satisfies Record<
      LibraryItemKind,
      string
    >,
    newShortcut: 'New',
    list: (kind: LibraryItemKind) =>
      kind === 'tool' ? 'Tools' : kind === 'machine' ? 'Machines' : 'Stock',
    editor: 'Item editor',
    used: 'Used in this project',
    usedHint: (project: string) => `“${project}” has a copy of this item.`,
    unsaved: 'Unsaved',
    unreadable: 'Does not load',
    unreadableHint: (message: string) =>
      `This file does not load, so it cannot be edited: ${message} The app never changes or deletes it.`,
    newRow: (kind: LibraryItemKind) => `New ${kindWord[kind]}`,
    count: (kind: LibraryItemKind, n: number) =>
      kind === 'stock'
        ? `${n} stock ${n === 1 ? 'item' : 'items'}`
        : `${n} ${kindWord[kind]}${n === 1 ? '' : 's'}`,
    unreadableCount: (n: number) => `${n} unreadable ${n === 1 ? 'file' : 'files'}`,
    shown: (n: number) => `${n} shown`,
    projectNote: (name: string) => `Project: ${name}`,
    noProject: 'No project',
    empty: (kind: LibraryItemKind) =>
      kind === 'stock' ? 'The stock library is empty.' : `No ${kindWord[kind]}s yet.`,
    emptyHint: (kind: LibraryItemKind) => `Create one with “New ${kindWord[kind]}”.`,
    noMatch: (query: string) => `Nothing matches “${query}”.`,
    noSelection: 'Select an item to edit it.',
    columns: {
      type: 'Type',
      name: 'Name',
      diameter: 'Ø',
      cornerRadius: 'RE',
      flutes: 'Flutes',
      fluteLength: 'Flute length',
      presets: 'Presets',
      controller: 'Controller',
      travel: 'Travel X × Y × Z',
      spindle: 'Spindle',
      shape: 'Shape',
      size: 'L × W × T',
      material: 'Material',
    },
    sortBy: (column: string) => `Sort by ${column}`,
    allTypes: 'All types',
    typeFilter: 'Tool type',
    duplicate: 'Duplicate',
    remove: 'Remove…',
    revert: 'Revert',
    save: 'Save',
    saved: 'Saved',
    actions: 'Item actions',
    removeTitle: (name: string) => `Remove ${name} from the library?`,
    removeDescription: 'Projects keep their copies. Library changes are not undoable.',
    removeConfirm: (kind: LibraryItemKind) => `Remove ${kindWord[kind]}`,
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
      cutting: 'Cutting',
      presets: 'Presets',
      notes: 'Notes',
      travel: 'Travel',
      feedRates: 'Feed rates',
      spindle: 'Spindle',
      controller: 'Controller',
      size: 'Size',
      material: 'Material',
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
    } satisfies Record<ToolType, string>,
    /** Short type word of the suggested name ("Flat 6"). */
    shortTypes: {
      flatEndMill: 'Flat',
      bullNoseEndMill: 'Bull',
      ballEndMill: 'Ball',
      drill: 'Drill',
    } satisfies Record<ToolType, string>,
    diameter: 'Diameter',
    cornerRadius: 'Corner radius',
    fluteLength: 'Flute length',
    overallLength: 'Overall length',
    stickout: 'Stickout',
    stickoutNote: 'Optional: length below the collet; plans may override it.',
    shankDiameter: 'Shank diameter',
    shankNote: 'Optional: the collet size.',
    fluteCount: 'Flutes',
    pointAngle: 'Point angle',
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
    /** ISO 13399 symbols of the drawing's dimensions. */
    symbols: {
      diameter: 'DC',
      cornerRadius: 'RE',
      fluteLength: 'LCF',
      overallLength: 'OAL',
      stickout: 'Stickout',
      shankDiameter: 'DMM',
      pointAngle: 'SIG',
    },
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
      field: (preset: string, column: string) => `${column} of ${preset}`,
      chipLoad: (value: string) => value,
      chipLoadNone: '–',
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
    acceleration: 'Acceleration',
    accelerationAxis: (axis: string) => `Acceleration ${axis} (mm/s²)`,
    accelerationNote: 'Optional, all three axes or none: better run-time estimates ($120–$122).',
    accelerationAll: 'Set the acceleration of all three axes, or of none.',
    spindle: 'Spindle',
    control: 'Spindle control',
    controls: { manual: 'Manual dial', gcode: 'By gCode' },
    maxSpeed: 'Max spindle speed',
    minSpeed: 'Min spindle speed',
    power: 'Spindle power',
    minSpeedNote: 'Optional: flags speeds below the spindle’s range.',
    powerNote: 'Optional: enables the feeds-and-speeds power check.',
    rigidity: 'Rigidity',
    rigidities: {
      extrusion: 'Aluminium extrusion',
      hobby: 'Hobby router',
      prosumer: 'Prosumer router',
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
}
