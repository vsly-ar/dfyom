// The inspector of a selected face (dogfood DF22): "Face: Stock top", where it faces, its face-frame
// axes in part-frame terms, and one button per operation kind (and Hole) that adds it on this face,
// as Add does while the face is selected. Doc: docs/conventions/ui.md#selection-and-picking
import type { OperationKind } from '../../../../core/design/part.dto'
import { STOCK_FACE } from '../../../../core/geometry/face'
import { designMessages } from '../../messages/design'
import { Button, Icon, PanelHeader, type IconName } from '../../ui'
import styles from './Design.module.css'
import { faceAxesText, type SelectedFace } from './face-selection'
import { surfaceLabel, type DesignPart } from './model'
import { useAddOperation } from './useAddOperation'

const f = designMessages.face
const KINDS: readonly { kind: OperationKind; icon: IconName }[] = [
  { kind: 'facing', icon: 'facing' },
  { kind: 'pocket', icon: 'pocket' },
  { kind: 'drilling', icon: 'drilling' },
  { kind: 'profile', icon: 'profile' },
]

export function FaceInspector({
  part,
  face,
}: {
  part: DesignPart
  face: SelectedFace
}): React.JSX.Element {
  const { add, addHole } = useAddOperation(part)
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
          {KINDS.map(({ kind, icon }) => (
            <Button key={kind} size="sm" icon={<Icon name={icon} />} onClick={() => void add(kind)}>
              {f.addHere(kind)}
            </Button>
          ))}
          <Button size="sm" icon={<Icon name="hole-counterbore" />} onClick={() => void addHole()}>
            {f.addHole}
          </Button>
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
