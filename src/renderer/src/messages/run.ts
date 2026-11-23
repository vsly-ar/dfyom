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
    paused: 'Paused by program',
    needsHoming: 'Needs homing',
    toolChange: 'Tool change',
    setupChange: 'Setup change',
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
    noPlan: 'No plan (manual control)',
    machine: 'Machine',
    machinePlaceholder: 'Choose a library machine',
    noMachines: 'No machine in the library yet. Add one in the Library window.',
    status: 'Status',
    ready: 'Ready to jog.',
    readyNoPlan: 'Ready to jog (manual control).',
    workZeroAtHome:
      'The work zero is at machine 0, the home corner: jog to the stock’s zero corner and set it.',
    setup: 'Setup',
    setupHint: 'One program per setup, run in this order.',
    connection: 'Connection',
    timeScale: 'Time scale',
    connect: 'Connect',
    connectHint:
      'To a virtual machine that simulates the plan’s machine (GRBL 1.1). No hardware moves.',
    connectHintNoPlan:
      'To a virtual machine that simulates the chosen library machine (GRBL 1.1). No hardware moves.',
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
    nothingToStop: 'Nothing to stop: the machine is not moving.',
    otherPlan: 'The connection emulates another plan’s machine. Disconnect to switch plans.',
  },

  /** A jog refused for leaving the travel (`run.travel`, docs/modes/run.md DF33), in the project's unit. */
  travel: (axis: string, side: 'max' | 'min', limit: string, target: string, unit: string) =>
    `${axis} would leave the travel: ${side} ${limit} ${unit}, the jog would end at ${target} ${unit}.`,
  travelUnknown: 'The jog would leave the machine travel (soft limits).',

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
    /** A coordinate while the position is not known (DF46). */
    unknown: '—',
    unknownHint: 'Position unknown until homed.',
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
    waitingSetupChange: (n: number, name: string) =>
      `Next: setup ${n}, ${name}. Turn the stock and set the work zero.`,
  },

  preflight: {
    title: 'Start run?',
    description: 'Check the run before the machine moves.',
    plan: 'Plan',
    setup: 'Setup',
    setupOf: (name: string, n: number, total: number) => `${name} (${n} of ${total})`,
    machine: 'Machine',
    target: 'Target',
    virtualTarget: (scale: string) => `Virtual machine at ${scale}`,
    workZero: 'Work zero (G54, machine coordinates)',
    tools: 'Tools in order',
    noTools: 'No tools assigned',
    softLimits: 'Soft limits',
    softLimitsChecking: 'Checking…',
    softLimitsOk: 'Inside the travel at this work zero.',
    /** One `softLimit` finding (DF46), lengths already in the project's unit. */
    softLimitsAxis: (axis: string, from: string, to: string, travel: string, unit: string) =>
      `${axis} leaves the travel: the program spans ${from} to ${to} ${unit}, the travel is −${travel} to 0 ${unit}.`,
    softLimitsFix: 'Move the work zero so the program fits the travel, then start again.',
    softLimitsFailed: 'The soft-limit check failed:',
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
    later: 'Close (stay paused)',
    announce: (n: number, name: string) => `Tool change ${n}: change to ${name}. The run waits.`,
  },

  setupChange: {
    title: (n: number, name: string) => `Setup change: setup ${n}, ${name}`,
    description: (face: string) =>
      `The previous setup is done. Turn the stock so its ${face} face is up, set the work zero, then start.`,
    picture: (up: string, front: string, right: string) =>
      `The stock on the machine: ${up} face up, ${front} face towards you, ${right} face on the right. The work zero is the front-left corner of the top.`,
    faces: { up: 'Up', front: 'Front', right: 'Right' },
    workZero: 'Work zero',
    steps: (up: string) => [
      'Raise the spindle clear of the stock (jog Z+).',
      `Turn the stock so its ${up} face is up, as in the picture, and clamp it.`,
      'Set the work zero on the new top: X and Y at its front-left corner, Z on its surface.',
      'Start the setup.',
    ],
    start: (n: number) => `Start setup ${n}`,
    later: 'Later',
    announce: (n: number, name: string) =>
      `Setup ${n - 1} done. Setup change to setup ${n}, ${name}: turn the stock and set the work zero.`,
  },

  pause: {
    title: (n: number) => `Program pause ${n}`,
    description: (message: string) => `The program paused the run: ${message}`,
    details:
      'Program pause (M0) in the gCode. Continue runs the next line; Close keeps the run paused, and the Run inspector shows it.',
    continue: 'Continue',
    later: 'Close (stay paused)',
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
