// Stock setup for the part (task 3.6): a project without a part picks its stock – a block from
// the stock library or a new block (added to the library first) – and creates the part from it
// (`design.part.add` takes a snapshot of the stock, design.md#part-and-stock-v01).
// Doc: docs/modes/design.md#workflow, docs/architecture/library.md#stock
import { Box } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { MATERIAL_CLASSES, type MaterialClass } from '../../../../core/library/item'
import type { StockValuesDTO } from '../../../../core/library/stock.dto'
import type { UnitSystem } from '../../../../core/project/document'
import { Quantity } from '../../../../core/quantity/quantity'
import type { AppErrorData } from '../../../../shared/errors/app-error'
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
    if (!r.ok) setError(r.error)
  }

  const sizeField = (i: 0 | 1 | 2, label: string, icon: 'length' | 'width' | 'depth') => (
    <QuantityInput
      label={label}
      kind="length"
      defaultUnit={defaultUnit('length', units)}
      value={size[i]}
      illustration={<FieldIcon name={icon} />}
      onCommit={(q) => setSize((s) => s.map((v, j) => (j === i ? q : v)))}
    />
  )

  return (
    // not a <form>: Enter in a field commits that field (QuantityInput), it does not submit; local
    // form state, so Enter never applies (apply.md#keyboard)
    <ApplyScope onApply={null}>
      <section className={styles['setup']} aria-labelledby={titleId}>
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
        {error !== undefined ? <ErrorMessage error={error} /> : null}
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
