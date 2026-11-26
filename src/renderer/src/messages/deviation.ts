// User-facing strings of the deviation panel (v0.4-llm-first U4): the simulated cut of a plan
// against the part's reference, in the Plan inspector. Terms from docs/glossary.md (over-cut,
// under-cut, edge band).
// Doc: docs/conventions/ui.md#deviation-panel, docs/modes/deviation.md#implementation-u4,
// docs/conventions/ui.md#internationalization

export type DeviationCause = 'toolRadius' | 'workholding' | 'holeMouth' | 'drillPoint' | 'tab'
export type DeviationSign = 'overcut' | 'undercut'

export const deviationMessages = {
  title: 'Compare with reference',
  info: "Simulates the cut of every toolpath in machining order and measures it against the reference model, column by column from each setup's up face.",
  noReference: 'Import a reference model in Design to compare the programs with it.',
  reference: 'Reference',
  threshold: 'Threshold',
  compare: 'Compare',
  compareAgain: 'Compare again',
  cancel: 'Cancel',
  hint: 'Toolpaths are generated where missing. Takes a few seconds.',
  comparing: 'Comparing with the reference…',
  progress: 'Comparing',
  failed: 'The plan could not be compared.',
  outdated: 'The plan changed since this comparison. Compare again to update it.',
  within: (threshold: string) => `The programs make the reference within ${threshold}.`,
  /** "3 regions over 0.1 mm · 1 without a known cause" (design review R5). */
  summary: (n: number, threshold: string, unexplained: number) =>
    `${n === 1 ? '1 region' : `${n} regions`} over ${threshold}${unexplained > 0 ? ` · ${unexplained} without a known cause` : ''}`,
  /** The closed accordion after the regions (design review R7) and its summary. */
  statistics: 'Statistics',
  statisticsSummary: (max: string, p95: string) => `max ${max} · 95 % ${p95}`,
  stat: {
    mean: 'Mean',
    p95: '95 %',
    p99: '99 %',
    max: 'Max',
    overcutMax: 'Worst over-cut',
    undercutMax: 'Worst under-cut',
    areaOver: 'Area over threshold',
    edgeBand: 'Edge band (not compared)',
  },
  /** One line per face with several faces: "Top: 99 % 0.005 mm · max 0.42 mm". */
  face: (face: string, p99: string, max: string) => `${face}: 99 % ${p99} · max ${max}`,
  regions: 'Regions',
  sign: { overcut: 'Over-cut', undercut: 'Under-cut' } as Record<DeviationSign, string>,
  /** A region row: "Over-cut 0.5 mm · Facing 1". */
  region: (sign: DeviationSign, dev: string, op: string | undefined) =>
    `${sign === 'overcut' ? 'Over-cut' : 'Under-cut'} ${dev}${op === undefined ? '' : ` · ${op}`}`,
  cause: {
    toolRadius: 'tool radius',
    workholding: 'workholding',
    holeMouth: 'hole mouth',
    drillPoint: 'drill point',
    tab: 'tab',
  } as Record<DeviationCause, string>,
  // "No known cause": none of the known causes applies; the operation name before it is who cut
  // the region, not its cause (design review R5).
  noCause: 'no known cause',
  /** A region over 0.5 mm without a cause (the result's `unexplained`). */
  unexplained: 'check: no known cause',
  /** The row's accessible name: "Over-cut 0.5 mm · Facing 1, top, 120 mm², no known cause". */
  regionName: (row: string, face: string, area: string, cause: string) =>
    `${row}, ${face}, ${area}, ${cause}`,
  more: (n: number) => `${n} more regions not shown.`,
  /** The Plan viewport's summary while a region is marked (U4 follow-up): "Marked: Over-cut 0.5 mm, top." */
  marked: (row: string, face: string) => `Marked: ${row}, ${face}.`,
} as const
