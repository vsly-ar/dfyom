// The pattern's Presets dialog (hardening DF107): a modal grid of preview cards, one per preset,
// each a window onto its lattice (`presetThumb` at PREVIEW size), its name, a one-line
// description and its key numbers. It is the shared PresetsDialog shell with the engraving's
// (P12): one radio group with a roving focus, arrows move (up/down a row), Home/End jump, Enter,
// Space or a click applies and closes, Escape or the footer's Close (P10) closes without a change.
// The preset the pattern already is is marked Current and focused on open. Applying is the
// caller's one `design.pattern.update` (one undo step).
// H1 (pattern-presets.md § UI): a segmented control above the grid, Decorative · Heatsink, opens
// on the group of the current preset, else the last one used this session. A heatsink card does
// not apply at once: the dialog shows its parameter step in place of the grid (fin thickness,
// slot width with the library's flat end mills ≤ it, fin height, outer wall, the live read-out
// and warnings); Apply sends the fields and the tool as one gesture, Back or Escape returns.
// Doc: docs/modes/patterns.md#presets-dialog-and-more-presets-df107, docs/conventions/ui.md#pattern-inspector-p1,
// docs/modes/pattern-presets.md#ui
import { useEffect, useId, useState } from 'react'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import {
  slotCut,
  straightFins,
  straightFinsArgs,
  type StraightFinsLayout,
} from '../../../../core/design/pattern/heatsink'
import { PATTERN_PRESETS, type PatternPreset } from '../../../../core/design/pattern/presets'
import { Quantity } from '../../../../core/quantity/quantity'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import type { UnitSystem } from '../../../../core/project/document'
import { designMessages } from '../../messages/design'
import { lengthSource } from '../../messages/dfm'
import { useLibraryVersion, useShell } from '../../shell/ShellContext'
import {
  Button,
  Field,
  Icon,
  QuantityInput,
  SegmentedControl,
  Select,
  type FieldMessage,
} from '../../ui'
import styles from './Design.module.css'
import { defaultUnit } from './model'
import { matchesPreset, presetNumbers } from './pattern-presets'
import { PREVIEW, presetRings, presetThumb, type RingGuide } from './pattern-thumbs'
import { PresetsDialog } from './PresetsDialog'

const p = designMessages.features.pattern

/** Cards per row (the grid's columns; Up/Down move by a row). */
export const PRESET_COLUMNS = 4

/** The previews, computed once. */
const PREVIEWS = new Map(PATTERN_PRESETS.map((preset) => [preset.id, presetThumb(preset, PREVIEW)]))
/** P10: a polar preset's ring guides, drawn faint behind its cells. */
const RINGS = new Map(PATTERN_PRESETS.map((preset) => [preset.id, presetRings(preset, PREVIEW)]))

export type Group = 'decorative' | 'heatsink'
/** The session's last group (H1), kept with the inspector's remembered steps. */
export const PRESET_GROUP_KEY = 'pattern.presetGroup'

/** A heatsink card (H1: Straight fins; H2–H3 add pins and radial). */
interface HeatsinkCard {
  readonly id: 'straightFins'
  readonly icon: 'fins-straight'
}
const HEATSINK: readonly HeatsinkCard[] = [{ id: 'straightFins', icon: 'fins-straight' }]

/** The straight-fins card's sample numbers (the user's heatsink, mm). */
const SAMPLE = { fin: 1.5, slot: 2, height: 10, wall: 1.5, across: 40, along: 40 }

/** The pocket's default finishing allowance (plan strategy, mm): the step's slot note. */
const ALLOWANCE = 0.2

/** The face and stock the step lays out on (mm). */
export interface HeatsinkFace {
  readonly across: number
  readonly along: number
  /** Material under the face; undefined: no base in the read-out. */
  readonly thickness: number | undefined
}

/** A library flat end mill (`library.tool.list`), mm. */
export interface FlatEndMill {
  readonly id: string
  readonly name: string
  readonly diameter: number
  readonly fluteLength: number | undefined
}

/** The library's flat end mills, smallest first; refreshed when the library changes. */
export function useFlatEndMills(): FlatEndMill[] {
  const { bridge } = useShell()
  const version = useLibraryVersion()
  const [tools, setTools] = useState<FlatEndMill[]>([])
  useEffect(() => {
    let live = true
    void bridge.call('library.tool.list', {}).then((r) => {
      if (!live || !r.ok) return
      const items = (
        r.value as {
          items: {
            id: string
            name: string
            type?: string
            diameter?: QuantityDTO
            fluteLength?: QuantityDTO
          }[]
        }
      ).items
      const mm = (q: QuantityDTO | undefined) => {
        const v = q === undefined ? undefined : Quantity.fromDTO(q)
        return v?.isOk() ? v.unwrap().canonical : undefined
      }
      setTools(
        items
          .filter((i) => i.type === 'flatEndMill' && (mm(i.diameter) ?? 0) > 0)
          .map((i) => ({
            id: i.id,
            name: i.name,
            diameter: mm(i.diameter)!,
            fluteLength: mm(i.fluteLength),
          }))
          .sort((a, b) => a.diameter - b.diameter),
      )
    })
    return () => {
      live = false
    }
  }, [bridge, version])
  return tools
}

