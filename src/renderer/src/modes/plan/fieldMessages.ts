// Plan findings shown at their field (the inspector's tool, feeds and strategy fields): a
// finding's severity maps to the field's support-area tier, its text is the core's message,
// sentence-cased (the design tool findings of E4 are worded from their params, `findingText`).
// Doc: docs/conventions/ui.md#plan-mode-task-37 (Checks)
import type { PlanWarning } from '../../../../core/plan/checks'
import type { UnitSystem } from '../../../../core/project/document'
import { findingText, type FindingNames } from '../../messages/plan'
import type { FieldMessage, FieldSeverity } from '../../ui'

const SEVERITY: Record<PlanWarning['severity'], FieldSeverity> = {
  error: 'error',
  warning: 'hard',
  info: 'soft',
}

/** The findings of one field (`field` as the core names it, e.g. `feedRate`, `strategy.cycle`). */
export const fieldMessages = (
  findings: readonly PlanWarning[],
  field: string,
  units: UnitSystem = 'mm',
  /** Readable names for the ids in a finding's params (DF43); generic words without them. */
  names?: FindingNames,
): FieldMessage[] =>
  findings
    .filter((w) => w.field === field)
    .map((w, i) => ({
      id: `${w.code}:${w.rule}:${i}`,
      severity: SEVERITY[w.severity],
      text: findingText(w, units, names),
    }))
