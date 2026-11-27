// The rest region of an operation cut after its roughing (hardening DF122, R3's viewport item),
// drawn by the run layer in the setup's WCS while the owner or its roughing is selected: what the
// roughing left for the owner's tool (uncleared corners, the wall margin band) as a faint
// `--vp-selected` fill at the roughing's lowest level with a hairline outline, never picked, no
// depth write. Props only.
// Doc: docs/modes/roughing.md#plan-viewport-rest-shading, docs/conventions/ui.md#plan-mode-task-37
import { Line } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import { Color, DoubleSide, ShapeGeometry, SRGBColorSpace } from 'three'
import type { Palette } from './colours'
import { patchShapes, type ZRefPolygon } from './ZRefLayer'

/** What the run layer shades for an operation after its roughing (`RunScene.rest`). */
export interface RestOverlay {
  /** The rest region (WCS, mm). */
  readonly patch: readonly ZRefPolygon[]
  /** Z of the roughing's lowest level in the WCS (mm). */
  readonly level: number
}

/** Fill opacity: a quiet area tint (ui.md: surface tints have no contrast target). */
export const REST_FILL = 0.22
/** Outline opacity: the margin band is a few tenths of a mm wide, the outline shows it. */
export const REST_LINE = 0.6
/** Lift over the floor (mm), so the outline does not fight the part's face. */
const LIFT = 0.02

const noRaycast = (): void => {}

/** The patch's rings closed, at `z` (for the outline). Pure. */
export function restOutlines(
  patch: readonly ZRefPolygon[],
  z: number,
): [number, number, number][][] {
  return patch.flatMap((p) =>
    [p.outer, ...p.holes]
      .filter((r) => r.length >= 2)
      .map((r) => [...r, r[0]!].map((q): [number, number, number] => [q[0], q[1], z])),
  )
}

export function RestLayer({
  rest,
  palette,
}: {
  rest: RestOverlay
  palette: Palette
}): React.JSX.Element {
  const fill = useMemo(() => {
    const shapes = patchShapes(rest.patch)
    return shapes.length === 0 ? null : new ShapeGeometry(shapes)
  }, [rest.patch])
  useEffect(() => () => fill?.dispose(), [fill])
  const outlines = useMemo(() => restOutlines(rest.patch, rest.level + LIFT), [rest])
  const accent = useMemo(() => {
    const c = palette.selected
    return new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)
  }, [palette])
  return (
    <group raycast={noRaycast}>
      {fill ? (
        <mesh geometry={fill} position={[0, 0, rest.level]} raycast={noRaycast} renderOrder={3}>
          <meshBasicMaterial
            color={accent}
            transparent
            opacity={REST_FILL}
            depthWrite={false}
            side={DoubleSide}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-4}
          />
        </mesh>
      ) : null}
      {outlines.map((pts, i) => (
        <Line
          key={i}
          points={pts}
          color={accent}
          lineWidth={1}
          transparent
          opacity={REST_LINE}
          raycast={noRaycast}
          renderOrder={3}
        />
      ))}
    </group>
  )
}
