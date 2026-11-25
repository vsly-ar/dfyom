// Split parts 4a in the part inspector: "Split part…" (a first level at half height), the split
// editor (lines and levels as fields, the margin; each commit sends the whole split with
// `design.split.set`, one undo step; removing pieces with plans asks first), the preview (pieces
// pulled apart in Top and Front, each with its blank, `--motion-slow`, none under reduced motion)
// and the piece chips; a piece's own inspector ("Piece 3 of 8 of Enclosure · Edit the split") and
// the read-only note for its operations.
// Doc: docs/conventions/ui.md#split-part-split-parts-4a, docs/modes/split-parts.md#ui-summary-design
import { useEffect, useState } from 'react'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { dfmMessages } from '../../messages/dfm'
import { useUi } from '../../shell/ShellContext'
import {
  Button,
  ConfirmDialog,
  ErrorMessage,
  Icon,
  IconButton,
  PanelHeader,
  QuantityInput,
  WarningList,
  type WarningListLabels,
  type WarningView,
} from '../../ui'
import styles from './Design.module.css'
import { NameField } from './NameField'
import { defaultUnit, quantityOf, type DesignPart, dfmNames } from './model'
import {
  blankText,
  cutSource,
  firstSplit,
  nextCut,
  pieceViews,
  piecesOf,
  splitArgs,
  type PieceView,
  type SplitArgs,
} from './split-view'
import { useCommand, useDesignSelection, type DesignWarnings } from './useDesign'

const m = designMessages
const t = m.split

const mmOf = (q: { exact: { num: string; den: string } }): number =>
  Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))

/** `design.split.set` with a confirmation when pieces with plans would go. */
function useSplitSet(part: DesignPart) {
  const call = useCommand()
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const [confirm, setConfirm] = useState<{ split: SplitArgs | null; plans: number } | null>(null)
  const send = async (split: SplitArgs | null, confirmed = false, gesture?: string) => {
    const r = await call(
      'design.split.set',
      { partId: part.dto.id, split, ...(confirmed ? { confirm: true } : {}) },
      gesture === undefined ? undefined : { gesture },
    )
    if (r.ok) return setError(undefined)
    const issue = r.error.issues.find((i) => i.rule === 'pieceHasPlans')
    if (issue !== undefined) {
      const plans = (issue.params?.['plans'] as readonly string[] | undefined)?.length ?? 1
      setError(undefined)
      return setConfirm({ split, plans })
    }
    setError(r.error)
  }
  return { send, error, confirm, setConfirm }
}

