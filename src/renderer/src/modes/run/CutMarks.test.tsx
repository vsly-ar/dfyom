// Already-cut marks from Run (hardening DF135 C2) in the run section, against the fake bridge with
// a real design dispatcher: a real run to the end marks its operations in the window that started
// it, with Undo; a stopped run offers its finished operations; a virtual run says nothing.
// Doc: docs/modes/cut-state.md#marking, #implementation-c2
import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { runPlanHash } from '../../../../core/run/plan-hash'
import { closedStatus, type LastRun } from '../../../../core/run/service'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { runStoreOf } from './run-store'

async function renderRun() {
  const s = await planSetup()
  const planId = await s.create()
  const bridge = createFakeBridge()
  bridge.bind(s.d)
  const shell = createShell(bridge)
  shell.ui.getState().setMode('run')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  await screen.findByRole('navigation', { name: 'Navigator' })
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const plan = () => s.plan(planId)
  const setup = plan().setups[0]!
  const ops = setup.operations.map((o) => o.id)
  /** main's status after run `jobId` ended so. */
  const ended = (over: Partial<LastRun>, virtual = false) =>
    act(() =>
      bridge.emitRunStatus({
        ...closedStatus(),
        lastRun: {
          ...(virtual ? {} : { real: true as const }),
          jobId: 'job-1',
          planId,
          setupId: setup.id,
          outcome: 'done',
          planHash: runPlanHash(plan(), setup.id),
          operations: ops,
          finished: ops,
          ...over,
        },
      }),
    )
  const part = () => s.d.doc.parts[s.partId]!
  const updates = () => bridge.calls.filter((c) => c.name === 'design.part.update')
  return { ...r, s, plan, bridge, ops, ended, part, updates, planId }
}

describe('Run: already-cut marks (DF135 C2)', () => {
  it('a real run to the end marks its operations in the window that started it, with Undo', async () => {
    const t = await renderRun()
    runStoreOf(t.bridge).setState({ startedHere: 'job-1' })
    t.ended({})
    const notice = await screen.findByRole('status', { name: 'Already cut' })
    expect(notice).toHaveTextContent(/^Marked \d+ operations as already cut in Design\./)
    await waitFor(() => expect(t.part().alreadyCut?.length).toBeGreaterThan(0))
    expect(t.updates()).toHaveLength(1)
    expect(t.updates()[0]!.args).toMatchObject({ cutByRun: t.planId })
    const marked = t.part().alreadyCut!
    for (const id of marked) expect(t.part().alreadyCutMarks?.[id]?.by).toBe('run')
    expect(within(notice).getByText(/Facing 1/)).toBeInTheDocument()
    await expectNoAxeViolations(notice)
    await t.user.click(within(notice).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(t.part().alreadyCut).toBeUndefined())
    expect(notice).toHaveTextContent('The already-cut marks were taken back.')
    // decided once: nothing marked again for the same run
    expect(t.updates()).toHaveLength(2)
  })

  it('C4: a run that cuts a recut unit again marks it anew; Undo keeps that mark', async () => {
    const t = await renderRun()
    runStoreOf(t.bridge).setState({ startedHere: 'job-1' })
    t.ended({})
    await waitFor(() => expect(t.part().alreadyCut).toContain('facing1'))
    const first = t.part().alreadyCutMarks!['facing1']!
    // Facing 1 made deeper in Design: recut, in the program again
    await act(async () => {
      await t.s.run('design.facing.update', {
        partId: t.part().id,
        operationId: 'facing1',
        depth: '1',
      })
      await t.s.run('project.apply', {})
    })
    const facing = t
      .plan()
      .setups[0]!.operations.find((o) => o.designOperationIds.includes('facing1'))!
    runStoreOf(t.bridge).setState({ startedHere: 'job-2' })
    t.ended({ jobId: 'job-2', operations: [facing.id], finished: [facing.id] })
    const notice = await screen.findByRole('status', { name: 'Already cut' })
    await waitFor(() => expect(notice).toHaveTextContent('Marked 1 operation as already cut'))
    await waitFor(() => expect(t.updates()).toHaveLength(2))
    expect(t.updates()[1]!.args).toMatchObject({ recut: ['facing1'], cutByRun: t.planId })
    await waitFor(() => expect(t.part().alreadyCutMarks?.['facing1']).not.toEqual(first))
    expect(t.part().alreadyCutMarks?.['facing1']?.asCut?.[0]).toMatchObject({ id: 'facing1' })
    const listed = t.part().alreadyCut
    await t.user.click(within(notice).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(t.updates()).toHaveLength(3))
    expect(t.part().alreadyCut).toEqual(listed)
  })

  it('a stopped real run offers its finished operations only; Not now closes the offer', async () => {
    const t = await renderRun()
    t.ended({ outcome: 'stopped', planOperationId: t.ops[1]!, finished: [t.ops[0]!] })
    const offer = await screen.findByRole('group', { name: 'Already cut' })
    expect(offer).toHaveTextContent('Mark the finished operation as already cut?')
    expect(
      within(offer)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Facing 1'])
    expect(offer).toHaveTextContent('The one in progress stays not cut')
    await expectNoAxeViolations(offer)
    // nothing marked without the user
    expect(t.updates()).toEqual([])
    await t.user.click(within(offer).getByRole('button', { name: 'Mark as already cut' }))
    await waitFor(() => expect(t.part().alreadyCut).toEqual(['facing1']))
    expect(t.part().alreadyCutMarks?.['facing1']?.by).toBe('run')
    expect(await screen.findByRole('status', { name: 'Already cut' })).toHaveTextContent(
      'Marked 1 operation as already cut in Design.',
    )
  })

  it('Not now closes the offer; a virtual run and an interrupted run say nothing', async () => {
    const t = await renderRun()
    t.ended({ outcome: 'stopped', planOperationId: t.ops[1]!, finished: [t.ops[0]!] })
    const offer = await screen.findByRole('group', { name: 'Already cut' })
    await t.user.click(within(offer).getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('group', { name: 'Already cut' })).toBeNull()
    runStoreOf(t.bridge).setState({ startedHere: 'job-2' })
    t.ended({ jobId: 'job-2' }, true)
    t.ended({ jobId: 'job-3', outcome: 'stopped', finished: [t.ops[0]!], planHash: 'other' })
    expect(await screen.findByRole('status', { name: 'Already cut' })).toHaveTextContent(
      'The plan changed since this program was exported',
    )
    expect(t.updates()).toEqual([])
  })
})
