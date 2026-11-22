// Icons of the shape item kinds (task U1): lucide glyphs at the icon size of the rows they sit in.
// Doc: docs/conventions/ui.md#icons, #shape-editor
import { Circle, Hexagon, Pill, RectangleHorizontal, Spline } from 'lucide-react'
import type { ShapeItemKind } from '../../../../core/design/shape.dto'

const ICONS = {
  rectangle: RectangleHorizontal,
  circle: Circle,
  obround: Pill,
  polygon: Hexagon,
  path: Spline,
} as const

export function ShapeKindIcon({ kind }: { kind: ShapeItemKind }): React.JSX.Element {
  const Icon = ICONS[kind]
  return <Icon aria-hidden="true" />
}
