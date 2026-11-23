// User-facing strings of the Shape UI (task U1): the navigator's Shapes group, the Shape Editor
// (item list, fields, segment table, flat view, handles) and the SVG import report. Terms from
// docs/glossary.md. Doc: docs/conventions/ui.md#shapes-v03, #internationalization
import type { ShapeItemKind, ShapeOp } from '../../../core/design/shape.dto'
import type { UnitSystem } from '../../../core/project/document'

const fmt = (n: number, digits: number): string => n.toFixed(digits)
const unitLabel = (units: UnitSystem): string => (units === 'mm' ? 'mm' : 'in')
const digitsOf = (units: UnitSystem): number => (units === 'mm' ? 2 : 3)
/** A length (mm) in project units: "12.50 mm", "0.492 in". */
export const lengthText = (mm: number, units: UnitSystem): string =>
  `${fmt(units === 'mm' ? mm : mm / 25.4, digitsOf(units))} ${unitLabel(units)}`
const num = (mm: number, units: UnitSystem): string =>
  fmt(units === 'mm' ? mm : mm / 25.4, digitsOf(units))
const short = (mm: number, units: UnitSystem): string =>
  String(+(units === 'mm' ? mm : mm / 25.4).toFixed(digitsOf(units)))

const KIND: Record<ShapeItemKind, string> = {
  rectangle: 'Rectangle',
  circle: 'Circle',
  obround: 'Obround',
  polygon: 'Polygon',
  path: 'Path',
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

export const shapeMessages = {
  kinds: KIND,
  navigator: {
    title: 'Shapes',
    listLabel: 'Shapes of the part',
    add: 'Add shape',
    addKind: (k: ShapeItemKind) => KIND[k],
    importSvg: 'Import SVG…',
    empty: 'No shapes yet: draw one, or import an SVG drawing.',
    usedBy: (n: number) => (n === 0 ? 'Not used' : `Used by ${n}`),
    failed: 'Does not resolve',
    remove: (name: string) => `Remove ${name}`,
    removed: (name: string) => `Removed ${name}`,
    referenced: (names: readonly string[]) =>
      `Used by ${names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`}.`,
  },
  inspector: {
    summaryMeta: (items: number) => plural(items, 'item'),
    name: 'Name',
    items: 'Items',
    itemsLabel: 'Items in order',
    addItem: 'Add item',
    op: 'Combine',
    ops: { add: 'Add', subtract: 'Subtract', intersect: 'Intersect' } satisfies Record<
      ShapeOp,
      string
    >,
    firstAdds: 'The first item always adds.',
    removeItem: (label: string) => `Remove ${label}`,
    lastItem: 'A shape needs at least one item.',
    itemLabel: (kind: ShapeItemKind, n: number) => `${KIND[kind]} ${n}`,
    /** The row's short description: "Rectangle 40 × 20", "Circle Ø 20", "Path · 4 segments". */
    itemSummary: (
      item:
        | { kind: 'rectangle' | 'obround'; length: number; width: number }
        | { kind: 'circle'; diameter: number }
        | { kind: 'polygon'; sides: number; diameter: number }
        | { kind: 'path'; segments: number; closed: boolean },
      units: UnitSystem,
    ): string => {
      switch (item.kind) {
        case 'rectangle':
        case 'obround':
          return `${KIND[item.kind]} ${short(item.length, units)} × ${short(item.width, units)}`
        case 'circle':
          return `Circle Ø ${short(item.diameter, units)}`
        case 'polygon':
          return `Polygon ${item.sides} sides Ø ${short(item.diameter, units)}`
        case 'path':
          return `${item.closed ? 'Path' : 'Open path'} · ${plural(item.segments, 'segment')}`
      }
    },
    fields: 'Item',
    centerX: 'Centre X',
    centerY: 'Centre Y',
    length: 'Length',
    width: 'Width',
    diameter: 'Diameter',
    cornerRadius: 'Corner radius',
    rotation: 'Rotation',
    sides: 'Sides',
    across: 'Diameter across',
    acrossCorners: 'Corners',
    acrossFlats: 'Flats',
    startX: 'Start X',
    startY: 'Start Y',
    closed: 'Closed',
    startFillet: 'Fillet at start',
    noneZero: '0',
    summary: 'Shape',
    area: 'Area',
    size: 'Size',
    insideRadius: 'Smallest inside radius',
    sharp: 'Sharp corner',
    noInside: 'None',
    elements: 'Elements',
    pathLength: 'Length',
    loops: (pieces: number, holes: number) =>
      holes === 0
        ? plural(pieces, 'loop')
        : `${plural(pieces, 'loop')}, ${plural(holes, 'island')}`,
    areaText: (mm2: number, units: UnitSystem) =>
      units === 'mm' ? `${(mm2 / 100).toFixed(2)} cm²` : `${(mm2 / 25.4 ** 2).toFixed(3)} in²`,
    sizeText: (w: number, h: number, units: UnitSystem) =>
      `${num(w, units)} × ${num(h, units)} ${unitLabel(units)}`,
    invalid: 'This shape does not resolve: fix the value marked in red.',
    commandFailed: 'The edit was not made.',
    show: 'Show items',
  },
  segments: {
    title: 'Segments',
    label: (item: string) => `Segments of ${item}`,
    number: '#',
    type: 'Type',
    x: 'End X',
    y: 'End Y',
    radius: 'Radius',
    direction: 'Direction',
    large: 'Large arc',
    /** The narrow column header of "Large arc" (its accessible name stays the long one). */
    largeShort: 'Large',
    fillet: 'Fillet',
    types: { line: 'Line', arc: 'Arc', tangentArc: 'Tangent arc' },
    cw: 'CW',
    ccw: 'CCW',
    add: 'Add segment',
    remove: (k: number) => `Remove segment ${k}`,
    removed: (k: number) => `Removed segment ${k}`,
    actions: (k: number) => `Actions for segment ${k}`,
    moveUp: (k: number) => `Move segment ${k} up`,
    moveDown: (k: number) => `Move segment ${k} down`,
    row: (k: number) => `Segment ${k}`,
    cell: (k: number, column: string) => `Segment ${k} ${column}`,
    lastSegment: 'A path needs at least one segment.',
    keys: 'Arrows move between cells, Enter edits, Alt+↑/↓ moves a row, Delete on # removes it.',
  },
  view: {
    region: 'Shape Editor',
    chipFrame: 'Shape frame',
    chip: (face: string | null) => (face === null ? 'Shape · Shape frame' : `Shape · ${face}`),
    summary: (o: {
      name: string
      loops: number
      elements: number
      face: string | null
      item: string | null
    }) =>
      `${o.name}: ${plural(o.loops, 'loop')}, ${plural(o.elements, 'element')}, ${
        o.face === null ? 'in its own frame' : `flat on ${o.face}`
      }.${o.item === null ? '' : ` Selected: ${o.item}.`}`,
    noOutline: 'The shape does not resolve yet.',
    invalid: 'Invalid: the last valid outline is shown.',
    /** A path with more than 20 segments shows the handles of the selected segment only (L3-7). */
    pickSegment: 'Click a segment, or a row of the segment table, to show its handles.',
    showItems: 'Show items',
    fit: 'Fit',
    close: 'Back to the part',
    keys: 'Tab moves between handles; arrows move the focused handle by 1 mm (Alt 0.1 mm, Shift 10 mm); Escape cancels a drag or leaves the editor.',
    locked: 'Remove the formula to drag.',
    handle: {
      centre: 'Centre',
      start: 'Start point',
      end: (k: number) => `Segment ${k} end point`,
      radius: (k: number) => `Segment ${k} radius`,
      size: {
        length: 'Length',
        width: 'Width',
        diameter: 'Diameter',
        cornerRadius: 'Corner radius',
      },
    },
    handleName: (name: string, value: string) => `${name}, ${value}`,
    point: (x: number, y: number, units: UnitSystem) => `X ${num(x, units)}, Y ${num(y, units)}`,
    chipPoint: (x: number, y: number, units: UnitSystem) =>
      `X ${num(x, units)}  Y ${num(y, units)}`,
    chipLength: (
      field: 'length' | 'width' | 'diameter' | 'cornerRadius' | 'radius',
      mm: number,
      units: UnitSystem,
    ) => {
      const prefix = { length: 'L', width: 'W', diameter: 'Ø', cornerRadius: 'R', radius: 'R' }[
        field
      ]
      return `${prefix} ${lengthText(mm, units)}`
    },
  },
  importReport: {
    optionsTitle: 'Import SVG',
    optionsDescription:
      'Closed loops become shapes with holes; curves are fitted with arcs within 0.01 mm.',
    refused: 'The file could not be imported',
    unit: 'Unit when the file has none',
    units: {
      mm: 'mm',
      in: 'inch',
      px96: 'px at 96 dpi',
      px72: 'px at 72 dpi',
    },
    split: 'Shapes',
    splits: { file: 'One per file', element: 'One per top-level element', loop: 'One per loop' },
    import: 'Import',
    cancel: 'Cancel',
    /** The shape inspector's button that reopens the last report (task U2). */
    reopen: 'Import report',
    title: (shapes: readonly string[]) =>
      shapes.length === 1 ? `Imported ${shapes[0]}` : `Imported ${shapes.length} shapes`,
    size: (w: number, h: number, units: UnitSystem) =>
      `${num(w, units)} × ${num(h, units)} ${unitLabel(units)}`,
    fromFile: 'from the file’s width and height',
    assumed: (unit: string) =>
      unit === 'px96'
        ? 'Unitless: 96 px per inch assumed'
        : unit === 'px72'
          ? 'Unitless: 72 px per inch assumed'
          : `Unitless: 1 unit = 1 ${unit === 'in' ? 'inch' : unit} assumed`,
    created: (shapes: number, loops: number, open: number) =>
      [
        plural(shapes, 'shape'),
        plural(loops, 'loop'),
        ...(open > 0 ? [plural(open, 'open path')] : []),
      ].join(', '),
    facts: 'What was imported',
    imported: 'Elements imported',
    skipped: 'Elements skipped',
    fitted: 'Curves fitted with arcs',
    fittedValue: (n: number, dev: number) => (n === 0 ? '0' : `${n}, ≤ ${dev.toFixed(3)} mm`),
    cusps: 'Corners kept at cusps',
    micro: 'Micro corners merged',
    repaired: 'Loops repaired',
    dropped: 'Loops dropped',
    gaps: 'Gaps closed',
    elements: 'Lines and arcs',
    elementsValue: (lines: number, arcs: number) => `${lines} lines, ${arcs} arcs`,
    byKind: (counts: Readonly<Record<string, number>>) => {
      const e = Object.entries(counts).filter(([, n]) => n > 0)
      return e.length === 0 ? '0' : e.map(([k, n]) => `${n} ${k}`).join(', ')
    },
    total: (counts: Readonly<Record<string, number>>) =>
      Object.values(counts).reduce((s, n) => s + n, 0),
    changed: 'Changed the drawing',
    preview: 'Preview of the imported outline',
    edit: 'Edit shape',
    close: 'Close',
  },
}
