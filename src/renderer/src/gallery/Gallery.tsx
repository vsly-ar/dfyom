// Dev-only gallery: every ui/ component in every variant and state, light and dark side by side
// like the design system page. The manual review surface and the screenshot target; never shipped
// (App.tsx loads it only in dev builds, at #gallery). Doc: docs/conventions/ui.md#inventory-v01
import { ArrowRight, Download, Play, Redo2, Square, Undo2 } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import type { ReferenceResolver } from '../../../core/expression/evaluate'
import { quantityFromSource } from '../../../core/expression/quantity'
import type { AppMode } from '../../../core/modes'
import type { Quantity } from '../../../core/quantity/quantity'
import { Rational } from '../../../core/quantity/rational'
import type { QuantityKind, UnitId } from '../../../core/quantity/units'
import { None, Some, type Option } from '../../../shared/result'
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorMessage,
  Field,
  FIELD_ICON_NAMES,
  FieldAdjustButton,
  FieldIcon,
  FieldInput,
  IconButton,
  JobIndicator,
  JobList,
  MachineStateBadge,
  StopControl,
  Menu,
  ModeSwitcher,
  Panel,
  PanelGroup,
  PanelHeader,
  PanelResizeHandle,
  Popover,
  PortalContainer,
  Progress,
  QuantityInput,
  SegmentedControl,
  Select,
  StatusChip,
  Switch,
  Tabs,
  Term,
  ThemeScope,
  Toast,
  ToastRegion,
  Toolbar,
  ToolbarButton,
  ToolbarSeparator,
  TOOL_ICON_NAMES,
  ToolIcon,
  toolIconLabel,
  Tooltip,
  UndoRedo,
  type FieldMessage,
  type JobView,
  type ToolIconName,
} from '../ui'
import styles from './Gallery.module.css'
import { ViewportDemo } from './ViewportDemo'

const noop = (): void => {}

