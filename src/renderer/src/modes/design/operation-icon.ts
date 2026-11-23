// Row icons of operations and features, shared by the design navigator and the plan list (one
// icon per meaning, DF44): an operation's kind icon, except a hole's owned operations, which take
// the hole type icon of their role (drill: simple hole, counterbore, countersink), and a Clones
// instance, which takes its source operation's icon.
// Doc: docs/conventions/ui.md#icons-v04, #feature-rows-and-add
import { stepOf } from '../../../../core/design/feature'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import type { OperationDTO, PartDTO } from '../../../../core/design/part.dto'
import type { IconName } from '../../ui'

const ICON: Record<OperationDTO['kind'], IconName> = {
  facing: 'facing',
  pocket: 'pocket',
  drilling: 'drilling',
  profile: 'profile',
  chamfer: 'chamfer',
}

/** A profile cut on its line is a groove (B22-5: the bent slot). */
export function operationIcon(op: Pick<OperationDTO, 'kind'> & { side?: unknown }): IconName {
  return op.kind === 'profile' && op.side === 'on' ? 'groove' : ICON[op.kind]
}

/** A feature's icon (L1, ui.md § Icons (v0.4)): the hole type, or Clones. */
export function featureIcon(feature: Pick<FeatureDTO, 'kind'> & Record<string, unknown>): IconName {
  if (feature.kind === 'clones') return 'clones'
  if (feature.kind !== 'hole') return 'design'
  return feature['type'] === 'counterbore'
    ? 'hole-counterbore'
    : feature['type'] === 'countersink'
      ? 'hole-countersink'
      : 'hole-simple'
}

const HOLE_ROLE_ICON: Record<string, IconName> = {
  drill: 'hole-simple',
  counterbore: 'hole-counterbore',
  countersink: 'hole-countersink',
}

/**
 * The icon of a part's operation in a list (DF44): a hole's owned operation shows the hole type
 * of its role, so a countersink never reads as a facing or a counterbore as a pocket; a Clones
 * instance shows its source operation's; any other operation its kind's.
 */
export function partOperationIcon(
  part: Pick<PartDTO, 'operations' | 'features'>,
  op: OperationDTO,
): IconName {
  let source = op
  const owner = part.features?.find((f) => f.id === op.featureId)
  if (owner?.kind === 'clones' && op.featureRole !== undefined) {
    const step = stepOf(op.featureRole)
    source = part.operations.find((o) => o.id === step) ?? op
  }
  const hole = part.features?.find((f) => f.id === source.featureId)
  if (hole?.kind === 'hole' && source.featureRole !== undefined) {
    const icon = HOLE_ROLE_ICON[source.featureRole]
    if (icon !== undefined) return icon
  }
  return operationIcon(source)
}
