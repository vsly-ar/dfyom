// The workholding editor's device drawing (WL3): a plan view above a side view of the device type
// (toe clamp with its strap, stud and heel; vise jaws; screw head; block; base; surface hold),
// the stock dashed, every library size dimensioned with its value as entered. Schematic, not to
// scale: the values are the labels. The dimension of the focused field is amber, as in the tool
// drawing; the rest stays grey (neutral styling). Decorative for the form (the fields carry the
// values), so it is one image named after the highlighted dimension, with a legend under it.
// Doc: docs/modes/workholding-library.md#library-window-tab
import type { ReactNode } from 'react'
import type { WorkholdingType } from '../../../core/library/workholding.dto'
import type { QuantityDTO } from '../../../core/quantity/quantity.dto'
import { libraryMessages } from '../messages/library'
import { quantityText, type WorkholdingDraft } from './form'
import styles from './LibraryWindow.module.css'

const m = libraryMessages.workholding

/** A dimension the drawing shows: a size field, or the toe clamp's grip range (both fields). */
export type DeviceDimension =
  | 'width'
  | 'length'
  | 'top'
  | 'grip'
  | 'jawWidth'
  | 'jawThickness'
  | 'jawHeight'
  | 'maxOpening'
  | 'headDiameter'
  | 'headHeight'
  | 'height'
  | 'thickness'

/** The field a focused input reports → the dimension it highlights. */
export function dimensionOf(field: string | undefined): DeviceDimension | undefined {
  if (field === 'gripMin' || field === 'gripMax') return 'grip'
  return field !== undefined && DIMENSION_NAMES[field as DeviceDimension] !== undefined
    ? (field as DeviceDimension)
    : undefined
}

/** Legend names (the field labels; a block's length, width and height without "strap"). */
const DIMENSION_NAMES: Record<DeviceDimension, string> = {
  width: m.width,
  length: m.length,
  top: m.top,
  grip: m.gripRange,
  jawWidth: m.jawWidth,
  jawThickness: m.jawThickness,
  jawHeight: m.jawHeight,
  maxOpening: m.maxOpening,
  headDiameter: m.headDiameter,
  headHeight: m.headHeight,
  height: m.blockHeight,
  thickness: m.thickness,
}

const legendName = (type: WorkholdingType, d: DeviceDimension): string =>
  type === 'block' && d === 'length'
    ? m.blockLength
    : type === 'block' && d === 'width'
      ? m.blockWidth
      : DIMENSION_NAMES[d]

/** The dimensions a type's drawing shows, in reading order. */
function shown(type: WorkholdingType): DeviceDimension[] {
  switch (type) {
    case 'toeClamp':
      return ['width', 'length', 'top', 'grip']
    case 'vise':
      return ['jawWidth', 'jawThickness', 'jawHeight', 'maxOpening']
    case 'screw':
      return ['headDiameter', 'headHeight']
    case 'block':
      return ['length', 'width', 'height']
    case 'base':
      return ['thickness']
    case 'surface':
      return []
  }
}

function Dim({
  id,
  focused,
  d,
  label,
  lx,
  ly,
  anchor = 'middle',
}: {
  id: DeviceDimension
  focused: DeviceDimension | undefined
  d: string
  label: string
  lx: number
  ly: number
  anchor?: 'start' | 'middle' | 'end'
}): React.JSX.Element {
  return (
    <g data-dim={id} data-active={focused === id || undefined} className={styles['dim']}>
      <path d={d} />
      <text
        x={lx}
        y={ly}
        textAnchor={anchor}
        dominantBaseline="middle"
        className={styles['dimText']}
      >
        {label}
      </text>
    </g>
  )
}

/** A horizontal dimension from x1 to x2 at y, its extension lines from `from` (the edges' y). */
const hDim = (x1: number, x2: number, y: number, from: number) => {
  const s = y < from ? -3 : 3
  return `M${x1} ${from}V${y + s}M${x2} ${from}V${y + s}M${x1} ${y}H${x2}`
}
/** A vertical dimension from y1 to y2 at x, its extension lines from `from` (the edges' x). */
const vDim = (y1: number, y2: number, x: number, from: number) => {
  const s = x < from ? -3 : 3
  return `M${from} ${y1}H${x + s}M${from} ${y2}H${x + s}M${x} ${y1}V${y2}`
}

/** A dimension's text: the value as entered ("30 mm", `1 1/4"`), "–" while empty. */
const val = (dto: QuantityDTO | undefined) => (dto === undefined ? '–' : quantityText(dto))

// viewBox 260 × 250: the plan view in the top half, the side view below the divider
const W = 260
const H = 250
const PLAN = 10
const SIDE = 132

