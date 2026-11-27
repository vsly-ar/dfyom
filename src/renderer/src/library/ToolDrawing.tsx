// The tool editor's drawing: a side view of the tool type (flat, bull nose, ball, drill, chamfer
// mill) with its ISO 13399 dimensions (DC, RE, LCF, OAL, SIG, DMM, DCN, stickout). A chamfer mill
// (task U4) is a shank with a wider head ending in a cone with a tip flat: DC across the top of the
// cone, the included angle as an arc between the flanks, the tip (DCN) the flat at the bottom, LCF
// along the flank. A tapered ball end mill (DF124 T3) is the shank narrowing in a cone to a ball
// tip, schematic as the chamfer mill: DC across the cone's large end, the ball's diameter (DCN)
// across the ball, the taper angle (TA) between a flank and a line parallel to the axis, LCF up to
// where the cone meets the shank. The dimension of the focused field is
// drawn as an amber line, as in the field illustrations; the others stay grey. Decorative for the
// form (the fields carry the values), so it is an image with a label naming the highlighted one.
// A legend under it names each ISO symbol it shows ("DC Diameter", DF48).
// Doc: docs/conventions/ui-library-window.md#layout
import type { ToolType } from '../../../core/library/tool.dto'
import { libraryMessages } from '../messages/library'
import styles from './LibraryWindow.module.css'

export type ToolDimension =
  | 'diameter'
  | 'cornerRadius'
  | 'fluteLength'
  | 'overallLength'
  | 'stickout'
  | 'shankDiameter'
  | 'pointAngle'
  | 'angle'
  | 'tipDiameter'
  | 'taperAngle'

const S = libraryMessages.tool.symbols
const T = libraryMessages.tool

/** The symbols a type's drawing shows, in reading order (the stickout is labelled in words). */
function shown(type: ToolType): ToolDimension[] {
  return [
    'diameter',
    ...(type === 'bullNoseEndMill' ? (['cornerRadius'] as const) : []),
    ...(type === 'chamferMill' ? (['angle', 'tipDiameter'] as const) : []),
    ...(type === 'taperedBallEndMill' ? (['tipDiameter', 'taperAngle'] as const) : []),
    ...(type === 'drill' ? (['pointAngle'] as const) : []),
    'fluteLength',
    'overallLength',
    'shankDiameter',
  ]
}

// geometry (viewBox 220 × 250): the tool axis at x = AX, shank above the flutes, tip below;
// lengths on the left (LCF inside, OAL outside), the stickout on the right, diameters above/below
const AX = 110
const R = 12
const X0 = AX - R
const X1 = AX + R
const TOP = 26
const FLUTE = 108
const TIP = 196
const COLLET = 70
// chamfer mill: the head (half-width CR) from HEAD to CONE, then the 90°-looking cone to the tip
// flat (half-width CT) at CTIP
const CR = 22
const CT = 5
const HEAD = 132
const CONE = 150
const CTIP = CONE + (CR - CT)

// tapered ball end mill: the cone from the shank (half-width R) at TCONE down to a ball of radius
// BR centred at BY, tangent to it; drawn about 9° per side so the cone and its angle read (the
// real 0.5°–30° is a value, the drawing a schematic, tapered-ball-nose.md § Library window)
const TCONE = 144
const BR = 4
const BY = TIP - BR
/** Where the right flank from (X1, TCONE) touches the ball (the left one mirrors it). */
const TANGENT = (() => {
  const dx = X1 - AX
  const dy = TCONE - BY
  const d = Math.hypot(dx, dy)
  const toP = Math.atan2(dy, dx)
  const a = toP + Math.acos(BR / d)
  return { x: AX + BR * Math.cos(a), y: BY + BR * Math.sin(a) }
})()
const round = (v: number) => Math.round(v * 100) / 100
/** The flank's unit direction, from the large end down to the ball. */
const FLANK = (() => {
  const dx = TANGENT.x - X1
  const dy = TANGENT.y - TCONE
  const d = Math.hypot(dx, dy)
  return { x: dx / d, y: dy / d }
})()
/** The taper angle's arc radius about the flank's top. */
const TA_R = 40

