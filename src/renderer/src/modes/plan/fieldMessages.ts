// Plan findings shown at their field (the inspector's tool, feeds and strategy fields): a
// finding's severity maps to the field's support-area tier, its text is the core's message,
// sentence-cased. Doc: docs/conventions/ui.md#plan-mode-task-37 (Checks)
import type { PlanWarning } from '../../../../core/plan/checks'
import { sentence } from '../../messages/plan'
import type { FieldMessage, FieldSeverity } from '../../ui'

const SEVERITY: Record<PlanWarning['severity'], FieldSeverity> = {
  error: 'error',
  warning: 'hard',
  info: 'soft',
}

/** The findings of one field (`field` as the core names it, e.g. `feedRate`, `strategy.cycle`). */
export const fieldMessages = (findings: readonly PlanWarning[], field: string): FieldMessage[] =>
  findings
    .filter((w) => w.field === field)
    .map((w, i) => ({
      id: `${w.code}:${w.rule}:${i}`,
      severity: SEVERITY[w.severity],
      text: sentence(w.message),
    }))
