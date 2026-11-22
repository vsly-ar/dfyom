// Dev-only gallery: every ui/ component in every variant and state, light and dark side by side
// like the design system page. The manual review surface (not screenshotted by e2e); never shipped
// (App.tsx loads it only in dev builds, at #gallery). Doc: docs/conventions/ui.md#inventory-v01
import { useId, useState, type ReactNode } from 'react'
import type { ReferenceResolver } from '../../../core/expression/evaluate'
import { quantityFromSource } from '../../../core/expression/quantity'
import type { AppMode } from '../../../core/modes'
import type { Quantity } from '../../../core/quantity/quantity'
import { Rational } from '../../../core/quantity/rational'
import type { QuantityKind, UnitId } from '../../../core/quantity/units'
import { None, Some, type Option } from '../../../shared/result'
import {
  ApplyButton,
  type ApplyButtonState,
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
  AnchorPicker,
  type AnchorValue,
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
  ICON_NAMES,
  ICON_SET,
  Icon,
  iconLabel,
  Tooltip,
  UndoRedo,
  type FieldMessage,
  type JobView,
  type IconName,
  type IconGroup,
} from '../ui'
import { designMessages } from '../messages/design'
import { ImportReportDemo } from './ImportReportDemo'
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
      <Row label="Import report · SVG import options and report (task U1; the app's entry is disabled)">
        <ImportReportDemo />
      </Row>
      <Row label="Mode switcher · own component">
        <ModeDemo />
      </Row>
      <Row label="Anchor picker · 3 × 3 points, sliding amber dot (task F2)">
        <div className={styles['line']}>
          <AnchorDemo />
          <AnchorPicker
            label="Anchor (disabled)"
            value={{ u: 'max', v: 'max' }}
            shape="circle"
            disabled
            caption="Remove the formula to change the anchor."
            pointLabel={(p) => `${p.v} ${p.u}`}
            onValueChange={noop}
          />
        </div>
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
      <Row label="Select · groups with descriptions (tool field), muted value (chosen again on Apply)">
        <div className={styles['selects']}>
          <Select aria-label="Tool candidates" options={TOOL_CANDIDATES} defaultValue="lib:t1" />
          <Select
            aria-label="Tool (muted)"
            options={TOOL_CANDIDATES}
            defaultValue="generalized"
            muted
          />
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
            icon: <Icon name="arrow-right" />,
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
        <Button icon={<Icon name="download" />}>With icon</Button>
        <Button size="lg" variant="primary" icon={<Icon name="run" />}>
          Resume
        </Button>
        <Button size="lg" icon={<Icon name="kind-rectangle" />}>
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
  const [tool, setTool] = useState<IconName>('rect')
  const [grid, setGrid] = useState(true)
  const tools: [IconName, string][][] = [
    [
      ['select', 'V'],
      ['rect', 'R'],
      ['circle', 'C'],
      ['line', 'L'],
    ],
    [
      ['profile', 'P'],
      ['pocket', 'K'],
      ['drilling', 'D'],
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
                  label={iconLabel(name)}
                  shortcut={key}
                  pressed={tool === name}
                  onClick={() => setTool(name)}
                  icon={<Icon name={name} />}
                />
              ))}
            </span>
          ))}
          <ToolbarSeparator />
          <ToolbarButton label="Undo" shortcut="⌘Z" icon={<Icon name="undo" />} />
          <ToolbarButton label="Redo" shortcut="⇧⌘Z" disabled icon={<Icon name="redo" />} />
        </Toolbar>
        <Toolbar label="View" floating>
          <ToolbarButton label="Fit" shortcut="F" icon={<Icon name="fit" />} />
          <ToolbarButton label="Isometric" shortcut="0" icon={<Icon name="iso" />} />
          <ToolbarButton
            label="Grid"
            shortcut="G"
            pressed={grid}
            onClick={() => setGrid((g) => !g)}
            icon={<Icon name="grid" />}
          />
        </Toolbar>
        <IconButton label="Run controls (large)" size="lg" icon={<Icon name="simulate" />} />
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
      <Row label="Apply · pending, applying (after 300 ms), failed, applied by agent">
        <div className={styles['stack']}>
          {(
            [
              { kind: 'pending', count: 3 },
              { kind: 'applying', count: 1, progress: 0.4 },
              {
                kind: 'failed',
                count: 2,
                error: {
                  code: 'internal.unexpected',
                  message: 'hook threw',
                  issues: [],
                  frames: [],
                },
              },
              { kind: 'appliedBy', by: 'agent' },
            ] satisfies ApplyButtonState[]
          ).map((state) => (
            <ApplyButton
              key={state.kind}
              state={state}
              list="Pocket 1: depth, corner radius · Drilling 2 added"
              shortcut="⌘↵"
              keyShortcuts="Meta+Enter"
              onApply={noop}
            />
          ))}
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