function body(type: ToolType): string {
  if (type === 'taperedBallEndMill') {
    const tx = round(TANGENT.x)
    const lx = round(2 * AX - TANGENT.x)
    const ty = round(TANGENT.y)
    return `M${X0} ${TOP}H${X1}V${TCONE}L${tx} ${ty}A${BR} ${BR} 0 0 1 ${lx} ${ty}L${X0} ${TCONE}Z`
  }
  if (type === 'chamferMill')
    return `M${X0} ${TOP}H${X1}V${HEAD}H${AX + CR}V${CONE}L${AX + CT} ${CTIP}H${AX - CT}L${AX - CR} ${CONE}V${HEAD}H${X0}Z`
  if (type === 'drill') return `M${X0} ${TOP}H${X1}V${TIP}L${AX} ${TIP + 10}L${X0} ${TIP}Z`
  if (type === 'ballEndMill')
    return `M${X0} ${TOP}H${X1}V${TIP - R}A${R} ${R} 0 0 1 ${X0} ${TIP - R}Z`
  if (type === 'bullNoseEndMill')
    return `M${X0} ${TOP}H${X1}V${TIP - 5}Q${X1} ${TIP} ${X1 - 5} ${TIP}H${X0 + 5}Q${X0} ${TIP} ${X0} ${TIP - 5}Z`
  return `M${X0} ${TOP}H${X1}V${TIP}H${X0}Z`
}

/** Bottom of the tool on the axis (where the lengths are measured to). */
const tipY = (type: ToolType) => (type === 'drill' ? TIP + 10 : type === 'chamferMill' ? CTIP : TIP)

