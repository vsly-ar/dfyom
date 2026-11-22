// Stock setup for the part (task 3.6): a project without a part picks its stock – a block from
// the stock library or a new block (added to the library first) – and creates the part from it
// (`design.part.add` takes a snapshot of the stock, design.md#part-and-stock-v01).
// Doc: docs/modes/design.md#workflow, docs/architecture/library.md#stock
import { Box } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { MATERIAL_CLASSES, type MaterialClass } from '../../../../core/library/item'
import type { StockValuesDTO } from '../../../../core/library/stock.dto'
import type { UnitSystem } from '../../../../core/project/document'
import { Quantity } from '../../../../core/quantity/quantity'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { issuesAt, unmatchedIssues } from '../../library/form'
import { issueMessages } from '../../library/LibraryForm'
import { LibraryLink } from '../../library/LibraryLink'
import { designMessages } from '../../messages/design'
import { libraryMessages } from '../../messages/library'
import { useLibraryVersion } from '../../shell/ShellContext'
import {
  ApplyScope,
  Button,
  ErrorMessage,
  Field,
  FieldIcon,
  FieldInput,
  QuantityInput,
  SegmentedControl,
  Select,
} from '../../ui'
import styles from './Design.module.css'
import { defaultUnit } from './model'
import { useCommand } from './useDesign'

const m = designMessages.stock

const DEFAULT_SIZE: Record<UnitSystem, [string, string, string]> = {
  mm: ['100', '60', '20'],
  inch: ['4', '2 1/2', '3/4'],
}

type LibraryStock = StockValuesDTO & { id: string }

/** The stock values the size fields edit (issue paths of `library.stock.add`). */
const SIZE_FIELDS = ['length', 'width', 'thickness'] as const

function parseLength(source: string, units: UnitSystem): Quantity {
  return Quantity.parse(source, { kind: 'length', defaultUnit: defaultUnit('length', units) })
    .ok()
    .unwrap()
}

