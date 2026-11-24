/**
 * Setup instructions for a program's header (hardening DF58): how the stock sits for a setup,
 * the move from setup 1 (flip, tip, turn), the part corner at the work zero and the face Z0 is
 * on. Also the corner name the setup panel shows. Pure, headless; words, not numbers in units.
 * Doc: docs/architecture/grbl.md#setup-header-hardening-df58
 */
import { DIRECTION_LABEL, type StockSize } from '../geometry/face'
import type { Vec3 } from '../geometry/model'
import type { SetupHeader } from '../post/program'
import type { Overreach } from '../toolpath/overreach'
import { setupFrame, setupOrientation, setupZeroCorner } from '../toolpath/wcs'
import type { SetupDTO } from './plan.dto'
import { setupDirection, setupRotation } from './setups'

type Mat = readonly [Vec3, Vec3, Vec3]

/** The setup's machine axes X, Y, Z as part-frame unit vectors (rows). */
function machineAxes(setup: Pick<SetupDTO, 'direction' | 'rotation'>, stock: StockSize): Mat {
  const f = setupFrame(setupDirection(setup), setupRotation(setup), stock)
  return [f.u, f.v, f.n]
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const round = (x: number) => Math.round(x) || 0

/** `a · bᵀ` of two rotation matrices given as rows. */
const mulT = (a: Mat, b: Mat): Mat =>
  a.map((r) => b.map((c) => round(dot(r, c))) as unknown as Vec3) as unknown as Mat

/**
 * The part corner at a setup's work zero, named by the part faces that meet there besides the up
 * face: "front left" for an unrotated top setup, "back left" for the bottom. On the machine it is
 * always the front-left corner of the up face.
 */
export function setupCorner(
  setup: Pick<SetupDTO, 'direction' | 'rotation'>,
  stock: StockSize,
): string {
  return setupZeroCorner(setupDirection(setup), setupRotation(setup), stock)
}

/** Tips that bring a setup-1 machine side up (old machine direction → T, a rotation). */
const TIPS: readonly { readonly from: Vec3; readonly t: Mat; readonly text: string }[] = [
  {
    from: [0, 0, 1],
    t: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    text: '',
  },
  {
    from: [0, 0, -1],
    t: [
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
    ],
    text: 'flip about X',
  },
  {
    from: [0, -1, 0],
    t: [
      [1, 0, 0],
      [0, 0, 1],
      [0, -1, 0],
    ],
    text: 'tip its front side up',
  },
  {
    from: [0, 1, 0],
    t: [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    text: 'tip its back side up',
  },
  {
    from: [1, 0, 0],
    t: [
      [0, 0, -1],
      [0, 1, 0],
      [1, 0, 0],
    ],
    text: 'tip its right side up',
  },
  {
    from: [-1, 0, 0],
    t: [
      [0, 0, 1],
      [0, 1, 0],
      [-1, 0, 0],
    ],
    text: 'tip its left side up',
  },
]

const TURN: Readonly<Record<number, string>> = {
  90: 'turn 90 deg CCW',
  180: 'turn 180 deg',
  270: 'turn 90 deg CW',
}

/**
 * How to move the stock from `first`'s orientation on the machine to `setup`'s: a flip or tip
 * (sides as they sat in `first`: front = towards the operator), then a turn about the spindle
 * axis (CCW seen from above). "same orientation" when nothing changes.
 */
export function setupMotion(
  first: Pick<SetupDTO, 'direction' | 'rotation'>,
  setup: Pick<SetupDTO, 'direction' | 'rotation'>,
  stock: StockSize,
): string {
  // R maps a part direction's machine coordinates in `first` to those in `setup`
  const r = mulT(machineAxes(setup, stock), machineAxes(first, stock))
  // the `first` machine direction that is up now: Rᵀ·ez
  const up: Vec3 = [r[2][0], r[2][1], r[2][2]]
  const tip = TIPS.find((t) => t.from.every((c, i) => c === up[i]))!
  // the remaining turn about Z: R·Tᵀ
  const z = mulT(r, tip.t)
  const deg = ((Math.round((Math.atan2(z[1][0], z[0][0]) * 180) / Math.PI) % 360) + 360) % 360
  if (tip.text === 'flip about X' && deg === 180) return 'flip about Y'
  const turn = TURN[deg]
  if (tip.text === '') return turn ?? 'same orientation'
  return turn === undefined ? tip.text : `${tip.text}, then ${turn}`
}

/**
 * The header's setup instructions for `setups[index]` (machining order): its number, the part
 * faces up, in front and on the right, the move from setup 1, the work-zero corner and the stock;
 * with `overreach` the tool's reach past the stock (DF59).
 */
export function setupHeader(
  setups: readonly Pick<SetupDTO, 'direction' | 'rotation'>[],
  index: number,
  stock: StockSize,
  overreach?: Overreach,
): SetupHeader {
  const setup = setups[index]!
  const o = setupOrientation(setupDirection(setup), setupRotation(setup), stock)
  return {
    number: index + 1,
    count: setups.length,
    up: DIRECTION_LABEL[o.up],
    front: DIRECTION_LABEL[o.front],
    right: DIRECTION_LABEL[o.right],
    ...(index === 0 ? {} : { fromFirst: setupMotion(setups[0]!, setup, stock) }),
    corner: setupCorner(setup, stock),
    stock: o.size,
    ...(overreach === undefined ? {} : { overreach }),
  }
}
