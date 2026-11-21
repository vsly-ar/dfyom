// User-facing strings of run mode (task 3.12; English only in v0.1, whole sentences as functions).
// Doc: docs/conventions/ui.md#run-mode-safety-ui, #internationalization
import type { UnitSystem } from '../../../core/project/document'

/** Short alarm names for the badge ("Alarm 2: soft limit"); GRBL's full text goes in the panel. */
const ALARM_NAMES: Readonly<Record<number, string>> = {
  1: 'hard limit',
  2: 'soft limit',
  3: 'reset while moving',
  4: 'probe fail',
  5: 'probe fail',
  6: 'homing fail',
  7: 'homing fail',
  8: 'homing fail',
  9: 'homing fail',
  10: 'homing fail',
}

const pad = (n: number) => String(n).padStart(2, '0')

export const runMessages = {
  state: {
    offline: 'Not connected',
    connecting: 'Connecting…',
    idle: 'Idle',
    running: 'Running',
    jogging: 'Jogging',
    homing: 'Homing',
    stopping: 'Stopping',
    hold: 'Feed hold',
    door: 'Door open',
    paused: 'Paused (M0)',
    toolChange: 'Tool change',
    alarm: (code: number | undefined) =>
      code === undefined ? 'Alarm' : `Alarm ${code}: ${ALARM_NAMES[code] ?? 'unknown'}`,
    other: (state: string) => state,
  },
  /** Badge region (polite live region; alarms are announced assertively by the dialog). */
  machineRegion: 'Machine',
  virtualChip: (scale: string) => `Virtual machine · ${scale}`,
  timeScale: (scale: number | 'max') => (scale === 'max' ? 'Max' : `${scale}×`),

  controls: {
    stop: 'Stop',
    stopHint: 'Controlled stop: feed hold, then reset. Never asks for confirmation.',
    feedHold: 'Feed hold',
    feedHoldShortcut: 'Esc',
    resume: 'Resume',
    reset: 'Reset (immediate)',
    resetHint:
      'Resets the controller at once. Motion in progress raises alarm 3 and the machine must be homed again.',
  },

  navigator: {
    title: 'Run',
    plan: 'Plan',
    planPlaceholder: 'Choose a plan',
    connection: 'Connection',
    timeScale: 'Time scale',
    connect: 'Connect to virtual machine',
    connectHint: 'Simulates the plan’s machine: GRBL 1.1 on a virtual machine. No hardware moves.',
    disconnect: 'Disconnect',
    homing: 'Homing',
    home: 'Home',
    unlock: 'Unlock',
    homed: 'Homed',
    notHomed: 'Not homed',
    jog: 'Jog',
    step: 'Jog step',
    jogButton: (axis: string, dir: '+' | '−') => `Jog ${axis}${dir}`,
    cancelJog: 'Stop jog',
    workZero: 'Work zero',
    zeroAxis: (axis: string) => `Zero ${axis}`,
    zeroAll: 'Zero X Y Z',
    workZeroHint: 'Sets the work zero (G54) at the current tool position.',
  },

  /** Why a control is disabled (ui.md: disabled controls explain why). */
  why: {
    notConnected: 'Connect to the virtual machine first.',
    homeFirst: 'Home the machine first.',
    busy: 'Not while the machine is moving.',
    running: 'Not while a run is going.',
    criticalAlarm: 'Reset the machine first (Reset (immediate)), then home it.',
    noPlan: 'Choose a plan first.',
    otherPlan: 'The connection emulates another plan’s machine. Disconnect to switch plans.',
  },

  unlockConfirm: {
    title: 'Unlock without homing?',
    description:
      'Position is not known until homed. Soft limits and the work zero may be wrong until you home the machine.',
    confirm: 'Unlock',
  },

  dro: {
    title: 'Position',
    work: 'Work',
    machine: 'Machine',
    workLabel: 'Work position',
    machineLabel: 'Machine position',
    feed: 'Feed',
    spindle: 'Spindle',
    units: { mm: 'mm', inch: 'in' } satisfies Record<UnitSystem, string>,
    feedUnits: { mm: 'mm/min', inch: 'in/min' } satisfies Record<UnitSystem, string>,
    rpm: 'rpm',
  },

  progress: {
    title: 'Run',
    label: 'Run progress',
    lines: (done: number, total: number) => `Line ${done} / ${total}`,
    linesText: (done: number, total: number) => `Line ${done} of ${total}`,
    elapsed: (seconds: number) => {
      const s = Math.max(0, Math.floor(seconds))
      const h = Math.floor(s / 3600)
      const mm = Math.floor((s % 3600) / 60)
      return h > 0 ? `${h}:${pad(mm)}:${pad(s % 60)}` : `${pad(mm)}:${pad(s % 60)}`
    },
    elapsedLabel: 'Elapsed',
    idle: 'No run yet. Connect, home, set the work zero, then start the run.',
    startRun: 'Start run',
    done: (lines: number, time: string) => `Run complete: ${lines} lines in ${time}.`,
    stopped: 'Run stopped. The machine kept its position.',
    failed: 'Run failed.',
    waitingToolChange: (n: number, name: string) => `Waiting for tool change ${n}: ${name}`,
    waitingPause: (message: string) => `Paused: ${message}`,
    openWait: 'Show instructions',
  },

  preflight: {
    title: 'Start run?',
    description: 'Check the run before the machine moves.',
    plan: 'Plan',
    machine: 'Machine',
    target: 'Target',
    virtualTarget: (scale: string) => `Virtual machine at ${scale}`,
    workZero: 'Work zero (G54, machine coordinates)',
    tools: 'Tools in order',
    noTools: 'No tools assigned',
    softLimits: 'Soft limits',
    softLimitsText:
      'Checked against the machine travel with this work zero when the run starts; a program outside the travel is refused.',
    checksTitle: 'Before you start',
    start: 'Start run',
    cancel: 'Cancel',
  },

  toolChange: {
    title: (n: number) => `Tool change ${n}`,
    description: (name: string) => `The run waits. Change to ${name}, set Z zero, then continue.`,
    steps: (name: string) => [
      'Raise the spindle clear of the part (jog Z+).',
      `Change to ${name}.`,
      'Touch off the new tool and set Z zero.',
      'Continue the run.',
    ],
    setZ: 'Set Z zero here',
    continue: 'Continue',
    later: 'Later',
    announce: (n: number, name: string) => `Tool change ${n}: change to ${name}. The run waits.`,
  },

  pause: {
    title: (n: number) => `Program pause ${n}`,
    description: (message: string) => `The program paused (M0): ${message}`,
    continue: 'Continue',
    later: 'Later',
    announce: (message: string) => `Program paused: ${message}`,
  },

  failure: {
    title: 'The run stopped with an error',
    alarmTitle: (code: number | undefined) =>
      code === undefined ? 'Machine alarm' : `Machine alarm ${code}`,
    line: (line: number) => `At line ${line}.`,
    didHold: 'DFYOM held the feed and reset the controller, so no later line ran.',
    nextHome: 'Home the machine again and check the work zero before the next run.',
    nextCheck: 'Check the work zero and the program, then start the run again.',
    close: 'Close',
  },

  noPlan: 'Choose a plan in the navigator.',
}
