// User-facing strings of design mode (task 3.6). Labels follow the parameter tables of
// docs/modes/design.md; terms from docs/glossary.md. Doc: docs/conventions/ui.md#internationalization
import type { EvaluationStatus } from '../../../core/design/evaluation'
import type { AnchorDTO, OperationKind } from '../../../core/design/part.dto'
import type { Direction } from '../../../core/geometry/face'
import type { MaterialClass } from '../../../core/library/item'

/** "A", "A and B", "A, B and C". */
const nameList = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

export const designMessages = {
  kinds: {
    facing: 'Facing',
    pocket: 'Pocket',
    drilling: 'Drilling',
    profile: 'Profile',
    chamfer: 'Chamfer',
    line: 'Line',
  } satisfies Record<OperationKind, string>,
  add: (kind: OperationKind) =>
    ({
      facing: 'Add facing',
      pocket: 'Add pocket',
      drilling: 'Add drilling',
      profile: 'Add profile',
      chamfer: 'Add chamfer',
      line: 'Add line',
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
    line: 'Engraves grooves along shapes with a V-bit, at a constant or changing depth.',
    hole: 'A hole for a screw or bolt: simple, counterbored or countersunk (also in a recess), sized from the fastener.',
    pattern: 'Many copies of a cell laid on a lattice over a face, cut as one pocket.',
    engraving: 'A decorative motif of V-bit grooves over a face, from a preset or your shapes.',
  } satisfies Record<OperationKind | 'hole' | 'pattern' | 'engraving', string>,

  /** Features in the navigator and inspector (v0.4 task U1, ui.md § Features (v0.4)). */
  features: {
    groups: { operations: 'Operations', features: 'Features' },
    /** The Add menu's feature item (DF17: the hole feature is a "Bolt hole"; kind stays `hole`). */
    addHole: 'Bolt hole',
    /** Patterns P1 (patterns.md § UI). */
    addPattern: 'Pattern',
    /** Engraved patterns E3 (engraved-patterns.md § UI). */
    addEngraving: 'Engraved pattern',
    pattern: {
      groups: { cell: 'Cell', layout: 'Layout', area: 'Area', cut: 'Cut', chamfer: 'Chamfer' },
      cell: 'Cell',
      cells: {
        circle: 'Circle',
        rectangle: 'Rectangle',
        obround: 'Obround',
        polygon: 'Polygon',
        shape: 'Shape',
      } as Record<string, string>,
      shape: 'Shape',
      diameter: 'Diameter',
      length: 'Length',
      width: 'Width',
      cornerRadius: 'Corner radius',
      sides: 'Sides',
      across: 'Across',
      acrossValues: { corners: 'Corners', flats: 'Flats' } as Record<string, string>,
      rotation: 'Rotation',
      lattice: 'Lattice',
      lattices: {
        square: 'Square',
        staggered: 'Staggered',
        hex: 'Hex',
        polar: 'Polar',
      } as Record<string, string>,
      spacing: 'Spacing',
      spacings: { gap: 'Gap', pitch: 'Pitch' } as Record<string, string>,
      gap: 'Gap',
      pitch: (i: number, polar = false) =>
        polar
          ? i === 0
            ? 'Pitch along rings'
            : 'Pitch between rings'
          : i === 0
            ? 'Pitch along rows'
            : 'Pitch between rows',
      angle: 'Angle',
      origin: (i: number) => (i === 0 ? 'Origin U' : 'Origin V'),
      originCentre: 'Centre of the area',
      /** P5: `alternate: flip`. */
      alternate: 'Flip every other cell',
      alternateNote: 'Turned 180° so triangles nest; the pitches keep the gap as the web.',
      on: 'On',
      boundary: 'Boundary',
      boundaryFace: 'Whole face',
      /** P4: the face option on another pattern's floor (stacked). */
      boundaryFloor: (pattern: string) => `${pattern}'s cells`,
      stackedNote: (pattern: string) =>
        `Stacked on ${pattern}: cells only inside its cells, less the margin, from its floor down.`,
      boundaryCenter: (i: number) => (i === 0 ? 'Boundary centre U' : 'Boundary centre V'),
      boundaryRotation: 'Boundary rotation',
      margin: 'Margin',
      fit: 'Boundary cells',
      fits: { whole: 'Whole', clip: 'Clip' } as Record<string, string>,
      fitDescription: 'Clip cuts the cells crossing the boundary; slivers under 1 mm are dropped.',
      invert: 'Invert (cells as islands)',
      /** The More rows' names (DF110): "More (Origin, Flip every other cell)". */
      originShort: 'Origin',
      invertShort: 'Invert',
      presets: 'Presets',
      /** DF107: the button that opens the Presets dialog. */
      presetsButton: 'Presets…',
      presetsTitle: 'Pattern presets',
      /** The dialog's footer button (P10): closes without a change, as Escape. */
      presetsClose: 'Close',
      presetsDescription:
        'Sets the cell, lattice, gap and Flip; the area, depth and tools stay. Arrow keys move, Enter applies.',
      presetCurrent: 'Current',
      presetNames: {
        staggeredHoles: 'Staggered holes',
        honeycomb: 'Honeycomb',
        roundedSquares: 'Rounded squares',
        diamonds: 'Diamonds',
        triangles: 'Triangles',
        slots: 'Slots',
        grille: 'Grille',
        circleGrid: 'Circle grid',
        waffle: 'Waffle',
        octagons: 'Octagons',
        louvres: 'Louvres',
        speakerGrille: 'Speaker grille',
        lighteningHoles: 'Lightening holes',
      } as Record<string, string>,
      /** DF107: each preset's one-line description in the dialog. */
      presetDescriptions: {
        staggeredHoles: 'Round holes, every other row shifted half a pitch.',
        honeycomb: 'Rounded hexagons nested 60° apart: strong, light webs.',
        roundedSquares: 'Squares with soft corners in aligned rows.',
        diamonds: 'Squares turned 45° on staggered rows.',
        triangles: 'Every other triangle flipped so they nest.',
        slots: 'Upright slots on staggered rows: a vent.',
        grille: 'Small holes packed tight: a fine mesh.',
        circleGrid: 'Round holes in aligned rows and columns.',
        waffle: 'Square cells with thin even webs, like a waffle.',
        octagons: 'Octagons in a grid: wider webs at the corners.',
        louvres: 'Long slots in aligned rows: vent louvres.',
        speakerGrille: 'Small holes on rings about the centre.',
        lighteningHoles: 'Large holes on a hex lattice to take weight out.',
      } as Record<string, string>,
      /** The key numbers' words (`presetNumbers`). */
      presetWords: {
        cell: (kind: string, sides: number) =>
          kind === 'polygon'
            ? ((
                { 3: 'triangle', 4: 'square', 6: 'hexagon', 8: 'octagon' } as Record<number, string>
              )[sides] ?? `${sides}-gon`)
            : kind === 'rectangle'
              ? 'rectangle'
              : kind === 'obround'
                ? 'slot'
                : kind === 'circle'
                  ? 'hole'
                  : kind,
        across: (corners: boolean) => (corners ? 'across corners' : 'across flats'),
        lattice: { square: 'square', staggered: 'staggered', hex: 'hex', polar: 'polar' } as Record<
          string,
          string
        >,
        gap: 'gap',
        flip: 'flipped',
      },
      /** DF108: the roughing pass and its tool (Cut group). */
      roughing: 'Roughing',
      roughingNote:
        'A bigger tool clears the cells first; the pocket’s tool then cuts only what it left (corners, small cells) and the walls.',
      roughingTool: 'Roughing tool',
      depth: 'Depth',
      through: 'Through',
      throughNote:
        'Every cell is cut through the stock and cleared: nothing comes loose. The breakthrough is set in Plan.',
      tool: 'Tool',
      chamfer: 'Chamfer every cell',
      chamferWidth: 'Chamfer width',
      chamferAngle: 'Chamfer angle',
      chamferTool: 'V-bit',
      /** The closed Chamfer accordion's summary (DF110). */
      chamferOff: 'Off',
      chamferSummary: (width?: string, angle?: string, side?: string) =>
        [width, angle, side].filter((x) => x !== undefined).join(' · '),
      /** P5: which cell edges (bottom: through cells, from a flipped setup). */
      chamferSide: 'Edges',
      chamferSides: { top: 'Top', bottom: 'Bottom', both: 'Both' } as Record<string, string>,
      chamferSideNote: 'The bottom edges are cut from a flipped setup.',
      chamferBottomTool: 'V-bit (bottom)',
      chamferNote:
        'An edge chamfer round every cell (inverted: every island), cut after the pocket.',
      readout: (cells: number) => (cells === 1 ? '1 cell' : `${cells} cells`),
      /** "84 cells · web 1.2 mm · 6 slivers dropped" (the inspector's read-out, P2). */
      readoutFull: (cells: number, web: string | undefined, dropped: number) =>
        [
          cells === 1 ? '1 cell' : `${cells} cells`,
          ...(web === undefined ? [] : [`web ${web}`]),
          ...(dropped === 0
            ? []
            : [dropped === 1 ? '1 sliver dropped' : `${dropped} slivers dropped`]),
        ].join(' · '),
      noShapes: 'No closed shapes in the part yet',
    },
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
    /** The Clones row's instance group (DF44: not "Clones 5", which reads like a feature). */
    clonesGroup: (n: number) => (n === 1 ? '1 clone' : `${n} clones`),
    /** An instance row's position (DF44): "X 196.50 · Y 115.59 mm" (u · v off the top face). */
    instanceAt: (u: string, v: string, axes: { u: string; v: string }, unit: string) =>
      `${axes.u} ${u} · ${axes.v} ${v} ${unit}`,
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
      actions: 'Clones draft actions',
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
      /**
       * Row field labels and hints (DF47, ui.md § Clones): axis names follow the face (`X`/`Y` on
       * the top face, `u`/`v` elsewhere, `axisNames`).
       */
      fields: {
        cols: 'Columns',
        rows: 'Rows',
        du: (u: string) => `Column spacing (${u})`,
        dv: (v: string) => `Row spacing (${v})`,
        count: 'Count',
        stepU: (u: string) => `Step ${u}`,
        stepV: (v: string) => `Step ${v}`,
        angle: 'Direction',
        distance: 'Distance per step',
        radius: 'Radius',
        centreAngle: 'Centre angle',
        arc: 'Sweep',
        step: 'Step angle',
        shape: 'Shape',
        start: 'Start offset',
        by: 'Place by',
        spacing: 'Spacing',
      },
      hints: {
        cols: (u: string) =>
          `How many positions across, along ${u}, counting the one the row starts from.`,
        rows: (v: string) =>
          `How many positions up, along ${v}, counting the one the row starts from.`,
        du: (u: string) =>
          `Distance between neighbouring columns, along ${u}. Negative goes the other way.`,
        dv: (v: string) =>
          `Distance between neighbouring rows, along ${v}. Negative goes the other way.`,
        count:
          'How many clones, each one step further on (not counting the position the row starts from).',
        stepU: (u: string) =>
          `How far each clone sits from the one before, along ${u}. Negative goes the other way.`,
        stepV: (v: string) =>
          `How far each clone sits from the one before, along ${v}. Negative goes the other way.`,
        angle: (u: string) => `Angle of the line the clones follow, from ${u}, counter-clockwise.`,
        distance: 'How far each clone sits from the one before, along that line.',
        radius: 'From the previous position to the arc’s centre.',
        centreAngle: (u: string) =>
          `Direction from the previous position to the arc’s centre, from ${u}, counter-clockwise.`,
        arc: 'How far the arc turns, up to ±360°: positive is counter-clockwise.',
        step: 'Angle between neighbouring positions, seen from the centre.',
        point: 'Where this clone goes, from the face’s origin (a jump: no path between).',
        shape: 'Positions follow this path from its start point.',
        start: 'Distance along the path before the first position. Empty: 0.',
        spacing: 'Distance between positions along the path.',
        alongCount: 'How many positions, spread evenly along the path.',
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
      types: {
        simple: 'Simple',
        counterbore: 'Counterbore',
        countersink: 'Countersink',
        recessedCountersink: 'Recessed countersink',
      } as Record<string, string>,
      /** Short segment labels where four do not fit the inspector's width (the full name is the tip). */
      typesShort: { recessedCountersink: 'Recessed' } as Record<string, string>,
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
      // a recessed countersink's cb* fields (hole-slots-and-round-corners.md § Inspector layout)
      recessDiameter: 'Recess Ø',
      recessDepth: 'Recess depth',
      // a slotted (long) hole (H3, hole-slots-and-round-corners.md § Inspector layout)
      slotted: 'Slotted',
      slottedInfo:
        'A long hole for adjustment: cut as Round pockets, the countersink along its outline.',
      slotLength: 'Slot length',
      slotLengthInfo: "Travel between the slot's end centres.",
      rotation: 'Rotation',
      overall: 'Overall',
      overallInfo: 'Slot length + diameter: the slot end to end.',
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
      /** The closed Defaults accordion's summary (DF110): head sink, a stepped countersink's stepdown. */
      defaultsSummary: (headSink: string | undefined, stepdown: string | undefined) =>
        [
          `Head sink ${headSink ?? '0'}`,
          ...(stepdown === undefined ? [] : [`stepdown ${stepdown}`]),
        ].join(' · '),
      showDefaults: 'Show defaults',
      hideDefaults: 'Hide defaults',
      sourcesLabel: 'Sizes from',
      sourceWhat: { close: 'close', normal: 'normal', loose: 'loose' } as Record<string, string>,
      /** Refill toast: "Sizes set from M4 (2 entered sizes replaced)". */
      refilled: (size: string, n: number) =>
        `Sizes set from ${size} (${n === 1 ? '1 entered size' : `${n} entered sizes`} replaced)`,
      useTable: (source: string) => `Use ${source}`,
      roleLabel: (role: string) =>
        (
          ({
            drill: 'Drill',
            counterbore: 'Counterbore',
            countersink: 'Countersink',
            recess: 'Recess',
            slot: 'Slot',
          }) as Record<string, string>
        )[role] ?? role[0]!.toUpperCase() + role.slice(1),
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
    /** DF48: the From library select with nothing to choose. */
    libraryEmpty: 'No stock in the library yet: Save to library adds one.',
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
    /**
     * DF96: a block's automatic name, its material class (not Other) and material, then its size:
     * "Aluminium 6061-T6 100 × 60 × 20"; the class is left out when the material starts with it
     * ("Hardwood" class, "Hardwood oak"), "Block" when both say nothing.
     */
    defaultName: (classLabel: string, cls: string, material: string, summary: string) => {
      const name = material.trim()
      const withClass =
        cls === 'other' || name.toLowerCase().startsWith(classLabel.toLowerCase())
          ? name
          : `${classLabel} ${name}`.trim()
      return `${withClass === '' ? 'Block' : withClass} ${summary}`
    },
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
    /** DF95: the Stock dialog of an existing part edits its stock. */
    update: 'Update stock',
    editTitle: 'Change the stock',
    editNote:
      'Operations keep their values: one that no longer fits the new stock shows a warning; nothing is moved or clamped.',
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
    /** DF95: the Stock dialog of a part edits its stock. */
    stockEditDescription:
      'The block the part is cut from. Change its size or material; Undo takes the change back.',
    /** "Choose one" only while there is one to choose (DF48). */
    shapesDescription: (any: boolean) =>
      any
        ? 'Outlines that pockets and profiles can cut. Choose one to edit it.'
        : 'Outlines that pockets and profiles can cut.',
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

  /** The part menu (split parts S0, ui.md § Part menu): switch, add and remove parts. */
  parts: {
    /** The part row's context menu (split parts 4a polish). */
    rowMenu: (part: string) => `Actions for ${part}`,
    menu: 'Parts',
    group: 'Parts',
    switchTo: (name: string) => `Show ${name}`,
    newPart: 'New part…',
    newTitle: 'New part',
    newDescription: 'Another part of this project, cut from its own block.',
    /** "<project> <n>" with the first number no part uses yet. */
    nextName: (project: string, used: readonly string[]) => {
      const base = project.trim() === '' ? 'Part' : project.trim()
      let n = used.length + 1
      while (used.includes(`${base} ${n}`)) n += 1
      return `${base} ${n}`
    },
    remove: (name: string) => `Remove ${name}`,
    inUse: (plan: string) => `${plan} is in use; archive it in Plan first.`,
    confirmTitle: (name: string) => `Remove ${name}?`,
    confirmDescription: (plans: number) =>
      `Its ${plans === 1 ? 'plan is' : `${plans} plans are`} removed too. Undo brings both back.`,
    confirmAction: 'Remove part',
    count: (n: number) => (n === 1 ? '1 part' : `${n} parts`),
  },

  /** Split parts 4a (ui.md § Split part): the split editor, its preview and read-only pieces. */
  split: {
    title: 'Split',
    action: 'Split part…',
    actionDescription: 'Cut this part from several blanks: pieces follow the part.',
    intro:
      'Pieces are parts of their own, each cut from its own blank. Edit this part; the pieces follow.',
    lines: 'Lines',
    levels: 'Levels',
    lineAt: (axis: 'x' | 'y') => `Line at ${axis.toUpperCase()}`,
    levelAt: 'Level at Z',
    addLine: (axis: 'x' | 'y') => `Add line at ${axis.toUpperCase()}`,
    addLevel: 'Add level',
    removeLine: (axis: 'x' | 'y', at: string) => `Remove line at ${axis.toUpperCase()} ${at}`,
    removeLevel: (at: string) => `Remove level at Z ${at}`,
    /** Split lines as shapes (split parts 4e). */
    addCurvedLine: 'Add curved line',
    addCurvedLineDescription:
      'A new open shape across the part and a line along it; edit its points in the Shape Editor',
    addLineAlong: 'Line along shape',
    lineAlongDescription: 'A line along one of this part’s open shapes, edge to edge',
    lineAlong: 'Line along shape',
    editLineShape: 'Edit shape',
    removeShapeLine: (shape: string) => `Remove line along ${shape}`,
    curveName: (n: number) => `Split curve ${n}`,
    margin: 'Blank margin',
    /** Keys on lines (split parts 4b-2). */
    lineJoint: 'Lines joined by',
    jointPuzzle: 'Puzzle',
    jointDovetail: 'Dovetail',
    /** Fingers and half laps (split parts 4d). */
    jointFinger: 'Finger',
    jointFingerDescription:
      'Interlocking fingers along the whole line, T-boned for the outline tool',
    jointHalfLap: 'Half lap',
    jointHalfLapDescription:
      'Each piece keeps half the thickness over an overlap; the upper piece is cut from its bottom',
    jointClearance: 'Joint clearance',
    fingerSettings: 'Finger settings',
    fingerSettingsSummary: (clearance: string, fingers: number | undefined) =>
      `clearance ${clearance}${fingers === undefined ? '' : ` · ${fingers === 1 ? '1 finger' : `${fingers} fingers`}`}`,
    /** "10 fingers · 26.1 mm wide · T-bones for the Ø6 mm outline tool" */
    fingerSummary: (n: number, width: string, tool: string) =>
      `${n === 1 ? '1 finger' : `${n} fingers`} · ${width} mm wide · T-bones for the Ø${tool} mm outline tool`,
    noFingers: 'No fingers fit yet: see the findings under each line.',
    lapSettings: 'Lap settings',
    lapSettingsSummary: (clearance: string, length: string | undefined) =>
      `clearance ${clearance}${length === undefined ? '' : ` · lap ${length} mm`}`,
    /** "1 half lap · 36 mm overlap · the upper piece is cut from its bottom (a flip)" */
    lapSummary: (n: number, length: string) =>
      `${n === 1 ? '1 half lap' : `${n} half laps`} · ${length} mm overlap · the upper piece is cut from its bottom (a flip)`,
    noLaps: 'No half lap fits yet: see the findings under each line.',
    clearance: 'Key clearance',
    clearanceHint:
      'Goes on the socket only; the knob keeps its size. Try 0.1–0.3 mm on a scrap first.',
    keyCount: (n: number) => (n === 1 ? '1 key' : `${n} keys`),
    /** "2 keys · neck 18 mm · Ø6.3 mm tool or smaller" */
    keySummary: (n: number, neck: string, tool: string) =>
      `${n === 1 ? '1 key' : `${n} keys`} · neck ${neck} mm · needs a tool of Ø${tool} mm or smaller (the outline's)`,
    noKeys: 'No key fits yet: see the findings under each line.',
    /** The joints' settings, collapsed once set (U9 Q131): their disclosure and summary. */
    keySettings: 'Key settings',
    keySettingsSummary: (clearance: string, keys: number | undefined) =>
      `clearance ${clearance}${keys === undefined ? '' : ` · ${keys === 1 ? '1 key' : `${keys} keys`}`}`,
    dowelSettings: 'Dowel settings',
    dowelSettingsSummary: (diameter: string, depth: string, holes: number) =>
      `Ø${diameter} · ${depth} deep · ${holes === 1 ? '1 hole' : `${holes} holes`}`,
    /** Test fit coupon (split parts 4b-3). */
    testFit: 'Test fit…',
    testFitDescription:
      'Add a small two-piece part with this key: cut it on scrap, try the fit, then set the clearance here.',
    testFitOne: (c: string) => `One coupon at ${c}`,
    testFitSeveral: (cs: readonly string[]) => `${cs.length} coupons: ${cs.join(', ')}`,
    /** Dowels on levels (split parts 4b). */
    levelJoint: 'Levels joined by',
    jointButt: 'Butt',
    jointDowels: 'Dowels',
    dowelDiameter: 'Dowel Ø',
    dowelHint: (sizes: string) =>
      `Dowels ${sizes} mm are common; the holes are 0.2 mm larger. Each piece is drilled from its glue face: the upper one from its bottom (a flip).`,
    dowelDepth: 'Hole depth',
    dowelCount: (n: number) => (n === 1 ? '1 dowel' : `${n} dowels`),
    positions: (n: number) => `Dowel positions (${n})`,
    dowelAt: (k: number, axis: 'x' | 'y') => `Dowel ${k} ${axis.toUpperCase()}`,
    dowelLevel: (k: number, level: string) => `Dowel ${k} · level at Z ${level}`,
    removeDowel: (k: number) => `Remove dowel ${k}`,
    placeAgain: 'Place dowels again',
    placeAgainDescription:
      'Spread new holes over every glue face, clear of features. A level whose last hole you remove is placed again.',
    remove: 'Remove split',
    /** DF110 S4: the Joints and Blanks accordions of the split editor and their summaries. */
    joints: 'Joints',
    jointsSummary: (lines: string | undefined, levels: string | undefined) =>
      [
        ...(lines === undefined ? [] : [`Lines ${lines}`]),
        ...(levels === undefined ? [] : [`Levels ${levels}`]),
      ].join(' · '),
    blanks: 'Blanks',
    blanksSummary: (margin: string, useStocks: boolean) =>
      `Margin ${margin} · ${useStocks ? 'library stocks' : 'own blocks'}`,
    noCuts: 'No lines or levels yet: the part is one piece.',
    pieces: (n: number) => (n === 1 ? '1 piece' : `${n} pieces`),
    preview: 'Split preview',
    top: 'Top',
    front: 'Front',
    /** "3 · 135 × 98.5 × 40 · own blank", "3 · 200 × 100.1 × 40 · Block 200 × 100.1 × 40" */
    chip: (n: number, size: string, blank: string) => `${n} · ${size} · ${blank}`,
    /** The blank of a row of piece chips (U9 Q132): "135 × 98.5 × 40 mm · own blank" */
    blankLine: (size: string, blank: string) => `${size} · ${blank}`,
    ownBlank: 'own blank',
    /** Blanks on library stocks (split parts 4c). */
    turned: (name: string) => `${name} · turned`,
    blankAuto: 'Automatic',
    blankAutoDescription:
      'The smallest library stock of the material class that holds the piece, if "Use library stocks" is on; else its own block.',
    blankOwn: 'Own block',
    blankOwnDescription: 'A block of the piece’s size plus the margins.',
    blankStocks: 'Library stocks that hold it',
    blankStock: (name: string, turned: boolean) => (turned ? `${name} (turned)` : name),
    noStockHolds: 'No library stock of this material class holds the piece.',
    useStocks: 'Use library stocks',
    useStocksHint:
      'Cut each piece from the smallest library stock that holds it; a thicker board is faced down.',
    fit: 'Split to fit…',
    fitDescription:
      'Choose a library stock: the fewest levels and lines so every piece fits it and the machine.',
    fitNoStocks: 'No library stock of this material class yet.',
    pieceTitle: 'Piece',
    pieceOf: (n: number, of: number, source: string) => `Piece ${n} of ${of} of ${source}`,
    editSplit: 'Edit the split',
    /** Detach (split parts 4d). */
    detach: 'Detach',
    detachDescription:
      'Make this piece a plain part you can edit; the split no longer makes or changes it. Undo brings it back.',
    readOnly: (source: string) => `Read-only: this piece follows ${source}.`,
    fromSource: (op: string, source: string) => `${op} comes from ${source}. Edit it there.`,
    generated: (op: string) => `${op} is made by the split. Edit the split to change it.`,
    showInSource: (source: string) => `Show in ${source}`,
    confirmTitle: 'Remove pieces with plans?',
    confirmDescription: (plans: number) =>
      `${plans === 1 ? 'A plan of a removed piece is' : `${plans} plans of removed pieces are`} removed too. Undo brings them back.`,
    confirmAction: 'Remove pieces',
    noStock: 'The part has no stock yet.',
    cutFindings: (n: number) => (n === 1 ? '1 finding' : `${n} findings`),
    moreFindings: (n: number) => `${n} more in Warnings`,
    viewportSummary: (pieces: number, cut: string | undefined) =>
      `Split preview: ${pieces === 1 ? '1 piece' : `${pieces} pieces`} pulled apart.${cut === undefined ? '' : ` ${cut}.`} Drag a line or level to move it, or edit it in the Split section.`,
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
    /**
     * The Operations header count's tooltip (DF44): the count is the list's rows, as shown; the
     * tooltip adds the operations in all when features hold more.
     */
    countTip: (rows: number, ops: number) =>
      rows === ops
        ? `${ops === 1 ? '1 operation' : `${ops} operations`} in design order.`
        : `${rows === 1 ? '1 row' : `${rows} rows`} in the list; ${ops === 1 ? '1 operation' : `${ops} operations`} in all, counting each hole's operations and every clone.`,
    listLabel: 'Operations in design order',
    empty: {
      title: 'No operations yet',
      // DF48: no "starting with facing" (wrong for sheet goods); features are offered too
      description: 'Add an operation or a feature to cut the stock.',
      addHole: 'Add bolt hole',
      /** DF98: every Add item is offered here too (add-items.ts). */
      addPattern: 'Add pattern',
      addEngraving: 'Add engraved pattern',
    },
    /** The row menu's Remove (DF16). */
    removeItem: 'Remove',
    /** The row menu's switch of a top-level row (DF106, design.md § Disabling operations and features). */
    disableItem: 'Disable',
    enableItem: 'Enable',
    /** The marker of a row that is off (DF106): its own, or following the item it builds on. */
    off: 'Off',
    offTitle: 'Disabled: kept here, left out of the 3D view, checks and Plan.',
    offFollows: 'Off: it builds on a disabled item. Enable that item to bring it back.',
    actions: (name: string) => `Actions for ${name}`,
    /** The description of a row with a row menu (DF70: no action buttons on rows). */
    rowMenuHint: 'Right-click or Shift+F10 for actions.',
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
      /** A profile's On, Side and Depth (DF110 target layout). */
      cut: 'Cut',
    },
    /**
     * Closed accordions' summaries (inspector-layout.md § Accordions): the values that matter, so
     * nothing hides silently.
     */
    summaries: {
      corners: (corner: string | undefined, floor: string, round = false) =>
        corner === undefined
          ? `Floor r ${floor}`
          : `r ${corner}${round ? ' (Round)' : ''} · Floor r ${floor}`,
      tabs: (count: string, entered: number | undefined) =>
        entered !== undefined ? `${entered} entered` : count === '1' ? '1 tab' : `${count} tabs`,
    },
    /** The More row of the Tabs group: the entered positions ("Add tab" while there are none). */
    tabPositions: 'Tab positions',
    generalTolerance: 'General tolerance (length)',
    /** The empty field's placeholder: no scope sets one, so untoleranced lengths are exact. */
    generalToleranceNone: 'None: lengths are exact',
    /** DF97: the field's presets (ui.md § General tolerance presets). */
    tolerancePresets: 'Common tolerances',
    tolerancePreset: (source: string, units: 'mm' | 'inch') =>
      units === 'mm' ? `±${source} mm` : `±${source}"`,
    toleranceUse: {
      precision: 'Precision fits in metal',
      fine: 'Fine: metal parts',
      standard: 'Standard CNC work',
      woodPlastic: 'Wood and plastics',
      rough: 'Rough work, wood that moves',
    },
    shapeKind: 'Shape',
    shapes: { rectangle: 'Rectangle', circle: 'Circle' },
    centerX: 'Centre X',
    centerY: 'Centre Y',
    length: 'Length (X)',
    width: 'Width (Y)',
    /**
     * Position and size labels in the face frame: the top face reads X and Y (its `u` and `v`),
     * every other face `u` and `v` (design-v0.2.md#face-frame). `point` is "Centre" for a
     * drilling (a hole is a point), "Position" for an anchored shape.
     */
    position: (point: 'Centre' | 'Position', axis: string) => `${point} ${axis}`,
    lengthAlong: (axis: string) => `Length (${axis})`,
    widthAlong: (axis: string) => `Width (${axis})`,
    anchor: 'Anchor',
    anchorFormula: 'Remove the formula to change the anchor.',
    diameter: 'Diameter',
    cornerRadius: 'Corner radius',
    /** DF120 R2: a rectangle's Round switch (hole-slots-and-round-corners.md#round-corners-df120). */
    round: 'Round',
    roundInfo:
      'Radius = half the narrowest side, follows size edits. Off: keeps the current radius.',
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
      /** DF49: imports a drawing and uses its first shape here (ui.md § Import SVG where it is looked for). */
      importSvg: 'Import SVG…',
      importUsed: (op: string, shape: string) => `${op} now cuts ${shape}.`,
      importNotUsed: (op: string, shape: string) =>
        `${op} could not use ${shape}; the reason shows at its Shape field.`,
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
    /** DF116: the Depth / Cut group's Through switch (design.md#pocket). */
    through: 'Through',
    throughInfo:
      'Cut through to the opposite face (or what an earlier setup left there), with the breakthrough. Off: the depth below On.',
    /** DF115: a Depth pick takes the surface the cut goes down to (ui.md#depth-pick-df115). */
    depthPickField: (label: string) => `${label} (cut down to it)`,
    depthPickedThrough: (op: string, surface: string) => `${op}: cut through to ${surface}.`,
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
      /** DF89: the flutes do not cut the walls' depth (the shank is not narrower). */
      flutes: (fluteLength: string | undefined, depth: string | undefined) =>
        fluteLength !== undefined && depth !== undefined
          ? `${fluteLength} flutes, too short for the ${depth} walls`
          : 'flutes too short for the walls',
      angle: 'another angle',
      /** DF108: a pattern's roughing tool over 0.6 × the widest cell. */
      roughingWidth: 'too wide to rough the cells',
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
    /**
     * Design's toast after an Apply re-chose tools because of the library (X2 F6,
     * design-v0.2.md § Library changes and opening): one with its reason, several counted.
     */
    rechosen: (operation: string | undefined, why: string | undefined, n: number) =>
      n === 1 && operation !== undefined && why !== undefined
        ? `Tool of ${operation} changed: ${why}.`
        : n === 1
          ? 'Tool of 1 operation changed: a library tool fits now.'
          : `Tools of ${n} operations changed: library tools fit now.`,
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
      flutes: (tool: string) => `the flutes of the ${tool} were too short for the walls`,
      roughingWidth: (tool: string) => `the ${tool} was too wide to rough the cells`,
      unresolved: 'the previous tool could not be read',
      /** DF54: a fitting generalized tool gave way to a library tool. */
      libraryFits: (tool: string) => `a library tool fits now instead of the ${tool}`,
      /** X2 F6: a tool removed from the library gave way to another library tool. */
      libraryRemoved: (tool: string) => `the ${tool} is no longer in the library`,
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
        line: 'Add line here',
      })[kind],
    addHole: 'Add bolt hole here',
    addPattern: 'Add pattern here',
    addEngraving: 'Add engraved pattern here',
    /** The empty part inspector: how operations get onto a face. */
    emptyHint: 'Select a face in the viewport (Alt+click for a floor) to add operations on it.',
    summary: (label: string) => `Selected face: ${label}; operations you add start on it.`,
  },

  /** The selected operation in the viewport's text summary (face frame and anchor shown). */
  selectionSummary: (p: { name: string; on: string; anchor: string | undefined }) =>
    `Selected: ${p.name} on ${p.on}, face axes u and v shown${
      p.anchor === undefined ? '' : `, anchor ${p.anchor}`
    }.`,

  /**
   * Construction surfaces (DF118 V3, docs/modes/construction-surfaces.md#ui): a referenced surface
   * later cuts removed; its level still holds.
   */
  construction: {
    /** The `On` field's note: what cut it away (other than the operation itself). */
    note: (by: readonly string[]) =>
      by.length === 0
        ? 'Cut away by this operation · still measured from its level'
        : `Cut away by ${nameList(by)} · still measured from its level`,
    /** A formula field's note names the surface. */
    noteOf: (surface: string, by: readonly string[]) =>
      by.length === 0
        ? `${surface} is cut away by this operation · still measured from its level`
        : `${surface} is cut away by ${nameList(by)} · still measured from its level`,
    info: 'A construction surface: later cuts remove it from the finished part, but its level still holds, so this operation is still measured from it.',
    /** The `On` list's muted suffix. */
    suffix: '(construction)',
    /** The viewport's text summary. */
    summary: (surface: string, by: readonly string[]) =>
      `${surface}, cut away by ${by.length === 0 ? 'a later operation' : nameList(by)}, shown as an outline.`,
  },

  viewportSummary: (p: { operations: number; warnings: number; status: EvaluationStatus }) => {
    const ops = p.operations === 1 ? '1 operation' : `${p.operations} operations`
    const warns =
      p.warnings === 0 ? '' : `, ${p.warnings === 1 ? '1 warning' : `${p.warnings} warnings`}`
    const state =
      p.status === 'pending' ? ', updating' : p.status === 'failed' ? ', evaluation failed' : ''
    return `Part with ${ops}${warns}${state}.`
  },
} as const
