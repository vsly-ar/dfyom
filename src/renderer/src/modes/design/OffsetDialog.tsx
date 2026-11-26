// "Offset…" (task U3): the dialog behind a shape row's "Offset…" (a new shape with one offset item
// of that row's shape) and the Shape Editor's "Add item" → "Offset…" (an offset item of another
// shape added to the edited one). Distance (length, project units) and Direction (Outward /
// Inward); in the Add item form also the Source, a closed named shape other than the edited one.
// The caller sends the command; a refusal (an inward offset that leaves nothing, a cycle) shows
// in the dialog, which stays open. Doc: docs/modes/design-llm-first.md#implementation-u3,
// docs/conventions/ui.md#shape-editor
import { useRef, useState } from 'react'
import type { OffsetDirection } from '../../../../core/design/shape.dto'
import { Quantity } from '../../../../core/quantity/quantity'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { shapeMessages } from '../../messages/shape'
import {
  Button,
  Dialog,
  ErrorMessage,
  Field,
  FieldIcon,
  Icon,
  QuantityInput,
  SegmentedControl,
  Select,
} from '../../ui'
import styles from './Design.module.css'
import { defaultUnit, type DesignPart } from './model'
import { useShapeList } from './useShapes'

const t = shapeMessages.offset

/** The offset item as `design.shape.add` / `update` take it (op: the default, add). */
export interface OffsetItemArgs {
  readonly kind: 'offset'
  readonly shapeId: string
  readonly distance: string
  readonly direction: OffsetDirection
}

/** Undefined: done (the dialog closes); else the refusal to show. */
export type OffsetSubmit = (item: OffsetItemArgs) => Promise<AppErrorData | undefined>

export interface OffsetDialogProps {
  readonly part: DesignPart
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** A shape row's "Offset…": the source is this shape and the result a new shape. */
  readonly source?: string
  /** "Add item" → "Offset…": the item joins this shape; the source is chosen here. */
  readonly target?: string
  readonly onSubmit: OffsetSubmit
  /** The gallery shows the dialog inline. */
  readonly modal?: boolean
}

/** A starting distance: 2 mm, 0.1 in. */
const startDistance = (units: DesignPart['units']): string => (units === 'mm' ? '2' : '0.1')

export function OffsetDialog(props: OffsetDialogProps): React.JSX.Element {
  // a fresh form per opening: the dialog's state does not outlive it
  return props.open ? <OffsetForm {...props} /> : <></>
}

function OffsetForm({
  part,
  open,
  onOpenChange,
  source,
  target,
  onSubmit,
  modal = true,
}: OffsetDialogProps): React.JSX.Element {
  const rows = useShapeList(part)
  // closed shapes that resolve, other than the edited one (open paths: offsetOpenPath)
  const sources = rows.filter((r) => r.kind === 'region' && r.id !== target)
  const unit = defaultUnit('length', part.units)
  const parse = (text: string) => Quantity.parse(text, { kind: 'length', defaultUnit: unit })
  const [distance, setDistance] = useState(() => parse(startDistance(part.units)).unwrap())
  // the latest committed value, for a click that follows the field's blur commit
  const latest = useRef(distance)
  const [direction, setDirection] = useState<OffsetDirection>('outward')
  // the row list loads after the dialog opens: the first source until one is chosen
  const [picked, setChosen] = useState<string | undefined>(source)
  const chosen = picked ?? sources[0]?.id
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const name = (id: string | undefined) =>
    part.dto.shapes?.find((s) => s.id === id)?.name ?? id ?? ''

  const submit = async () => {
    if (chosen === undefined || busy) return
    setBusy(true)
    const refused = await onSubmit({
      kind: 'offset',
      shapeId: chosen,
      distance: latest.current.source,
      direction,
    })
    setBusy(false)
    if (refused === undefined) onOpenChange(false)
    else setError(refused)
  }

  const item = target !== undefined
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      modal={modal}
      title={item ? t.titleItem(name(target)) : t.title(name(source))}
      description={item ? t.descriptionItem : t.description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t.cancel}</Button>
          <Button
            variant="primary"
            icon={<Icon name="kind-offset" />}
            disabled={chosen === undefined || busy}
            onClick={() => void submit()}
          >
            {item ? t.add : t.create}
          </Button>
        </>
      }
    >
      <div className={styles['offsetForm']}>
        {error ? <ErrorMessage error={error} message={t.refused} /> : null}
        {item ? (
          sources.length === 0 ? (
            <p className={styles['setupEmpty']}>{t.noSources}</p>
          ) : (
            <Field label={t.source}>
              <Select
                id="offset-source"
                options={sources.map((r) => ({ value: r.id, label: r.name }))}
                {...(chosen === undefined ? {} : { value: chosen })}
                onValueChange={(id) => {
                  setChosen(id)
                  setError(undefined)
                }}
              />
            </Field>
          )
        ) : null}
        <QuantityInput
          label={t.distance}
          kind="length"
          defaultUnit={unit}
          value={distance}
          stepKind="small"
          stepKey="shape.offset.distance"
          illustration={<FieldIcon name="offsetDistance" />}
          onCommit={(q) => {
            latest.current = q
            setDistance(q)
            setError(undefined)
          }}
        />
        <Field label={t.direction} kind="toggle">
          <SegmentedControl
            label={t.direction}
            size="sm"
            options={[
              { value: 'outward', label: t.outward },
              { value: 'inward', label: t.inward },
            ]}
            value={direction}
            onValueChange={(d) => {
              setDirection(d)
              setError(undefined)
            }}
          />
        </Field>
      </div>
    </Dialog>
  )
}
