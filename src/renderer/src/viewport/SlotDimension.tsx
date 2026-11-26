// A selected slotted Bolt hole's centre line and travel dimension (DF119 H3 follow-up), in the
// measure tool's dimension style: neutral `--vp-edge` lines over everything (the centre line
// dashed), extension lines across the dimension line, the distance chip at its middle. Never
// pickable. Positions come from `slot-dimension.ts` (part frame).
// Doc: docs/conventions/ui.md#section-illustration,
// docs/modes/hole-slots-and-round-corners.md#viewport-slot-dimension
import { Html, Line } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { Color, SRGBColorSpace } from 'three'
import type { Palette } from './colours'
import type { Vec3 } from './mesh'
import chip from './SnapGlyph.module.css'
import styles from './Viewport.module.css'

/** What the viewport draws of a slotted hole (part frame, mm): `slot-dimension.ts`. */
export interface SlotDimensionView {
  readonly centreLine: readonly [Vec3, Vec3]
  readonly dimension: readonly [Vec3, Vec3]
  readonly extensions: readonly (readonly [Vec3, Vec3])[]
  readonly travel: number
  /** The chip's text: the travel as the inspector shows it ("19.5 mm"). */
  readonly label: string
}

const noRaycast = (): void => {}
const pts = (l: readonly [Vec3, Vec3]): [number, number, number][] => [
  [l[0][0], l[0][1], l[0][2]],
  [l[1][0], l[1][1], l[1][2]],
]

export function SlotDimension({
  slot,
  palette,
}: {
  slot: SlotDimensionView
  palette: Palette
}): React.JSX.Element {
  const edge = useMemo(() => new Color().setRGB(...palette.edge, SRGBColorSpace), [palette.edge])
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => invalidate(), [slot, invalidate])
  const [a, b] = slot.dimension
  const mid: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
  const span = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  return (
    <group userData={{ slotDimension: true }}>
      <Line
        points={pts(slot.centreLine)}
        color={edge}
        lineWidth={1}
        dashed
        dashSize={Math.max(0.5, span / 8)}
        gapSize={Math.max(0.25, span / 24)}
        depthTest={false}
        renderOrder={7}
        raycast={noRaycast}
      />
      {[slot.dimension, ...slot.extensions].map((l, i) => (
        <Line
          key={i}
          points={pts(l)}
          color={edge}
          lineWidth={i === 0 ? 1.5 : 1}
          depthTest={false}
          renderOrder={8}
          raycast={noRaycast}
        />
      ))}
      <Html position={mid} zIndexRange={[30, 20]}>
        <div className={styles['snapAnchor']}>
          <span
            className={chip['dimensionChip']}
            style={{ transform: 'translate(-50%, -50%)' }}
            data-testid="slot-dimension-chip"
            aria-hidden="true"
          >
            {slot.label}
          </span>
        </div>
      </Html>
    </group>
  )
}
