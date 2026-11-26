// Icons of the shape item kinds (task U1), at the icon size of the rows they sit in.
// Doc: docs/conventions/ui.md#icons, #shape-editor
import type { ShapeItemKind } from '../../../../core/design/shape.dto'
import { Icon, type IconName } from '../../ui'

const ICONS = {
  rectangle: 'kind-rectangle',
  circle: 'kind-circle',
  obround: 'kind-obround',
  polygon: 'kind-polygon',
  path: 'kind-path',
  // its own icon is L1 (plans/v0.4-llm-first.md)
  offset: 'kind-path',
} as const satisfies Record<ShapeItemKind, IconName>

export function ShapeKindIcon({ kind }: { kind: ShapeItemKind }): React.JSX.Element {
  return <Icon name={ICONS[kind]} />
}