export function PatternPresetsDialog({
  feature,
  onApply,
  heatsink,
}: {
  feature: FeatureDTO
  /** Applies the preset's args (one `design.pattern.update`). */
  onApply: (preset: PatternPreset) => void
  /** H1: the face for the parameter step, and the Apply of a heatsink (one gesture). */
  heatsink?:
    | {
        readonly face: HeatsinkFace | undefined
        readonly units: UnitSystem
        /** True when the pattern reads as straight fins (the dialog opens on Heatsink). */
        readonly current: boolean
        /** The library's flat end mills (`useFlatEndMills`). */
        readonly tools: readonly FlatEndMill[]
        /** The group last used this session, and its setter (the inspector's remembered steps). */
        readonly lastGroup: Group | undefined
        readonly onGroup: (group: Group) => void
        readonly apply: (
          args: Record<string, unknown>,
          toolLibraryItemId: string | undefined,
        ) => void
      }
    | undefined
}): React.JSX.Element {
  const remembered = heatsink?.lastGroup
  const current = PATTERN_PRESETS.findIndex((preset) => matchesPreset(feature, preset))
  const opening: Group =
    heatsink?.current === true
      ? 'heatsink'
      : current >= 0
        ? 'decorative'
        : (remembered ?? 'decorative')
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState<Group>(opening)
  const [step, setStep] = useState<HeatsinkCard | undefined>(undefined)
  const openChange = (o: boolean) => {
    if (o) {
      setGroup(opening)
      fins.reset()
    }
    setStep(undefined)
    setOpen(o)
  }
  const choose = (g: Group) => {
    setGroup(g)
    heatsink?.onGroup(g)
  }

  const header =
    heatsink === undefined || step !== undefined ? undefined : (
      <div className={styles['presetGroups']}>
        <SegmentedControl
          label={p.presetGroupLabel}
          size="sm"
          options={(['decorative', 'heatsink'] as const).map((g) => ({
            value: g,
            label: p.presetGroups[g] ?? g,
            icon: <Icon name={g === 'heatsink' ? 'heatsink' : 'pattern'} />,
          }))}
          value={group}
          onValueChange={choose}
        />
      </div>
    )
  const trigger = (
    <Button size="sm" data-pattern-presets>
      {p.presetsButton}
    </Button>
  )

  const fins = useStraightFinsStep(
    heatsink?.face,
    heatsink?.units ?? 'mm',
    heatsink?.tools ?? [],
    () => setStep(undefined),
  )
  if (group === 'heatsink' && heatsink !== undefined)
    return (
      <PresetsDialog<HeatsinkCard>
        title={p.presetsTitle}
        description={p.heatsinkDescription}
        closeLabel={p.presetsClose}
        currentLabel={p.presetCurrent}
        trigger={trigger}
        presets={HEATSINK}
        current={heatsink.current ? 0 : -1}
        columns={PRESET_COLUMNS}
        name={(c) => p.heatsinkNames[c.id] ?? c.id}
        describe={(c) => p.heatsinkDescriptions[c.id] ?? ''}
        numbers={() => p.heatsinkNumbers('1.5 mm', '2 mm', '10 mm')}
        preview={() => <FinsPreview />}
        icon={(c) => <Icon name={c.icon} />}
        header={header}
        onChoose={(c) => {
          setStep(c)
          return true
        }}
        step={
          step === undefined
            ? undefined
            : fins.step((args, tool) => {
                setOpen(false)
                setStep(undefined)
                heatsink.apply(args, tool)
              })
        }
        onApply={() => undefined}
        open={open}
        onOpenChange={openChange}
      />
    )
  return (
    <PresetsDialog
      title={p.presetsTitle}
      description={p.presetsDescription}
      closeLabel={p.presetsClose}
      currentLabel={p.presetCurrent}
      trigger={trigger}
      presets={PATTERN_PRESETS}
      current={current}
      columns={PRESET_COLUMNS}
      name={(preset) => p.presetNames[preset.id] ?? preset.id}
      describe={(preset) => p.presetDescriptions[preset.id] ?? ''}
      numbers={(preset) => presetNumbers(preset, p.presetWords)}
      preview={(preset) => (
        <PresetPreview cells={PREVIEWS.get(preset.id) ?? []} rings={RINGS.get(preset.id) ?? []} />
      )}
      header={header}
      onApply={onApply}
      open={open}
      onOpenChange={openChange}
    />
  )
}

