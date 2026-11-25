// Design mode's part setup (D45): stock and shapes are set once per project, so they live in
// dialogs opened from the main toolbar's "Part setup" group instead of the sidebar; its
// "Reference" button toggles the Reference panel in the right sidebar (dogfood DF3). The Stock
// dialog opens by itself once per project and window while the project has no part (a new
// project starts there); choosing a shape selects it and closes its dialog, so the Shape Editor
// shows as before. With a part the Stock dialog edits its stock (DF95; a split piece's blank comes
// from its source, so a piece shows the read-out).
// Doc: docs/conventions/ui.md#design-sidebar-and-setup-dialogs-v04-d45, #reference-panel-hardening-df2df8
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import { LibraryLink } from '../../library/LibraryLink'
import { designMessages } from '../../messages/design'
import { libraryMessages } from '../../messages/library'
import { useReplica, useUi } from '../../shell/ShellContext'
import { Button, Dialog, DialogClose, Icon, Toolbar, ToolbarButton } from '../../ui'
import styles from './Design.module.css'
import type { DesignPart } from './model'
import { partReferences } from './reference-view'
import { ShapeList } from './ShapeList'
import { StockSetup, type StockEdit } from './StockSetup'
import { useDesignPartOf, useDesignSelection } from './useDesign'

const m = designMessages.setup
const s = designMessages.stock

/** The main toolbar's "Part setup" group (design mode with a project open). */
export function PartSetupTools({ doc }: { doc: ProjectDoc }): React.JSX.Element {
  const open = useUi((st) => st.setDesignDialog)
  const panel = useUi((st) => st.referencePanel)
  const openPanel = useUi((st) => st.openReferencePanel)
  const closePanel = useUi((st) => st.closeReferencePanel)
  const [selected] = useDesignSelection()
  const part = useDesignPartOf(doc)
  return (
    <Toolbar label={m.toolbar} className={styles['setupTools']}>
      <ToolbarButton
        label={m.stock}
        icon={<Icon name="stock" />}
        aria-haspopup="dialog"
        onClick={() => open('stock')}
      />
      <ToolbarButton
        label={m.shapes}
        icon={<Icon name="shapes" />}
        aria-haspopup="dialog"
        onClick={() => open('shapes')}
      />
      <ToolbarButton
        label={m.reference}
        icon={<Icon name="reference" />}
        pressed={panel}
        onClick={() => {
          if (panel) return closePanel()
          const refs = part === undefined ? [] : partReferences(doc, part.dto.id)
          // keep a selected reference, else the first one
          openPanel(refs.find((r) => r.id === selected)?.id ?? refs[0]?.id ?? null)
        }}
      />
    </Toolbar>
  )
}

/** "Stock: 100 × 60 × 20 · 6061-T6", or undefined while the part's stock does not load. */
export function stockReadout(part: DesignPart): string | undefined {
  const st = part.loaded?.stock
  if (st === undefined) return undefined
  return m.readout(
    s.summary(st.length.source, st.width.source, st.thickness.source),
    st.material.name,
  )
}

