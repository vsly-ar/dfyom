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
// H2: the Square, Round and Staggered pin-fin cards and their step (pin size, channel with the
// library's flat end mills ≤ it and the Ø + 0.5 mm suggestion, pin height); the current heatsink
// card's step starts from the pattern's own sizes.
// Doc: docs/modes/patterns.md#presets-dialog-and-more-presets-df107, docs/conventions/ui.md#pattern-inspector-p1,
// docs/modes/pattern-presets.md#ui, docs/modes/pattern-presets.md#implementation-h2
import { useEffect, useId, useState } from 'react'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import {
  channelCut,
  pinCentres,
  pinFins,
  pinFinsArgs,
  slotCut,
  straightFins,
  straightFinsArgs,
  suggestedChannel,
  type PinFinsLayout,
  type PinKind,
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
  type IconName,
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

/** The heatsink cards (H1: Straight fins; H2: the three pin fins; H3 adds radial). */
export type HeatsinkId = 'straightFins' | 'squarePins' | 'roundPins' | 'staggeredPins'
interface HeatsinkCard {
  readonly id: HeatsinkId
  readonly icon: IconName
}
const HEATSINK: readonly HeatsinkCard[] = [
  { id: 'straightFins', icon: 'fins-straight' },
  { id: 'squarePins', icon: 'pins-square' },
  { id: 'roundPins', icon: 'pins-round' },
  { id: 'staggeredPins', icon: 'pins-staggered' },
]
/** The pin kind of a pin card. */
const PIN_KIND: Readonly<Record<HeatsinkId, PinKind | undefined>> = {
  straightFins: undefined,
  squarePins: 'square',
  roundPins: 'round',
  staggeredPins: 'staggered',
}
/** The card of a pin kind (the inspector's current card). */
export const PIN_CARD: Readonly<Record<PinKind, HeatsinkId>> = {
  square: 'squarePins',
  round: 'roundPins',
  staggered: 'staggeredPins',
}

/** The straight-fins card's sample numbers (the user's heatsink, mm). */
const SAMPLE = { fin: 1.5, slot: 2, height: 10, wall: 1.5, across: 40, along: 40 }
/** The pin cards' sample numbers (the doc's worked example, mm). */
const PIN_SAMPLE = { pin: 3, channel: 2.5, height: 8, across: 40, along: 40 }

/** The pocket's default finishing allowance (plan strategy, mm): the step's slot note. */
const ALLOWANCE = 0.2

/** The face and stock the step lays out on (mm). */
export interface HeatsinkFace {
  readonly across: number
  readonly along: number
  /** Material under the face; undefined: no base in the read-out. */
  readonly thickness: number | undefined
}

/**
 * The heatsink card the pattern already is, with its sizes in the step's terms (mm): straight
 * fins `fin`, `slot`, `height`, `wall`; pins `pin`, `channel`, `height`. Its step starts from them.
 */
export interface CurrentHeatsink {
  readonly id: HeatsinkId
  readonly values: Readonly<Record<string, number>>
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
        /** The heatsink card the pattern is (the dialog opens on Heatsink, its step pre-filled). */
        readonly current: CurrentHeatsink | undefined
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
  const currentHeatsink = heatsink?.current
  const opening: Group =
    currentHeatsink !== undefined
      ? 'heatsink'
      : current >= 0
        ? 'decorative'
        : (remembered ?? 'decorative')
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState<Group>(opening)
  const [step, setStep] = useState<HeatsinkCard | undefined>(undefined)
  const fins = useStraightFinsStep(
    heatsink?.face,
    heatsink?.units ?? 'mm',
    heatsink?.tools ?? [],
    () => setStep(undefined),
  )
  const pins = usePinFinsStep(heatsink?.face, heatsink?.units ?? 'mm', heatsink?.tools ?? [], () =>
    setStep(undefined),
  )
  const openChange = (o: boolean) => {
    if (o) {
      setGroup(opening)
      // each step starts from the sample sizes, or the current heatsink's own (H2)
      const values = currentHeatsink?.values
      fins.reset(currentHeatsink?.id === 'straightFins' ? values : undefined)
      pins.reset(
        currentHeatsink !== undefined && PIN_KIND[currentHeatsink.id] !== undefined
          ? values
          : undefined,
      )
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

  if (group === 'heatsink' && heatsink !== undefined) {
    const applied = (args: Record<string, unknown>, tool: string | undefined) => {
      setOpen(false)
      setStep(undefined)
      heatsink.apply(args, tool)
    }
    const stepKind = step === undefined ? undefined : PIN_KIND[step.id]
    return (
      <PresetsDialog<HeatsinkCard>
        title={p.presetsTitle}
        description={p.heatsinkDescription}
        closeLabel={p.presetsClose}
        currentLabel={p.presetCurrent}
        trigger={trigger}
        presets={HEATSINK}
        current={HEATSINK.findIndex((c) => c.id === currentHeatsink?.id)}
        columns={PRESET_COLUMNS}
        name={(c) => p.heatsinkNames[c.id] ?? c.id}
        describe={(c) => p.heatsinkDescriptions[c.id] ?? ''}
        numbers={(c) =>
          PIN_KIND[c.id] === undefined
            ? p.heatsinkNumbers('1.5 mm', '2 mm', '10 mm')
            : p.pinNumbers(PIN_KIND[c.id] === 'square' ? '3 mm' : 'Ø 3 mm', '2.5 mm', '8 mm')
        }
        preview={(c) => {
          const kind = PIN_KIND[c.id]
          return kind === undefined ? <FinsPreview /> : <PinsPreview kind={kind} />
        }}
        icon={(c) => <Icon name={c.icon} />}
        header={header}
        onChoose={(c) => {
          setStep(c)
          return true
        }}
        step={
          step === undefined
            ? undefined
            : stepKind === undefined
              ? fins.step(applied)
              : pins.step(stepKind, step, applied)
        }
        onApply={() => undefined}
        open={open}
        onOpenChange={openChange}
      />
    )
  }
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

const mmQ = (mm: number): Quantity | undefined => {
  const q = Quantity.parse(`${Math.round(mm * 1e6) / 1e6} mm`, {
    kind: 'length',
    defaultUnit: 'mm',
  })
  return q.isOk() ? q.unwrap() : undefined
}
/** A step's sizes as quantities: `values` (mm) where given, else the sample's. */
function startFrom<K extends string>(
  keys: readonly K[],
  sample: Readonly<Record<K, number>>,
  values: Readonly<Record<string, number>> | undefined,
): Record<K, Quantity | undefined> {
  const out = {} as Record<K, Quantity | undefined>
  for (const k of keys) out[k] = mmQ(values?.[k] ?? sample[k])
  return out
}
const note = (id: string, text: string, severity: FieldMessage['severity'] = 'note') => ({
  id,
  severity,
  text,
})

/** The library's flat end mills that fit a slot or channel (Q206), the largest first. */
const fittingTools = (tools: readonly FlatEndMill[], width: number | undefined) =>
  width === undefined ? [] : tools.filter((t) => t.diameter <= width + 0.02 + 1e-9).reverse()

/** The step's Tool field: the fitting flat end mills, with notes. */
function ToolSelect({
  fitting,
  tool,
  none,
  messages,
  onChange,
}: {
  fitting: readonly FlatEndMill[]
  tool: FlatEndMill | undefined
  none: string
  messages: FieldMessage[]
  onChange: (id: string) => void
}): React.JSX.Element {
  return (
    <div data-heatsink-field="tool">
      <Field label={p.slotTool} messages={messages}>
        <Select
          options={fitting.map((t) => ({
            value: t.id,
            label: t.name,
            icon: <Icon name="flat-end-mill" />,
          }))}
          value={tool?.id ?? ''}
          placeholder={none}
          disabled={fitting.length === 0}
          onValueChange={onChange}
        />
      </Field>
    </div>
  )
}

/** A step's length field (the user's units; `stepKey` remembers the adjust step). */
function StepField({
  name,
  label,
  value,
  units,
  depth,
  messages = [],
  onCommit,
}: {
  name: string
  label: string
  value: Quantity | undefined
  units: UnitSystem
  depth: boolean
  messages?: FieldMessage[]
  onCommit: (q: Quantity) => void
}): React.JSX.Element {
  return (
    <div data-heatsink-field={name}>
      <QuantityInput
        label={label}
        kind="length"
        defaultUnit={defaultUnit('length', units)}
        value={value}
        stepKind={depth ? 'depth' : 'small'}
        stepKey={`heatsink.${name}`}
        onCommit={onCommit}
        messages={messages}
      />
    </div>
  )
}

/** A step's body: its card's icon and name, the fields, the live read-out. */
function StepBody({
  card,
  name,
  fields,
  readout,
}: {
  card: HeatsinkCard
  name: string
  fields: React.ReactNode
  readout: string
}): React.JSX.Element {
  return (
    <div className={styles['heatsinkStep']} data-heatsink-step={card.id}>
      <div className={styles['heatsinkStepHead']}>
        <Icon name={card.icon} />
        <span className={styles['presetName']}>{name}</span>
      </div>
      <div className={styles['heatsinkFields']}>{fields}</div>
      <p className={styles['heatsinkReadout']} data-heatsink-readout>
        {readout}
      </p>
    </div>
  )
}

/** A step's footer: Back and Apply. */
function stepFooter(onBack: () => void, disabled: boolean, onApply: () => void): React.ReactNode {
  return (
    <>
      <Button onClick={onBack} data-heatsink-back>
        {p.back}
      </Button>
      <Button
        variant="primary"
        icon={<Icon name="heatsink" />}
        disabled={disabled}
        data-heatsink-apply
        onClick={onApply}
      >
        {p.apply}
      </Button>
    </>
  )
}

type StepResult = { content: React.ReactNode; footer: React.ReactNode; onBack: () => void }
type ApplyFn = (args: Record<string, unknown>, tool: string | undefined) => void

const FIN_KEYS = ['fin', 'slot', 'height', 'wall'] as const
type FinValues = Record<(typeof FIN_KEYS)[number], Quantity | undefined> & {
  /** Library item id; undefined: the largest flat end mill ≤ the slot. */
  readonly tool: string | undefined
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
  const start = (values?: Readonly<Record<string, number>>): FinValues => ({
    ...startFrom(FIN_KEYS, SAMPLE, values),
    tool: undefined,
  })
  const [v, setV] = useState<FinValues>(() => start())
  const slot = v.slot?.canonical
  const fitting = fittingTools(tools, slot)
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

  const field = (key: (typeof FIN_KEYS)[number], label: string, messages: FieldMessage[] = []) => (
    <StepField
      name={key}
      label={label}
      value={v[key]}
      units={units}
      depth={key === 'height'}
      messages={messages}
      onCommit={(q) => setV((x) => ({ ...x, [key]: q }))}
    />
  )
  const slotNotes: FieldMessage[] =
    tool === undefined || slot === undefined
      ? []
      : [note('cut', p.slotCut[slotCut(slot, tool.diameter, ALLOWANCE)] ?? '')]
  const height = v.height?.canonical
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

  const step = (apply: ApplyFn): StepResult => ({
    content: (
      <StepBody
        card={HEATSINK[0]!}
        name={p.heatsinkNames['straightFins'] ?? ''}
        readout={readout}
        fields={
          <>
            {field('fin', p.fin, tall ? [note('tall', p.tallFins(layout.ratio), 'soft')] : [])}
            {field('slot', p.slot, slotNotes)}
            <ToolSelect
              fitting={fitting}
              tool={tool}
              none={p.slotToolNone}
              messages={toolNotes}
              onChange={(id) => setV((x) => ({ ...x, tool: id }))}
            />
            {field('height', p.finHeight)}
            {field('wall', p.wall)}
          </>
        }
      />
    ),
    footer: stepFooter(onBack, layout === undefined || sizes === undefined, () => {
      if (layout === undefined || sizes === undefined) return
      apply(straightFinsArgs(sizes, layout), tool?.id)
    }),
    onBack,
  })
  /** The step starts from the sample sizes (or the pattern's own) each time the dialog opens. */
  const reset = (values?: Readonly<Record<string, number>>) => setV(start(values))
  return { step, reset }
}

const PIN_KEYS = ['pin', 'channel', 'height'] as const
type PinValues = Record<(typeof PIN_KEYS)[number], Quantity | undefined> & {
  /** Library item id; undefined: the largest flat end mill ≤ the channel. */
  readonly tool: string | undefined
}

/**
 * The pin-fin parameter step (H2), shared by the three pin cards: pin size (round: diameter),
 * channel with its tool and the Ø + 0.5 mm suggestion (§ DFM Pins), pin height, the live read-out
 * and warnings, Back / Apply. Margin 0: the channels open at every edge. Values persist while the
 * dialog is open (across the three pin cards).
 */
function usePinFinsStep(
  face: HeatsinkFace | undefined,
  units: UnitSystem,
  tools: readonly FlatEndMill[],
  onBack: () => void,
) {
  const start = (values?: Readonly<Record<string, number>>): PinValues => ({
    ...startFrom(PIN_KEYS, PIN_SAMPLE, values),
    tool: undefined,
  })
  const [v, setV] = useState<PinValues>(() => start())
  const len = (x: number) => lengthSource(x, units)

  const step = (kind: PinKind, card: HeatsinkCard, apply: ApplyFn): StepResult => {
    const channel = v.channel?.canonical
    const fitting = fittingTools(tools, channel)
    const tool = fitting.find((t) => t.id === v.tool) ?? fitting[0]
    const sizes =
      face === undefined || v.pin === undefined || channel === undefined || v.height === undefined
        ? undefined
        : {
            kind,
            pin: v.pin.canonical,
            channel,
            height: v.height.canonical,
            across: face.across,
            along: face.along,
            thickness: face.thickness,
          }
    const layout: PinFinsLayout | undefined = sizes === undefined ? undefined : pinFins(sizes)
    const field = (
      key: (typeof PIN_KEYS)[number],
      label: string,
      messages: FieldMessage[] = [],
    ) => (
      <StepField
        name={key}
        label={label}
        value={v[key]}
        units={units}
        depth={key === 'height'}
        messages={messages}
        onCommit={(q) => setV((x) => ({ ...x, [key]: q }))}
      />
    )
    // § DFM Pins: a channel narrower than Ø + 0.5 mm gets the suggestion as its fix
    const suggested = tool === undefined ? undefined : suggestedChannel(tool.diameter)
    const cut =
      tool === undefined || channel === undefined
        ? undefined
        : channelCut(channel, tool.diameter, ALLOWANCE)
    const suggest =
      suggested !== undefined &&
      channel !== undefined &&
      cut !== 'tooWide' &&
      channel < suggested - 1e-9
    const channelNotes: FieldMessage[] =
      cut === undefined
        ? []
        : [
            {
              ...note('cut', p.channelCut[cut] ?? ''),
              ...(suggest
                ? {
                    fix: {
                      label: p.useChannel(len(suggested)),
                      onApply: () => setV((x) => ({ ...x, channel: mmQ(suggested) })),
                    },
                  }
                : {}),
            },
          ]
    const height = v.height?.canonical
    const short =
      tool?.fluteLength !== undefined && height !== undefined && height > tool.fluteLength + 1e-9
    const toolNotes: FieldMessage[] =
      tool === undefined
        ? [note('none', p.channelToolNone, 'soft')]
        : [
            ...(tool.fluteLength !== undefined && height !== undefined
              ? [
                  note(
                    'flute',
                    p.pinFluteNote(len(height), len(tool.fluteLength), short),
                    short ? 'soft' : 'note',
                  ),
                ]
              : []),
            note('chips', p.pinChipsNote),
          ]
    const tall = layout !== undefined && layout.ratio > 8
    const readout =
      layout === undefined || sizes === undefined
        ? p.noPinFit
        : [
            p.pinsReadout(
              layout.pins,
              len(sizes.pin),
              kind !== 'square',
              len(sizes.height),
              layout.ratio,
              layout.base === undefined ? undefined : len(layout.base),
            ),
            p.pinsChannels(len(sizes.channel), len(layout.border)),
          ].join(' · ')
    return {
      content: (
        <StepBody
          card={card}
          name={p.heatsinkNames[card.id] ?? ''}
          readout={readout}
          fields={
            <>
              {field(
                'pin',
                kind === 'square' ? p.pinSize : p.pinDiameter,
                tall ? [note('tall', p.tallPins(layout.ratio), 'soft')] : [],
              )}
              {field('channel', p.channel, channelNotes)}
              <ToolSelect
                fitting={fitting}
                tool={tool}
                none={p.channelToolNone}
                messages={toolNotes}
                onChange={(id) => setV((x) => ({ ...x, tool: id }))}
              />
              {field('height', p.pinHeight)}
            </>
          }
        />
      ),
      footer: stepFooter(onBack, layout === undefined || sizes === undefined, () => {
        if (layout === undefined || sizes === undefined) return
        apply(pinFinsArgs(sizes, layout), tool?.id)
      }),
      onBack,
    }
  }
  /** The step starts from the sample sizes (or the pattern's own) each time the dialog opens. */
  const reset = (values?: Readonly<Record<string, number>>) => setV(start(values))
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
 * A pin card's preview (H2): a window onto the top view at scale (the cut channels shaded, the
 * pins standing), over a section through the middle row, so the pin height against its size reads.
 * Drawn from the sample sizes.
 */
function PinsPreview({ kind }: { kind: PinKind }): React.JSX.Element {
  const step = { kind, ...PIN_SAMPLE }
  const l = pinFins(step)!
  const centres = pinCentres(step, l)
  const s = 2.2 // px per mm: 40 mm across is 88 px
  const x0 = (PREVIEW.w - PIN_SAMPLE.across * s) / 2
  const top = 6
  const topH = 34
  const base = PREVIEW.h - 6
  const r = (v: number) => Math.round(v * 10) / 10
  const half = PIN_SAMPLE.pin / 2
  // the window: the face's middle band, topH px high
  const v0 = PIN_SAMPLE.along / 2 - topH / s / 2
  const v1 = PIN_SAMPLE.along / 2 + topH / s / 2
  const shown = centres.filter(([, v]) => v - half >= v0 - 1e-9 && v + half <= v1 + 1e-9)
  const px = (u: number) => x0 + u * s
  const py = (v: number) => top + (v - v0) * s
  const pin = ([u, v]: readonly [number, number]) =>
    kind === 'square'
      ? `M${r(px(u - half))} ${r(py(v - half))}h${r(2 * half * s)}v${r(2 * half * s)}h${-r(2 * half * s)}Z`
      : `M${r(px(u - half))} ${r(py(v))}a${r(half * s)} ${r(half * s)} 0 1 0 ${r(2 * half * s)} 0a${r(half * s)} ${r(half * s)} 0 1 0 ${-r(2 * half * s)} 0Z`
  const pins = shown.map(pin).join('')
  const band = `M${r(x0)} ${top}h${r(PIN_SAMPLE.across * s)}v${topH}h${-r(PIN_SAMPLE.across * s)}Z`
  // the section through the row nearest the middle: pins stand on the floor at the pin height
  const mid = PIN_SAMPLE.along / 2
  const rowV = centres.reduce((b, c) => (Math.abs(c[1] - mid) < Math.abs(b - mid) ? c[1] : b), 1e9)
  const row = centres.filter((c) => Math.abs(c[1] - rowV) < 1e-6).sort((a, b) => a[0] - b[0])
  const y1 = base - 14 * s
  const floor = r(y1 + PIN_SAMPLE.height * s)
  let section = `M${r(x0)} ${r(base)}V${floor}`
  for (const [u] of row) section += `H${r(px(u - half))}V${r(y1)}H${r(px(u + half))}V${floor}`
  section += `H${r(x0 + PIN_SAMPLE.across * s)}V${r(base)}Z`
  return (
    <svg
      className={styles['presetPreview']}
      viewBox={`0 0 ${PREVIEW.w} ${PREVIEW.h}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {/* the cut floor shaded, the pins left as stock (even-odd) */}
      <path className={styles['miniFill']} d={band + pins} fillRule="evenodd" />
      <path className={styles['miniEdge']} d={band} />
      <path className={styles['miniEdge']} d={pins} />
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
