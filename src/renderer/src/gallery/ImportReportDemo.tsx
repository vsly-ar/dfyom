// Gallery specimen of the SVG import dialog (task U1): the options step and a report, inline. The
// app runs it through `useSvgImport` (ShapeList.tsx) from its "Import SVG…" entries (DF49).
// Doc: docs/conventions/ui.md#import-report
import type { Element } from '../../../core/geometry/2d/model'
import type { SvgImportReport } from '../../../core/import/svg'
import { ImportReportDialog, type ImportPreview } from '../modes/design/ImportReportDialog'
import { PortalContainer } from '../ui'
import { useState, type ReactNode } from 'react'
import styles from './Gallery.module.css'

const noop = () => undefined

const REPORT: SvgImportReport = {
  size: { width: 120, height: 80 },
  bounds: { min: [0, 0], max: [120, 80] },
  unit: 'mm',
  unitAssumed: false,
  imported: { path: 3, circle: 2, rect: 1 },
  skipped: { text: 2, image: 1 },
  beziersFitted: 14,
  ellipticalArcsFitted: 2,
  maxDeviation: 0.008,
  cornersAtCusps: 6,
  microCornersMerged: 1,
  tinySegmentsMerged: 0,
  loopsRepaired: 1,
  loopsDropped: 0,
  gapsClosed: 0,
  loops: 5,
  openPaths: 0,
  lines: 22,
  arcs: 41,
  warnings: [
    {
      rule: 'svg.skipped',
      message: 'Text is not imported; convert it to paths first.',
      element: 'text (line 12)',
    },
  ],
}

const line = (a: [number, number], b: [number, number]): Element => ({ kind: 'line', a, b })
const circle = (c: [number, number], r: number): Element => ({
  kind: 'arc',
  a: [c[0] + r, c[1]],
  b: [c[0] + r, c[1]],
  centre: c,
  ccw: false,
})

const PREVIEW: ImportPreview = {
  bounds: REPORT.bounds,
  loops: [
    {
      closed: true,
      elements: [
        line([0, 0], [120, 0]),
        line([120, 0], [120, 50]),
        { kind: 'arc', a: [120, 50], b: [90, 80], centre: [90, 50], ccw: true },
        line([90, 80], [0, 80]),
        line([0, 80], [0, 0]),
      ],
    },
    { closed: true, elements: [circle([30, 40], 12)] },
    { closed: true, elements: [circle([80, 30], 8)] },
  ],
}

function Stage({ children }: { children: ReactNode }): React.JSX.Element {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  return (
    <div ref={setEl} className={styles['stage']} data-tall>
      <PortalContainer container={el}>{el ? children : null}</PortalContainer>
    </div>
  )
}

export function ImportReportDemo(): React.JSX.Element {
  return (
    <div className={styles['line']}>
      <Stage>
        <ImportReportDialog
          open
          modal={false}
          onOpenChange={noop}
          step={{ kind: 'options' }}
          units="mm"
        />
      </Stage>
      <Stage>
        <ImportReportDialog
          open
          modal={false}
          onOpenChange={noop}
          step={{
            kind: 'report',
            report: REPORT,
            shapes: ['Bracket', 'Hole 1', 'Hole 2'],
            preview: PREVIEW,
          }}
          units="mm"
        />
      </Stage>
    </div>
  )
}
