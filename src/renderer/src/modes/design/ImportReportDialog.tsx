// The SVG import dialog (task U1): the options step (unit for a unitless file, how the drawing
// splits into shapes), then the report of `design.shape.import` – title, summary line, the facts
// as a two-column list (what changed the drawing as soft notes with the "i" icon), a mini flat
// outline, and "Edit shape" / "Close"; an import from an operation's shape picker says above the
// facts which operation now uses the shape (DF49). Presentational: the caller runs the import
// (`useSvgImport` in ShapeList.tsx, task U2; its entries since DF49 in ui.md#import-svg-where-it-is-looked-for-df49).
// Doc: docs/conventions/ui.md#import-report, docs/modes/design-v0.3.md#svg-import
import { useState } from 'react'
import type { Bounds2, Element } from '../../../../core/geometry/2d/model'
import type { SvgImportReport, SvgSplit, SvgUnit } from '../../../../core/import/svg'
import type { UnitSystem } from '../../../../core/project/document'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { shapeMessages } from '../../messages/shape'
import { Icon, Button, Dialog, ErrorMessage, Field, Select } from '../../ui'
import { chainPath, fitView } from '../../viewport/flat-view'
import styles from './ImportReportDialog.module.css'

const t = shapeMessages.importReport

/** The outline of the imported shapes for the preview (shape frame, mm). */
export interface ImportPreview {
  readonly loops: readonly { readonly elements: readonly Element[]; readonly closed: boolean }[]
  readonly bounds: Bounds2 | undefined
}

export type ImportReportStep =
  | {
      readonly kind: 'options'
      /** The chosen file's path: the dialog names it (DF48). */
      readonly path?: string
    }
  | { readonly kind: 'refused'; readonly error: AppErrorData }
  | {
      readonly kind: 'report'
      readonly report: SvgImportReport
      /** The created shapes' names, in order (the first is the one "Edit shape" selects). */
      readonly shapes: readonly string[]
      readonly preview?: ImportPreview
      /** DF49: what the import did beyond the shapes ("Profile 1 now cuts outline."). */
      readonly note?: string
    }

export interface ImportReportDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly step: ImportReportStep
  readonly units: UnitSystem
  /** Options step: run the import with these options. */
  readonly onImport?: (options: { unit: SvgUnit; split: SvgSplit }) => void
  /** Report step: select the first created shape. */
  readonly onEdit?: () => void
  /** The gallery shows the dialog inline. */
  readonly modal?: boolean
}

