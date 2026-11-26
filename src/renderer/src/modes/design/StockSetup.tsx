// Stock setup for the part (task 3.6; one screen since dogfood DF11–DF13): the part name (the
// project name + " 1"), an optional library stock that fills the block's fields (sizes stay
// editable: the part is cut from a piece of it; its material is shown locked), the block's size
// and material, "Save to library" (add, or for a changed library stock: update it or save a
// variant of it) and "Create part" (`design.part.add`: a linked copy of an unchanged library
// stock, else the project's own block; nothing is added to the library by itself). Since D45 the
// Stock dialog without a part: it renders the whole dialog (the caller titles and describes it),
// so "Create part" sits beside Cancel in the footer (dialog actions, DF12 re-report);
// `onCreated` closes the dialog. Since DF95 the same form edits the stock of an existing part
// (`edit`): it starts from the part's copy, and "Update stock" sends `design.part.update` with the
// new stock (one undo step; operations that no longer fit show as warnings). Since DF96 a block's
// automatic name is its material class (not Other) and material, then its size. Since DF110 (S6)
// the sizes and the material are the groups Size and Material (inspector-layout.md).
// Doc: docs/conventions/ui.md#stock-dialog-df11df13, docs/modes/design.md#workflow,
// docs/architecture/library.md#stock-variants-df13, docs/conventions/ui.md#radix-wrapping-pattern
import { useEffect, useRef, useState } from 'react'
import { MATERIAL_CLASSES, type MaterialClass } from '../../../../core/library/item'
import type { LibraryItemDTO } from '../../../../core/library/library-item'
import type { StockValuesDTO } from '../../../../core/library/stock.dto'
import type { UnitSystem } from '../../../../core/project/document'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import { Quantity } from '../../../../core/quantity/quantity'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { displayQuantity, issuesAt, unmatchedIssues } from '../../library/form'
import { issueMessages } from '../../library/LibraryForm'
import { LibraryLink } from '../../library/LibraryLink'
import { designMessages } from '../../messages/design'
import { libraryMessages } from '../../messages/library'
import { useLibraryVersion } from '../../shell/ShellContext'
import {
  Icon,
  ApplyScope,
  Button,
  Dialog,
  DialogClose,
  type DialogProps,
  ErrorMessage,
  Field,
  FieldIcon,
  FieldInput,
  InspectorGroup,
  QuantityInput,
  Select,
  type SelectOption,
} from '../../ui'
import styles from './Design.module.css'
import { defaultUnit } from './model'
import { useCommand } from './useDesign'

const m = designMessages.stock

const DEFAULT_SIZE: Record<UnitSystem, [string, string, string]> = {
  mm: ['100', '60', '20'],
  inch: ['4', '2 1/2', '3/4'],
}

type LibraryStock = StockValuesDTO & { id: string; revision: number; parentId?: string }

/** The stock values the size fields edit (issue paths of `library.stock.*` and `stock.*`). */
const SIZE_FIELDS = ['length', 'width', 'thickness'] as const
const SIZE_ICONS = ['stock-length', 'stock-width', 'stock-thickness'] as const
/** The From library list's "Not selected" (Radix Select values must not be empty). */
const NONE = '\u0000none'

function parseLength(source: string, units: UnitSystem): Quantity {
  return Quantity.parse(source, { kind: 'length', defaultUnit: defaultUnit('length', units) })
    .ok()
    .unwrap()
}

/** Same value and tolerance (the source may differ: "100" and "100 mm" are the same size). */
function sameSize(q: Quantity, dto: QuantityDTO): boolean {
  const { exact, tolerance } = q.toDTO()
  return (
    JSON.stringify({ exact, tolerance }) ===
    JSON.stringify({ exact: dto.exact, tolerance: dto.tolerance })
  )
}

/** Roots by name, each followed by its variants; a variant without its parent counts as a root. */
export function stockOrder(items: readonly LibraryStock[]): LibraryStock[] {
  const ids = new Set(items.map((i) => i.id))
  const byName = (a: LibraryStock, b: LibraryStock) => a.name.localeCompare(b.name)
  const isRoot = (i: LibraryStock) => i.parentId === undefined || !ids.has(i.parentId)
  return [...items]
    .filter(isRoot)
    .sort(byName)
    .flatMap((r) => [r, ...items.filter((i) => !isRoot(i) && i.parentId === r.id).sort(byName)])
}

