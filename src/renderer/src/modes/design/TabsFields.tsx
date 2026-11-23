// The Tabs group of a profile (task U2): count, width and thickness as before; with entered
// positions (`tabs.positions`, design-v0.3.md#tabs-on-shapes) one field per tab ("Tab 2" at its
// distance from the start point) with a remove action, "Add tab" (the middle of the largest gap)
// and the note "Positions entered by you." with "Space evenly", which clears them. The keyboard
// path of the viewport's tab markers. Every commit is one profile update; an arrow-key run of a
// marker still being applied ends first and the edit builds on the positions it left
// (`tab-key-run.ts`, X2 finding).
// Doc: docs/conventions/ui.md#tab-markers
import type { OperationDTO } from '../../../../core/design/part.dto'
import { designMessages } from '../../messages/design'
import { dfmMessages, lengthSource } from '../../messages/dfm'
import { useRegion2d } from '../../shell/ShellContext'
import { Icon, Button, FieldIcon, IconButton, QuantityInput, type FieldMessage } from '../../ui'
import styles from './Design.module.css'
import { defaultUnit, dfmNames, quantityOf } from './model'
import type { OperationFieldsContext } from './OperationFields'
import { settleTabKeyRun } from './tab-key-run'
import { newTabPosition, profileTabs } from './tabs-model'

const t = designMessages.inspector
const tt = t.tabs

type ProfileDTO = Extract<OperationDTO, { kind: 'profile' }>

/** The stored positions as sources, in stored order. */
export const positionSources = (op: ProfileDTO): string[] =>
  (op.tabs.positions ?? []).map((q) => q.source)

/** Count-spaced centres as entered positions (project units). */
export const centresAsSources = (
  centres: readonly number[],
  ctx: OperationFieldsContext,
): string[] => centres.map((c) => lengthSource(c, ctx.units))

export function TabPositions({ ctx }: { ctx: OperationFieldsContext }): React.JSX.Element | null {
  const port = useRegion2d()
  const op = ctx.op
  if (op.kind !== 'profile') return null
  const tabs = profileTabs(ctx.part, op.id, port)
  const positions = op.tabs.positions
  const errorsAt = (path: string): FieldMessage[] =>
    ctx.errors
      .filter((e) => e.path === path)
      .map((e, i) => ({ id: `error-${i}`, severity: 'error' as const, text: e.text }))
  const warnings: FieldMessage[] = ctx.warnings
    .filter((w) => w.parameter === 'tabs' && positions !== undefined)
    .map((w) => ({
      id: w.code,
      severity: dfmMessages.tier(w),
      text: dfmMessages.text(w, ctx.units, dfmNames(ctx.part.dto)),
    }))
  const send = (
    next: readonly string[] | null,
    path: string,
    extra: Record<string, unknown> = {},
  ) => ctx.send({ tabs: { positions: next, ...extra } }, path)

  /** The stored positions after any open key run of the markers has ended. */
  const settled = async (): Promise<string[]> => {
    const run = await settleTabKeyRun(op.id)
    return run !== undefined ? [...run] : positionSources(op)
  }

  const add = () => {
    if (tabs === undefined) return
    const base = positions === undefined ? centresAsSources(tabs.centres, ctx) : positionSources(op)
    const at = newTabPosition(tabs.centres, tabs.length)
    send([...base, lengthSource(at, ctx.units)], 'tabs.positions')
  }
  const canAdd = !ctx.readOnly && tabs !== undefined && tabs.allowed

  if (positions === undefined)
    return canAdd ? (
      <div className={styles['pickerActions']}>
        <Button size="sm" icon={<Icon name="add" />} onClick={add}>
          {tt.add}
        </Button>
      </div>
    ) : null

  return (
    <div className={styles['tabList']} role="group" aria-label={t.groups.tabs}>
      <p className={styles['tabNote']}>
        <span>{tt.entered}</span>
        {!ctx.readOnly ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              ctx.send({ tabs: { positions: null, count: String(positions.length) } }, 'tabs.count')
            }
          >
            {tt.spaceEvenly}
          </Button>
        ) : null}
      </p>
      {[...errorsAt('tabs.positions'), ...warnings].map((m) => (
        <p key={m.id} className={styles['tabIssue']} data-severity={m.severity}>
          {m.text}
        </p>
      ))}
      {positions.map((q, i) => {
        const path = `tabs.positions.${i}`
        return (
          <div key={i} className={styles['tabRow']}>
            <QuantityInput
              label={tt.position(i + 1)}
              kind="length"
              defaultUnit={defaultUnit('length', ctx.units)}
              value={quantityOf(q)}
              illustration={<FieldIcon name="tabs" />}
              messages={errorsAt(path)}
              readOnly={ctx.readOnly}
              onCommit={(next) =>
                void settled().then((all) => {
                  all[i] = next.source
                  send(all, path)
                })
              }
              onCancelGesture={ctx.cancelGesture}
            />
            {!ctx.readOnly ? (
              <IconButton
                label={tt.remove(i + 1)}
                icon={<Icon name="delete" />}
                className={styles['tabRemove']}
                onClick={() => {
                  const all = positionSources(op).filter((_, k) => k !== i)
                  // the last one removed: back to the count rule with no tabs
                  if (all.length === 0)
                    ctx.send({ tabs: { positions: null, count: '0' } }, 'tabs.count')
                  else send(all, 'tabs.positions')
                }}
              />
            ) : null}
          </div>
        )
      })}
      {canAdd ? (
        <div className={styles['pickerActions']}>
          <Button size="sm" icon={<Icon name="add" />} onClick={add}>
            {tt.add}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
