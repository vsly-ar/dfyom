// The machine editor's holder drawing (hardening DF132 H1): a side view of the spindle body (cut
// off at the top: it counts to infinity upward), the collet nut under it and a tool in the collet,
// with the four holder dimensions and the spindle nose (the nut face, where stickout and the nose
// to table distance are measured). Schematic: the proportions are fixed, the fields carry the
// values. The focused field's dimension is drawn amber, as in the tool drawing; a legend under it
// names each label. Doc: docs/modes/tool-holder.md#implementation-h1
import type { HolderSize } from '../../../core/library/holder'
import { libraryMessages } from '../messages/library'
import styles from './LibraryWindow.module.css'

const H = libraryMessages.machine.holder

// geometry (viewBox 220 × 230): the axis at AX; body BODY_TOP..NUT_TOP, nut NUT_TOP..NOSE, tool
// NOSE..TIP; the nut length on the right, the diameters above (body) and below (nut, shank)
const AX = 110
const BODY_R = 58
const NUT_R = 26
const SHANK_R = 7
const BODY_TOP = 30
const NUT_TOP = 92
const NOSE = 132
const TIP = 196

/** The top edge of the body as a break line (zigzag): the body goes on upward. */
const BREAK = (() => {
  const xs = [AX - BODY_R, AX - 30, AX - 20, AX + 20, AX + 30, AX + BODY_R]
  const ys = [BODY_TOP, BODY_TOP, BODY_TOP - 6, BODY_TOP + 6, BODY_TOP, BODY_TOP]
  return xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x} ${ys[i]}`).join('')
})()

function Dim({
  id,
  focused,
  label,
  lx,
  ly,
  anchor = 'middle',
  d,
}: {
  id: HolderSize
  focused: HolderSize | undefined
  label: string
  lx: number
  ly: number
  anchor?: 'start' | 'middle' | 'end'
  d: string
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

export function HolderDrawing({ focused }: { focused: HolderSize | undefined }): React.JSX.Element {
  const bl = AX - BODY_R
  const br = AX + BODY_R
  const nl = AX - NUT_R
  const nr = AX + NUT_R
  const sl = AX - SHANK_R
  const sr = AX + SHANK_R
  const name = focused === undefined ? undefined : H.labels[focused]
  return (
    <figure className={styles['drawingFigure']}>
      <svg
        viewBox="0 0 220 230"
        role="img"
        aria-label={H.drawing(name)}
        className={styles['drawing']}
        data-focused={focused}
      >
        {/* body: broken off at the top, then the nut (hex flats as two lines), then the tool */}
        <path className={styles['toolBody']} d={`${BREAK}V${NUT_TOP}H${bl}Z`} />
        <path className={styles['toolBody']} d={`M${nl} ${NUT_TOP}H${nr}V${NOSE}H${nl}Z`} />
        <path
          className={styles['flutes']}
          d={`M${AX - 9} ${NUT_TOP}V${NOSE}M${AX + 9} ${NUT_TOP}V${NOSE}`}
        />
        <path
          className={styles['toolBody']}
          d={`M${sl} ${NOSE}H${sr}V${TIP - SHANK_R}L${AX} ${TIP}L${sl} ${TIP - SHANK_R}Z`}
        />
        {/* the spindle nose: the nut face */}
        <path
          className={styles['collet']}
          d={`M${bl - 6} ${NOSE}H${nl - 4}M${nr + 4} ${NOSE}H${br}`}
        />
        <text
          x={bl - 6}
          y={NOSE - 7}
          textAnchor="start"
          dominantBaseline="middle"
          className={styles['dimText']}
        >
          {H.nose}
        </text>

        <Dim
          id="bodyDiameter"
          focused={focused}
          label={H.symbols.bodyDiameter}
          lx={AX}
          ly={8}
          d={`M${bl} ${BODY_TOP - 3}V${BODY_TOP - 18}M${br} ${BODY_TOP - 3}V${BODY_TOP - 18}M${bl} ${BODY_TOP - 14}H${br}`}
        />
        <Dim
          id="nutLength"
          focused={focused}
          label={H.symbols.nutLength}
          lx={nr + 22}
          ly={(NUT_TOP + NOSE) / 2}
          anchor="start"
          d={`M${nr + 4} ${NUT_TOP}H${nr + 20}M${nr + 4} ${NOSE}H${nr + 20}M${nr + 16} ${NUT_TOP}V${NOSE}`}
        />
        <Dim
          id="nutDiameter"
          focused={focused}
          label={H.symbols.nutDiameter}
          lx={nl - 6}
          ly={NOSE + 16}
          anchor="end"
          d={`M${nl} ${NOSE + 3}V${NOSE + 20}M${nr} ${NOSE + 3}V${NOSE + 20}M${nl} ${NOSE + 16}H${nr}`}
        />
        <Dim
          id="maxShank"
          focused={focused}
          label={H.symbols.maxShank}
          lx={AX}
          ly={TIP + 26}
          d={`M${sl} ${TIP - 12}V${TIP + 16}M${sr} ${TIP - 12}V${TIP + 16}M${sl} ${TIP + 12}H${sr}`}
        />
      </svg>
      <figcaption>
        <dl className={styles['legend']} aria-label={H.legend}>
          {(['nutDiameter', 'nutLength', 'bodyDiameter', 'maxShank'] as const).map((d) => (
            <div key={d} data-active={focused === d || undefined}>
              <dt>{H.symbols[d]}</dt>
              <dd>{H.labels[d]}</dd>
            </div>
          ))}
        </dl>
      </figcaption>
    </figure>
  )
}
