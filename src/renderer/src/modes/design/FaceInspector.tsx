// The inspector of a selected face (dogfood DF22): "Face: Stock top", where it faces, its face-frame
// axes in part-frame terms, and one button per Add item (operations and features, add-items.ts,
// DF98) that adds it on this face, as Add does while the face is selected.
// Doc: docs/conventions/ui.md#selection-and-picking, docs/conventions/ui.md#add-lists-df98
import { STOCK_FACE } from '../../../../core/geometry/face'
import { designMessages } from '../../messages/design'
import { Button, Icon, PanelHeader } from '../../ui'
import { addItemLabel, addItemsFor, runAddItem } from './add-items'
import styles from './Design.module.css'
import { faceAxesText, type SelectedFace } from './face-selection'
import { surfaceLabel, type DesignPart } from './model'
import { useAddOperation } from './useAddOperation'

const f = designMessages.face

export function FaceInspector({
  part,
  face,
}: {
  part: DesignPart
  face: SelectedFace
}): React.JSX.Element {
  const adder = useAddOperation(part)
  const axes = faceAxesText(face.direction)
  return (
    <div className={styles['inspector']}>
      <PanelHeader title={f.title(face.label)} />
      <div className={styles['fields']}>
        <p className={styles['muted']}>
          {f.direction(face.direction)} · {f.axes(axes.u, axes.v)}
        </p>
        <p className={styles['muted']}>{f.hint}</p>
        <div className={styles['addRow']}>
          {addItemsFor('face').map((item) => (
            <Button
              key={item.id}
              size="sm"
              icon={<Icon name={item.icon} />}
              onClick={() => void runAddItem(adder, item.id)}
            >
              {addItemLabel(item.id, 'face')}
            </Button>
          ))}
        </div>
        {face.stockFace ? null : (
          <p className={styles['muted']}>
            {f.stockFaceNote(surfaceLabel(part.dto, STOCK_FACE[face.direction]))}
          </p>
        )}
      </div>
    </div>
  )
}