/** The split section of a source part's inspector. */
export function SplitSection({ part }: { part: DesignPart }): React.JSX.Element {
  const { send, error, confirm, setConfirm } = useSplitSet(part)
  const split = part.dto.split
  const stock = part.loaded?.stock
  const units = part.units
  const unit = defaultUnit('length', units)
  const confirmDialog = (
    <ConfirmDialog
      open={confirm !== null}
      onOpenChange={(o) => {
        if (!o) setConfirm(null)
      }}
      title={t.confirmTitle}
      description={t.confirmDescription(confirm?.plans ?? 1)}
      confirmLabel={t.confirmAction}
      cancelLabel={m.setup.cancel}
      destructive
      onConfirm={() => void (confirm !== null && send(confirm.split, true))}
    />
  )
  if (split === undefined || stock === undefined)
    return (
      <section aria-label={t.title} className={styles['splitSection']}>
        <h3 className={styles['groupTitle']}>{t.title}</h3>
        <Button
          size="sm"
          icon={<Icon name="split" />}
          title={t.actionDescription}
          disabled={stock === undefined}
          onClick={() => void send(firstSplit(stock?.thickness.canonical ?? 0, units))}
        >
          {t.action}
        </Button>
        {error ? <ErrorMessage error={error} /> : null}
        {confirmDialog}
      </section>
    )
  const args = splitArgs(split)
  const L = stock.length.canonical
  const W = stock.width.canonical
  const T = stock.thickness.canonical
  const withLines = (lines: SplitArgs['lines']) => ({ ...args, lines })
  const withLevels = (levels: SplitArgs['levels']) => ({ ...args, levels })
  const addLine = (axis: 'x' | 'y') => {
    const at = split.lines.filter((l) => l.axis === axis).map((l) => mmOf(l.at))
    const v = nextCut(at, 0, axis === 'x' ? L : W)
    void send(withLines([...args.lines, { axis, at: cutSource(v, units) }]))
  }
  const addLevel = () => {
    const v = nextCut(split.levels.map(mmOf), -T, 0)
    void send(withLevels([...args.levels, cutSource(v, units)]))
  }
  const pieces = pieceViews(part.doc, part.dto.id)
  return (
    <section aria-label={t.title} className={styles['splitSection']}>
      <h3 className={styles['groupTitle']}>
        {t.title} · {t.pieces(pieces.length)}
      </h3>
      <p className={styles['muted']}>{t.intro}</p>
      <SplitPreview part={part} pieces={pieces} />
      <ul className={styles['splitChips']} aria-label={t.pieces(pieces.length)}>
        {pieces.map((p) => (
          <li key={p.id} className={styles['splitChip']}>
            {t.chip(p.n, blankText(p.blank, units))}
          </li>
        ))}
      </ul>
      <div className={styles['splitGroup']} role="group" aria-label={t.lines}>
        {split.lines.length === 0 && split.levels.length === 0 ? (
          <p className={styles['muted']}>{t.noCuts}</p>
        ) : null}
        {split.lines.map((line, i) => (
          <div key={`line-${i}`} className={styles['splitRow']}>
            <QuantityInput
              label={t.lineAt(line.axis)}
              kind="length"
              defaultUnit={unit}
              value={quantityOf(line.at)}
              onCommit={(q, gesture) =>
                void send(
                  withLines(args.lines.map((l, k) => (k === i ? { ...l, at: q.source } : l))),
                  false,
                  gesture,
                )
              }
            />
            <IconButton
              label={t.removeLine(line.axis, line.at.source)}
              icon={<Icon name="delete" />}
              onClick={() => void send(withLines(args.lines.filter((_, k) => k !== i)))}
            />
          </div>
        ))}
        {split.levels.map((level, i) => (
          <div key={`level-${i}`} className={styles['splitRow']}>
            <QuantityInput
              label={t.levelAt}
              kind="length"
              defaultUnit={unit}
              value={quantityOf(level)}
              onCommit={(q, gesture) =>
                void send(
                  withLevels(args.levels.map((l, k) => (k === i ? q.source : l))),
                  false,
                  gesture,
                )
              }
            />
            <IconButton
              label={t.removeLevel(level.source)}
              icon={<Icon name="delete" />}
              onClick={() => void send(withLevels(args.levels.filter((_, k) => k !== i)))}
            />
          </div>
        ))}
        <div className={styles['addRow']}>
          <Button size="sm" icon={<Icon name="add" />} onClick={() => addLine('x')}>
            {t.addLine('x')}
          </Button>
          <Button size="sm" icon={<Icon name="add" />} onClick={() => addLine('y')}>
            {t.addLine('y')}
          </Button>
          <Button size="sm" icon={<Icon name="add" />} onClick={addLevel}>
            {t.addLevel}
          </Button>
        </div>
      </div>
      <QuantityInput
        label={t.margin}
        kind="length"
        defaultUnit={unit}
        value={quantityOf(split.margin)}
        onCommit={(q, gesture) => void send({ ...args, margin: q.source }, false, gesture)}
      />
      <p className={styles['muted']}>{t.joint}</p>
      <div className={styles['addRow']}>
        <Button
          size="sm"
          variant="danger"
          icon={<Icon name="delete" />}
          onClick={() => void send(null)}
        >
          {t.remove}
        </Button>
      </div>
      {error ? <ErrorMessage error={error} /> : null}
      {confirmDialog}
    </section>
  )
}

/**
 * Top (X–Y) and Front (X–Z) of the pieces' blanks, pulled apart from the part's centre once shown
 * (`--motion-slow`; reduced motion zeroes it, so the pieces just appear apart).
 */
function SplitPreview({ part, pieces }: { part: DesignPart; pieces: readonly PieceView[] }) {
  const [apart, setApart] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setApart(true))
    return () => cancelAnimationFrame(id)
  }, [])
  const stock = part.loaded?.stock
  if (stock === undefined || pieces.length === 0) return null
  const L = stock.length.canonical
  const W = stock.width.canonical
  const T = stock.thickness.canonical
  const pad = Math.max(L, W, T) * 0.12
  const gap = Math.max(L, W, T) * 0.04
  const view = (kind: 'top' | 'front') => {
    const h = kind === 'top' ? W : T
    const box = `${-pad} ${-pad} ${L + 2 * pad} ${h + 2 * pad}`
    // one rectangle per distinct footprint (top) or X–Z slice (front)
    const seen = new Set<string>()
    const rects = pieces.flatMap((p) => {
      const b = p.box
      const r =
        kind === 'top'
          ? { x: b.x0, y: W - b.y1, w: b.x1 - b.x0, h: b.y1 - b.y0 }
          : { x: b.x0, y: -b.z1, w: b.x1 - b.x0, h: b.z1 - b.z0 }
      const key = `${r.x}:${r.y}:${r.w}:${r.h}`
      if (seen.has(key)) return []
      seen.add(key)
      const cx = r.x + r.w / 2 - L / 2
      const cy = r.y + r.h / 2 - h / 2
      const d = Math.hypot(cx, cy) || 1
      const dx = apart ? (cx / d) * gap : 0
      const dy = apart ? (cy / d) * gap : 0
      return [{ key, n: p.n, r, dx, dy }]
    })
    return (
      <figure className={styles['splitView']}>
        <svg
          viewBox={box}
          role="img"
          aria-label={`${t.preview}: ${kind === 'top' ? t.top : t.front}`}
        >
          <rect className={styles['splitWhole']} x={0} y={0} width={L} height={h} />
          {rects.map(({ key, n, r, dx, dy }) => (
            <g
              key={key}
              className={styles['splitPiece']}
              style={{ transform: `translate(${dx}px, ${dy}px)` }}
            >
              <rect x={r.x} y={r.y} width={r.w} height={r.h} />
              <text x={r.x + r.w / 2} y={r.y + r.h / 2} fontSize={Math.max(L, W, T) * 0.06}>
                {n}
              </text>
            </g>
          ))}
        </svg>
        <figcaption className={styles['muted']}>{kind === 'top' ? t.top : t.front}</figcaption>
      </figure>
    )
  }
  return (
    <div className={styles['splitPreview']} aria-label={t.preview} role="group">
      {view('top')}
      {view('front')}
    </div>
  )
}