function AnchorDemo(): React.JSX.Element {
  const [anchor, setAnchor] = useState<AnchorValue>({ u: 'min', v: 'min' })
  return (
    <AnchorPicker
      label="Anchor"
      value={anchor}
      caption={designMessages.anchorPoint('+z', anchor)}
      pointLabel={(p) => designMessages.anchorPoint('+z', p)}
      onValueChange={setAnchor}
    />
  )
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

/** The design tool field's list (task F5): generalized tool, then fitting library tools. */
const TOOL_CANDIDATES = [
  {
    value: 'generalized',
    label: '6 mm flat end mill',
    group: 'Generalized tool',
    description: 'Type and size only: Plan uses a matching library tool.',
  },
  {
    value: 'lib:t1',
    label: 'Flat 6 · Ø 6 mm',
    group: 'Library tools that fit',
    description: 'Has a preset for aluminum',
  },
  { value: 'lib:t2', label: 'Flat 4 · Ø 4 mm', group: 'Library tools that fit' },
]

function Fields(): React.JSX.Element {
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
    <Row label="Field · illustration (full colour focused or not, grey when read-only), lock (feeds fields in auto mode only; disabled with its reason), input with pencil, support area under the input">
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
        <Field label="Chamfer" illustration={<FieldIcon name="chamfer" />}>
          <FieldInput
            defaultValue="45"
            unit="°"
            adjust={<FieldAdjustButton label="Adjust Chamfer angle" />}
          />
        </Field>
        <Field
          label="Width"
          illustration={<FieldIcon name="width" />}
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
        <Field
          label="Spindle speed"
          illustration={<FieldIcon name="corner" />}
          lock={{
            locked: false,
            onLockedChange: noop,
            disabledReason: "24000 rpm is above this machine's 18000 rpm.",
          }}
        >
          <FieldInput defaultValue="24000" unit="rpm" />
        </Field>
        <Field label="Tool" illustration={<FieldIcon name="tool" />}>
          <Select options={TOOLS} defaultValue="t1" />
        </Field>
        <Field
          label="Feed"
          illustration={<FieldIcon name="feed" />}
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
            <IconButton label="Rectangle" icon={<Icon name="rect" />} />
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

const ICON_GROUPS: [IconGroup, string][] = [
  ['operation', 'Operations'],
  ['feature', 'Features and Clones row kinds'],
  ['tool', 'Tool types (20 px in the tool picker)'],
  ['shape', 'Drawing tools and shape kinds'],
  ['cnc', 'Modes and CNC actions'],
  ['view', 'Views'],
  ['action', 'Generic actions (no accent part)'],
  ['status', 'Status (coloured by the status)'],
]

/** The B22 set from its single source: each icon at rest and active (accent amber). */
function Icons(): React.JSX.Element {
  return (
    <Row label="Icons · own set (B22): rest, active (accent part amber), 20 px; then field illustrations">
      {ICON_GROUPS.map(([group, title]) => (
        <div key={group} className={styles['iconGroup']}>
          <h4 className={styles['iconGroupTitle']}>{title}</h4>
          <div className={styles['icons']}>
            {ICON_NAMES.filter((n) => ICON_SET[n].group === group).map((name) => (
              <figure key={name} className={styles['figure']}>
                <span className={styles['iconStates']}>
                  <span className={styles['iconCell']}>
                    <Icon name={name} />
                  </span>
                  <span className={styles['iconCell']} data-active="">
                    <Icon name={name} />
                  </span>
                  <span className={styles['iconCell']} data-active="">
                    <Icon name={name} size="lg" />
                  </span>
                </span>
                <figcaption>
                  {iconLabel(name)}
                  {'reserved' in ICON_SET[name] ? ' (not shown yet)' : ''}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      ))}
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