/** The step's fields as entered (sources, so the user's units stay). */
interface StepValues {
  readonly fin: Quantity | undefined
  readonly slot: Quantity | undefined
  readonly height: Quantity | undefined
  readonly wall: Quantity | undefined
  /** Library item id; undefined: the largest flat end mill ≤ the slot. */
  readonly tool: string | undefined
}

const mmQ = (mm: number): Quantity | undefined => {
  const q = Quantity.parse(`${mm} mm`, { kind: 'length', defaultUnit: 'mm' })
  return q.isOk() ? q.unwrap() : undefined
}
const START: StepValues = {
  fin: mmQ(SAMPLE.fin),
  slot: mmQ(SAMPLE.slot),
  height: mmQ(SAMPLE.height),
  wall: mmQ(SAMPLE.wall),
  tool: undefined,
}

/**
 * The Straight fins parameter step (H1): its fields, the slot's tool, the live read-out and
 * warnings, and Back / Apply. Values persist while the dialog is open.
 */
function useStraightFinsStep(
  face: HeatsinkFace | undefined,
  units: UnitSystem,
  tools: readonly FlatEndMill[],
  onBack: () => void,
) {
  const [v, setV] = useState<StepValues>(START)
  const mm = (q: Quantity | undefined) => q?.canonical
  const slot = mm(v.slot)
  // the library's flat end mills that fit the slot (Q206), the largest first
  const fitting =
    slot === undefined ? [] : tools.filter((t) => t.diameter <= slot + 0.02 + 1e-9).reverse()
  const tool = fitting.find((t) => t.id === v.tool) ?? fitting[0]
  const sizes =
    face === undefined ||
    v.fin === undefined ||
    v.slot === undefined ||
    v.height === undefined ||
    v.wall === undefined
      ? undefined
      : {
          fin: v.fin.canonical,
          slot: v.slot.canonical,
          height: v.height.canonical,
          wall: v.wall.canonical,
          across: face.across,
          along: face.along,
          thickness: face.thickness,
        }
  const layout: StraightFinsLayout | undefined =
    sizes === undefined ? undefined : straightFins(sizes)
  const len = (x: number) => lengthSource(x, units)

  const field = (
    key: 'fin' | 'slot' | 'height' | 'wall',
    label: string,
    messages: FieldMessage[] = [],
  ) => (
    <div data-heatsink-field={key}>
      <QuantityInput
        label={label}
        kind="length"
        defaultUnit={defaultUnit('length', units)}
        value={v[key]}
        stepKind={key === 'height' ? 'depth' : 'small'}
        stepKey={`heatsink.${key}`}
        onCommit={(q) => setV((x) => ({ ...x, [key]: q }))}
        messages={messages}
      />
    </div>
  )
  const note = (id: string, text: string, severity: FieldMessage['severity'] = 'note') => ({
    id,
    severity,
    text,
  })
  const slotNotes: FieldMessage[] =
    tool === undefined || slot === undefined
      ? []
      : [note('cut', p.slotCut[slotCut(slot, tool.diameter, ALLOWANCE)] ?? '')]
  const height = mm(v.height)
  const short =
    tool?.fluteLength !== undefined && height !== undefined && height > tool.fluteLength + 1e-9
  const toolNotes: FieldMessage[] =
    tool === undefined
      ? [note('none', p.slotToolNone, 'soft')]
      : [
          ...(tool.fluteLength !== undefined && height !== undefined
            ? [
                note(
                  'flute',
                  p.fluteNote(len(height), len(tool.fluteLength), short),
                  short ? 'soft' : 'note',
                ),
              ]
            : []),
          note('chips', p.chipsNote),
        ]
  const tall = layout !== undefined && layout.ratio > 8
  const readout =
    layout === undefined || sizes === undefined
      ? p.noFit
      : [
          p.finsReadout(
            layout.slots,
            layout.fins,
            len(sizes.fin),
            len(sizes.height),
            layout.ratio,
            layout.base === undefined ? undefined : len(layout.base),
          ),
          p.finsWalls(len(layout.wall)),
        ].join(' · ')

  const step = (
    apply: (args: Record<string, unknown>, tool: string | undefined) => void,
  ): { content: React.ReactNode; footer: React.ReactNode; onBack: () => void } => ({
    content: (
      <div className={styles['heatsinkStep']} data-heatsink-step="straightFins">
        <div className={styles['heatsinkStepHead']}>
          <Icon name="fins-straight" />
          <span className={styles['presetName']}>{p.heatsinkNames['straightFins']}</span>
        </div>
        <div className={styles['heatsinkFields']}>
          {field('fin', p.fin, tall ? [note('tall', p.tallFins(layout.ratio), 'soft')] : [])}
          {field('slot', p.slot, slotNotes)}
          <div data-heatsink-field="tool">
            <Field label={p.slotTool} messages={toolNotes}>
              <Select
                options={fitting.map((t) => ({
                  value: t.id,
                  label: t.name,
                  icon: <Icon name="flat-end-mill" />,
                }))}
                value={tool?.id ?? ''}
                placeholder={p.slotToolNone}
                disabled={fitting.length === 0}
                onValueChange={(id) => setV((x) => ({ ...x, tool: id }))}
              />
            </Field>
          </div>
          {field('height', p.finHeight)}
          {field('wall', p.wall)}
        </div>
        <p className={styles['heatsinkReadout']} data-heatsink-readout>
          {readout}
        </p>
      </div>
    ),
    footer: (
      <>
        <Button onClick={onBack} data-heatsink-back>
          {p.back}
        </Button>
        <Button
          variant="primary"
          icon={<Icon name="heatsink" />}
          disabled={layout === undefined || sizes === undefined}
          data-heatsink-apply
          onClick={() => {
            if (layout === undefined || sizes === undefined) return
            apply(straightFinsArgs(sizes, layout), tool?.id)
          }}
        >
          {p.apply}
        </Button>
      </>
    ),
    onBack,
  })
  /** The step starts from the sample sizes each time the dialog opens. */
  const reset = () => setV(START)
  return { step, reset }
}

