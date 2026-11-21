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

  settingsDialog: {
    title: 'Settings',
    description: 'Settings apply to every window and are kept for the next start.',
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
      ready: {
        title: 'Plan the part',
        description: 'Plans, setups and toolpaths come with the plan UI (task 3.7).',
      },
      inspector: 'Select a plan operation to edit it (task 3.7).',
    },
    run: {
      noPlan: {
        title: 'Create a plan to run',
        description: 'Run mode runs a plan on the machine. Create one in Plan.',
        action: 'Go to Plan',
      },
      ready: {
        title: 'Run a plan',
        description: 'Connection, homing, jog and run controls come with the run UI (task 3.12).',
      },
      inspector: 'DRO, run progress and run controls appear here (task 3.12).',
    },
  },
}