export function StockSetup({ units }: { units: UnitSystem }): React.JSX.Element {
  const call = useCommand()
  const [partName, setPartName] = useState<string>(m.defaultPartName)
  const [library, setLibrary] = useState<readonly LibraryStock[]>([])
  const [source, setSource] = useState<'new' | 'library'>('new')
  const [itemId, setItemId] = useState<string | undefined>(undefined)
  const [size, setSize] = useState(() => DEFAULT_SIZE[units].map((s) => parseLength(s, units)))
  const [material, setMaterial] = useState('6061-T6')
  const [materialClass, setMaterialClass] = useState<MaterialClass>('aluminum')
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState(0)
  const section = useRef<HTMLElement>(null)
  const titleId = useId()
  // re-read when the library changes (the Library window, an agent)
  const libraryVersion = useLibraryVersion()

  useEffect(() => {
    let live = true
    void call('library.stock.list', {}).then((r) => {
      if (!live || !r.ok) return
      const items = ((r.value as { items: LibraryStock[] }).items ?? []).filter(
        (i) => i.shape === 'block',
      )
      setLibrary(items)
      if (items[0] !== undefined) setItemId((id) => id ?? items[0]!.id)
    })
    return () => {
      live = false
    }
  }, [call, libraryVersion])

  const create = async () => {
    setBusy(true)
    setError(undefined)
    let stockId = itemId
    if (source === 'new') {
      const [l, w, t] = size as [Quantity, Quantity, Quantity]
      const added = await call('library.stock.add', {
        values: {
          name: m.defaultName(l.source, w.source, t.source),
          shape: 'block',
          length: l.source,
          width: w.source,
          thickness: t.source,
          material: { name: material.trim() || m.classes[materialClass], class: materialClass },
        },
        units, // bare numbers as the fields read them (library.md#command-input)
      })
      if (!added.ok) {
        setBusy(false)
        setError(added.error)
        setFailures((n) => n + 1)
        return
      }
      stockId = (added.value as { id: string }).id
    }
    if (stockId === undefined) {
      setBusy(false)
      return
    }
    const r = await call('design.part.add', {
      name: partName.trim() || m.defaultPartName,
      stockLibraryItemId: stockId,
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      setFailures((n) => n + 1)
    }
  }

  // after a failed Create, focus the first field it marked (ui.md#errors)
  useEffect(() => {
    if (failures > 0) section.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [failures])

  // a failed add shows its issues at the size fields (ui.md#errors), the rest above Create
  const issues = error?.issues ?? []
  const summary =
    error === undefined
      ? undefined
      : issues.length === 0
        ? error
        : (() => {
            const rest = unmatchedIssues(issues, SIZE_FIELDS)
            return rest.length > 0 ? { ...error, issues: rest } : undefined
          })()
  const sizeField = (i: 0 | 1 | 2, label: string, icon: 'length' | 'width' | 'depth') => (
    <QuantityInput
      label={label}
      kind="length"
      defaultUnit={defaultUnit('length', units)}
      value={size[i]}
      illustration={<FieldIcon name={icon} />}
      messages={issueMessages(issues, SIZE_FIELDS[i])}
      onCommit={(q) => {
        setSize((s) => s.map((v, j) => (j === i ? q : v)))
        // the edited field's issue is stale now; the others stay until the next Create
        setError((e) => {
          if (e === undefined || e.issues.length === 0) return e
          const left = e.issues.filter((x) => issuesAt([x], SIZE_FIELDS[i]).length === 0)
          return left.length === 0 ? undefined : { ...e, issues: left }
        })
      }}
    />
  )

  return (
    // not a <form>: Enter in a field commits that field (QuantityInput), it does not submit; local
    // form state, so Enter never applies (apply.md#keyboard)
    <ApplyScope onApply={null}>
      <section ref={section} className={styles['setup']} aria-labelledby={titleId}>
        <h2 id={titleId} className={styles['setupTitle']}>
          {m.setupTitle}
        </h2>
        <p className={styles['muted']}>{m.setupDescription}</p>
        <Field label={m.partName}>
          <FieldInput value={partName} onChange={(e) => setPartName(e.target.value)} />
        </Field>
        <div className={styles['choice']}>
          <span className={styles['caption']} aria-hidden="true">
            {m.source}
          </span>
          <SegmentedControl<'new' | 'library'>
            label={m.source}
            options={[
              { value: 'new', label: m.newStock },
              { value: 'library', label: m.fromLibrary, disabled: library.length === 0 },
            ]}
            value={source}
            onValueChange={setSource}
          />
        </div>
        {source === 'library' ? (
          <>
            <Field label={m.libraryItem}>
              <Select
                options={library.map((i) => ({ value: i.id, label: i.name }))}
                value={itemId ?? ''}
                onValueChange={setItemId}
              />
            </Field>
            <div>
              <LibraryLink
                target={{ kind: 'stock', ...(itemId === undefined ? {} : { itemId }) }}
                label={libraryMessages.links.open}
              />
            </div>
          </>
        ) : (
          <>
            {sizeField(0, m.length, 'length')}
            {sizeField(1, m.width, 'width')}
            {sizeField(2, m.thickness, 'depth')}
            <Field label={m.materialName}>
              <FieldInput value={material} onChange={(e) => setMaterial(e.target.value)} />
            </Field>
            <Field label={m.materialClass}>
              <Select<MaterialClass>
                options={MATERIAL_CLASSES.map((c) => ({ value: c, label: m.classes[c] }))}
                value={materialClass}
                onValueChange={setMaterialClass}
              />
            </Field>
          </>
        )}
        {source !== 'library' ? (
          <div>
            <LibraryLink target={{ kind: 'stock' }} />
          </div>
        ) : null}
        {summary !== undefined ? <ErrorMessage error={summary} /> : null}
        <Button
          variant="primary"
          onClick={() => void create()}
          icon={<Box aria-hidden="true" />}
          disabled={busy || (source === 'library' && itemId === undefined)}
        >
          {m.create}
        </Button>
      </section>
    </ApplyScope>
  )
}