/**
 * The Straight fins card's preview: the top view (slots running out of the face's two sides)
 * over a section strip at scale, so the fin height against its thickness reads (pattern-presets.md
 * § UI). Drawn from the sample sizes.
 */
function FinsPreview(): React.JSX.Element {
  const l = straightFins(SAMPLE)!
  const s = 2.2 // px per mm: 40 mm across is 88 px
  const x0 = (PREVIEW.w - SAMPLE.across * s) / 2
  const slots = Array.from({ length: l.slots }, (_, i) => x0 + (l.wall + i * l.pitch) * s)
  const top = 6
  const topH = 34
  const base = PREVIEW.h - 6
  const r = (v: number) => Math.round(v * 10) / 10
  const plan = slots.map(
    (x) => `M${r(x)} ${top}h${r(SAMPLE.slot * s)}v${topH}h${-r(SAMPLE.slot * s)}Z`,
  )
  // the section: the block, cut down by each slot to the fin height
  const y1 = base - 14 * s
  let section = `M${r(x0)} ${r(base)}V${r(y1)}`
  for (const x of slots) {
    const d = r(y1 + SAMPLE.height * s)
    section += `H${r(x)}V${d}H${r(x + SAMPLE.slot * s)}V${r(y1)}`
  }
  section += `H${r(x0 + SAMPLE.across * s)}V${r(base)}Z`
  return (
    <svg
      className={styles['presetPreview']}
      viewBox={`0 0 ${PREVIEW.w} ${PREVIEW.h}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <rect
        className={styles['miniEdge']}
        x={r(x0)}
        y={top}
        width={r(SAMPLE.across * s)}
        height={topH}
        rx={1}
      />
      <path className={styles['miniFill']} d={plan.join('')} />
      <path className={styles['miniEdge']} d={plan.join('')} />
      <path className={styles['miniFill']} d={section} />
      <path className={styles['miniEdge']} d={section} />
    </svg>
  )
}
/**
 * A preset's preview: a window onto its lattice, drawn as the mini outlines at PREVIEW size; a
 * polar one over its faint ring guides (P10).
 */
function PresetPreview({
  cells,
  rings,
}: {
  cells: readonly (readonly (readonly [number, number])[])[]
  rings: readonly RingGuide[]
}): React.JSX.Element {
  const r = (v: number) => Math.round(v * 10) / 10
  const d = cells.map((c) => `M${c.map(([x, y]) => `${r(x)} ${r(y)}`).join('L')}Z`).join('')
  const mask = useId()
  return (
    <svg
      className={styles['presetPreview']}
      viewBox={`0 0 ${PREVIEW.w} ${PREVIEW.h}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {rings.length > 0 ? (
        <>
          {/* the guides only between the cells, never across a hole */}
          <mask id={mask}>
            <rect width={PREVIEW.w} height={PREVIEW.h} fill="white" />
            <path d={d} fill="black" />
          </mask>
          <g mask={`url(#${mask})`}>
            {rings.map((g) => (
              <circle
                key={g.r}
                className={styles['presetRing']}
                cx={r(g.cx)}
                cy={r(g.cy)}
                r={r(g.r)}
                data-ring=""
              />
            ))}
          </g>
        </>
      ) : null}
      <path className={styles['miniFill']} d={d} />
      <path className={styles['miniEdge']} d={d} />
    </svg>
  )
}