function ToeClamp({ v, f }: { v: WorkholdingDraft; f: DeviceDimension | undefined }) {
  const grip =
    v.gripMin === undefined && v.gripMax === undefined ? '–' : `${val(v.gripMin)}–${val(v.gripMax)}`
  return (
    <>
      {/* plan: the stock edge on the left, the strap over it with the stud slot */}
      <path className={styles['stockShape']} d="M10 28H82V110H10" />
      <rect className={styles['deviceBody']} x={52} y={52} width={146} height={30} rx={2} />
      <rect className={styles['deviceDetail']} x={118} y={61} width={30} height={12} rx={6} />
      <Dim
        id="length"
        focused={f}
        d={hDim(52, 198, 40, 52)}
        label={val(v.length)}
        lx={125}
        ly={30}
      />
      <Dim
        id="width"
        focused={f}
        d={vDim(52, 82, 212, 198)}
        label={val(v.width)}
        lx={218}
        ly={67}
        anchor="start"
      />
      <Dim
        id="grip"
        focused={f}
        d={hDim(52, 82, 94, 82)}
        label={grip}
        lx={88}
        ly={95}
        anchor="start"
      />
      {/* side: the strap on the stock and the heel on the table, the stud and its nut on top */}
      <path className={styles['table']} d={`M6 ${H - 12}H${W - 6}`} />
      <path className={styles['stockShape']} d={`M10 ${H - 52}H82V${H - 12}`} />
      <rect className={styles['deviceBody']} x={52} y={H - 64} width={146} height={12} rx={1} />
      <rect className={styles['deviceBody']} x={184} y={H - 52} width={14} height={40} />
      <path className={styles['deviceDetail']} d={`M133 ${H - 74}V${H - 12}`} />
      <rect className={styles['deviceBody']} x={124} y={H - 82} width={18} height={10} rx={1} />
      <Dim
        id="top"
        focused={f}
        d={`M120 ${H - 82}H${W - 34}M86 ${H - 52}H${W - 34}M${W - 38} ${H - 82}V${H - 52}`}
        label={val(v.top)}
        lx={W - 32}
        ly={H - 67}
        anchor="start"
      />
    </>
  )
}

function Vise({ v, f }: { v: WorkholdingDraft; f: DeviceDimension | undefined }) {
  return (
    <>
      {/* plan: the fixed and the moving jaw, the stock between them */}
      <rect className={styles['deviceBody']} x={30} y={40} width={170} height={14} />
      <rect className={styles['deviceBody']} x={30} y={94} width={170} height={14} />
      <rect className={styles['stockShape']} x={80} y={54} width={90} height={40} />
      <Dim
        id="jawWidth"
        focused={f}
        d={hDim(30, 200, 30, 40)}
        label={val(v.jawWidth)}
        lx={115}
        ly={20}
      />
      <Dim
        id="jawThickness"
        focused={f}
        d={vDim(40, 54, 212, 200)}
        label={val(v.jawThickness)}
        lx={218}
        ly={47}
        anchor="start"
      />
      <Dim
        id="maxOpening"
        focused={f}
        d={`M50 54V94`}
        label={val(v.maxOpening)}
        lx={56}
        ly={74}
        anchor="start"
      />
      {/* side, looking along the jaws: the jaws stand on the vise body, the stock between */}
      <path className={styles['table']} d={`M6 ${H - 12}H${W - 6}`} />
      <rect className={styles['deviceDetail']} x={50} y={H - 42} width={170} height={30} />
      <rect className={styles['deviceBody']} x={80} y={H - 90} width={16} height={48} />
      <rect className={styles['deviceBody']} x={174} y={H - 90} width={16} height={48} />
      <rect className={styles['stockShape']} x={96} y={H - 100} width={78} height={58} />
      <Dim
        id="jawHeight"
        focused={f}
        d={vDim(H - 90, H - 42, 66, 80)}
        label={val(v.jawHeight)}
        lx={60}
        ly={H - 66}
        anchor="end"
      />
    </>
  )
}

