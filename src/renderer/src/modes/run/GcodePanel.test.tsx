// The gCode panel (DF84): rows and section headers, the executing line, the marks, Follow and its
// end on the user's scroll, collapse, resize; the row arithmetic of a 100k-line program.
// Doc: docs/modes/run.md#gcode-panel-df84, docs/conventions/ui.md#run-mode-safety-ui
import { fireEvent, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import type { RunProgram } from '../../../../core/run/service'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import type { Interruption } from '../../../../core/run/interruption'
import { closedStatus } from '../../../../core/run/service'
import { GcodePanelView, GCODE_ROW_PX, interruptedRange } from './GcodePanel'
import {
  lineState,
  MAX_SCROLL_PX,
  ProgramRows,
  scrollGeometry,
  scrollTopFor,
  visibleRows,
  type RunIndices,
} from './gcode-rows'
import type { GcodePanelState } from './run-store'

function program(lines: number): RunProgram {
  return {
    jobId: 'run-1',
    lines: Array.from({ length: lines }, (_, i) => `G1 X${i} Y0 F600`),
    sections: [
      { fromLine: 1, label: 'Start' },
      { fromLine: 4, label: 'facing1 · tool 1: Flat 6' },
      { fromLine: 40, label: 'pocket1 · tool 1: Flat 6' },
    ],
    operations: [],
  }
}

function Panel({
  initial,
  run,
  lines = 200,
}: {
  initial: Partial<GcodePanelState>
  run: RunIndices | undefined
  lines?: number
}): React.JSX.Element {
  const [state, setState] = useState<GcodePanelState>({
    open: true,
    height: 12,
    follow: true,
    ...initial,
  })
  return (
    <GcodePanelView
      program={{ state: 'ready', value: program(lines) }}
      run={run}
      state={state}
      onChange={(p) => setState((s) => ({ ...s, ...p }))}
    />
  )
}

describe('gCode rows', () => {
  it('puts a header row before each section start', () => {
    const rows = new ProgramRows(50, program(50).sections)
    expect(rows.count).toBe(53)
    expect(rows.row(0)).toEqual({ kind: 'section', section: 0, label: 'Start' })
    expect(rows.row(1)).toEqual({ kind: 'line', line: 1 })
    expect(rows.row(4)).toMatchObject({ kind: 'section', section: 1 })
    expect(rows.row(5)).toEqual({ kind: 'line', line: 4 })
    expect(rows.row(52)).toEqual({ kind: 'line', line: 50 })
    for (const line of [1, 3, 4, 39, 40, 50])
      expect(rows.row(rows.rowOfLine(line))).toEqual({ kind: 'line', line })
    expect(rows.sectionOf(39)).toBe('facing1 · tool 1: Flat 6')
  })

  it('gives each line its state from the indices', () => {
    const run = { executing: 5, acknowledged: 8, sent: 10 }
    expect([4, 5, 6, 8, 9, 10, 11].map((l) => lineState(l, run))).toEqual([
      'done',
      'executing',
      'planned',
      'planned',
      'sent',
      'sent',
      'pending',
    ])
    expect(lineState(3, { acknowledged: 3, sent: 4 })).toBe('done')
    expect(lineState(9, { ...run, finished: true })).toBe('done')
  })

  it('scales the scroll past the element height limit and renders only the visible rows', () => {
    const rows = 1_000_000
    const { spacer, scale } = scrollGeometry(rows, GCODE_ROW_PX, 300)
    expect(spacer).toBe(MAX_SCROLL_PX)
    expect(scale).toBeGreaterThan(1)
    const end = visibleRows(rows, GCODE_ROW_PX, 300, MAX_SCROLL_PX - 300, 20)
    expect(end.last).toBe(rows - 1)
    expect(end.last - end.first).toBeLessThan(60)
    const top = scrollTopFor(600_000, rows, GCODE_ROW_PX, 300)
    const at = visibleRows(rows, GCODE_ROW_PX, 300, top, 0)
    expect(at.first).toBeLessThanOrEqual(600_000)
    expect(at.last).toBeGreaterThanOrEqual(600_000)
  })
})

describe('GcodePanelView', () => {
  it('shows the program with the executing line, the marks and headers, and is accessible', async () => {
    renderUi(<Panel initial={{}} run={{ executing: 42, acknowledged: 50, sent: 53 }} />)
    const region = screen.getByRole('region', { name: 'gCode' })
    expect(within(region).getByRole('button', { name: 'gCode' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(within(region).getByText('Line 42 / 200')).toBeInTheDocument()
    expect(
      within(region).getByText('pocket1 · tool 1: Flat 6', { selector: 'span' }),
    ).toBeInTheDocument()
    const list = within(region).getByRole('list', { name: 'Program lines' })
    expect(list).toHaveAccessibleDescription(/highlighted line is the one the machine executes/)
    const current = within(list)
      .getAllByRole('listitem')
      .find((e) => e.getAttribute('aria-current') === 'step')!
    expect(current).toHaveTextContent('G1 X41 Y0 F600')
    expect(current).toHaveAttribute('data-state', 'executing')
    const state = (line: number) =>
      within(list)
        .getByText(`G1 X${line - 1} Y0 F600`)
        .closest('[data-state]')!
        .getAttribute('data-state')
    expect([state(41), state(50), state(52), state(60)]).toEqual([
      'done',
      'planned',
      'sent',
      'pending',
    ])
    // virtualized: far fewer rows than lines
    expect(within(list).getAllByRole('listitem').length).toBeLessThan(80)
    expect(screen.getByRole('button', { name: 'Follow' })).toHaveAttribute('aria-pressed', 'true')
    await expectNoAxeViolations()
  })

  it('follows the executing line until the user scrolls; Follow jumps back', async () => {
    // the run advances on each "Next status" click, as main's status pushes would
    const runs: RunIndices[] = [
      { executing: 2, acknowledged: 4, sent: 5 },
      { executing: 1500, acknowledged: 1510, sent: 1512 },
      { executing: 1600, acknowledged: 1610, sent: 1612 },
    ]
    function Harness(): React.JSX.Element {
      const [i, setI] = useState(0)
      return (
        <>
          <button type="button" onClick={() => setI((n) => n + 1)}>
            Next status
          </button>
          <Panel initial={{}} run={runs[i]} lines={2000} />
        </>
      )
    }
    const { user } = renderUi(<Harness />)
    const setRun = () => fireEvent.click(screen.getByRole('button', { name: 'Next status' }))
    const list = screen.getByRole('list', { name: 'Program lines' })
    const at = (line: number) =>
      within(list)
        .queryByText(`G1 X${line - 1} Y0 F600`)
        ?.closest('[role="listitem"]') ?? null
    setRun()
    expect(at(1500)).toHaveAttribute('aria-current', 'step')
    expect(at(2)).toBeNull()
    // the user's wheel turns Follow off: the list stays where it is
    fireEvent.wheel(list, { deltaY: -100 })
    const follow = screen.getByRole('button', { name: 'Follow' })
    expect(follow).toHaveAttribute('aria-pressed', 'false')
    // the user scrolls back to the top
    list.scrollTop = 0
    fireEvent.scroll(list)
    setRun()
    expect(at(1)).toBeInTheDocument()
    expect(at(1600)).toBeNull()
    await user.click(follow)
    expect(follow).toHaveAttribute('aria-pressed', 'true')
    expect(at(1600)).toHaveAttribute('aria-current', 'step')
    // a scroll key in the list ends it too
    fireEvent.keyDown(list, { key: 'PageUp' })
    expect(follow).toHaveAttribute('aria-pressed', 'false')
  })

  it('collapses to its header and resizes from its top edge', async () => {
    const { user } = renderUi(<Panel initial={{}} run={undefined} />)
    const region = screen.getByRole('region', { name: 'gCode' })
    expect(within(region).getByText('200 lines')).toBeInTheDocument()
    const handle = screen.getByRole('separator', { name: 'Resize the gCode panel' })
    expect(handle).toHaveAttribute('aria-valuenow', '12')
    handle.focus()
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(handle).toHaveAttribute('aria-valuenow', '14')
    await user.keyboard('{Home}')
    expect(handle).toHaveAttribute('aria-valuenow', '6')
    expect(region.style.height).toBe('6rem')
    await user.click(within(region).getByRole('button', { name: 'gCode' }))
    expect(within(region).getByRole('button', { name: 'gCode' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(within(region).queryByRole('list')).toBeNull()
    expect(within(region).queryByRole('button', { name: 'Follow' })).toBeNull()
    expect(region.style.height).toBe('2rem')
    await expectNoAxeViolations()
  })

  it('says where the program will show before a run', async () => {
    renderUi(
      <GcodePanelView
        program={{ state: 'none' }}
        run={undefined}
        state={{ open: true, height: 12, follow: true }}
        onChange={() => {}}
      />,
    )
    expect(screen.getByText('The program shows here once a run starts.')).toBeInTheDocument()
    await expectNoAxeViolations()
  })

  it('before a start at a line: earlier lines skipped, the start line marked; "Start from here…" (DF129 RC3)', async () => {
    const asked: number[] = []
    const { user } = renderUi(
      <GcodePanelView
        program={{ state: 'ready', value: program(60) }}
        run={undefined}
        start={45}
        state={{ open: true, height: 12, follow: true }}
        onChange={() => {}}
        onStartFromHere={(line) => asked.push(line)}
      />,
    )
    const region = screen.getByRole('region', { name: 'gCode' })
    expect(within(region).getByText('Starts at line 45')).toBeInTheDocument()
    const list = within(region).getByRole('list', { name: 'Program lines' })
    expect(list).toHaveAccessibleDescription(/Muted lines are skipped/)
    const start = list.querySelector('[aria-current="location"]')!
    expect(start.getAttribute('data-line')).toBe('45')
    expect(list.querySelector('[data-line="44"]')).toHaveAttribute('data-state', 'skipped')
    expect(list.querySelector('[data-line="46"]')).toHaveAttribute('data-state', 'pending')
    await expectNoAxeViolations()
    // the row's context menu
    fireEvent.contextMenu(list.querySelector('[data-line="50"]')!)
    await user.click(await screen.findByRole('menuitem', { name: 'Start from here…' }))
    expect(asked).toEqual([50])
  })

  it("mutes a resumed run's lead-in until it runs (DF129 RC3)", () => {
    const p = program(30)
    renderUi(
      <GcodePanelView
        program={{
          state: 'ready',
          value: {
            ...p,
            sections: [
              { fromLine: 1, label: 'Lead-in' },
              { fromLine: 12, label: 'pocket1 · tool 1: Flat 6' },
            ],
          },
        }}
        run={{ acknowledged: 0, sent: 0 }}
        state={{ open: true, height: 12, follow: true }}
        onChange={() => {}}
      />,
    )
    const list = screen.getByRole('list', { name: 'Program lines' })
    expect(list.querySelector('[data-line="11"]')).toHaveAttribute('data-lead-in', '')
    expect(list.querySelector('[data-line="12"]')).not.toHaveAttribute('data-lead-in')
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it("marks an interrupted run's lines and starts there (DF129 RC6)", async () => {
    renderUi(
      <GcodePanelView
        program={{ state: 'ready', value: program(60) }}
        run={undefined}
        interrupted={{ from: 45, to: 47, sent: 50 }}
        state={{ open: true, height: 12, follow: true }}
        onChange={() => {}}
      />,
    )
    const region = screen.getByRole('region', { name: 'gCode' })
    expect(within(region).getByText('Interrupted at lines 45–47')).toBeInTheDocument()
    const list = within(region).getByRole('list', { name: 'Program lines' })
    expect(list).toHaveAccessibleDescription(/where the run was interrupted/)
    expect(list.querySelector('[aria-current="location"]')?.getAttribute('data-line')).toBe('45')
    expect(list.querySelector('[data-line="44"]')).toHaveAttribute('data-state', 'done')
    expect(list.querySelector('[data-line="47"]')).toHaveAttribute('data-state', 'interrupted')
    expect(list.querySelector('[data-line="50"]')).toHaveAttribute('data-state', 'sent')
    expect(list.querySelector('[data-line="51"]')).toHaveAttribute('data-state', 'pending')
    await expectNoAxeViolations()
  })

  it("the range in the original program or past a resumed run's lead-in (DF129 RC6)", () => {
    const i = {
      reason: 'appCrashed',
      at: '2026-11-27T10:05:00.000Z',
      startedAt: '2026-11-27T10:00:00.000Z',
      lines: 60,
      sent: 50,
      acknowledged: 47,
      executing: 45,
      executingFrom: 'estimate',
      workZero: { start: [0, 0, 0], last: [0, 0, 0] },
      spindle: { dir: 'off', rpm: 0 },
      resumedRun: { fromLine: 40, leadIn: 5 },
    } satisfies Interruption
    const status = {
      ...closedStatus(),
      lastRun: { jobId: 'run-1', outcome: 'failed' as const, interruption: i },
    }
    // the original program (restored at launch): the lines as they are
    expect(interruptedRange(status, program(60))).toEqual({ from: 45, to: 47, sent: 50 })
    // the streamed program behind a lead-in: original 45 is streamed 45 − 40 + 1 + 5 = 11
    const streamed = { ...program(30), sections: [{ fromLine: 1, label: 'Lead-in' }] }
    expect(interruptedRange(status, streamed)).toEqual({ from: 11, to: 13, sent: 16 })
    // nothing while a run streams, nor without a record
    expect(interruptedRange({ ...closedStatus() }, program(60))).toBeUndefined()
  })
})