/** The stock of an existing part the form edits (DF95). */
export interface StockEdit {
  partId: string
  partName: string
  length: Quantity
  width: Quantity
  thickness: Quantity
  material: { name: string; class: MaterialClass }
  /** The library stock the part's copy was taken from, if any. */
  libraryItemId?: string
}

/** The dialog's own props (title, description, open state, focus return). */
type StockDialogProps = Pick<
  DialogProps,
  'title' | 'description' | 'open' | 'onOpenChange' | 'onCloseAutoFocus'
>

export function StockSetup({
  units,
  projectName,
  partName: initialName,
  onCreated,
  edit,
  onUpdated,
  dialog,
}: {
  units: UnitSystem
  /** The project's name: the part is named after it (DF12). */
  projectName: string
  /** The name field's start value (another part, split parts S0); default "<project> 1". */
  partName?: string
  /** The part was created. */
  onCreated?: (partId: string) => void
  /** Edit this part's stock instead of creating a part (DF95). */
  edit?: StockEdit
  /** The stock was updated (or nothing changed): close the dialog. */
  onUpdated?: () => void
  dialog: StockDialogProps
}): React.JSX.Element {
  const call = useCommand()
  const fallbackName = edit?.partName ?? initialName ?? m.firstPartName(projectName)
  const [partName, setPartName] = useState(fallbackName)
  const [library, setLibrary] = useState<readonly LibraryStock[]>([])
  const [itemId, setItemId] = useState<string | null>(edit?.libraryItemId ?? null)
  const [size, setSize] = useState(() =>
    edit !== undefined
      ? [edit.length, edit.width, edit.thickness]
      : DEFAULT_SIZE[units].map((s) => parseLength(s, units)),
  )
  // bumped when a library stock fills the fields, so the inputs show the new values
  const [fill, setFill] = useState(0)
  const [material, setMaterial] = useState(edit?.material.name ?? '6061-T6')
  const [materialClass, setMaterialClass] = useState<MaterialClass>(
    edit?.material.class ?? 'aluminum',
  )
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState(0)
  const [asking, setAsking] = useState(false)
  const section = useRef<HTMLElement>(null)
  // re-read when the library changes (the Library window, an agent, our own Save)
  const libraryVersion = useLibraryVersion()

  const reload = async (): Promise<readonly LibraryStock[]> => {
    const r = await call('library.stock.list', {})
    if (!r.ok) return library
    const items = ((r.value as { items: LibraryItemDTO[] }).items ?? []).filter(
      (i): i is LibraryItemDTO & { kind: 'stock' } => i.kind === 'stock' && i.shape === 'block',
    ) as LibraryStock[]
    return stockOrder(items)
  }

  useEffect(() => {
    let live = true
    void reload().then((items) => {
      if (live) setLibrary(items)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on library changes only
  }, [call, libraryVersion])

  const item = itemId === null ? undefined : library.find((i) => i.id === itemId)
  const parentOf = (i: LibraryStock) =>
    i.parentId === undefined ? undefined : library.find((p) => p.id === i.parentId)
  const changed =
    item !== undefined && SIZE_FIELDS.some((f, i) => !sameSize(size[i] as Quantity, item[f]))

  /** Fills the fields from a library stock (or keeps them for "Not selected"). */
  const choose = (id: string, items: readonly LibraryStock[] = library) => {
    const chosen = id === NONE ? undefined : items.find((i) => i.id === id)
    setItemId(chosen?.id ?? null)
    setError(undefined)
    if (chosen === undefined) return
    setSize((s) =>
      SIZE_FIELDS.map((f, i) => displayQuantity(chosen[f], units) ?? (s[i] as Quantity)),
    )
    setMaterial(chosen.material.name)
    setMaterialClass(chosen.material.class)
    setFill((n) => n + 1)
  }

  const [l, w, t] = size as [Quantity, Quantity, Quantity]
  const summary = m.summary(l.source, w.source, t.source)
  // DF96: "Aluminium 6061-T6 100 × 60 × 20", not "Block 100 × 60 × 20"
  const autoName = () => m.defaultName(m.classes[materialClass], materialClass, material, summary)
  /** The block's values as `library.stock.add` and `design.part.add { stock }` take them. */
  const blockValues = (name: string, notes?: string) => ({
    name,
    ...(notes === undefined ? {} : { notes }),
    shape: 'block' as const,
    length: l.source,
    width: w.source,
    thickness: t.source,
    material: { name: material.trim() || m.classes[materialClass], class: materialClass },
  })

  const failed = (e: AppErrorData) => {
    setError(e)
    setFailures((n) => n + 1)
  }

  const create = async () => {
    setBusy(true)
    setError(undefined)
    const name = partName.trim() || fallbackName
    const r = await call(
      'design.part.add',
      item !== undefined && !changed
        ? { name, stockLibraryItemId: item.id }
        : { name, stock: blockValues(autoName()) },
    )
    setBusy(false)
    if (!r.ok) return failed(r.error)
    onCreated?.((r.value as { partId: string }).partId)
  }

  /** DF95: the part's stock (and name) in one `design.part.update`, so one undo step. */
  const update = async (e: StockEdit) => {
    const name = partName.trim() || e.partName
    const same =
      itemId === (e.libraryItemId ?? null) &&
      [e.length, e.width, e.thickness].every((q, i) => sameSize(size[i] as Quantity, q.toDTO())) &&
      material === e.material.name &&
      materialClass === e.material.class
    const args = {
      ...(name === e.partName ? {} : { name }),
      ...(same
        ? {}
        : item !== undefined && !changed
          ? { stockLibraryItemId: item.id }
          : { stock: blockValues(autoName()) }),
    }
    if (Object.keys(args).length === 0) return onUpdated?.()
    setBusy(true)
    setError(undefined)
    const r = await call('design.part.update', { partId: e.partId, ...args })
    setBusy(false)
    if (!r.ok) return failed(r.error)
    onUpdated?.()
  }

  /** Saves to the library: add (no stock chosen, or a variant) or update the chosen one. */
  const save = async (how: 'add' | 'update' | 'variant') => {
    setAsking(false)
    setBusy(true)
    setError(undefined)
    const root = item === undefined ? undefined : (parentOf(item) ?? item)
    const r =
      how === 'update' && item !== undefined
        ? await call('library.stock.update', {
            id: item.id,
            revision: item.revision,
            values: blockValues(item.name, item.notes),
            units,
          })
        : await call('library.stock.add', {
            values: blockValues(
              how === 'variant' && root !== undefined
                ? m.variantName(root.name, summary)
                : autoName(),
            ),
            units, // bare numbers as the fields read them (library.md#command-input)
            ...(how === 'variant' && root !== undefined ? { parentId: root.id } : {}),
          })
    if (!r.ok) {
      setBusy(false)
      return failed(r.error)
    }
    const saved = r.value as LibraryStock
    const items = await reload()
    setLibrary(items)
    setBusy(false)
    choose(saved.id, items)
  }

  // after a failed Create or Save, focus the first field it marked (ui.md#errors)
  useEffect(() => {
    if (failures > 0) section.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [failures])

  // a failed command shows its issues at the size fields (ui.md#errors), the rest above Create
  const issues = (error?.issues ?? []).map((i) =>
    i.path[0] === 'stock' ? { ...i, path: i.path.slice(1) } : i,
  )
  const rest =
    error === undefined
      ? undefined
      : issues.length === 0
        ? error
        : (() => {
            const left = unmatchedIssues(issues, SIZE_FIELDS)
            return left.length > 0 ? { ...error, issues: left } : undefined
          })()
  const sizeField = (i: 0 | 1 | 2, label: string) => (
    <QuantityInput
      key={`${SIZE_FIELDS[i]}-${fill}`}
      label={label}
      kind="length"
      defaultUnit={defaultUnit('length', units)}
      value={size[i]}
      stepKind={i === 2 ? 'depth' : 'xy'}
      illustration={<FieldIcon name={SIZE_ICONS[i]} />}
      messages={issueMessages(issues, SIZE_FIELDS[i])}
      onCommit={(q) => {
        setSize((s) => s.map((v, j) => (j === i ? q : v)))
        // the edited field's issue is stale now; the others stay until the next Create
        setError((e) => {
          if (e === undefined || e.issues.length === 0) return e
          const left = e.issues.filter(
            (x) =>
              issuesAt(
                [{ ...x, path: x.path.slice(x.path[0] === 'stock' ? 1 : 0) }],
                SIZE_FIELDS[i],
              ).length === 0,
          )
          return left.length === 0 ? undefined : { ...e, issues: left }
        })
      }}
    />
  )

  const options: SelectOption<string>[] = [
    { value: NONE, label: m.notSelected },
    ...library.map((i) => {
      const parent = parentOf(i)
      return {
        value: i.id,
        label: i.name,
        ...(parent === undefined ? {} : { description: m.variantOf(parent.name) }),
      }
    }),
  ]
  const locked = item !== undefined
  const saveDisabled = busy || (item !== undefined && !changed)

  // the dialog's outcome in its footer: Cancel, then the primary Create part at the end edge
  const footer = (
    <>
      <DialogClose>
        <Button>{designMessages.setup.cancel}</Button>
      </DialogClose>
      <Button
        variant="primary"
        onClick={() => void (edit !== undefined ? update(edit) : create())}
        icon={<Icon name="stock" />}
        disabled={busy}
      >
        {edit !== undefined ? m.update : m.create}
      </Button>
    </>
  )

  return (
    <Dialog {...dialog} footer={footer}>
      {/* not a <form>: Enter in a field commits that field (QuantityInput), it does not submit; local
        form state, so Enter never applies (apply.md#keyboard) */}
      <ApplyScope onApply={null}>
        <section
          ref={section}
          className={styles['setup']}
          aria-label={edit !== undefined ? m.editTitle : m.setupTitle}
        >
          <Field label={m.partName}>
            <FieldInput value={partName} onChange={(e) => setPartName(e.target.value)} />
          </Field>
          {/* an empty library has nothing to choose: disabled with the way to fill it (DF48) */}
          <Field
            label={m.fromLibrary}
            readOnly={library.length === 0}
            messages={
              library.length === 0
                ? [{ id: 'libraryEmpty', severity: 'note', text: m.libraryEmpty }]
                : []
            }
          >
            <Select
              options={options}
              value={item?.id ?? NONE}
              disabled={library.length === 0}
              onValueChange={(id) => choose(id)}
            />
          </Field>
          <InspectorGroup title={libraryMessages.window.groups.size}>
            {sizeField(0, m.length)}
            {sizeField(1, m.width)}
            {sizeField(2, m.thickness)}
          </InspectorGroup>
          <InspectorGroup title={libraryMessages.window.groups.material}>
            <Field
              label={m.materialName}
              readOnly={locked}
              messages={
                locked ? [{ id: 'materialLocked', severity: 'note', text: m.materialLocked }] : []
              }
            >
              <FieldInput
                value={material}
                readOnly={locked}
                onChange={(e) => setMaterial(e.target.value)}
              />
            </Field>
            <Field label={m.materialClass} readOnly={locked}>
              <Select<MaterialClass>
                options={MATERIAL_CLASSES.map((c) => ({ value: c, label: m.classes[c] }))}
                value={materialClass}
                disabled={locked}
                onValueChange={setMaterialClass}
              />
            </Field>
          </InspectorGroup>
          {/* the two library actions in one row, each with its own icon (DF48) */}
          <div className={styles['setupButtons']}>
            <LibraryLink
              target={{ kind: 'stock', ...(itemId === null ? {} : { itemId }) }}
              label={libraryMessages.links.open}
              variant="default"
            />
            <Button
              size="sm"
              icon={<Icon name="save" />}
              disabled={saveDisabled}
              title={item !== undefined && !changed ? m.unchanged : undefined}
              onClick={() => (item !== undefined ? setAsking(true) : void save('add'))}
            >
              {m.saveToLibrary}
            </Button>
          </div>
          {/* DF95: what a changed stock does to the operations */}
          {edit !== undefined ? <p className={styles['setupEmpty']}>{m.editNote}</p> : null}
          {rest !== undefined ? <ErrorMessage error={rest} /> : null}
        </section>
        {item !== undefined ? (
          <Dialog
            title={m.saveTitle}
            description={m.saveDescription(item.name)}
            open={asking}
            onOpenChange={setAsking}
            footer={
              <>
                <DialogClose>
                  <Button>{libraryMessages.cancel}</Button>
                </DialogClose>
                <Button onClick={() => void save('update')}>{m.updateStock}</Button>
                <Button
                  variant="primary"
                  icon={<Icon name="add" />}
                  onClick={() => void save('variant')}
                >
                  {m.saveVariant}
                </Button>
              </>
            }
          />
        ) : null}
      </ApplyScope>
    </Dialog>
  )
}