function Dim({
  id,
  focused,
  children,
  label,
  lx,
  ly,
  anchor = 'middle',
}: {
  id: ToolDimension
  focused: ToolDimension | undefined
  children: React.ReactNode
  label: string
  lx: number
  ly: number
  anchor?: 'start' | 'middle' | 'end'
}): React.JSX.Element {
  return (
    <g data-dim={id} data-active={focused === id || undefined} className={styles['dim']}>
      {children}
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

export function ToolDrawing({
  type,
  focused,
}: {
  type: ToolType
  focused: ToolDimension | undefined
}): React.JSX.Element {
  const tip = tipY(type)
  const chamfer = type === 'chamferMill'
  const tapered = type === 'taperedBallEndMill'
  // the stickout line: beside the shank, or beside a chamfer mill's wider head (a tapered ball's
  // clears the taper angle's label)
  const sx = chamfer ? AX + CR + 30 : tapered ? X1 + 30 : X1 + 20
  // a tapered ball's flutes end where the cone meets the shank
  const lcfTop = tapered ? TCONE : FLUTE
  const legendName = (d: ToolDimension) => (tapered ? (T.taperedLegend[d] ?? T[d]) : T[d])
  const name =
    focused === undefined ? undefined : (libraryMessages.tool.drawingNames[focused] ?? S[focused])
  const helix = [0, 20, 40, 60, 80]
    .map((y) => `M${X0} ${FLUTE + y + 12}L${X1} ${FLUTE + y + 2}`)
    .join('')
  return (
    <figure className={styles['drawingFigure']}>
      <svg
        viewBox="0 0 220 250"
        role="img"
        aria-label={libraryMessages.tool.drawing(name)}
        className={styles['drawing']}
        data-focused={focused}
      >
        {/* collet face */}
        <path className={styles['collet']} d={`M${X0 - 22} ${COLLET}H${X1 + 40}`} />
        <path className={styles['toolBody']} d={body(type)} />
        {/* flutes: helix hints below the shank (a chamfer mill: one flute edge on the cone) */}
        {chamfer ? (
          <path className={styles['flutes']} d={`M${AX + 8} ${CONE}L${AX + 2} ${CTIP}`} />
        ) : tapered ? (
          <path
            className={styles['flutes']}
            d={`M${X0} ${TCONE}H${X1}M${AX + 6} ${TCONE + 6}L${AX + 1} ${BY - 2}`}
          />
        ) : (
          <path className={styles['flutes']} d={`M${X0} ${FLUTE}H${X1}${helix}`} />
        )}

        <Dim
          id="overallLength"
          focused={focused}
          label={S.overallLength}
          lx={30}
          ly={(TOP + tip) / 2}
          anchor="end"
        >
          <path d={`M${X0 - 4} ${TOP}H34M${X0 - 4} ${tip}H34M38 ${TOP}V${tip}`} />
        </Dim>
        {chamfer ? (
          // the cutting edge: parallel to the right flank, offset outwards
          <Dim
            id="fluteLength"
            focused={focused}
            label={S.fluteLength}
            lx={AX + CR + 4}
            ly={CTIP + 6}
            anchor="start"
          >
            <path d={`M${AX + CR + 5} ${CONE + 5}L${AX + CT + 5} ${CTIP + 5}`} />
          </Dim>
        ) : (
          <Dim
            id="fluteLength"
            focused={focused}
            label={S.fluteLength}
            lx={64}
            ly={(lcfTop + tip) / 2}
            anchor="end"
          >
            <path d={`M${X0 - 4} ${lcfTop}H68M72 ${lcfTop}V${tip}M${X0 - 4} ${tip}H68`} />
          </Dim>
        )}
        <Dim
          id="stickout"
          focused={focused}
          label={S.stickout}
          lx={sx + 6}
          ly={(COLLET + tip) / 2}
          anchor="start"
        >
          <path
            d={`M${sx} ${COLLET}V${tip}M${sx - (chamfer || tapered ? 4 : 16)} ${tip}H${sx + 4}`}
          />
        </Dim>
        <Dim id="shankDiameter" focused={focused} label={S.shankDiameter} lx={AX} ly={10}>
          <path
            d={`M${X0} ${TOP - 3}V${TOP - 12}M${X1} ${TOP - 3}V${TOP - 12}M${X0} ${TOP - 8}H${X1}`}
          />
        </Dim>
        {chamfer ? (
          // DC: the width at the top of the cone, dimensioned below the tool as for the other types
          <Dim id="diameter" focused={focused} label={S.diameter} lx={AX} ly={tip + 34}>
            <path
              d={`M${AX - CR} ${tip + 6}V${tip + 24}M${AX + CR} ${tip + 6}V${tip + 24}M${AX - CR} ${tip + 20}H${AX + CR}`}
            />
          </Dim>
        ) : (
          <Dim id="diameter" focused={focused} label={S.diameter} lx={AX} ly={tip + 34}>
            <path
              d={`M${X0} ${tip + 6}V${tip + 24}M${X1} ${tip + 6}V${tip + 24}M${X0} ${tip + 20}H${X1}`}
            />
          </Dim>
        )}
        {chamfer ? (
          <>
            {/* the included angle: an arc between the flanks about their (virtual) apex */}
            <Dim
              id="angle"
              focused={focused}
              label={S.angle}
              lx={AX + CR + 4}
              ly={CONE + 2}
              anchor="start"
            >
              <path
                d={`M${AX - 13} ${CTIP + CT - 13}A${13 * Math.SQRT2} ${13 * Math.SQRT2} 0 0 1 ${AX + 13} ${CTIP + CT - 13}`}
              />
            </Dim>
            {/* the tip: the flat at the bottom */}
            <Dim id="tipDiameter" focused={focused} label={S.tipDiameter} lx={AX} ly={tip + 10}>
              <path d={`M${AX - CT} ${tip}H${AX + CT}`} />
            </Dim>
          </>
        ) : null}
        {tapered ? (
          <>
            {/* the taper angle: between a line parallel to the axis (dashed) and the flank */}
            <Dim
              id="taperAngle"
              focused={focused}
              label={S.taperAngle}
              lx={X1 + 4}
              ly={TCONE + TA_R + 8}
              anchor="start"
            >
              <path d={`M${X1} ${TCONE}V${TCONE + TA_R + 4}`} strokeDasharray="3 2" />
              <path
                d={`M${X1} ${TCONE + TA_R}A${TA_R} ${TA_R} 0 0 1 ${round(X1 + TA_R * FLANK.x)} ${round(TCONE + TA_R * FLANK.y)}`}
              />
            </Dim>
            {/* the ball's diameter: across the ball at its centre */}
            <Dim id="tipDiameter" focused={focused} label={S.tipDiameter} lx={AX} ly={tip + 10}>
              <path d={`M${AX - BR} ${BY}H${AX + BR}`} />
            </Dim>
          </>
        ) : null}
        {type === 'bullNoseEndMill' ? (
          <Dim
            id="cornerRadius"
            focused={focused}
            label={S.cornerRadius}
            lx={X1 + 26}
            ly={TIP + 16}
            anchor="start"
          >
            <path d={`M${X1 - 2} ${TIP - 2}L${X1 + 22} ${TIP + 14}`} />
          </Dim>
        ) : null}
        {type === 'drill' ? (
          <Dim
            id="pointAngle"
            focused={focused}
            label={S.pointAngle}
            lx={X1 + 26}
            ly={TIP + 18}
            anchor="start"
          >
            <path
              d={`M${AX} ${tip}L${X0 - 10} ${TIP - 6}M${AX} ${tip}L${X1 + 10} ${TIP - 6}M${X1 + 2} ${TIP - 1}Q${X1 + 8} ${TIP + 6} ${X1 + 22} ${TIP + 16}`}
            />
          </Dim>
        ) : null}
      </svg>
      <figcaption>
        <dl className={styles['legend']} aria-label={T.legend}>
          {shown(type).map((d) => (
            <div key={d} data-active={focused === d || undefined}>
              <dt>{S[d]}</dt>
              <dd>{legendName(d)}</dd>
            </div>
          ))}
        </dl>
      </figcaption>
    </figure>
  )
}
