// Setup inspector (v0.2 task F6): a setup selected in the setup panel – its name, the face up to
// the spindle (direction icon and word), the work zero G54 (its corner, offset or point), how far the tool
// reaches past the stock (DF59), the rotation about the spindle axis (0/90/180/270°), the safe
// heights (clearance with the clamp note, or the item it follows since workholding.md; retract;
// moved here from the navigator), the links between operations and, without workholding items,
// the clamp height (DF64), the Z headroom estimate (DF68), the tool changes (DF66, `ToolChanges`:
// the tool runs, reorderable), the workholding (`Workholding`, workholding.md) and the machine
// checks of this setup. Each change is one `plan.setup.update`. DF78: the work zero and the
// alignment points (`AlignmentFields`).
// Read-only (with the plan's reason in the navigator) outside draft and settled design.
// Doc: docs/conventions/ui.md#design-and-plan-controls-v02, docs/modes/plan-v0.2.md#setups-from-face-directions,
// docs/modes/safe-links.md#agent-api-and-settings, docs/modes/alignment.md#plan-ui
import { useState } from 'react'
import { fieldContext } from '../../../../core/design/operation'
import { DIRECTION_LABEL } from '../../../../core/geometry/face'
import type { PlanWarning } from '../../../../core/plan/checks'
import {
  SETUP_ROTATIONS,
  type PlanDTO,
  type SetupDTO,
  type SetupRotation,
} from '../../../../core/plan/plan.dto'
import { setupWorkholding } from '../../../../core/plan/workholding/setup'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import { RETRACTIONS, type Retraction } from '../../../../core/toolpath/links'
import { Quantity } from '../../../../core/quantity/quantity'
import type { Overreach } from '../../../../core/toolpath/overreach'
import type { AppErrorData, Issue } from '../../../../shared/errors/app-error'
import {
  formatDuration,
  formatHeight,
  formatReach,
  planMessages,
  sentence,
  zHeadroomNote,
} from '../../messages/plan'
import { useCancelGesture } from '../../shell/hooks'
import {
  Button,
  ErrorMessage,
  Field,
  FieldIcon,
  PanelHeader,
  QuantityInput,
  SegmentedControl,
  WarningList,
  type FieldMessage,
} from '../../ui'
import { defaultUnit, quantityOf } from '../design/model'
import { DirectionIcon } from './DirectionIcon'
import {
  allows,
  directionOfSetup,
  planPart,
  planStockSize,
  setupOverreach,
  setupZeroWords,
  type ToolpathEntry,
} from './model'
import { AlignmentFields } from './AlignmentFields'
import { usePlanCommand, usePlanState } from './plan-store'
import styles from './Plan.module.css'
import { NameField, planWarningLabels, planWarningView } from './PlanInspector'
import { ToolChanges } from './ToolChanges'
import { usePlanSelection } from './usePlan'
import { Workholding } from './Workholding'

const m = planMessages.setup
const NO_SOURCES: readonly never[] = []
const wm = planMessages.workholding

/** A length in mm as a quantity in the document's units ("14 mm", "0.551 in"). */
function lengthQuantity(mm: number, units: UnitSystem): Quantity | undefined {
  const q = Quantity.parse(formatHeight(mm, units), fieldContext('length', units))
  return q.isOk() ? q.unwrap() : undefined
}

