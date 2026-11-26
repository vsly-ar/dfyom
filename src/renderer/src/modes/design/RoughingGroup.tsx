// Roughing passes in the Design inspectors (hardening DF122, slice R2): the "Roughing" accordion
// of the Pocket and Pattern inspectors (right after the tool; closed while off with the summary
// "Off", open while on with "Ø 8 mm · walls auto · floor 0"): the Roughing switch, then the
// roughing pocket's own tool field (Auto / lock, the fit list, `dfm.roughingNoGain` under it),
// Leave on walls ("Auto · 0.5 mm": the finishing allowance) and Leave on floor. Every edit is one
// update of the owner (`roughing: true | false | { wall, floor }`, one undo step). And the roughing
// pocket's short inspector: breadcrumb, "Edited through Pocket 1", its name, its tool, the
// margins read-only with "Edit in Pocket 1".
// Doc: docs/modes/roughing.md#ui, docs/modes/roughing.md#implementation-r2,
// docs/conventions/inspector-layout.md#per-inspector-target-layout
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import type { OperationDTO } from '../../../../core/design/part.dto'
import type { DfmWarning } from '../../../../core/geometry/model'
import { designMessages } from '../../messages/design'
import { useCancelGesture } from '../../shell/hooks'
import {
  Field,
  FieldIcon,
  Icon,
  InspectorGroup,
  PanelHeader,
  QuantityInput,
  Switch,
  WarningList,
  type FieldMessage,
  type GroupSeverity,
} from '../../ui'
import { warningLabels, warningView } from './DesignInspector'
import styles from './Design.module.css'
import { countsAsWarning, roleLabel } from './feature-view'
import { NameField } from './NameField'
import { warningPath } from './OperationFields'
import { ToolField } from './ToolField'
import { defaultUnit, quantityOf, type DesignPart } from './model'
import {
  floorPlaceholder,
  marginArg,
  roughingSummary,
  wallPlaceholder,
  type RoughingMarginsView,
} from './roughing-view'
import { useCommand, useDesignSelection, type DesignWarnings } from './useDesign'

const r = designMessages.roughing
const f = designMessages.features

/** The `roughing` arg of `design.pocket.update` / `design.pattern.update`. */
export type RoughingArgValue = boolean | { wall?: string; floor?: string }

/**
 * The Roughing accordion. `margins` undefined = off. Errors and findings come in by path
 * (`roughing`, `roughing.wall`, `roughing.floor`); the roughing pocket's own findings show at its
 * tool field.
 */
export function RoughingGroup({
  part,
  margins,
  roughingOp,
  warnings,
  messagesAt,
  send,
  rememberKey,
  info,
  level = 3,
}: {
  part: DesignPart
  margins: RoughingMarginsView | undefined
  /** The owned roughing pocket (absent while off, or until the update lands). */
  roughingOp: OperationDTO | undefined
  /** The part's findings (those of the roughing pocket show at its tool). */
  warnings: readonly DfmWarning[]
  messagesAt: (path: string) => FieldMessage[]
  send: (roughing: RoughingArgValue, path: string, gesture?: string) => void
  /** `pocket` or `pattern`: the open state is remembered apart for on and off (DF110). */
  rememberKey: string
  info: string
  level?: 3 | 4
}): React.JSX.Element {
  const cancelGesture = useCancelGesture()
  const on = margins !== undefined
  const toolWarnings =
    roughingOp === undefined ? [] : warnings.filter((w) => w.operation === roughingOp.id)
  const own = ['roughing', 'roughing.wall', 'roughing.floor'].flatMap(messagesAt)
  const problem: GroupSeverity | undefined = own.some((m) => m.severity === 'error')
    ? 'error'
    : own.some((m) => m.severity !== 'note') || toolWarnings.some(countsAsWarning)
      ? 'warning'
      : undefined
  const margin = (which: 'wall' | 'floor') => {
    const path = `roughing.${which}`
    const dto = margins?.[which]
    return (
      <div key={path} data-feature-field={path}>
        <QuantityInput
          label={which === 'wall' ? r.wall : r.floor}
          kind="length"
          defaultUnit={defaultUnit('length', part.units)}
          value={dto === undefined ? undefined : quantityOf(dto)}
          placeholder={which === 'wall' ? wallPlaceholder(part) : floorPlaceholder()}
          optional
          stepKind="small"
          stepKey={`${rememberKey}.${path}`}
          info={which === 'wall' ? r.wallInfo : r.floorInfo}
          illustration={<FieldIcon name={which === 'wall' ? 'allowance' : 'thickness'} />}
          onCommit={(q, gesture) => send(marginArg(margins, which, q?.source), path, gesture)}
          onCancelGesture={cancelGesture}
          messages={messagesAt(path)}
        />
      </div>
    )
  }
  return (
    <InspectorGroup
      title={r.group}
      level={level}
      collapsible
      rememberKey={`${rememberKey}.roughing.${on ? 'on' : 'off'}`}
      defaultOpen={on}
      summary={roughingSummary(part, margins, roughingOp)}
      severity={problem}
      forceOpen={problem !== undefined}
      info={info}
    >
      <div data-feature-field="roughing">
        <Field label={r.switch} kind="toggle" messages={messagesAt('roughing')}>
          <Switch
            label={r.switch}
            hideLabel
            checked={on}
            onCheckedChange={(next) => send(next, 'roughing')}
          />
        </Field>
      </div>
      {on && roughingOp !== undefined ? (
        <div data-feature-field="roughing.tool">
          <ToolField part={part} op={roughingOp} warnings={toolWarnings} label={r.toolLabel} />
        </div>
      ) : null}
      {on ? [margin('wall'), margin('floor')] : null}
    </InspectorGroup>
  )
}

