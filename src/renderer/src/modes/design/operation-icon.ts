// Row icons of operations and features, shared by the design navigator and the plan list (one
// icon per meaning, DF44): an operation's kind icon, except a hole's owned operations, which take
// the hole type icon of their role (drill: simple hole, counterbore, countersink), and a Clones
// instance, which takes its source operation's icon. A facing's icon turns to the stock face it
// cuts (DF99): bottom upside down, the right and left sides a quarter turn; top, front and back
// as drawn.
// Doc: docs/conventions/ui.md#icons-v04, #feature-rows-and-add
import { stepOf } from '../../../../core/design/feature'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import type { OperationDTO, PartDTO } from '../../../../core/design/part.dto'
import type { IconName, IconRotation } from '../../ui'

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

/**
 * DF99: how far a facing's icon turns (clockwise) to show the face it cuts. The icon is a front
 * view with the passes on top, so the bottom turns it over and the right (`stock.side[1]`, +X) and
 * left (`stock.side[3]`, −X) sides a quarter turn; the front and back, seen face-on in a front
 * view, keep it as drawn, like the top.
 */
export function facingIconRotation(on: string | undefined): IconRotation {
  return on === 'stock.bottom'
    ? 180
    : on === 'stock.side[1]'
      ? 90
      : on === 'stock.side[3]'
        ? 270
        : 0
}

/** A feature's icon (L1, ui.md § Icons (v0.4)): the hole type, Clones or a pattern. */
export function featureIcon(feature: Pick<FeatureDTO, 'kind'> & Record<string, unknown>): IconName {
  if (feature.kind === 'clones') return 'clones'
  if (feature.kind === 'pattern') return 'pattern'
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
  return partOperationIconProps(part, op).name
}

/** The icon of a part's operation in a list with its turn (`<Icon {...props} />`, DF99). */
export function partOperationIconProps(
  part: Pick<PartDTO, 'operations' | 'features'>,
  op: OperationDTO,
): { name: IconName; rotate: IconRotation } {
  const source = iconSource(part, op)
  const hole = part.features?.find((f) => f.id === source.featureId)
  if (hole?.kind === 'hole' && source.featureRole !== undefined) {
    const icon = HOLE_ROLE_ICON[source.featureRole]
    if (icon !== undefined) return { name: icon, rotate: 0 }
  }
  return {
    name: operationIcon(source),
    rotate: source.kind === 'facing' ? facingIconRotation(source.on) : 0,
  }
}

/** The operation whose icon a row shows: a Clones instance's source step, else the operation. */
function iconSource(
  part: Pick<PartDTO, 'operations' | 'features'>,
  op: OperationDTO,
): OperationDTO {
  let source = op
  const owner = part.features?.find((f) => f.id === op.featureId)
  if (owner?.kind === 'clones' && op.featureRole !== undefined) {
    const step = stepOf(op.featureRole)
    source = part.operations.find((o) => o.id === step) ?? op
  }
  return source
}