/** A piece's inspector: its name, where it comes from, its blank and its warnings. */
export function PieceInspector({
  part,
  warnings,
  warningItems,
  labels,
}: {
  part: DesignPart
  warnings: DesignWarnings
  warningItems: (w: DfmWarning) => WarningView
  labels: WarningListLabels
}): React.JSX.Element {
  const call = useCommand()
  const setPart = useUi((st) => st.setDesignPart)
  const [, select] = useDesignSelection()
  const from = part.dto.derivedFrom!
  const source = part.doc.parts[from.partId]
  const total = piecesOf(part.doc, from.partId).length
  const view = pieceViews(part.doc, from.partId).find((p) => p.id === part.dto.id)
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  return (
    <div className={styles['inspector']}>
      <PanelHeader title={t.pieceTitle} meta={<span>{t.pieces(total)}</span>} />
      <div className={styles['fields']}>
        <NameField
          label={m.inspector.name}
          name={part.dto.name}
          onCommit={(name) =>
            void call('design.part.update', { partId: part.dto.id, name }).then((r) =>
              setError(r.ok ? undefined : r.error),
            )
          }
        />
        <p className={styles['muted']}>{t.pieceOf(from.index, total, source?.name ?? '')}</p>
        {view !== undefined ? (
          <p className={styles['muted']}>
            {m.stock.title}: {blankText(view.blank, part.units)} · {t.ownBlank}
          </p>
        ) : null}
        <div className={styles['addRow']}>
          <Button
            size="sm"
            icon={<Icon name="split" />}
            onClick={() => {
              setPart(from.partId)
              select(null)
            }}
          >
            {t.editSplit}
          </Button>
        </div>
        {error ? <ErrorMessage error={error} /> : null}
        <section aria-label={dfmMessages.listTitle} className={styles['warnings']}>
          <h3 className={styles['groupTitle']}>{dfmMessages.listTitle}</h3>
          <WarningList
            labels={labels}
            items={warnings.warnings.map(warningItems)}
            empty={dfmMessages.none}
            {...(warnings.evaluation === 'pending' ? { note: dfmMessages.checksPending } : {})}
          />
        </section>
      </div>
    </div>
  )
}

/** A piece's operation, selected: read-only, with the way to its source. */
export function PieceOperationNote({
  part,
  operationId,
}: {
  part: DesignPart
  operationId: string
}): React.JSX.Element {
  const setPart = useUi((st) => st.setDesignPart)
  const [, select] = useDesignSelection()
  const from = part.dto.derivedFrom!
  const source = part.doc.parts[from.partId]
  const op = part.dto.operations.find((o) => o.id === operationId)!
  const inSource = source?.operations.some((o) => o.id === operationId) === true
  const name = dfmNames(part.dto).item(operationId)
  return (
    <div className={styles['inspector']}>
      <PanelHeader title={op.name} />
      <div className={styles['fields']}>
        <p className={styles['muted']}>
          {inSource ? t.fromSource(name, source?.name ?? '') : t.generated(name)}
        </p>
        <div className={styles['addRow']}>
          <Button
            size="sm"
            icon={<Icon name={inSource ? 'arrow-right' : 'split'} />}
            onClick={() => {
              setPart(from.partId)
              select(inSource ? operationId : null)
            }}
          >
            {inSource ? t.showInSource(source?.name ?? '') : t.editSplit}
          </Button>
        </div>
      </div>
    </div>
  )
}