/**
 * The roughing pocket's short inspector (roughing.md § UI): breadcrumb "Pocket 1 › roughing",
 * "Edited through Pocket 1", its name, its tool (A4: its own auto choice and lock), the stock to
 * leave read-only with "Edit in Pocket 1"; its findings at the tool or listed. `owner` is the
 * plain pocket, or the pattern feature whose pocket it roughs.
 */
export function RoughingInspector({
  part,
  op,
  owner,
  margins,
  warnings,
}: {
  part: DesignPart
  op: OperationDTO
  owner: { readonly id: string; readonly name: string }
  margins: RoughingMarginsView
  warnings: DesignWarnings
}): React.JSX.Element {
  const call = useCommand()
  const [, select] = useDesignSelection()
  const opWarnings = warnings.warnings.filter((w) => w.operation === op.id)
  const unplaced = opWarnings.filter((w) => warningPath(w, op) !== 'tool')
  const role = roleLabel(owner.name, op.name)
  const shown = (which: 'wall' | 'floor') => {
    const dto = margins[which]
    return (
      <QuantityInput
        key={which}
        label={which === 'wall' ? r.wall : r.floor}
        kind="length"
        defaultUnit={defaultUnit('length', part.units)}
        value={dto === undefined ? undefined : quantityOf(dto)}
        placeholder={which === 'wall' ? wallPlaceholder(part) : floorPlaceholder()}
        stepKind="small"
        illustration={<FieldIcon name={which === 'wall' ? 'allowance' : 'thickness'} />}
        readOnly
        onCommit={() => {}}
      />
    )
  }
  return (
    <div className={styles['inspector']}>
      <PanelHeader title={op.name} itemId={op.id} />
      <div className={styles['fields']}>
        <nav aria-label={f.breadcrumb}>
          <ol className={styles['breadcrumb']}>
            <li>
              <button type="button" className={styles['crumb']} onClick={() => select(owner.id)}>
                {owner.name}
              </button>
            </li>
            <li aria-hidden="true" className={styles['crumbSep']}>
              ›
            </li>
            <li>
              <button
                type="button"
                className={styles['crumb']}
                aria-current="page"
                onClick={() => select(op.id)}
              >
                {role}
              </button>
            </li>
          </ol>
        </nav>
        <div className={styles['ownedNote']}>
          <Icon name="lock" size="sm" />
          <p className={styles['ownedNoteText']}>
            {f.editedThrough}{' '}
            <button type="button" className={styles['inlineLink']} onClick={() => select(owner.id)}>
              {owner.name}
            </button>
          </p>
        </div>
        <NameField
          label={designMessages.inspector.name}
          name={op.name}
          onCommit={(name) =>
            void call(`design.${op.kind}.update`, {
              partId: part.dto.id,
              operationId: op.id,
              name,
            })
          }
        />
        <InspectorGroup title={designMessages.inspector.groups.tool}>
          <ToolField part={part} op={op} warnings={opWarnings} label={r.toolLabel} />
        </InspectorGroup>
        <InspectorGroup title={r.stockToLeave}>
          {shown('wall')}
          {shown('floor')}
          <p className={styles['muted']}>
            <button type="button" className={styles['inlineLink']} onClick={() => select(owner.id)}>
              {r.editIn(owner.name)}
            </button>
          </p>
        </InspectorGroup>
        {unplaced.length > 0 ? (
          <WarningList
            labels={warningLabels}
            items={unplaced.map((w) => warningView(w, part, undefined))}
          />
        ) : null}
      </div>
    </div>
  )
}

/** The owner a roughing pocket's inspector links to, and the margins it shows. */
export function roughingOwnerOf(
  part: DesignPart,
  op: OperationDTO,
): { owner: { id: string; name: string }; margins: RoughingMarginsView } | undefined {
  if (op.kind !== 'pocket' || op.roughing !== true) return undefined
  const margins: RoughingMarginsView = op.leave ?? {}
  if (op.roughingOf !== undefined) {
    const owner = part.dto.operations.find((o) => o.id === op.roughingOf)
    return owner === undefined ? undefined : { owner, margins }
  }
  const feature: FeatureDTO | undefined = part.dto.features?.find((x) => x.id === op.featureId)
  return feature === undefined ? undefined : { owner: feature, margins }
}