export function Gallery(): React.JSX.Element {
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system')
  const [motion, setMotion] = useState<'full' | 'reduce'>('full')
  return (
    <div className={styles['page']}>
      <header className={styles['header']}>
        <div>
          <h1 className={styles['h1']}>Component gallery</h1>
          <p className={styles['muted']}>
            Dev only. Every ui/ component in its states; light on the left, dark on the right. The
            reference is docs/conventions/ui-design-system.html.
          </p>
        </div>
        <div className={styles['line']}>
          <SegmentedControl
            label="Window theme"
            options={[
              { value: 'system', label: 'Follow OS' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            value={theme}
            onValueChange={(t) => {
              setTheme(t)
              if (t === 'system') delete document.documentElement.dataset['theme']
              else document.documentElement.dataset['theme'] = t
            }}
          />
          <Switch
            label="Reduce motion"
            checked={motion === 'reduce'}
            onCheckedChange={(on) => {
              setMotion(on ? 'reduce' : 'full')
              if (on) document.documentElement.dataset['motion'] = 'reduce'
              else delete document.documentElement.dataset['motion']
            }}
          />
        </div>
      </header>
      <div className={styles['duo']}>
        <ThemeScope theme="light" className={styles['pane']}>
          <Specimens title="Light · Ghost White" />
        </ThemeScope>
        <ThemeScope theme="dark" className={styles['pane']}>
          <Specimens title="Dark · Jet" />
        </ThemeScope>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <section className={styles['row']} aria-label={label}>
      <h2 className={styles['lbl']}>{label}</h2>
      {children}
    </section>
  )
}

function Specimens({ title }: { title: string }): React.JSX.Element {
  return (
    <>
      <span className={styles['eyebrow']}>{title}</span>
      <Buttons />
      <Toolbars />
      <Row label="Viewport · sample part, click to select, pick mode, evaluation status">
        <ViewportDemo />
      </Row>
      <Row label="Mode switcher · own component">
        <ModeDemo />
      </Row>
      <Row label="Segmented control · amber thumb, dark text">
        <div className={styles['line']}>
          <SegmentedDemo />
          <SegmentedControl
            label="Unit system"
            size="sm"
            options={[
              { value: 'mm', label: 'mm' },
              { value: 'in', label: 'in' },
            ]}
            value="mm"
            onValueChange={noop}
          />
        </div>
      </Row>
      <Row label="Switch · checkbox">
        <div className={styles['line']}>
          <Switch label="Tabs" hideLabel />
          <Switch label="Finish pass" hideLabel defaultChecked />
          <Checkbox label="Peck" />
          <Checkbox label="Chip break" defaultChecked />
          <Checkbox label="Mixed" checked="indeterminate" />
          <Checkbox label="Disabled" disabled />
        </div>
        <div className={styles['narrow']}>
          <Switch label="Show dimensions" defaultChecked />
          <Switch label="Snap to grid" />
        </div>
      </Row>
      <Row label="Select · value, placeholder, disabled">
        <div className={styles['selects']}>
          <Select aria-label="Strategy" options={STRATEGIES} defaultValue="offset" />
          <Select aria-label="Tool" options={TOOLS} placeholder="Choose a tool…" />
          <Select aria-label="Tool (disabled)" options={TOOLS} defaultValue="t1" disabled />
        </div>
      </Row>
      <Fields />
      <QuantityFields />
      <Row label="Status chips · evaluation and plan state">
        <div className={styles['line']}>
          <StatusChip tone="success">Up to date</StatusChip>
          <StatusChip tone="busy">Updating…</StatusChip>
          <StatusChip tone="warning">Stale: tool changed</StatusChip>
          <StatusChip tone="danger">Evaluation failed</StatusChip>
          <StatusChip>3 operations</StatusChip>
        </div>
      </Row>
      <Row label="Machine state · shape and label each; Running circles its edge">
        <div className={styles['line']}>
          <MachineStateBadge state="offline" />
          <MachineStateBadge state="idle" />
          <MachineStateBadge state="moving" />
          <MachineStateBadge state="hold" />
          <MachineStateBadge state="action" />
          <MachineStateBadge state="alarm" label="Alarm 2: soft limit" />
        </div>
      </Row>
      <Row label="Stop control · 44 px, the only filled control, never confirmed">
        <div className={styles['line']}>
          <StopControl onStop={() => {}} />
        </div>
      </Row>
      <Row label="Progress · determinate, indeterminate">
        <div className={styles['stack']}>
          <Progress label="Run" value={62} valueText="Line 1 884 of 3 020" />
          <Progress label="Toolpath generation" value={null} />
        </div>
      </Row>
      <ShellParts />
      <Overlays />
      <Row label="Empty state · one sentence, one action">
        <EmptyState
          icon={
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="2.5" y="3.5" width="11" height="9" rx="2" />
              <path data-accent="" d="M5.5 8h5M8 5.5v5" />
            </svg>
          }
          title="Design a part first"
          description="Plans are made from a part. Add a part in Design."
          action={{
            label: 'Go to Design',
            icon: <ArrowRight aria-hidden="true" />,
            onClick: noop,
          }}
        />
      </Row>
      <Icons />
    </>
  )
}

function Buttons(): React.JSX.Element {
  return (
    <Row label="Button · default, primary (neutral, semibold, amber icon), ghost, danger, disabled">
      <div className={styles['line']}>
        <Button>Export G-code…</Button>
        <Button variant="primary" icon={<ToolpathIcon />}>
          Generate toolpaths
        </Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="danger">Remove plan</Button>
        <Button disabled>Simulate</Button>
      </div>
      <div className={styles['line']}>
        <Button size="sm">Small</Button>
        <Button icon={<Download aria-hidden="true" />}>With icon</Button>
        <Button size="lg" variant="primary" icon={<Play aria-hidden="true" />}>
          Resume
        </Button>
        <Button size="lg" icon={<Square aria-hidden="true" />}>
          Large
        </Button>
      </div>
    </Row>
  )
}

function ToolpathIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 12.5V5l3.5 6V5l3.5 6V5l3.5 6" />
    </svg>
  )
}

function Toolbars(): React.JSX.Element {
  const [tool, setTool] = useState<ToolIconName>('rect')
  const [grid, setGrid] = useState(true)
  const tools: [ToolIconName, string][][] = [
    [
      ['select', 'V'],
      ['rect', 'R'],
      ['circle', 'C'],
      ['line', 'L'],
    ],
    [
      ['profile', 'P'],
      ['pocket', 'K'],
      ['drill', 'D'],
    ],
  ]
  return (
    <Row label="Toolbar · icon buttons with tooltip, active tool shows its accent detail">
      <div className={styles['line']}>
        <Toolbar label="Tools">
          {tools.map((group, i) => (
            <span key={i} className={styles['group']}>
              {i > 0 ? <ToolbarSeparator /> : null}
              {group.map(([name, key]) => (
                <ToolbarButton
                  key={name}
                  label={toolIconLabel(name)}
                  shortcut={key}
                  pressed={tool === name}
                  onClick={() => setTool(name)}
                  icon={<ToolIcon name={name} />}
                />
              ))}
            </span>
          ))}
          <ToolbarSeparator />
          <ToolbarButton label="Undo" shortcut="⌘Z" icon={<Undo2 aria-hidden="true" />} />
          <ToolbarButton label="Redo" shortcut="⇧⌘Z" disabled icon={<Redo2 aria-hidden="true" />} />
        </Toolbar>
        <Toolbar label="View" floating>
          <ToolbarButton label="Fit" shortcut="F" icon={<ToolIcon name="fit" />} />
          <ToolbarButton label="Isometric" shortcut="0" icon={<ToolIcon name="iso" />} />
          <ToolbarButton
            label="Grid"
            shortcut="G"
            pressed={grid}
            onClick={() => setGrid((g) => !g)}
            icon={<ToolIcon name="grid" />}
          />
        </Toolbar>
        <IconButton label="Run controls (large)" size="lg" icon={<ToolIcon name="simulate" />} />
      </div>
    </Row>
  )
}

const JOBS: JobView[] = [
  { id: 'j1', label: 'Evaluate part', state: 'running' },
  { id: 'j2', label: 'Generate toolpaths', state: 'paused', progress: { done: 3, total: 4 } },
]

/** Shell components (3.3b): tabs, term, undo/redo, panels, jobs, errors. */
function ShellParts(): React.JSX.Element {
  // ids become DOM ids: unique per theme pane
  const uid = useId()
  return (
    <>
      <Row label="Tabs · inspector sections, sliding underline">
        <Tabs
          label="Pocket sections"
          items={[
            { value: 'shape', label: 'Shape', content: <p className={styles['muted']}>Shape</p> },
            { value: 'depth', label: 'Depth', content: <p className={styles['muted']}>Depth</p> },
            { value: 'tabs', label: 'Tabs', content: null, disabled: true },
          ]}
        />
      </Row>
      <Row label="Term · dotted underline, definition on hover and focus">
        <p className={styles['muted']}>
          Each pass cuts one{' '}
          <Term definition="Stepdown: 1.5 mm per pass for this pocket">stepdown</Term> deeper.
        </p>
      </Row>
      <Row label="Undo / redo · named step, whose step">
        <Toolbar label="Edit">
          <UndoRedo
            undo="Add pocket – by agent"
            redo={null}
            onUndo={noop}
            onRedo={noop}
            undoShortcut="⌘Z"
            redoShortcut="⇧⌘Z"
          />
        </Toolbar>
      </Row>
      <Row label="Panels · resizable, collapsible; drag or focus the hairline">
        <div className={styles['panels']}>
          <PanelGroup id={`${uid}-panels`}>
            <Panel id={`${uid}-left`} defaultSize="35" minSize="20" collapsible>
              <PanelHeader title="Operations" meta="5" />
            </Panel>
            <PanelResizeHandle label="Resize operations" />
            <Panel id={`${uid}-right`}>
              <PanelHeader title="Properties" />
            </Panel>
          </PanelGroup>
        </div>
      </Row>
      <Row label="Jobs · status bar indicator (after 300 ms) and the job list">
        <div className={styles['stack']}>
          <JobIndicator jobs={JOBS} onPause={noop} onResume={noop} onCancel={noop} />
          <JobList jobs={JOBS} onPause={noop} onResume={noop} onCancel={noop} />
        </div>
      </Row>
      <Row label="Error message · error, warning, cancelled (neutral)">
        <div className={styles['stack']}>
          <ErrorMessage
            error={{ code: 'persist.io', message: 'EACCES', issues: [], frames: [] }}
            message="Export failed: the folder is read-only. Choose another folder."
            onRetry={noop}
          />
          <ErrorMessage
            error={{ code: 'op.timeout', message: 'worker timed out', issues: [], frames: [] }}
          />
          <ErrorMessage
            error={{ code: 'op.aborted', message: 'aborted', issues: [], frames: [] }}
          />
        </div>
      </Row>
    </>
  )
}

function ModeDemo(): React.JSX.Element {
  const [mode, setMode] = useState<AppMode>('plan')
  return <ModeSwitcher value={mode} onValueChange={setMode} />
}

function SegmentedDemo(): React.JSX.Element {
  const [dir, setDir] = useState<'climb' | 'conventional'>('climb')
  return (
    <SegmentedControl
      label="Cut direction"
      options={[
        { value: 'climb', label: 'Climb' },
        { value: 'conventional', label: 'Conventional' },
      ]}
      value={dir}
      onValueChange={setDir}
    />
  )
}

const STRATEGIES = [
  { value: 'offset', label: 'Offset' },
  { value: 'zigzag', label: 'Zigzag' },
] as const
const TOOLS = [
  { value: 't1', label: 'T1 · Ø6 flat end mill 2F' },
  { value: 't2', label: 'T2 · Ø3 drill' },
] as const

function Fields(): React.JSX.Element {
  const [locked, setLocked] = useState(true)
  const lockOff = { locked: false, onLockedChange: noop }
  const stepdown: FieldMessage[] = [
    {
      id: 'stepdown.above',
      severity: 'soft',
      text: 'Above the suggested 1.20 mm',
      fix: { label: 'Use 1.20', onApply: noop },
    },
    { id: 'rec', severity: 'note', text: 'Recommended 0.60–1.20 mm, 10–20 % of tool Ø' },
    { id: 'agent', severity: 'info', text: 'Changed by agent 2 min ago' },
  ]
  return (
    <Row label="Field · illustration (35 % saturation at rest, full on focus), lock, input with pencil, support area under the input">
      <div className={styles['fields']}>
        <Field
          label="Stepdown"
          illustration={<FieldIcon name="stepdown" />}
          lock={lockOff}
          messages={stepdown}
        >
          <FieldInput
            defaultValue="1.50"
            unit="mm"
            adjust={<FieldAdjustButton label="Adjust Stepdown" fix />}
          />
        </Field>
        <Field
          label="Corner R"
          illustration={<FieldIcon name="corner" />}
          lock={lockOff}
          messages={[
            {
              id: 'corner.tool',
              severity: 'hard',
              text: 'Smaller than the 6 mm tool can cut',
              fix: { label: 'Use 3.00', onApply: noop },
            },
          ]}
        >
          <FieldInput
            defaultValue="1.50"
            unit="mm"
            adjust={<FieldAdjustButton label="Adjust Corner radius" fix />}
          />
        </Field>
        <Field label="Chamfer" illustration={<FieldIcon name="chamfer" />} lock={lockOff}>
          <FieldInput
            defaultValue="45"
            unit="°"
            adjust={<FieldAdjustButton label="Adjust Chamfer angle" />}
          />
        </Field>
        <Field
          label="Width"
          illustration={<FieldIcon name="width" />}
          lock={lockOff}
          echo="= 1.588 mm · ±0.1 mm from part"
        >
          <FieldInput
            defaultValue={'1/16"'}
            unit="mm"
            adjust={<FieldAdjustButton label="Adjust Width" />}
          />
        </Field>
        <Field
          label="Depth"
          illustration={<FieldIcon name="depth" />}
          lock={lockOff}
          messages={[
            {
              id: 'parse',
              severity: 'error',
              text: 'Two decimal points',
              fix: { label: 'Use 3.5', onApply: noop },
            },
          ]}
        >
          <FieldInput
            defaultValue="3..5"
            unit="mm"
            adjust={<FieldAdjustButton label="Adjust Depth" />}
          />
        </Field>
        <Field label="Tool" illustration={<FieldIcon name="tool" />}>
          <Select options={TOOLS} defaultValue="t1" />
        </Field>
        <Field
          label="Feed"
          illustration={<FieldIcon name="feed" />}
          lock={{ locked, onLockedChange: setLocked }}
          readOnly
          messages={[
            {
              id: 'ro',
              severity: 'note',
              text: 'Finalized plans are read-only',
              icon: <LockGlyph />,
            },
          ]}
        >
          <FieldInput defaultValue="900" unit="mm/min" />
        </Field>
        <Field label="Tabs" illustration={<FieldIcon name="tabs" />} kind="toggle">
          <Checkbox label="Leave 4 tabs" defaultChecked />
        </Field>
      </div>
    </Row>
  )
}

// QuantityInput specimens: a tiny stand-in for the design's surfaces (pocket1) and the tool.
const GALLERY_REFS: ReadonlyMap<string, Quantity> = new Map([
  ['pocket1.floor.z', galleryQuantity('-6 ±0.05')],
  ['pocket1.depth', galleryQuantity('6')],
  ['tool.diameter', galleryQuantity('6')],
])
const GALLERY_RESOLVER: ReferenceResolver = { resolve: resolveGalleryRef }

function resolveGalleryRef(name: string): Option<Quantity> {
  const v = GALLERY_REFS.get(name)
  return v ? Some(v) : None
}
const GALLERY_REFERENCES = [
  { id: 'pocket1.floor.z', label: 'Pocket 1 floor' },
  { id: 'pocket1.depth', label: 'Pocket 1 depth' },
  { id: 'tool.diameter', label: 'T1 · Ø6 flat end mill' },
]

function galleryQuantity(
  source: string,
  kind: QuantityKind = 'length',
  defaultUnit: UnitId = 'mm',
): Quantity {
  return quantityFromSource(source, { kind, defaultUnit }, { resolve: resolveGalleryRef }).unwrap()
}

/** A stored value that follows its commits, like the document replica. */
function useStored(source: string, kind?: QuantityKind, unit?: UnitId) {
  const [value, setValue] = useState(() => galleryQuantity(source, kind, unit))
  return { value, onCommit: setValue }
}

function QuantityFields(): React.JSX.Element {
  const width = useStored('1/16"')
  const depth = useStored('3.00')
  const on = useStored('pocket1.floor.z - 2')
  const tolerance = useStored('10 +0.1/-0.05')
  const feed = useStored('900', 'feedRate', 'mm/min')
  const [picking, setPicking] = useState(false)
  return (
    <Row label="Quantity input · source as typed, computed value when unfocused, echo while typing, errors with a fix, steppers, references and pick">
      <div className={styles['fields']}>
        <QuantityInput
          label="Width"
          kind="length"
          defaultUnit="mm"
          illustration={<FieldIcon name="width" />}
          inheritedTolerance={{ deviation: Rational.create(1n, 10n).unwrap(), scope: 'part' }}
          recommended={{ source: '2.00', text: '≥ 2.00 mm for the 2 mm tool' }}
          {...width}
        />
        <QuantityInput
          label="Depth"
          kind="length"
          defaultUnit="mm"
          step="0.1"
          illustration={<FieldIcon name="depth" />}
          {...depth}
        />
        <QuantityInput
          label="Floor"
          kind="length"
          defaultUnit="mm"
          illustration={<FieldIcon name="depth" />}
          resolver={GALLERY_RESOLVER}
          references={GALLERY_REFERENCES}
          picking={picking}
          onPick={(insert) => {
            // stand-in for viewport pick mode: picks pocket1.floor.z after a moment
            setPicking(true)
            setTimeout(() => {
              insert('pocket1.floor.z')
              setPicking(false)
            }, 900)
          }}
          {...on}
        />
        <QuantityInput
          label="Length"
          kind="length"
          defaultUnit="mm"
          illustration={<FieldIcon name="length" />}
          {...tolerance}
        />
        <QuantityInput
          label="Feed"
          kind="feedRate"
          defaultUnit="mm/min"
          illustration={<FieldIcon name="feed" />}
          readOnly
          {...feed}
        />
      </div>
    </Row>
  )
}

function LockGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
    >
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  )
}

