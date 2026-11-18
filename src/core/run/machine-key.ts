/**
 * Identity of a plan's machine copy, which the virtual machine emulates (decision 6 of
 * docs/modes/run-v0.1.md): the hash of the copy's values.
 */
import type { AppResult } from '../../shared/result'
import { findPlanDTO, snapshotById } from '../plan/plan'
import { hashJson } from '../plan/snapshot'
import type { ProjectDoc } from '../project/document'

/** `undefined` when the plan has no machine copy; `input.malformed` for an unknown plan. */
export function machineKeyOf(
  doc: ProjectDoc,
  planId: string,
  where: string,
): AppResult<string | undefined> {
  return findPlanDTO(doc, planId, where).map((plan) => {
    const id = plan.machine
    const snap = id === undefined ? undefined : snapshotById(plan, id)
    return snap === undefined ? undefined : hashJson(snap.values)
  })
}
