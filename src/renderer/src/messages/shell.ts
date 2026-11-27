// User-facing strings of the app shell (English only in v0.1; one module per feature, whole
// sentences as functions with typed params). Doc: docs/conventions/ui.md#internationalization
import type { AppMode } from '../../../core/modes'
import type { UnitSystem } from '../../../core/project/document'
import type { ThemeSetting } from '../../../shared/settings'

export const shellMessages = {
  appName: 'DFYOM',
  /** Native title bar: the document name and its edit state only (decision 17). */
  windowTitle: (name: string, dirty: boolean) => (dirty ? `${name} — Edited` : name),

  regions: {
    toolbar: 'Main toolbar',
    navigator: 'Navigator',
    viewport: 'Viewport',
    inspector: 'Inspector',
    statusBar: 'Status bar',
  },
  resize: {
    navigator: 'Resize navigator',
    inspector: 'Resize inspector',
  },
  toggles: {
    navigator: 'Navigator',
    inspector: 'Inspector',
  },
  settings: 'Settings',
  library: 'Library',
  /** The toolbar's File group (dogfood DF14): the File menu's New / Open / Save. */
  file: {
    toolbar: 'File',
    newProject: 'New project…',
    open: 'Open project…',
    save: 'Save',
    /** Save while the project has unsaved changes (the icon shows a dot). */
    saveDirty: 'Save (unsaved changes)',
  },
  /** The main toolbar's group of viewport tools (Measure, DF19). */
  viewTools: 'Tools',

  modes: { design: 'Design', plan: 'Plan', run: 'Run' } satisfies Record<AppMode, string>,

  /** Undo/redo step names: the step's title, and whose step it is when not a user's. */
  historyStep: (title: string, sourceKind: string) => {
    const by: Record<string, string> = {
      agent: 'by agent',
      cli: 'by command line',
      automation: 'by automation',
      system: 'by DFYOM',
    }
    const who = by[sourceKind]
    return who === undefined ? title : `${title} – ${who}`
  },

  status: {
    noProject: 'No project',
    saved: 'Saved',
    unsaved: 'Unsaved changes',
    untitled: 'Not saved yet',
    units: { mm: 'mm', inch: 'inch' } satisfies Record<UnitSystem, string>,
    unitsLabel: (u: UnitSystem) => `Unit system: ${u === 'mm' ? 'millimetres' : 'inches'}`,
  },

  agents: {
    connected: (n: number) => (n === 1 ? 'Agent connected' : `${n} agents connected`),
    popoverTitle: 'Connected agents',
    unknownClient: 'Unknown client',
    boundTo: (key: string) => `Project ${key}`,
    noProject: 'No project',
    openSettings: 'Agent settings',
    explain:
      'Agents act through the same commands as you; their changes appear in place and can be undone.',
  },

  connectAgent: {
    title: 'Connect an agent',
    description:
      'Run one of these lines in a terminal to give Claude Code the DFYOM tools. Other MCP clients take the same command.',
    connectTitle: 'Work in this app',
    connectHint:
      'Recommended. The agent works on the projects open here, while you watch; DFYOM must be running.',
    localAgentsOff: '“Allow local agents to connect” is off, so this line cannot connect yet.',
    openSettings: 'Open settings',
    headlessTitle: 'Without the app',
    headlessHint:
      'The agent opens projects on its own. A project open here stays locked to the app.',
    cliTitle: 'Command line',
    cliHint: 'The launcher itself, for the command line: add “tools” to list the commands.',
    development: 'Development build: the lines run the built CLI from this checkout with node.',
    copy: 'Copy',
    copyLabel: (what: string) => `Copy: ${what}`,
    copied: 'Copied',
    copiedAnnounce: (what: string) => `${what} copied to the clipboard.`,
    copyFailed: 'Could not copy. Select the line and copy it.',
    loading: 'Reading the installation…',
    close: 'Close',
  },

  settingsDialog: {
    title: 'Settings',
    description: 'Settings apply to every window and are kept for the next start.',
    groups: { appearance: 'Appearance', editing: 'Editing', run: 'Run', agents: 'Agents' },
    theme: 'Theme',
    themes: { light: 'Light', dark: 'Dark', system: 'System' } satisfies Record<
      ThemeSetting,
      string
    >,
    reduceMotion: 'Reduce motion',
    reduceMotionHint: 'Also on whenever the operating system asks for reduced motion.',
    allowAgents: 'Allow local agents to connect',
    allowAgentsHint: (port: number | undefined) =>
      port === undefined
        ? 'Off: agents on this computer cannot connect to DFYOM.'
        : `Agents on this computer can connect (port ${port}). Turning it off disconnects them.`,
    defaultAnchor: 'Default anchor',
    defaultAnchorHint:
      'Which point of a new pocket or profile its position gives, seen from above. Agents choose their own.',
    snapGrid: 'Snap grid',
    snapGridMm: 'Snap grid in mm projects',
    snapGridInch: 'Snap grid in inch projects',
    snapGridHint:
      'Handles and tab markers snap to grid points this far apart when nothing nearer is in reach.',
    snapGridPositive: 'Must be greater than 0.',
    autoApply: 'Auto-apply after',
    autoApplyOff: 'Off',
    autoApplySeconds: (s: number) => `${s} s`,
    autoApplyHint:
      'Pending edits apply by themselves after this long without another edit, as if you pressed Apply; the button shows the countdown. Off: Enter in a field, the shortcut or the button apply.',
    /** DF88 (docs/conventions/ui.md#jog-hotkeys). */
    jogKeys: 'Jog keys',
    jogKeyStyles: {
      game: 'Videogame (WASD, Shift/Space for Z)',
      gsender: 'gSender (Shift+arrows, Shift+Page Up/Down)',
      arrows: "Arrow keys (/ and ' for Z)",
      off: 'Off',
    },
    jogKeysCustom: 'Custom (coming later)',
    jogKeysHint:
      'In Run mode, while connected and no run is going: a short press jogs one step, holding jogs until released; Escape stops a jog. Not while typing in a field.',
    homeConfirm: 'Homing confirmation',
    homeConfirmReset: 'Ask again for every machine',
    /** DF129 RC4 (docs/modes/run-recovery.md#auto-reconnect). */
    autoReconnect: 'Reconnect automatically after a lost connection',
    autoReconnectHint:
      'When the connection drops during a run, DFYOM connects to the same machine again for up to 2 minutes. It only reads the controller: nothing moves until you say so.',
    homeConfirmHint: (n: number) =>
      n === 0
        ? 'Homing a real machine asks for confirmation first.'
        : `Not asked for ${n === 1 ? '1 machine' : `${n} machines`} (“Don’t ask again”).`,
    done: 'Done',
  },

  close: {
    unsavedTitle: (name: string) => `Close “${name}” with unsaved changes?`,
    unsavedDescription:
      'The changes are not in the project file. They stay recoverable: DFYOM offers to restore them when you open the project again.',
    confirm: 'Close without saving',
    refusedTitle: 'The project cannot be closed now',
    ok: 'Back to the project',
  },

  jobs: {
    /** Job command → label; unknown jobs show their command name. */
    labels: {
      'design.part.evaluate': 'Evaluate part',
      'design.reference.compare': 'Compare with reference',
      'plan.toolpath.generate': 'Generate toolpaths',
      'run.job.start': 'Run plan',
      'run.machine.home': 'Home',
    } as Readonly<Record<string, string>>,
  },

  empty: {
    design: {
      inspector: 'Select an operation to edit its parameters.',
    },
    plan: {
      noPart: {
        title: 'Design a part first',
        description: 'Plans are made from a part. Add a part in Design.',
        action: 'Go to Design',
      },
      inspector: 'Design a part to plan it.',
    },
    run: {
      inspector: 'The DRO, run progress and run controls show here once a project is open.',
    },
    noProject: 'No project open.',
  },
}