function Screw({ v, f }: { v: WorkholdingDraft; f: DeviceDimension | undefined }) {
  const flush = v.headHeight === undefined || /^0(\s|$|"|mm|in)/.test(v.headHeight.source.trim())
  const headTop = flush ? H - 76 : H - 84
  return (
    <>
      {/* plan: the head on the stock, its drive recess */}
      <rect className={styles['stockShape']} x={40} y={42} width={180} height={72} />
      <circle className={styles['deviceBody']} cx={130} cy={78} r={20} />
      <path className={styles['deviceDetail']} d="M122 78H138M130 70V86" />
      <Dim
        id="headDiameter"
        focused={f}
        d={hDim(110, 150, 30, 78)}
        label={val(v.headDiameter)}
        lx={130}
        ly={20}
      />
      {/* side: the screw through the stock into the base, the head on or in the stock top */}
      <rect className={styles['stockShape']} x={40} y={H - 76} width={180} height={34} />
      <rect className={styles['deviceDetail']} x={20} y={H - 42} width={220} height={30} />
      <rect className={styles['deviceBody']} x={112} y={headTop} width={36} height={8} rx={1} />
      <path
        className={styles['deviceBody']}
        d={`M124 ${headTop + 8}V${H - 22}L130 ${H - 16}L136 ${H - 22}V${headTop + 8}`}
      />
      <Dim
        id="headHeight"
        focused={f}
        d={`M150 ${headTop}H${W - 54}M222 ${H - 76}H${W - 54}M${W - 58} ${headTop}V${H - 76}`}
        label={val(v.headHeight)}
        lx={W - 52}
        ly={flush ? headTop - 8 : headTop + 4}
        anchor="start"
      />
    </>
  )
}

function Block({ v, f }: { v: WorkholdingDraft; f: DeviceDimension | undefined }) {
  return (
    <>
      <rect className={styles['deviceBody']} x={60} y={42} width={130} height={60} rx={1} />
      <Dim
        id="length"
        focused={f}
        d={hDim(60, 190, 30, 42)}
        label={val(v.length)}
        lx={125}
        ly={20}
      />
      <Dim
        id="width"
        focused={f}
        d={vDim(42, 102, 204, 190)}
        label={val(v.width)}
        lx={210}
        ly={72}
        anchor="start"
      />
      <path className={styles['table']} d={`M6 ${H - 12}H${W - 6}`} />
      <rect className={styles['deviceBody']} x={60} y={H - 62} width={130} height={50} rx={1} />
      <Dim
        id="height"
        focused={f}
        d={vDim(H - 62, H - 12, 204, 190)}
        label={val(v.height)}
        lx={210}
        ly={H - 37}
        anchor="start"
      />
    </>
  )
}

function Base({ v, f }: { v: WorkholdingDraft; f: DeviceDimension | undefined }) {
  const plate = v.baseType === 'fixturePlate'
  const holes = plate
    ? [50, 90, 130, 170, 210].flatMap((x) => [32, 64, 96].map((y) => ({ x, y })))
    : []
  return (
    <>
      <rect className={styles['deviceBody']} x={20} y={22} width={220} height={92} rx={1} />
      {holes.map((h) => (
        <circle key={`${h.x}-${h.y}`} className={styles['deviceDetail']} cx={h.x} cy={h.y} r={3} />
      ))}
      <rect className={styles['stockShape']} x={76} y={44} width={108} height={48} />
      <path className={styles['table']} d={`M6 ${H - 12}H${W - 6}`} />
      <rect className={styles['stockShape']} x={76} y={H - 58} width={108} height={22} />
      <rect className={styles['deviceBody']} x={20} y={H - 36} width={220} height={24} />
      <Dim
        id="thickness"
        focused={f}
        d={vDim(H - 36, H - 12, 250, 240)}
        label={val(v.thickness)}
        lx={246}
        ly={H - 46}
        anchor="end"
      />
    </>
  )
}

function Surface({ v }: { v: WorkholdingDraft }) {
  const pattern: ReactNode =
    v.surfaceType === 'vacuum' ? (
      <path
        className={styles['deviceDetail']}
        d="M60 50H200M60 70H200M60 90H200M80 38V102M130 38V102M180 38V102"
      />
    ) : v.surfaceType === 'glue' ? (
      [70, 110, 150, 190].flatMap((x) =>
        [50, 90].map((y) => (
          <circle key={`${x}-${y}`} className={styles['deviceDetail']} cx={x} cy={y} r={5} />
        )),
      )
    ) : (
      [52, 104].map((x) => (
        <rect key={x} className={styles['deviceDetail']} x={x} y={36} width={22} height={68} />
      ))
    )
  return (
    <>
      <rect className={styles['stockShape']} x={50} y={30} width={160} height={80} />
      {pattern}
      <path className={styles['table']} d={`M6 ${H - 12}H${W - 6}`} />
      <rect className={styles['stockShape']} x={50} y={H - 50} width={160} height={30} />
      <rect className={styles['deviceBody']} x={50} y={H - 20} width={160} height={8} />
    </>
  )
}

export function WorkholdingDrawing({
  values,
  focused,
}: {
  values: WorkholdingDraft
  focused: DeviceDimension | undefined
}): React.JSX.Element {
  const type = values.type
  const dims = shown(type)
  const name = focused === undefined ? undefined : legendName(type, focused)
  const props = { v: values, f: focused }
  return (
    <figure className={styles['drawingFigure']}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={m.drawing(name)}
        className={styles['drawing']}
        data-type={type}
        data-focused={focused}
      >
        <text x={0} y={PLAN} className={styles['viewLabel']}>
          {m.plan}
        </text>
        <path className={styles['viewDivider']} d={`M0 ${SIDE - 8}H${W}`} />
        <text x={0} y={SIDE + 6} className={styles['viewLabel']}>
          {m.side}
        </text>
        {type === 'toeClamp' ? (
          <ToeClamp {...props} />
        ) : type === 'vise' ? (
          <Vise {...props} />
        ) : type === 'screw' ? (
          <Screw {...props} />
        ) : type === 'block' ? (
          <Block {...props} />
        ) : type === 'base' ? (
          <Base {...props} />
        ) : (
          <Surface v={values} />
        )}
      </svg>
      {dims.length > 0 ? (
        <figcaption>
          <ul className={styles['deviceLegend']} aria-label={m.legend}>
            {dims.map((d) => (
              <li key={d} data-active={focused === d || undefined}>
                {legendName(type, d)}
              </li>
            ))}
          </ul>
        </figcaption>
      ) : null}
    </figure>
  )
}
