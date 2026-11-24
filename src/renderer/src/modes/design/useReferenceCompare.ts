// The compare overlay's runner (DF60 P5): while `referenceCompare` is set, runs
// `design.reference.compare` as a job after each finished evaluation (debounced; the running job
// is aborted first), then asks the worker for the per-vertex distances of the mesh shown and the
// missing pieces (`reference.compareView`, window plumbing). A result of an older evaluation is
// dropped; the last good one stays on screen meanwhile. Nothing runs while the overlay is off.
// Doc: docs/modes/reference-tools.md#overlay-ui, docs/conventions/ui.md#reference-tools-df60
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ReferenceDTO } from '../../../../core/design/reference.dto'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import type { PartEvaluationEntry } from '../../state/evaluations'
import { useShell, useUi } from '../../shell/ShellContext'
import { COMPARE_DEBOUNCE_MS, COMPARE_REGIONS, type CompareResult } from './reference-compare-state'

interface JobOutcome {
  readonly state: 'running' | 'paused' | 'finished'
  readonly outcome?:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: AppErrorData }
}

/** What a compare depends on besides the evaluation: the reference's record (placement, asset). */
const referenceKey = (r: ReferenceDTO): string =>
  JSON.stringify([r.asset.sha256, r.scale, r.rotation, r.position, r.sourceUnit])

export function useReferenceCompare(
  partId: string | undefined,
  evaluation: PartEvaluationEntry | undefined,
  references: readonly { readonly ref: ReferenceDTO }[],
): void {
  const { bridge, ui } = useShell()
  const settings = useUi((s) => s.referenceCompare)
  const setResult = useUi((s) => s.setCompareResult)
  const setSettings = useUi((s) => s.setReferenceCompare)
  const ref =
    settings === null ? undefined : references.find((r) => r.ref.id === settings.referenceId)?.ref
  const on = settings !== null && settings.partId === partId && ref !== undefined
  const done = evaluation?.status === 'done' ? evaluation : undefined
  const mesh = done?.mesh ?? null
  const key =
    !on || done?.inputHash === undefined || mesh === null
      ? null
      : `${done.inputHash}|${settings.referenceId}|${settings.threshold}|${referenceKey(ref)}`
  // the reference or the part went away: the overlay turns off
  const gone = settings !== null && (settings.partId !== partId || ref === undefined)
  useEffect(() => {
    if (gone && partId !== undefined) setSettings(null)
  }, [gone, partId, setSettings])

  const job = useRef<string | null>(null)
  // the latest inputs, read when the debounced run starts
  const latest = useRef({ settings, mesh, inputHash: done?.inputHash })
  useLayoutEffect(() => {
    latest.current = { settings, mesh, inputHash: done?.inputHash }
  })

  useEffect(() => {
    if (key === null || settings === null || partId === undefined) return
    let live = true
    const abort = () => {
      const id = job.current
      job.current = null
      if (id !== null) void bridge.call('job.abort', { jobId: id })
    }
    const timer = setTimeout(() => {
      const s = latest.current
      if (s.settings === null || s.mesh === null || s.inputHash === undefined) return
      const positions = s.mesh.positions
      const { referenceId, threshold } = s.settings
      abort()
      setResult({ ...ui.getState().compareResult, busy: true })
      void (async () => {
        const fail = (error: AppErrorData) => {
          if (live) setResult({ busy: false, error })
        }
        const started = await bridge.call('design.reference.compare', {
          partId,
          referenceId,
          source: { kind: 'part' },
          threshold,
          limit: COMPARE_REGIONS,
        })
        if (!live) return
        if (!started.ok) return fail(started.error)
        const { jobId } = started.value as { jobId: string }
        job.current = jobId
        const w = await bridge.call('job.wait', { jobId, timeoutSeconds: 300 })
        if (job.current === jobId) job.current = null
        if (!live) return
        if (!w.ok) return fail(w.error)
        const outcome = (w.value as JobOutcome).outcome
        if (outcome === undefined) return
        if (!outcome.ok) {
          if (outcome.error.code === 'op.aborted') return
          return fail(outcome.error)
        }
        const result = outcome.value as CompareResult
        // an edit landed meanwhile: its own run replaces this one
        if (result.evaluation !== latest.current.inputHash) return
        const view = await bridge.reference.compareView({ referenceId, positions, threshold })
        if (!live) return
        setResult(
          view.ok
            ? {
                busy: false,
                result,
                view: { positions, distances: view.distances, missing: view.missing ?? null },
              }
            : { busy: false, result, error: view.error },
        )
      })()
    }, COMPARE_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
      abort()
    }
    // the key covers what a run depends on (the rest is read from `latest` when it starts)
  }, [key, bridge, ui, setResult])
}
