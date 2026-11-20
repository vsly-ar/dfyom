// Gallery specimen of the 3D viewport (task 3.5) on a hand-built sample part: selection, hover,
// pick mode, evaluation status and mouse presets. Dev only. Doc: docs/conventions/ui.md#testing
import { Crosshair } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button, SegmentedControl } from '../ui'
import { MOUSE_PRESETS, Viewport, type MousePreset, type SurfaceTarget } from '../viewport'
import { sampleMesh, SAMPLE_PICK_ELIGIBLE, SAMPLE_STOCK } from '../viewport/sample-mesh'
import styles from './Gallery.module.css'

const STATUSES = ['done', 'pending', 'failed'] as const
type Status = (typeof STATUSES)[number]
const PRESET_LABELS: Record<MousePreset, string> = {
  default: 'Default',
  fusion: 'Fusion 360',
  blender: 'Blender',
}

export function ViewportDemo(): React.JSX.Element {
  const mesh = useMemo(() => sampleMesh(), [])
  const [selected, setSelected] = useState<string | null>('pocket1')
  const [status, setStatus] = useState<Status>('done')
  const [preset, setPreset] = useState<MousePreset>('default')
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<SurfaceTarget | null>(null)
  return (
    <div className={styles['viewportDemo']}>
      <div className={styles['viewportStage']}>
        <Viewport
          mesh={mesh}
          stock={SAMPLE_STOCK}
          status={status}
          selectedOperation={selected}
          onSelect={(t) => setSelected(t?.operation ?? null)}
          pick={picking ? { eligible: SAMPLE_PICK_ELIGIBLE, field: 'On' } : null}
          onPick={(t) => {
            setPicked(t)
            setPicking(false)
          }}
          onPickCancel={() => setPicking(false)}
          mousePreset={preset}
        />
      </div>
      <div className={styles['line']}>
        <SegmentedControl
          label="Evaluation"
          size="sm"
          options={STATUSES.map((s) => ({ value: s, label: s }))}
          value={status}
          onValueChange={setStatus}
        />
        <SegmentedControl
          label="Mouse"
          size="sm"
          options={MOUSE_PRESETS.map((p) => ({ value: p, label: PRESET_LABELS[p] }))}
          value={preset}
          onValueChange={setPreset}
        />
        <Button size="sm" icon={<Crosshair />} onClick={() => setPicking((p) => !p)}>
          {picking ? 'Cancel pick' : 'Pick a surface'}
        </Button>
      </div>
      <p className={styles['muted']}>
        Selected: {selected ?? 'nothing'} · Picked: {picked?.surface ?? 'nothing'}
      </p>
    </div>
  )
}