export function ImportReportDialog(props: ImportReportDialogProps): React.JSX.Element {
  const { step } = props
  const close = () => props.onOpenChange(false)
  if (step.kind === 'options') return <OptionsStep {...props} />
  if (step.kind === 'refused')
    return (
      <Dialog
        open={props.open}
        onOpenChange={props.onOpenChange}
        modal={props.modal ?? true}
        title={t.optionsTitle}
        footer={<Button onClick={close}>{t.close}</Button>}
      >
        <ErrorMessage error={step.error} message={t.refused} />
      </Dialog>
    )
  const r = step.report
  const sizeLine = r.size
    ? `${t.size(r.size.width, r.size.height, props.units)}, ${t.fromFile}`
    : r.bounds
      ? `${t.size(r.bounds.max[0] - r.bounds.min[0], r.bounds.max[1] - r.bounds.min[1], props.units)}`
      : ''
  const summary = [
    sizeLine,
    r.unitAssumed ? t.assumed(r.unit) : '',
    t.created(step.shapes.length, r.loops, r.openPaths),
  ]
    .filter((s) => s.length > 0)
    .join(' · ')
  const fitted = r.beziersFitted + r.ellipticalArcsFitted
  const skipped = t.total(r.skipped)
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      modal={props.modal ?? true}
      title={t.title(step.shapes)}
      description={summary}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{t.close}</Button>
          <Button
            variant="primary"
            icon={<Icon name="edit" />}
            onClick={() => {
              props.onEdit?.()
              close()
            }}
          >
            {t.edit(step.shapes)}
          </Button>
        </>
      }
    >
      {step.note !== undefined ? <p className={styles['note']}>{step.note}</p> : null}
      <div className={styles['body']}>
        <section aria-label={t.facts}>
          <h3 className={styles['heading']}>{t.facts}</h3>
          <dl className={styles['facts']}>
            <Fact label={t.imported} value={t.byKind(r.imported)} />
            <Fact label={t.skipped} value={t.byKind(r.skipped)} note={skipped > 0} />
            <Fact label={t.fitted} value={t.fittedValue(fitted, r.maxDeviation)} />
            <Fact label={t.cusps} value={String(r.cornersAtCusps)} />
            <Fact label={t.micro} value={String(r.microCornersMerged)} />
            <Fact label={t.repaired} value={String(r.loopsRepaired)} note={r.loopsRepaired > 0} />
            {r.loopsDropped > 0 ? (
              <Fact label={t.dropped} value={String(r.loopsDropped)} note />
            ) : null}
            {r.gapsClosed > 0 ? <Fact label={t.gaps} value={String(r.gapsClosed)} /> : null}
            <Fact label={t.elements} value={t.elementsValue(r.lines, r.arcs)} />
          </dl>
          {r.warnings.length > 0 ? (
            <ul className={styles['warnings']}>
              {r.warnings.map((w, i) => (
                <li key={i}>
                  <Icon name="info" />
                  <span>
                    {w.message}
                    {w.element ? <span className={styles['source']}> · {w.element}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        {step.preview ? <Preview preview={step.preview} /> : null}
      </div>
    </Dialog>
  )
}

/** One fact; `note`: it changed the drawing (soft note, "i" icon, described as such). */
function Fact({
  label,
  value,
  note = false,
}: {
  label: string
  value: string
  note?: boolean
}): React.JSX.Element {
  return (
    <div className={styles['fact']} data-note={note ? '' : undefined}>
      <dt>
        {note ? <Icon name="info" label={t.changed} /> : null}
        {label}
      </dt>
      <dd>{value}</dd>
    </div>
  )
}

/** The file name of a path (either separator). */
const baseName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path

const PREVIEW_W = 220
const PREVIEW_H = 140

function Preview({ preview }: { preview: ImportPreview }): React.JSX.Element {
  const v = fitView(preview.bounds, PREVIEW_W, PREVIEW_H, 0.08)
  const fill = preview.loops
    .filter((l) => l.closed)
    .map((l) => chainPath(v, l.elements, true))
    .join(' ')
  return (
    <figure className={styles['preview']}>
      <svg
        viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}
        width={PREVIEW_W}
        height={PREVIEW_H}
        role="img"
        aria-label={t.preview}
      >
        {fill.length > 0 ? <path className={styles['fill']} d={fill} fillRule="evenodd" /> : null}
        {preview.loops.map((l, i) => (
          <path key={i} className={styles['edge']} d={chainPath(v, l.elements, l.closed)} />
        ))}
      </svg>
    </figure>
  )
}

function OptionsStep(props: ImportReportDialogProps): React.JSX.Element {
  const [unit, setUnit] = useState<SvgUnit>('px96')
  const [split, setSplit] = useState<SvgSplit>('element')
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      modal={props.modal ?? true}
      title={t.optionsTitle}
      description={t.optionsDescription}
      footer={
        <>
          <Button onClick={() => props.onOpenChange(false)}>{t.cancel}</Button>
          <Button
            variant="primary"
            icon={<Icon name="shape-import" />}
            onClick={() => props.onImport?.({ unit, split })}
          >
            {t.import}
          </Button>
        </>
      }
    >
      <div className={styles['options']}>
        {props.step.kind === 'options' && props.step.path !== undefined ? (
          <p className={styles['file']} title={props.step.path}>
            <span className={styles['fileLabel']}>{t.file}</span>
            <span className={styles['fileName']}>{baseName(props.step.path)}</span>
          </p>
        ) : null}
        <Field label={t.unit}>
          <Select
            id="svg-import-unit"
            options={(['px96', 'px72', 'mm', 'in'] as const).map((u) => ({
              value: u,
              label: t.units[u],
            }))}
            value={unit}
            onValueChange={setUnit}
          />
        </Field>
        <Field label={t.split}>
          <Select
            id="svg-import-split"
            options={(['element', 'file', 'loop'] as const).map((s) => ({
              value: s,
              label: t.splits[s],
            }))}
            value={split}
            onValueChange={setSplit}
          />
        </Field>
      </div>
    </Dialog>
  )
}
