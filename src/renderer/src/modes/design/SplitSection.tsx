// Split parts 4a in the part inspector: "Split part…" (a first level at half height), the split
// editor (lines and levels as fields, the margin; each commit sends the whole split with
// `design.split.set`, one undo step; removing pieces with plans asks first), the preview (pieces
// pulled apart in Top and Front, each with its blank, `--motion-slow`, none under reduced motion)
// and the piece chips; a piece's own inspector ("Piece 3 of 8 of Enclosure · Edit the split") and
// the read-only note for its operations. Since 4b the joints: dowels on levels, keys on lines
// (Puzzle / Dovetail with the clearance; the keys drawn in Top) and, 4b-3, "Test fit…" (coupon
// parts of the key at one or three clearances; the first is shown). Since 4c each piece chip names
// its blank and opens a menu to change it, "Use library stocks" and "Split to fit…". Since 4e a
// line can run along an open named shape: "Add curved line" (a new shape and the line, one undo
// step), "Line along shape", the row's shape picker and "Edit shape"; Top draws the pieces' shapes.
// Doc: docs/conventions/ui.md#split-part-split-parts-4a, docs/modes/split-parts.md#ui-summary-design,
// docs/modes/split-parts.md#implementation-4c, docs/modes/split-parts.md#implementation-4e
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { dfmMessages } from '../../messages/dfm'
import { useLibraryVersion, useRegion2d, useUi } from '../../shell/ShellContext'
import {
  Button,
  ConfirmDialog,
  ErrorMessage,
  Field,
  Icon,
  IconButton,
  Menu,
  newGestureId,
  PanelHeader,
  QuantityInput,
  SegmentedControl,
  Select,
  Switch,
  WarningList,
  type WarningListLabels,
  type WarningView,
  type MenuEntry,
} from '../../ui'
import styles from './Design.module.css'
import { NameField } from './NameField'
import { defaultUnit, quantityOf, type DesignPart, dfmNames } from './model'
import {
  blankText,
  curvedLineSeed,
  cutFindings,
  cutSource,
  dowelHoles,
  firstSplit,
  libraryStockViews,
  nextCut,
  pieceViews,
  piecesOf,
  splitArgs,
  stocksHolding,
  stocksOfClass,
  testFitClearances,
  withoutLevel,
  type LibraryStockView,
  type PieceView,
  type SplitArgs,
} from './split-view'
import { isShapeLine } from '../../../../core/design/part.dto'
import { shapeLinePath } from '../../../../core/design/split/layout'
import { useOpenShape } from './useOpenShape'
import { DOWEL_SIZES } from '../../../../core/design/dowel'
import {
  isKeyKind,
  keyClearance,
  keyPreviewPoints,
  KEY_CLEARANCE_MAX,
  type KeyPlan,
} from '../../../../core/design/split/keys'
import type { Lap } from '../../../../core/design/split/laps'
import { lengthDTO, splitKeys } from '../../../../core/design/split/pieces'
import { useCommand, useDesignSelection, type DesignWarnings } from './useDesign'

const m = designMessages
const t = m.split

const mmOf = (q: { exact: { num: string; den: string } }): number =>
  Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))