/** Overlays open in place: each stage contains its fixed-position content (transform). */
function Stage({
  children,
  tall = false,
}: {
  children: ReactNode
  tall?: boolean
}): React.JSX.Element {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  return (
    <div ref={setEl} className={styles['stage']} data-tall={tall || undefined}>
      <PortalContainer container={el}>{el ? children : null}</PortalContainer>
    </div>
  )
}

function Overlays(): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  return (
    <Row label="Overlays · tooltip, menu, popover, toast, dialog, confirm dialog (open)">
      <div className={styles['overlays']}>
        <Stage>
          <Tooltip content="Rectangle" shortcut="R" open side="right">
            <IconButton label="Rectangle" icon={<ToolIcon name="rect" />} />
          </Tooltip>
        </Stage>
        <Stage tall>
          <Menu
            open
            modal={false}
            items={[
              { label: 'Duplicate', shortcut: '⌘D', onSelect: noop },
              { label: 'Rename', shortcut: 'F2', onSelect: noop },
              'separator',
              { label: 'Remove', shortcut: '⌫', danger: true, onSelect: noop },
            ]}
          >
            <Button size="sm">Actions</Button>
          </Menu>
        </Stage>
        <Stage tall>
          <Popover
            open
            label="Adjust Width"
            title="Adjust Width"
            align="start"
            content={
              <SegmentedControl
                label="Step"
                size="sm"
                options={['.01', '.1', '1', '10'].map((v) => ({ value: v, label: v }))}
                value=".1"
                onValueChange={noop}
              />
            }
          >
            <Button size="sm">Popover</Button>
          </Popover>
        </Stage>
        <Stage>
          <ToastRegion inline>
            <Toast
              open
              duration={Infinity}
              message="Removed Pocket 2"
              action={{ label: 'Undo', altText: 'Undo with Cmd+Z', onClick: noop }}
            />
          </ToastRegion>
        </Stage>
        <Stage tall>
          <Dialog
            open
            modal={false}
            title="Remove plan “Roughing”?"
            description="Its toolpaths and export settings are deleted. This cannot be undone."
            footer={
              <>
                <Button>Cancel</Button>
                <Button variant="danger">Remove plan</Button>
              </>
            }
          />
        </Stage>
        <div className={styles['line']}>
          <ConfirmDialog
            open={confirm}
            onOpenChange={setConfirm}
            title="Remove plan “Roughing”?"
            description="Its toolpaths and export settings are deleted. This cannot be undone."
            confirmLabel="Remove plan"
            onConfirm={noop}
            trigger={<Button variant="danger">Open the confirm dialog</Button>}
          />
        </div>
      </div>
    </Row>
  )
}

function Icons(): React.JSX.Element {
  return (
    <Row label="Icons · own tool icons (accent detail when active), field illustrations">
      <div className={styles['icons']}>
        {TOOL_ICON_NAMES.map((name) => (
          <figure key={name} className={styles['figure']}>
            <span className={styles['iconCell']} data-active={name === 'pocket' || undefined}>
              <ToolIcon name={name} />
            </span>
            <figcaption>{toolIconLabel(name)}</figcaption>
          </figure>
        ))}
      </div>
      <div className={styles['icons']}>
        {FIELD_ICON_NAMES.map((name) => (
          <figure key={name} className={styles['figure']}>
            <span className={styles['fieldCell']}>
              <FieldIcon name={name} />
            </span>
            <figcaption>{name}</figcaption>
          </figure>
        ))}
      </div>
    </Row>
  )
}