export function SetupInspector({
  doc,
  plan,
  setup,
  warnings,
  toolpaths = {},
}: {
  doc: ProjectDoc
  plan: PlanDTO
  setup: SetupDTO
  warnings: readonly PlanWarning[]
  toolpaths?: Readonly<Record<string, ToolpathEntry>>
}): React.JSX.Element {
  const call = usePlanCommand()
  const [, select] = usePlanSelection()
  const cancelGesture = useCancelGesture()
  const [errors, setErrors] = useState<readonly Issue[]>([])
  const [failed, setFailed] = useState<AppErrorData | undefined>(undefined)
  const units = doc.unitSystem
  const readOnly = !allows(plan, 'plan.setup.update')
  const index = plan.setups.findIndex((s) => s.id === setup.id)
  const direction = directionOfSetup(setup)
  const face = DIRECTION_LABEL[direction]
  const stock = planStockSize(doc, plan)
  // per-setup machine checks carry the setup (plan-v0.2.md#implementation-task-e1)
  const mine = warnings.filter((w) => w.params['setupId'] === setup.id)
  const headroom = zHeadroomText(plan, mine, warnings)
  const reach = reachText(setupOverreach(setup, toolpaths), units)
  const info = usePlanState((s) => s.data?.alignment.find((a) => a.setupId === setup.id))
  const sources = usePlanState(
    (s) => s.data?.alignmentSources.find((a) => a.setupId === setup.id)?.sources,
  )
  // workholding.md#links-and-safe-heights: the clearance follows the items unless the user set it
  const planStock = planPart(doc, plan).loaded?.stock
  const holding = planStock === undefined ? undefined : setupWorkholding(setup, planStock)
  const from = holding?.items.find((i) => i.id === holding.clearanceFrom)
  const clearance =
    holding !== undefined && from !== undefined
      ? lengthQuantity(holding.clearance, units)
      : quantityOf(setup.clearanceHeight)
  const clampNote: FieldMessage[] =
    clearance === undefined
      ? []
      : from !== undefined
        ? [
            {
              id: 'clampNote',
              severity: 'note',
              text: wm.clearanceFrom(from.name, formatHeight(holding!.margin, units)),
            },
          ]
        : (holding?.items.length ?? 0) > 0
          ? []
          : [
              {
                id: 'clampNote',
                severity: 'note',
                text: m.clampNote(formatHeight(clearance.canonical, units)),
              },
            ]
  // a clearance the user set while items exist can go back to following them
  const canFollow =
    !readOnly && holding !== undefined && holding.clearanceSet && holding.items.length > 0
  const clampHeight = setup.clampHeight === undefined ? undefined : quantityOf(setup.clampHeight)
  const retraction: Retraction = setup.retraction ?? 'minimum'
  const clampHeightNote: FieldMessage[] = [
    {
      id: 'clampHeightNote',
      severity: 'note',
      // DF90: items supersede the clamp height (workholding.md#links-and-safe-heights)
      text:
        (holding?.items.length ?? 0) > 0
          ? m.clampHeightNoteItems
          : clampHeight === undefined
            ? m.clampHeightNoteUnknown
            : m.clampHeightNote,
    },
  ]
  const links = usePlanState((s) => s.data?.links.find((l) => l.setupId === setup.id)?.links)
  const linksText =
    links === undefined || links === null
      ? m.linksUnknown
      : retraction === 'full'
        ? m.linksFull
        : m.linksValue(
            links.low,
            links.count,
            links.savedSeconds === null || links.savedSeconds <= 0
              ? undefined
              : formatDuration(links.savedSeconds),
          )

  const update = async (args: object, gesture?: string) => {
    const r = await call(
      'plan.setup.update',
      { planId: plan.id, setupId: setup.id, ...args },
      gesture === undefined ? undefined : { gesture },
    )
    setErrors(r.ok ? [] : r.error.issues)
    setFailed(r.ok || r.error.issues.length > 0 ? undefined : r.error)
  }
  const messages = (key: string): FieldMessage[] =>
    errors
      .filter((i) => i.path[0] === key)
      .map((i, n) => ({ id: `${key}-${n}`, severity: 'error', text: sentence(i.message) }))

  return (
    <div className={styles['inspector']}>
      <PanelHeader title={m.inspector} meta={m.position(index + 1, plan.setups.length)} />
      <div className={styles['fields']}>
        <NameField
          label={m.name}
          name={setup.name}
          readOnly={readOnly}
          onCommit={(name) => void update({ name })}
        />
        {failed ? (
          <ErrorMessage error={failed} message={planMessages.inspector.commandFailed} />
        ) : null}
        <div className={styles['setupFacts']}>
          <DirectionIcon direction={direction} className={styles['dirIconLg']} />
          <dl className={styles['facts']}>
            <dt>{m.direction}</dt>
            <dd>{m.directionValue(face)}</dd>
            {stock !== undefined ? (
              <>
                <dt>{m.workOffset}</dt>
                <dd>
                  {m.workOffsetValue(
                    setupZeroWords(setup, stock, info, (mm) => formatHeight(mm, units)),
                    face,
                  )}
                </dd>
              </>
            ) : null}
            <dt>{m.reach}</dt>
            <dd>{reach}</dd>
            <dt>{m.links}</dt>
            <dd>{linksText}</dd>
            {headroom !== undefined ? (
              <>
                <dt>{m.zHeadroom}</dt>
                <dd>{headroom}</dd>
              </>
            ) : null}
          </dl>
        </div>
        <Field
          label={m.rotation}
          kind="toggle"
          illustration={<FieldIcon name="rotation" />}
          readOnly={readOnly}
          messages={[{ id: 'rotationHint', severity: 'note', text: m.rotationHint }]}
        >
          <SegmentedControl<string>
            label={m.rotation}
            options={SETUP_ROTATIONS.map((r) => ({ value: String(r), label: `${r}°` }))}
            value={String(setup.rotation ?? 0)}
            disabled={readOnly}
            onValueChange={(v) => {
              const rotation = Number(v) as SetupRotation
              if (rotation !== (setup.rotation ?? 0)) void update({ rotation })
            }}
          />
        </Field>
        <QuantityInput
          label={m.clearanceHeight}
          kind="length"
          defaultUnit={defaultUnit('length', units)}
          value={clearance}
          illustration={<FieldIcon name="clearance" />}
          readOnly={readOnly}
          messages={[...messages('clearanceHeight'), ...clampNote]}
          onCommit={(q, gesture) => void update({ clearanceHeight: q.source }, gesture)}
          onCancelGesture={cancelGesture}
        />
        {canFollow ? (
          <Button
            size="sm"
            variant="ghost"
            className={styles['followButton']}
            title={wm.clearanceAutoHint}
            onClick={() => void update({ clearanceHeight: 'auto' })}
          >
            {wm.clearanceAuto}
          </Button>
        ) : null}
        <QuantityInput
          label={m.retractHeight}
          kind="length"
          defaultUnit={defaultUnit('length', units)}
          value={quantityOf(setup.retractHeight)}
          illustration={<FieldIcon name="retract" />}
          readOnly={readOnly}
          messages={messages('retractHeight')}
          onCommit={(q, gesture) => void update({ retractHeight: q.source }, gesture)}
          onCancelGesture={cancelGesture}
        />
        <Field
          label={m.retraction}
          kind="toggle"
          illustration={<FieldIcon name="retract" />}
          readOnly={readOnly}
          messages={[
            { id: 'retractionHint', severity: 'note', text: m.retractionHint[retraction] },
          ]}
        >
          <SegmentedControl<Retraction>
            label={m.retraction}
            options={RETRACTIONS.map((r) => ({
              value: r,
              label: r === 'minimum' ? m.retractionMinimum : m.retractionFull,
            }))}
            value={retraction}
            disabled={readOnly}
            onValueChange={(v) => {
              if (v !== retraction) void update({ retraction: v })
            }}
          />
        </Field>
        {/* workholding.md#links-and-safe-heights: items supersede the clamp height */}
        {(holding?.items.length ?? 0) > 0 ? null : (
          <QuantityInput
            label={m.clampHeight}
            kind="length"
            optional
            placeholder={m.clampHeightPlaceholder}
            defaultUnit={defaultUnit('length', units)}
            value={clampHeight}
            illustration={<FieldIcon name="clearance" />}
            readOnly={readOnly}
            messages={[...messages('clampHeight'), ...clampHeightNote]}
            onCommit={(q, gesture) => void update({ clampHeight: q?.source ?? null }, gesture)}
            onCancelGesture={cancelGesture}
          />
        )}
        <AlignmentFields
          plan={plan}
          setup={setup}
          units={units}
          readOnly={readOnly}
          info={info}
          sources={sources ?? NO_SOURCES}
          warnings={mine}
        />
        <ToolChanges plan={plan} setup={setup} units={units} toolpaths={toolpaths} />
        <Workholding doc={doc} plan={plan} setup={setup} />
        {mine.length > 0 ? (
          <section aria-label={m.findings} className={styles['warnings']}>
            <h3 className={styles['groupTitle']}>{m.findings}</h3>
            <WarningList
              labels={planWarningLabels}
              items={mine.map((w, i) => {
                const item = planWarningView(w, plan, select, i, units)
                // DF78 markLast: "Move to end" moves the setup's last witness mark to the end
                const mark = w.params['planOperationId']
                return w.rule === 'markLast' && typeof mark === 'string' && !readOnly
                  ? {
                      ...item,
                      fix: {
                        label: m.markLastFix,
                        onApply: () =>
                          void call('plan.operation.move', {
                            planId: plan.id,
                            planOperationId: mark,
                            toIndex: setup.operations.length - 1,
                          }),
                      },
                    }
                  : item
              })}
              empty=""
            />
          </section>
        ) : null}
      </div>
    </div>
  )
}

/**
 * DF68: the setup's Z headroom as a sentence from its findings and the plan's `zHeadroomUnknown`
 * note; undefined without a machine copy (nothing is estimated).
 */
function zHeadroomText(
  plan: PlanDTO,
  mine: readonly PlanWarning[],
  all: readonly PlanWarning[],
): string | undefined {
  if (plan.machine === undefined) return undefined
  const short = mine.some((w) => w.rule === 'zHeadroom')
  const note = zHeadroomNote(all)
  if (note === undefined) return short ? m.zHeadroomShort : m.zHeadroomOk
  return note.partly ? m.zHeadroomPartly(note.missing, short) : m.zHeadroomUnknown(note.missing)
}

/** The setup's reach past the stock as a sentence (DF59), or why it is not known yet. */
function reachText(reach: Overreach | undefined, units: UnitSystem): string {
  if (reach === undefined) return m.reachUnknown
  const sides = (
    [
      ['left', reach.xMin],
      ['right', reach.xMax],
      ['front', reach.yMin],
      ['back', reach.yMax],
    ] as const
  )
    .filter(([, v]) => v > 0)
    .map(([side, v]) => m.reachSide(side, formatReach(v, units)))
  return sides.length === 0 ? m.reachNone : m.reachValue(sides)
}