/** The dialogs; rendered in design mode only (`active`), the toolbar group opens them. */
export function PartSetupDialogs({
  doc,
  active,
}: {
  doc: ProjectDoc
  active: boolean
}): React.JSX.Element | null {
  const replica = useReplica()
  const key = replica.status === 'open' ? replica.key : null
  const dialog = useUi((st) => st.designDialog)
  const setDialog = useUi((st) => st.setDesignDialog)
  const offeredFor = useUi((st) => st.stockOfferedFor)
  const markOffered = useUi((st) => st.markStockOffered)
  const setRemovedToast = useUi((st) => st.setRemovedToast)
  const setDesignPart = useUi((st) => st.setDesignPart)
  const [, select] = useDesignSelection()
  const part = useDesignPartOf(doc)
  const hasPart = part !== undefined
  // the opener (a toolbar button, the stock read-out) gets the focus back on close: the dialogs
  // have no Radix trigger. A layout effect runs before Radix moves the focus into the dialog.
  const opener = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    if (dialog !== null && !wasOpen.current) {
      const active = document.activeElement
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null
    }
    wasOpen.current = dialog !== null
  }, [dialog])
  const returnFocus = (e: Event) => {
    const el = opener.current
    if (el === null || !el.isConnected) return
    e.preventDefault()
    el.focus()
  }

  // the Stock dialog that opened by itself (until it closes): obsolete once a part exists
  const autoOpened = useRef(false)
  // once per project and window, the first time design mode shows it: no part → the Stock dialog
  useEffect(() => {
    if (!active || key === null || offeredFor === key) return
    markOffered(key)
    if (hasPart) return
    autoOpened.current = true
    setDialog('stock')
  }, [active, key, offeredFor, hasPart, markOffered, setDialog])
  // a part made elsewhere (an agent, another window) closes the self-opened dialog; one the
  // user opened stays (Create part closes it in any case)
  useEffect(() => {
    if (!autoOpened.current || !hasPart) return
    autoOpened.current = false
    if (dialog === 'stock') setDialog(null)
  }, [dialog, hasPart, setDialog])
  // leaving design mode closes the dialog (it would reopen on return otherwise)
  useEffect(() => {
    if (!active && dialog !== null) setDialog(null)
  }, [active, dialog, setDialog])

  if (!active) return null
  const close = () => {
    autoOpened.current = false
    setDialog(null)
  }
  const onOpenChange = (open: boolean) => {
    if (!open) close()
  }
  const onRemoved = (name: string) => setRemovedToast(designMessages.navigator.removed(name))
  const done = (
    <DialogClose>
      <Button>{m.done}</Button>
    </DialogClose>
  )
  const needPart = (
    <div className={styles['setupList']}>
      <p className={styles['setupEmpty']}>{m.noPart}</p>
      <div className={styles['setupActions']}>
        <Button size="sm" icon={<Icon name="stock" />} onClick={() => setDialog('stock')}>
          {m.setUpStock}
        </Button>
      </div>
    </div>
  )

  return (
    <>
      {part === undefined ? (
        // the setup renders its own dialog, so Create part sits in the footer beside Cancel;
        // mounted while open only, so each opening starts from fresh form state
        dialog === 'stock' || dialog === 'newPart' ? (
          <StockSetup
            units={doc.unitSystem}
            projectName={doc.name}
            onCreated={(partId) => {
              setDesignPart(partId)
              close()
            }}
            dialog={{
              title: m.stock,
              description: s.setupDescription,
              open: true,
              onOpenChange,
              onCloseAutoFocus: returnFocus,
            }}
          />
        ) : null
      ) : dialog === 'newPart' ? (
        // another part (split parts S0): the same stock setup, named "<project> <n>"
        <StockSetup
          units={doc.unitSystem}
          projectName={doc.name}
          partName={designMessages.parts.nextName(
            doc.name,
            Object.values(doc.parts).map((p) => p.name),
          )}
          onCreated={(partId) => {
            setDesignPart(partId)
            close()
          }}
          dialog={{
            title: designMessages.parts.newTitle,
            description: designMessages.parts.newDescription,
            open: true,
            onOpenChange,
            onCloseAutoFocus: returnFocus,
          }}
        />
      ) : dialog === 'stock' && part.dto.derivedFrom === undefined && part.loaded !== undefined ? (
        // DF95: the part's stock, editable; mounted while open, so it starts from the part's copy
        <StockSetup
          units={doc.unitSystem}
          projectName={doc.name}
          edit={stockEdit(part)}
          onUpdated={close}
          dialog={{
            title: m.stock,
            description: m.stockEditDescription,
            open: true,
            onOpenChange,
            onCloseAutoFocus: returnFocus,
          }}
        />
      ) : (
        <Dialog
          title={m.stock}
          description={m.stockDescription}
          open={dialog === 'stock'}
          onOpenChange={onOpenChange}
          onCloseAutoFocus={returnFocus}
          footer={done}
        >
          <StockFacts
            part={part}
            onShowPart={() => {
              select(null)
              close()
            }}
          />
        </Dialog>
      )}
      <Dialog
        title={m.shapes}
        description={m.shapesDescription(
          part?.dto.shapes?.some((s) => s.owner === undefined) ?? false,
        )}
        open={dialog === 'shapes'}
        onOpenChange={onOpenChange}
        onCloseAutoFocus={returnFocus}
        footer={done}
      >
        {part === undefined ? (
          needPart
        ) : (
          <ShapeList part={part} onRemoved={onRemoved} onChosen={close} />
        )}
      </Dialog>
    </>
  )
}

/** The part's stock as the Stock dialog edits it (DF95). */
function stockEdit(part: DesignPart): StockEdit {
  const st = part.loaded!.stock
  const libraryItemId = part.doc.snapshots[part.dto.stock]?.libraryItemId
  return {
    partId: part.dto.id,
    partName: part.dto.name,
    length: st.length,
    width: st.width,
    thickness: st.thickness,
    material: { name: st.material.name, class: st.material.class },
    ...(libraryItemId === undefined ? {} : { libraryItemId }),
  }
}

/**
 * The Stock dialog of a split piece (or a part whose stock does not load): what it is cut from
 * (its own snapshot of the stock), read-only.
 */
function StockFacts({
  part,
  onShowPart,
}: {
  part: DesignPart
  onShowPart: () => void
}): React.JSX.Element {
  const st = part.loaded?.stock
  const libraryItemId = part.doc.snapshots[part.dto.stock]?.libraryItemId
  return (
    <div className={styles['setupList']}>
      <dl className={styles['stockFacts']}>
        <dt>{m.part}</dt>
        <dd>{part.dto.name}</dd>
        {st !== undefined ? (
          <>
            <dt>{m.size}</dt>
            <dd>{s.summary(st.length.source, st.width.source, st.thickness.source)}</dd>
            <dt>{m.material}</dt>
            <dd>{m.materialValue(st.material.name, s.classes[st.material.class])}</dd>
          </>
        ) : null}
      </dl>
      <p className={styles['setupEmpty']}>{m.copyNote}</p>
      <div className={styles['setupActions']}>
        <Button size="sm" icon={<Icon name="arrow-right" />} onClick={onShowPart}>
          {m.showPart}
        </Button>
        {libraryItemId !== undefined ? (
          <LibraryLink
            target={{ kind: 'stock', itemId: libraryItemId }}
            label={libraryMessages.links.open}
          />
        ) : null}
      </div>
    </div>
  )
}