/** The library's block stocks, re-read when the library changes (split parts 4c). */
function useLibraryStocks(): readonly LibraryStockView[] {
  const call = useCommand()
  const version = useLibraryVersion()
  const [stocks, setStocks] = useState<readonly LibraryStockView[]>([])
  useEffect(() => {
    let live = true
    void call('library.stock.list', {}).then((r) => {
      if (live && r.ok) setStocks(libraryStockViews((r.value as { items: unknown[] }).items ?? []))
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on library changes only
  }, [version])
  return stocks
}

/** Pieces grouped by their blank's words, in piece order (U9 Q132: one row per blank). */
function blankGroups(
  pieces: readonly PieceView[],
  words: (p: PieceView) => string,
): { blank: string; pieces: PieceView[] }[] {
  const groups = new Map<string, PieceView[]>()
  for (const p of pieces) {
    const k = words(p)
    groups.set(k, [...(groups.get(k) ?? []), p])
  }
  return [...groups].map(([blank, ps]) => ({ blank, pieces: ps }))
}

/** A piece's blank in words: the library stock (turned) or "own blank". */
const blankName = (p: PieceView): string =>
  p.stock === undefined ? t.ownBlank : p.stock.turned ? t.turned(p.stock.name) : p.stock.name

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

/**
 * The part menu's and the part row's context menu entry (split parts 4a polish): "Split part…" on
 * a part without a split (the same first split as the inspector's button), else "Edit the split";
 * both show the part inspector, where the Split section is (on a piece: its source's).
 */
export function useSplitEntry(part: DesignPart): MenuEntry {
  const { send } = useSplitSet(part)
  const setPart = useUi((st) => st.setDesignPart)
  const showInspector = useUi((st) => st.showInspector)
  const [, select] = useDesignSelection()
  const from = part.dto.derivedFrom
  const stock = part.loaded?.stock
  const show = () => {
    if (from !== undefined) setPart(from.partId)
    select(null)
    showInspector()
  }
  if (from !== undefined || part.dto.split !== undefined)
    return { label: t.editSplit, icon: <Icon name="split" />, onSelect: show }
  return {
    label: t.action,
    description: t.actionDescription,
    icon: <Icon name="split" />,
    ...(stock === undefined ? { disabledReason: m.split.noStock } : {}),
    onSelect: () => {
      show()
      void send(firstSplit(stock?.thickness.canonical ?? 0, part.units))
    },
  }
}

/** The split section of a source part's inspector. */
export function SplitSection({
  part,
  warnings = [],
}: {
  part: DesignPart
  /** The part's warnings: each line's and level's split findings show under its field. */
  warnings?: readonly DfmWarning[]
}): React.JSX.Element {
  const { send, error, confirm, setConfirm } = useSplitSet(part)
  const setFocus = useUi((st) => st.setSplitFocus)
  const call = useCommand()
  const openShape = useOpenShape()
  const shapeName = (id: string) => part.dto.shapes?.find((x) => x.id === id)?.name ?? id
  const split = part.dto.split
  const stock = part.loaded?.stock
  // keys on the lines (4b-2): placed by the core from the source, for the preview and read-outs
  const port = useRegion2d()
  const loaded = part.loaded
  const info = useMemo(() => {
    if (port === undefined || loaded === undefined || split === undefined) return undefined
    const r = splitKeys(loaded, split, port)
    return r.isOk() ? r.unwrap() : undefined
  }, [port, loaded, split])
  const keys = split !== undefined && isKeyKind(split.joint.kind) ? info : undefined
  const stocks = useLibraryStocks()
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
        {/* full width, as Split to fit… under it and the editor's actions (design review U9) */}
        <div className={styles['addRow']}>
          <Button
            size="sm"
            icon={<Icon name="split" />}
            title={t.actionDescription}
            disabled={stock === undefined}
            onClick={() => void send(firstSplit(stock?.thickness.canonical ?? 0, units))}
          >
            {t.action}
          </Button>
        </div>
        {stock === undefined ? null : (
          <SplitToFit part={part} stocks={stocks} send={(a) => void send(a)} />
        )}
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
    const at = split.lines.flatMap((l) => (!isShapeLine(l) && l.axis === axis ? [mmOf(l.at)] : []))
    const v = nextCut(at, 0, axis === 'x' ? L : W)
    void send(withLines([...args.lines, { axis, at: cutSource(v, units) }]))
  }
  // shape lines (4e): the part's named shapes that are one open path, and those not yet lines
  const openShapes = (part.dto.shapes ?? []).filter(
    (x) => port !== undefined && shapeLinePath(port, x.id, part.dto.shapes) !== undefined,
  )
  const used = new Set(split.lines.flatMap((l) => (isShapeLine(l) ? [l.shape] : [])))
  const freeShape = openShapes.find((x) => !used.has(x.id))
  const addCurvedLine = async () => {
    // a new open shape and the line along it: one gesture, one undo step
    const gesture = newGestureId()
    const r = await call(
      'design.shape.add',
      {
        partId: part.dto.id,
        name: t.curveName(openShapes.length + 1),
        items: [curvedLineSeed(L, W, units)],
      },
      { gesture },
    )
    if (!r.ok) return
    const { shapeId } = r.value as { shapeId: string }
    await send(withLines([...args.lines, { shape: shapeId }]), false, gesture)
  }
  const addLevel = () => {
    const v = nextCut(split.levels.map(mmOf), -T, 0)
    void send(withLevels([...args.levels, cutSource(v, units)]))
  }
  const pieces = pieceViews(part.doc, part.dto.id)
  const findingText = (w: DfmWarning) => dfmMessages.text(w, units, dfmNames(part.dto))
  const holes = dowelHoles(split)
  // the keys' and fingers' outlines, and each half lap's overlap (4d) as a closed outline
  const laps = split.joint.kind === 'halfLap' ? (info?.laps ?? []) : []
  const knobs = [...(keys?.keys.keys ?? []).map((k) => keyPreviewPoints(k)), ...laps.map(lapPoints)]
  // with a shape line every key names its line (4e); else by the straight line's axis and value
  const keysOn = (i: number) => {
    const l = split.lines[i]!
    return (keys?.keys.keys ?? []).filter((k) =>
      k.line !== undefined
        ? k.line === i
        : !isShapeLine(l) && k.axis === l.axis && Math.abs(k.at - mmOf(l.at)) < 1e-6,
    ).length
  }
  return (
    <section aria-label={t.title} className={styles['splitSection']}>
      <h3 className={styles['groupTitle']}>
        {t.title} · {t.pieces(pieces.length)}
      </h3>
      <p className={styles['muted']}>{t.intro}</p>
      <SplitPreview
        part={part}
        pieces={pieces}
        holes={holes}
        knobs={knobs}
        outlines={info?.outlines}
        paths={info?.paths}
      />
      {/* U9 Q132 (provisional): pieces with the same blank in one row, a small numbered chip per
          piece (each opens its blank menu, named by the whole chip text) and the blank once */}
      <ul className={styles['splitChips']} aria-label={t.pieces(pieces.length)}>
        {blankGroups(pieces, (p) => t.blankLine(blankText(p.blank, units), blankName(p))).map(
          (g) => (
            <li key={g.pieces[0]!.id} className={styles['splitChipGroup']}>
              <div className={styles['splitChipNumbers']}>
                {g.pieces.map((p) => (
                  <BlankMenu
                    key={p.id}
                    piece={p}
                    need={info?.needs.get(p.n)}
                    stocks={stocks}
                    materialClass={stock.material.class}
                  >
                    <button
                      type="button"
                      className={styles['splitChip']}
                      aria-label={t.chip(p.n, blankText(p.blank, units), blankName(p))}
                      title={t.chip(p.n, blankText(p.blank, units), blankName(p))}
                    >
                      {p.n}
                    </button>
                  </BlankMenu>
                ))}
              </div>
              <span className={styles['splitChipBlank']} aria-hidden="true">
                {g.blank}
              </span>
            </li>
          ),
        )}
      </ul>
      <div className={styles['splitGroup']} role="group" aria-label={t.lines}>
        {split.lines.length === 0 && split.levels.length === 0 ? (
          <p className={styles['muted']}>{t.noCuts}</p>
        ) : null}
        {split.lines.map((line, i) =>
          isShapeLine(line) ? (
            <CutRow
              key={`line-${i}`}
              onFocus={() => setFocus(null)}
              onBlur={() => setFocus(null)}
              {...(keys === undefined ? {} : { note: t.keyCount(keysOn(i)) })}
              text={findingText}
              findings={cutFindings(warnings, {
                kind: 'line',
                index: i,
                axis: 'x',
                at: Number.NaN,
                shape: line.shape,
              })}
            >
              <Select
                aria-label={t.lineAlong}
                value={line.shape}
                options={openShapes.map((x) => ({
                  value: x.id,
                  label: x.name,
                  disabled: x.id !== line.shape && used.has(x.id),
                }))}
                onValueChange={(v) =>
                  void send(withLines(args.lines.map((l, k) => (k === i ? { shape: v } : l))))
                }
              />
              <IconButton
                label={t.editLineShape}
                icon={<Icon name="edit" />}
                onClick={() => openShape(part.dto.id, line.shape)}
              />
              <IconButton
                label={t.removeShapeLine(shapeName(line.shape))}
                icon={<Icon name="delete" />}
                onClick={() => void send(withLines(args.lines.filter((_, k) => k !== i)))}
              />
            </CutRow>
          ) : (
            <CutRow
              key={`line-${i}`}
              onFocus={() => setFocus({ kind: 'line', index: i })}
              onBlur={() => setFocus(null)}
              {...(keys === undefined ? {} : { note: t.keyCount(keysOn(i)) })}
              text={findingText}
              findings={cutFindings(warnings, {
                kind: 'line',
                index: i,
                axis: line.axis,
                at: mmOf(line.at),
              })}
            >
              <QuantityInput
                label={t.lineAt(line.axis)}
                kind="length"
                defaultUnit={unit}
                value={quantityOf(line.at)}
                onCommit={(q, gesture) =>
                  void send(
                    withLines(
                      args.lines.map((l, k) =>
                        k === i && !('shape' in l) ? { ...l, at: q.source } : l,
                      ),
                    ),
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
            </CutRow>
          ),
        )}
        {split.levels.map((level, i) => (
          <CutRow
            key={`level-${i}`}
            onFocus={() => setFocus({ kind: 'level', index: i })}
            onBlur={() => setFocus(null)}
            {...(split.joint.dowels === undefined
              ? {}
              : { note: t.dowelCount(holes.filter((h) => h.level === i).length) })}
            text={findingText}
            findings={cutFindings(warnings, {
              kind: 'level',
              index: i,
              axis: 'z',
              at: mmOf(level),
            })}
          >
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
              onClick={() => void send(withoutLevel(args, i))}
            />
          </CutRow>
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
        {/* split lines as shapes (4e) */}
        <div className={styles['addRow']}>
          <Button
            size="sm"
            icon={<Icon name="add" />}
            title={t.addCurvedLineDescription}
            disabled={port === undefined}
            onClick={() => void addCurvedLine()}
          >
            {t.addCurvedLine}
          </Button>
          {freeShape === undefined ? null : (
            <Button
              size="sm"
              icon={<Icon name="add" />}
              title={t.lineAlongDescription}
              onClick={() => void send(withLines([...args.lines, { shape: freeShape.id }]))}
            >
              {t.addLineAlong}
            </Button>
          )}
        </div>
      </div>
      <QuantityInput
        label={t.margin}
        kind="length"
        defaultUnit={unit}
        value={quantityOf(split.margin)}
        onCommit={(q, gesture) => void send({ ...args, margin: q.source }, false, gesture)}
      />
      {split.lines.length > 0 ? (
        <KeyFields
          part={part}
          args={args}
          keys={keys}
          laps={laps}
          send={(a, g) => void send(a, false, g)}
        />
      ) : null}
      {split.levels.length > 0 ? (
        <DowelFields part={part} args={args} send={(a, g) => void send(a, false, g)} />
      ) : null}
      {/* the blanks after the cuts (U9 Q131): how the pieces are cut first, then from what */}
      <Field
        label={t.useStocks}
        kind="toggle"
        messages={[{ id: 'note', severity: 'note', text: t.useStocksHint }]}
      >
        <Switch
          label={t.useStocks}
          hideLabel
          checked={split.useStocks === true}
          onCheckedChange={(on) => void send({ ...args, useStocks: on })}
        />
      </Field>
      <SplitToFit part={part} stocks={stocks} send={(a) => void send(a)} args={args} />
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

/** A half lap's overlap in the top view: ℓ across the line, over the pieces' extent along it. */
function lapPoints(l: Lap): (readonly [number, number])[] {
  const h = l.length / 2
  const p = (u: number, w: number) =>
    l.axis === 'x' ? ([l.at + w, u] as const) : ([u, l.at + w] as const)
  return [p(l.lo, -h), p(l.hi, -h), p(l.hi, h), p(l.lo, h), p(l.lo, -h)]
}

type LineJoint = 'butt' | 'puzzle' | 'dovetail' | 'finger' | 'halfLap'

/**
 * The lines' joint (split parts 4b-2, 4d): Butt, Puzzle, Dovetail, Finger or Half lap, in a
 * select (five do not fit a segmented control); with a joint the clearance (socket side only), a
 * read-out (keys: count, neck, largest tool; fingers: count, width, T-bones; a lap: its length and
 * the flip) and Test fit (not for a half lap).
 */
function KeyFields({
  part,
  args,
  keys,
  laps,
  send,
}: {
  part: DesignPart
  args: SplitArgs
  keys: { readonly keys: KeyPlan; readonly outlineTool: number } | undefined
  laps: readonly Lap[]
  send: (split: SplitArgs, gesture?: string) => void
}): React.JSX.Element {
  const split = part.dto.split!
  const kind = split.joint.kind
  const unit = defaultUnit('length', part.units)
  const placed = keys?.keys.keys ?? []
  const fmt = (v: number) => `${+v.toFixed(2)}`
  // U9 Q131: the settings open when the joint is chosen here, collapsed once set
  const [chosen, setChosen] = useState(false)
  const clearance =
    split.joint.clearance?.source ?? lengthDTO(keyClearance(split), part.units).source
  return (
    <div className={styles['splitGroup']} role="group" aria-label={t.lineJoint}>
      <Field label={t.lineJoint}>
        <Select<LineJoint>
          options={[
            { value: 'butt', label: t.jointButt },
            { value: 'puzzle', label: t.jointPuzzle },
            { value: 'dovetail', label: t.jointDovetail },
            { value: 'finger', label: t.jointFinger, description: t.jointFingerDescription },
            { value: 'halfLap', label: t.jointHalfLap, description: t.jointHalfLapDescription },
          ]}
          value={kind}
          onValueChange={(v) => {
            const { joint: _, clearance: _c, ...rest } = args
            setChosen(true)
            // a joint's clearance carries over to another joint (the stored one)
            send(v === 'butt' ? rest : { ...rest, joint: v })
          }}
        />
      </Field>
      {kind === 'butt' ? null : (
        <JointSettings
          title={
            kind === 'finger'
              ? t.fingerSettings
              : kind === 'halfLap'
                ? t.lapSettings
                : t.keySettings
          }
          summary={
            kind === 'finger'
              ? t.fingerSettingsSummary(clearance, keys === undefined ? undefined : placed.length)
              : kind === 'halfLap'
                ? t.lapSettingsSummary(
                    clearance,
                    laps[0] === undefined ? undefined : fmt(laps[0].length),
                  )
                : t.keySettingsSummary(clearance, keys === undefined ? undefined : placed.length)
          }
          open={chosen}
        >
          <QuantityInput
            label={kind === 'puzzle' || kind === 'dovetail' ? t.clearance : t.jointClearance}
            kind="length"
            defaultUnit={unit}
            value={
              split.joint.clearance === undefined ? undefined : quantityOf(split.joint.clearance)
            }
            onCommit={(q, gesture) => send({ ...args, clearance: q.source }, gesture)}
            messages={[{ id: 'note', severity: 'note', text: t.clearanceHint }]}
          />
          {kind === 'halfLap' ? (
            <p className={styles['muted']}>
              {laps[0] === undefined ? t.noLaps : t.lapSummary(laps.length, fmt(laps[0].length))}
            </p>
          ) : keys === undefined ? null : (
            <p className={styles['muted']}>
              {placed.length === 0
                ? kind === 'finger'
                  ? t.noFingers
                  : t.noKeys
                : kind === 'finger'
                  ? t.fingerSummary(
                      placed.length,
                      fmt(Math.min(...placed.map((k) => k.size.neck))),
                      fmt(keys.outlineTool),
                    )
                  : t.keySummary(
                      placed.length,
                      fmt(Math.min(...placed.map((k) => k.size.neck))),
                      fmt(Math.min(...placed.map((k) => k.size.maxTool))),
                    )}
            </p>
          )}
          {kind === 'halfLap' ? null : <TestFit part={part} />}
        </JointSettings>
      )}
    </div>
  )
}

/**
 * A joint's settings (U9 Q131): a disclosure under the joint control, its summary a one-line
 * read-out ("Key settings · clearance 0.15 mm · 2 keys"); open when the joint was chosen in
 * this inspector, collapsed otherwise (the joint is set), so a set split stays short. Opens and
 * closes over `--motion-base` (the height, cut under reduced motion).
 */
function JointSettings({
  title,
  summary,
  open: opened,
  children,
}: {
  title: string
  summary: string
  /** Open it (the joint was just chosen); the user's own toggles win after that. */
  open: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(opened)
  const [was, setWas] = useState(opened)
  if (opened !== was) {
    setWas(opened)
    if (opened) setOpen(true)
  }
  return (
    <details
      className={styles['splitSettings']}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <Icon name="chevron-down" />
        <span className={styles['splitSettingsTitle']}>{title}</span>
        <span className={styles['splitSettingsSummary']}>{summary}</span>
      </summary>
      <div className={styles['splitGroup']}>{children}</div>
    </details>
  )
}

/**
 * A piece chip's menu (split parts 4c): Automatic, Own block, the library stocks of the class
 * that hold the piece (smallest first); `design.part.update { blank }` on the piece.
 */
function BlankMenu({
  piece,
  need,
  stocks,
  materialClass,
  children,
}: {
  piece: PieceView
  need: readonly [number, number, number] | undefined
  stocks: readonly LibraryStockView[]
  materialClass: string
  children: React.ReactElement
}): React.JSX.Element {
  const call = useCommand()
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const choose = (blank: 'auto' | 'own' | { stockLibraryItemId: string }) =>
    void call('design.part.update', { partId: piece.id, blank }).then((r) =>
      setError(r.ok ? undefined : r.error),
    )
  const holding = need === undefined ? [] : stocksHolding(stocks, need, materialClass)
  const items: MenuEntry[] = [
    {
      label: t.blankAuto,
      description: t.blankAutoDescription,
      checked: piece.choice === undefined,
      onSelect: () => choose('auto'),
    },
    {
      label: t.blankOwn,
      description: t.blankOwnDescription,
      checked: piece.choice === 'own',
      onSelect: () => choose('own'),
    },
    {
      group: t.blankStocks,
      items:
        holding.length === 0
          ? [{ label: t.noStockHolds, disabled: true, onSelect: () => undefined }]
          : holding.map(({ stock, turned }) => ({
              id: stock.id,
              label: t.blankStock(stock.name, turned),
              checked: piece.choice === stock.id,
              onSelect: () => choose({ stockLibraryItemId: stock.id }),
            })),
    },
  ]
  return (
    <>
      {/* named by its chip (Radix labels the menu by the trigger) */}
      <Menu items={items}>{children}</Menu>
      {error ? <ErrorMessage error={error} /> : null}
    </>
  )
}

/**
 * "Split to fit…" (split parts 4c): the library stocks of the source's class; choosing one asks
 * `design.split.suggest` and applies its lines and levels with `design.split.set` (library stocks
 * on, margin and joint kept, dowel holes placed again).
 */
function SplitToFit({
  part,
  stocks,
  send,
  args,
}: {
  part: DesignPart
  stocks: readonly LibraryStockView[]
  send: (args: SplitArgs) => void
  args?: SplitArgs
}): React.JSX.Element {
  const call = useCommand()
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const cls = part.loaded?.stock.material.class ?? ''
  const options = stocksOfClass(stocks, cls)
  const fit = async (id: string) => {
    const r = await call('design.split.suggest', { partId: part.dto.id, stockLibraryItemId: id })
    if (!r.ok) return setError(r.error)
    setError(undefined)
    const s = r.value as { lines: SplitArgs['lines']; levels: SplitArgs['levels'] }
    const { dowels, ...rest } = args ?? firstSplit(0, part.units)
    // dowel holes are placed again on the new levels
    const placed = dowels === undefined ? undefined : (({ holes: _, ...d }) => d)(dowels)
    send({
      ...rest,
      ...(placed === undefined ? {} : { dowels: placed }),
      lines: s.lines,
      levels: s.levels,
      useStocks: true,
    })
  }
  const items: MenuEntry[] =
    options.length === 0
      ? [{ label: t.fitNoStocks, disabled: true, onSelect: () => undefined }]
      : options.map((o) => ({
          id: o.id,
          label: `${o.name} · ${blankText(o.size, part.units)}`,
          onSelect: () => void fit(o.id),
        }))
  return (
    <>
      <div className={styles['addRow']}>
        <Menu label={t.fit} items={items}>
          <Button size="sm" icon={<Icon name="split" />} title={t.fitDescription}>
            {t.fit}
          </Button>
        </Menu>
      </div>
      {error ? <ErrorMessage error={error} /> : null}
    </>
  )
}

/**
 * "Test fit…" (split parts 4b-3): a menu adding one coupon at the split's clearance or three
 * side by side (`design.split.testFit`, one undo step); the first coupon is shown.
 */
function TestFit({ part }: { part: DesignPart }): React.JSX.Element {
  const call = useCommand()
  const setPart = useUi((st) => st.setDesignPart)
  const [, select] = useDesignSelection()
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const c = keyClearance(part.dto.split!)
  const label = (v: number) => lengthDTO(v, part.units).source
  const add = async (cs: readonly number[]) => {
    const r = await call('design.split.testFit', {
      partId: part.dto.id,
      clearances: cs.map((v) => `${v} mm`),
    })
    if (!r.ok) return setError(r.error)
    setError(undefined)
    const first = (r.value as { parts: { partId: string }[] }).parts[0]
    if (first !== undefined) {
      setPart(first.partId)
      select(null)
    }
  }
  const several = testFitClearances(c, KEY_CLEARANCE_MAX)
  return (
    <>
      <div className={styles['addRow']}>
        <Menu
          label={t.testFit}
          items={[
            { label: t.testFitOne(label(c)), onSelect: () => void add([c]) },
            ...(several.length > 1
              ? [{ label: t.testFitSeveral(several.map(label)), onSelect: () => void add(several) }]
              : []),
          ]}
        >
          <Button size="sm" icon={<Icon name="add" />} title={t.testFitDescription}>
            {t.testFit}
          </Button>
        </Menu>
      </div>
      {error ? <ErrorMessage error={error} /> : null}
    </>
  )
}

/**
 * The levels' joint (split parts 4b): Butt or Dowels; with dowels the dowel Ø (changing it lets
 * the depth default for the new size), the hole depth, the hole positions (X, Y, remove: a level
 * left without holes is placed again by the core) and "Place dowels again" (no holes sent).
 */
function DowelFields({
  part,
  args,
  send,
}: {
  part: DesignPart
  args: SplitArgs
  send: (split: SplitArgs, gesture?: string) => void
}): React.JSX.Element {
  const split = part.dto.split!
  const dowels = split.joint.dowels
  const unit = defaultUnit('length', part.units)
  const d = args.dowels
  const holes = dowelHoles(split)
  const withHoles = (next: NonNullable<SplitArgs['dowels']>['holes']) => ({
    ...args,
    dowels: { ...d, holes: next ?? [] },
  })
  // U9 Q131: the settings open when Dowels is chosen here, collapsed once set
  const [chosen, setChosen] = useState(false)
  return (
    <div className={styles['splitGroup']} role="group" aria-label={t.levelJoint}>
      <Field label={t.levelJoint} kind="toggle">
        <SegmentedControl
          label={t.levelJoint}
          options={[
            { value: 'butt', label: t.jointButt },
            { value: 'dowels', label: t.jointDowels },
          ]}
          value={dowels === undefined ? 'butt' : 'dowels'}
          onValueChange={(v) => {
            const { dowels: _, ...rest } = args
            setChosen(true)
            send(v === 'dowels' ? { ...rest, dowels: {} } : rest)
          }}
        />
      </Field>
      {dowels === undefined || d === undefined ? null : (
        <JointSettings
          title={t.dowelSettings}
          summary={t.dowelSettingsSummary(
            dowels.diameter.source,
            dowels.depth.source,
            holes.length,
          )}
          open={chosen}
        >
          <QuantityInput
            label={t.dowelDiameter}
            kind="length"
            defaultUnit={unit}
            value={quantityOf(dowels.diameter)}
            onCommit={(q, gesture) => {
              const { depth: _, ...rest } = d
              send({ ...args, dowels: { ...rest, diameter: q.source } }, gesture)
            }}
            messages={[{ id: 'note', severity: 'note', text: t.dowelHint(DOWEL_SIZES.join(', ')) }]}
          />
          <QuantityInput
            label={t.dowelDepth}
            kind="length"
            defaultUnit={unit}
            value={quantityOf(dowels.depth)}
            onCommit={(q, gesture) => send({ ...args, dowels: { ...d, depth: q.source } }, gesture)}
          />
          <details className={styles['splitDowels']}>
            <summary>{t.positions(holes.length)}</summary>
            <ul>
              {dowels.holes.map((h, i) => (
                <li key={i} aria-label={t.dowelLevel(i + 1, split.levels[h.level]?.source ?? '')}>
                  {(['x', 'y'] as const).map((axis, a) => (
                    <QuantityInput
                      key={axis}
                      label={t.dowelAt(i + 1, axis)}
                      kind="length"
                      defaultUnit={unit}
                      value={quantityOf(h.at[a]!)}
                      onCommit={(q, gesture) =>
                        send(
                          withHoles(
                            d.holes?.map((x, k) =>
                              k === i
                                ? { ...x, at: a === 0 ? [q.source, x.at[1]] : [x.at[0], q.source] }
                                : x,
                            ),
                          ),
                          gesture,
                        )
                      }
                    />
                  ))}
                  <IconButton
                    label={t.removeDowel(i + 1)}
                    icon={<Icon name="delete" />}
                    onClick={() => send(withHoles(d.holes?.filter((_, k) => k !== i)))}
                  />
                </li>
              ))}
            </ul>
          </details>
          <div className={styles['addRow']}>
            <Button
              size="sm"
              icon={<Icon name="refresh" />}
              title={t.placeAgainDescription}
              onClick={() => {
                const { holes: _, ...rest } = d
                send({ ...args, dowels: rest })
              }}
            >
              {t.placeAgain}
            </Button>
          </div>
        </JointSettings>
      )}
    </div>
  )
}

/**
 * A line's or level's field row: focus within it highlights the cut in the viewport's exploded
 * preview (ui-store `splitFocus`); the split findings on that cut (a thin glue face, a feature
 * near it) list under it, following every source edit.
 */
function CutRow({
  children,
  findings,
  text,
  note,
  onFocus,
  onBlur,
}: {
  children: React.ReactNode
  findings: readonly DfmWarning[]
  /** A finding's text, as the warning list words it (design review U9: not the core's message). */
  text: (w: DfmWarning) => string
  /** A read-out under the field (a level's dowel count, 4b). */
  note?: string
  onFocus: () => void
  onBlur: () => void
}): React.JSX.Element {
  // the cut's own glue face first, then the features near it; the rest in Warnings
  const sorted = [...findings].sort(
    (a, b) => Number(a.params['rule'] !== 'thinJoint') - Number(b.params['rule'] !== 'thinJoint'),
  )
  const shown = sorted.slice(0, CUT_FINDINGS_MAX)
  return (
    <div
      className={styles['splitCut']}
      onFocus={onFocus}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onBlur()
      }}
    >
      <div className={styles['splitRow']}>{children}</div>
      {note === undefined ? null : <p className={styles['muted']}>{note}</p>}
      {shown.length > 0 ? (
        <ul className={styles['splitFindings']}>
          {shown.map((f, k) => (
            <li key={k}>
              <Icon name="warning" />
              <span>{text(f)}</span>
            </li>
          ))}
          {sorted.length > shown.length ? (
            <li className={styles['splitMore']}>{t.moreFindings(sorted.length - shown.length)}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * Findings listed under a cut's field at most (U9 Q131: one, its glue face first, was three);
 * the rest are in the warning list ("n more in Warnings").
 */
const CUT_FINDINGS_MAX = 1

/**
 * Top (X–Y) and Front (X–Z) of the pieces' blanks, pulled apart from the part's centre once shown
 * (`--motion-slow`; reduced motion zeroes it, so the pieces just appear apart).
 */
function SplitPreview({
  part,
  pieces,
  holes,
  knobs,
  outlines,
  paths,
}: {
  part: DesignPart
  pieces: readonly PieceView[]
  /** Dowel holes (4b), drawn in Top at their place on the part. */
  holes: readonly { readonly x: number; readonly y: number }[]
  /** Each key's knob outline (4b-2, part frame), drawn in Top on its line. */
  knobs: readonly (readonly (readonly [number, number])[])[]
  /** With a shape line (4e): each piece's footprint by number, drawn in Top instead of its box. */
  outlines?: ReadonlyMap<number, readonly (readonly [number, number])[]> | undefined
  /** With a shape line (4e): the lines' paths, drawn in Top. */
  paths?: ReadonlyMap<number, readonly (readonly [number, number])[]> | undefined
}) {
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
      // a piece's own footprint in Top on a split with a shape line (4e)
      const pts = kind === 'top' ? outlines?.get(p.n) : undefined
      const poly = pts?.map((q) => `${q[0]},${W - q[1]}`).join(' ')
      const key = poly ?? `${r.x}:${r.y}:${r.w}:${r.h}`
      if (seen.has(key)) return []
      seen.add(key)
      const cx = r.x + r.w / 2 - L / 2
      const cy = r.y + r.h / 2 - h / 2
      const d = Math.hypot(cx, cy) || 1
      const dx = apart ? (cx / d) * gap : 0
      const dy = apart ? (cy / d) * gap : 0
      return [{ key, n: p.n, r, dx, dy, poly }]
    })
    return (
      <PreviewView
        width={L + 2 * pad}
        height={h + 2 * pad}
        box={box}
        label={`${t.preview}: ${kind === 'top' ? t.top : t.front}`}
        caption={kind === 'top' ? t.top : t.front}
      >
        {(fontSize) => (
          <>
            <rect className={styles['splitWhole']} x={0} y={0} width={L} height={h} />
            {kind === 'top'
              ? holes.map((d, k) => (
                  <circle
                    key={`dowel-${k}`}
                    className={styles['splitDowel']}
                    cx={d.x}
                    cy={W - d.y}
                    r={Math.max(L, W) * 0.012}
                  />
                ))
              : null}
            {kind === 'top'
              ? knobs.map((pts, k) => (
                  <polyline
                    key={`key-${k}`}
                    className={styles['splitKey']}
                    points={pts.map((p) => `${p[0]},${W - p[1]}`).join(' ')}
                  />
                ))
              : null}
            {kind === 'top'
              ? [...(paths ?? [])].map(([i, pts]) => (
                  <polyline
                    key={`path-${i}`}
                    className={styles['splitKey']}
                    points={pts.map((p) => `${p[0]},${W - p[1]}`).join(' ')}
                  />
                ))
              : null}
            {rects.map(({ key, n, r, dx, dy, poly }) => (
              <g
                key={key}
                className={styles['splitPiece']}
                style={{ transform: `translate(${dx}px, ${dy}px)` }}
              >
                {poly === undefined ? (
                  <rect x={r.x} y={r.y} width={r.w} height={r.h} />
                ) : (
                  <polygon points={poly} />
                )}
                <text x={r.x + r.w / 2} y={r.y + r.h / 2} fontSize={fontSize}>
                  {n}
                </text>
              </g>
            ))}
          </>
        )}
      </PreviewView>
    )
  }
  return (
    <div className={styles['splitPreview']} aria-label={t.preview} role="group">
      {view('top')}
      {view('front')}
    </div>
  )
}

/** The piece numbers' size on screen (`--text-xs`, 11 px), whatever the part's size (U9 P7). */
const PIECE_NUMBER_PX = 11

/**
 * One view of the split preview: an SVG box at the drawing's aspect (U9 P7: it was stretched
 * taller than its drawing), at most the figure's width and 120 px high, on the figure's bottom so
 * both views' captions share a baseline. `children` gets the font size in drawing units that
 * shows as `PIECE_NUMBER_PX` at the box's current scale.
 */
function PreviewView({
  width,
  height,
  box,
  label,
  caption,
  children,
}: {
  width: number
  height: number
  box: string
  label: string
  caption: string
  children: (fontSize: number) => React.ReactNode
}): React.JSX.Element {
  const ref = useRef<SVGSVGElement>(null)
  const [shown, setShown] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const read = () => setShown(el.getBoundingClientRect().width)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // until measured (and in tests without layout): a size that reads at about the usual width
  const scale = shown > 0 ? shown / width : 120 / width
  return (
    <figure className={styles['splitView']}>
      <svg
        ref={ref}
        viewBox={box}
        // a large intrinsic size at the drawing's aspect; CSS shrinks it to fit, keeping the aspect
        width={1000}
        height={(1000 * height) / width}
        role="img"
        aria-label={label}
      >
        {children(PIECE_NUMBER_PX / scale)}
      </svg>
      <figcaption className={styles['muted']}>{caption}</figcaption>
    </figure>
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
            {m.stock.title}: {blankText(view.blank, part.units)} · {blankName(view)}
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
          <Button
            size="sm"
            icon={<Icon name="edit" />}
            title={t.detachDescription}
            onClick={() =>
              void call('design.part.update', { partId: part.dto.id, detach: true }).then((r) =>
                setError(r.ok ? undefined : r.error),
              )
            }
          >
            {t.detach}
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
