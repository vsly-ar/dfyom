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
    holding: 'Holding…',
    /** DF82: a hold DFYOM did not send (the controller's feed-hold button or pin). */
    heldByMachine: 'Held (machine button)',
    door: 'Door open',
    /** GRBL `Door:0`: the safety door is closed again; Resume continues (DF82). */
    doorClosed: 'Held (door closed)',
    /** GRBL `Door:3`: restoring the spindle after the door, then moving on. */
    doorResuming: 'Resuming…',
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
  serialChip: (path: string) => `Serial · ${path}`,
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
    /** Without a project (DF80): the machine profile gives travel, limits and the probe plate. */
    machineHint: 'The machine profile sets the travel, the soft limits and the probe plate.',
    status: 'Status',
    ready: 'Ready to jog.',
    readyNoPlan: 'Ready to jog (manual control).',
    workZeroAtHome:
      'The work zero is at machine 0, the home corner: jog to the stock’s zero corner and set it.',
    setup: 'Setup',
    setupHint: 'One program per setup, run in this order.',
    connection: 'Connection',
    timeScale: 'Time scale',
    /** One label for both targets: the "Connect to" select above names the target. */
    connect: 'Connect',
    connectHint:
      'To a virtual machine that simulates the plan’s machine (GRBL 1.1). No hardware moves.',
    connectHintSerial:
      'To a real GRBL controller on this port. The machine moves only when you start it here.',
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
    /** Step or continuous (hold to jog) jogging (docs/modes/run-machine.md#machine-readiness-m3). */
    jogMode: 'Jog mode',
    jogModeStep: 'Step',
    jogModeContinuous: 'Continuous',
    holdHint: 'Hold to jog; release to stop.',
    /** After a real connection was lost without a reset (run-machine.md#lost-connection-m2). */
    lost: 'Connection to the machine lost. It may still be moving and the spindle may still be on: use the emergency stop.',
    workZero: 'Work zero',
    zeroAxis: (axis: string) => `Zero ${axis}`,
    zeroAll: 'Zero X Y Z',
    workZeroHint: 'Sets the work zero (G54) at the current tool position.',
  },

  /** Why a control is disabled (ui.md: disabled controls explain why). */
  why: {
    notConnected: 'Connect to a machine first.',
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
  /** A continuous jog from the end of the travel (`run.travel`, `atEdge`). */
  travelAtEdge: (axis: string, side: 'max' | 'min', limit: string, unit: string) =>
    `${axis} is at the end of its travel (${side} ${limit} ${unit}).`,

  /**
   * The alarm panel: what happened and the next steps per GRBL alarm
   * (docs/modes/run-machine.md#machine-readiness-m3). `0` = locked without an alarm code.
   */
  alarm: {
    region: 'Alarm',
    lockedTitle: 'Locked (Alarm)',
    next: 'Next',
    grbl: 'Controller',
    codes: {
      0: {
        what: 'The controller starts locked until it is homed.',
        next: ['Home the machine.', 'Unlock only to jog an axis off a limit switch first.'],
      },
      1: {
        what: 'A limit switch tripped while moving; the position is lost.',
        next: [
          'Reset (immediate).',
          'Check what tripped it: a crash, chips, a loose wire.',
          'If an axis rests on its switch, unlock and jog it off.',
          'Home the machine.',
        ],
      },
      2: {
        what: 'A move would have left the travel; the controller stopped it and kept the position.',
        next: [
          'Reset (immediate).',
          'Home the machine.',
          'Check the work zero and the program before the next run.',
        ],
      },
      3: {
        what: 'The controller was reset during motion; steps may be lost.',
        next: ['Home the machine.', 'Check the work zero.'],
      },
      4: {
        what: 'The probe was already triggered before probing.',
        next: ['Check the probe or plate wiring and that nothing touches it.', 'Unlock.'],
      },
      5: {
        what: 'The probe made no contact within its travel.',
        next: ['Check the plate and its clip on the bit.', 'Unlock and probe again.'],
      },
      6: { what: 'Homing was reset before it finished.', next: ['Home the machine again.'] },
      7: {
        what: 'The safety door opened during homing.',
        next: ['Close the door.', 'Home the machine again.'],
      },
      8: {
        what: 'Homing could not pull off a limit switch.',
        next: [
          'Check the limit switch and its wiring.',
          'Unlock, jog the axis off the switch, home again.',
          'The pull-off ($27) may be too short: change it with your controller’s tool.',
        ],
      },
      9: {
        what: 'Homing found no limit switch within the search distance.',
        next: ['Check the limit switches and their wiring.', 'Home again.'],
      },
      10: {
        what: 'Homing found no second switch for a self-squared axis.',
        next: ['Check both switches of the axis.', 'Home again.'],
      },
    } as Readonly<Record<number, { what: string; next: readonly string[] }>>,
    other: { what: '', next: ['Reset (immediate), then home the machine.'] },
  },

  /** Connect to a real controller (docs/modes/run-machine.md#ports-and-the-port-picker). */
  serial: {
    connectTo: 'Connect to',
    virtual: 'Virtual machine',
    serialPort: 'Serial port',
    port: 'Serial port',
    portPlaceholder: 'Choose a port',
    noPortsShort: 'No serial ports',
    noPorts: 'No serial ports found. Connect the controller by USB and refresh.',
    refresh: 'Refresh ports',
    baud: 'Baud',
    mismatch: (
      against: 'plan' | 'machine',
      differences: readonly {
        setting: string
        field: string
        controller: string
        machine: string
      }[],
    ) =>
      `The controller's settings differ from the ${against === 'plan' ? 'plan’s machine' : 'library machine'}: ${differences
        .slice(0, 3)
        .map(
          (d) =>
            `${d.setting} ${d.field} is ${d.controller} on the controller, ${d.machine} in the ${against === 'plan' ? 'plan' : 'library'}`,
        )
        .join(
          '; ',
        )}${differences.length > 3 ? `; and ${differences.length - 3} more` : ''}. Runs are refused until they match.${
        differences.some((d) => d.setting === '$30' || d.setting === '$31')
          ? ' If your speed controller needs a $31/$30 other than the usable speed range, set it in the machine’s Controller PWM range ($31 / $30).'
          : ''
      }`,
    homingOff: 'Homing is off on the controller ($22=0): DFYOM runs only on a homed machine.',
    review: 'Review',
  },

  /** Home on a real connection while not homed (run.md § Safety 3). */
  homeConfirm: {
    title: 'Home the machine?',
    description:
      'It moves to its home corner. Keep hands clear and know where the emergency stop is.',
    confirm: 'Home',
  },

  /** Z touch plate (docs/modes/run-machine.md#probing-and-re-zero-m4). */
  probe: {
    button: 'Probe Z',
    hint: (thickness: string) => `Touch plate ${thickness}: Z0 on the stock top.`,
    confirmTitle: 'Probe Z?',
    confirmDescription: (thickness: string, surface?: string) =>
      `Put the touch plate on ${surface ?? 'the stock'} under the bit and the clip on the bit. The spindle must be off. The bit moves down until it touches the plate (at most 25 mm). Plate thickness: ${thickness}.`,
    confirm: 'Probe',
  },

  /** DF69: "Move to touch-off spot" at a tool change (docs/modes/z-reference.md#dfyom-run). */
  touchOff: {
    button: 'Move to touch-off spot',
    confirmTitle: 'Move to the touch-off spot?',
    confirmDescription: (spot: string, surface: string) =>
      `The spindle must be off. The bit rises to the clearance height if it is lower, then moves to ${spot} over ${surface}. A longer new tool sits lower than the last one: check that it clears the part.`,
    confirm: 'Move',
  },

  /** The gCode panel under the 3D view (DF84, docs/modes/run.md#gcode-panel-df84). */
  gcode: {
    title: 'gCode',
    region: 'gCode',
    list: 'Program lines',
    legend:
      'Muted lines have run. The highlighted line is the one the machine executes (estimated). A filled mark: acknowledged by the controller, waiting in its planner; a hollow mark: sent, not yet acknowledged.',
    follow: 'Follow',
    followHint: 'Keep the executing line in view. Scrolling the list turns it off.',
    resize: 'Resize the gCode panel',
    empty: 'The program shows here once a run starts.',
    loading: 'Loading the program…',
    gone: 'This run’s program is no longer kept.',
    line: (n: number, total: number) =>
      `Line ${n.toLocaleString('en-GB')} / ${total.toLocaleString('en-GB')}`,
    lines: (total: number) => `${total.toLocaleString('en-GB')} lines`,
  },

  /** Feed, spindle and rapid overrides (docs/modes/run-machine.md#overrides-m6). */
  overrides: {
    title: 'Overrides',
    feed: 'Feed',
    spindle: 'Spindle',
    rapids: 'Rapids',
    minus: '−10 %',
    plus: '+10 %',
    reset: 'Reset',
    minusLabel: (what: string) => `Decrease ${what.toLowerCase()} override by 10 %`,
    plusLabel: (what: string) => `Increase ${what.toLowerCase()} override by 10 %`,
    resetLabel: (what: string) => `Reset ${what.toLowerCase()} override to 100 %`,
    percent: (v: number) => `${Math.round(v)} %`,
    unknown: '–',
    hint: 'Overrides apply until reset or the program ends.',
    /** DF85: the slider per row. */
    sliderLabel: (what: string) => `${what} override`,
    /** The effective value next to the percent while a run streams. */
    effectiveFeed: (value: string, units: string) => `F ${value} ${units}`,
    effectiveSpindle: (rpm: number) => `S ${rpm.toFixed(0)} rpm`,
    spindleOff: 'Spindle off',
    valueText: (pct: number, effective: string | undefined) =>
      effective === undefined ? `${pct} %` : `${pct} %, ${effective}`,
    capFeed: (max: number, value: string, units: string) =>
      `Up to ${max} %: the machine's max feed is ${value} ${units}.`,
    capSpindle: (max: number, rpm: number) =>
      `Up to ${max} %: the machine's max spindle speed is ${rpm.toFixed(0)} rpm.`,
    /** DF86 follow-up: the floor at the spindle's usable minimum speed. */
    floorSpindle: (min: number, rpm: number) =>
      `From ${min} %: lower is below the spindle's minimum speed (${rpm.toFixed(0)} rpm).`,
    noSpindleManual: 'The spindle speed is set by hand on this machine: no spindle override.',
    noSpindleLaser: 'Laser mode is on ($32=1): no spindle override.',
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
    /** Without a project (DF80): machine control works; only a plan run needs a project. */
    noProject: {
      title: 'Open a project to run a plan',
      description: 'Connecting, homing, jogging and setting the work zero need no project.',
      action: 'Open project',
    },
    startRun: 'Start run',
    done: (lines: number, time: string) => `Run complete: ${lines} lines in ${time}.`,
    stopped: 'Run stopped. The machine kept its position.',
    failed: 'Run failed.',
    waitingToolChange: (n: number, name: string) => `Waiting for tool change ${n}: ${name}`,
    waitingPause: (message: string) => `Paused: ${message}`,
    openWait: 'Show instructions',
    waitingSetupChange: (n: number, name: string) =>
      `Next: setup ${n}, ${name}. Turn the stock and set the work zero.`,
    /** Section resume (M5, docs/modes/run-machine.md#section-resume-m5). */
    resumeFrom: 'Resume from…',
    /** Whose run (M7): plan and setup of the running job. */
    runOf: (plan: string, setup: number, setups: number, setupName: string) =>
      setups > 1 ? `${plan} · setup ${setup} of ${setups}: ${setupName}` : plan,
    startedElsewhere: 'Started in another window or by an agent.',
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
    serialTarget: (path: string, baud: number) => `Serial port ${path} at ${baud} baud`,
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
    /** Real connection (docs/modes/run-machine.md#pre-flight-on-a-real-machine). */
    startMachine: 'Start on the machine',
    planStatus: 'Plan status',
    airCut:
      'First run of this program? Run it in the air: spindle off, Z zero raised above the stock.',
    notFinalized: 'A real machine runs only finalized plans. Finalize the plan in Plan mode first.',
    settingsMismatch: 'The controller’s settings differ from the plan’s machine (see Connection).',
    cancel: 'Cancel',
    /** Resume mode (M5, docs/modes/run-machine.md#section-resume-m5). */
    resumeTitle: 'Resume run?',
    resumeDescription: 'Restart the program at the start of an operation, never inside one.',
    resumeAt: 'Resume at',
    resumePoint: (label: string, tool: number, toolName: string) =>
      `${label} · tool ${tool}: ${toolName}`,
    stoppedHere: (point: string) => `${point} (stopped here)`,
    resumeNote:
      'The run waits at the tool first: check or change it and set Z zero, then continue. The spindle starts and the machine moves to the operation’s start at the clearance height.',
    resume: 'Resume run',
    resumeMachine: 'Resume on the machine',
    /** DF85: the plan was edited since the stop. */
    planChanged:
      'The plan changed since the stop: the resumed program is exported from the current plan.',
    stoppedRemoved:
      'The operation the run stopped in is no longer in this setup. Choose where to resume.',
    reordered: 'The operations were reordered since the stop. Check where to resume.',
  },

  toolChange: {
    title: (n: number) => `Tool change ${n}`,
    description: (name: string) => `The run waits. Change to ${name}, set Z zero, then continue.`,
    steps: (name: string, surface?: string, spot?: string) => [
      'Raise the spindle clear of the part (jog Z+).',
      `Change to ${name}.`,
      surface === undefined
        ? 'Touch off the new tool and set Z zero.'
        : `Touch off the new tool on ${surface}${spot === undefined ? '' : ` at ${spot}`} and set Z zero there.`,
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
    picture: (
      up: string,
      front: string,
      right: string,
      zero = 'the front-left corner of the top',
    ) =>
      `The stock on the machine: ${up} face up, ${front} face towards you, ${right} face on the right. The work zero is ${zero}.`,
    /** DF78 (N7): where the setup's work zero is, in words for the picture and the steps. */
    zeroAt: (zero: { readonly offset?: readonly [string, string]; readonly point?: string }) =>
      zero.point !== undefined
        ? `on ${zero.point}`
        : zero.offset !== undefined
          ? `X ${zero.offset[0]}, Y ${zero.offset[1]} from the front-left corner of the top`
          : 'the front-left corner of the top',
    faces: { up: 'Up', front: 'Front', right: 'Right' },
    workZero: 'Work zero',
    /** The zero to set (M7, docs/modes/run-machine.md#run-status-and-the-zero-to-set-m7). */
    zeroToSet: 'Zero to set',
    zeroText: (zero = 'at the front-left corner of the top') =>
      `X0 Y0 ${zero}, Z0 on the top surface.`,
    zeroCorner: (corner: string) => `This is the part’s ${corner} corner.`,
    /** DF78 (N9): the zero is offset from the corner. */
    offsetCorner: (corner: string) => `That corner is the part’s ${corner} corner.`,
    stockOnMachine: 'Stock on the machine',
    zeroLabel: 'X0 Y0',
    steps: (up: string, zero = 'the front-left corner of the top') => [
      'Raise the spindle clear of the stock (jog Z+).',
      `Turn the stock so its ${up} face is up, as in the picture, and clamp it.`,
      zero === 'the front-left corner of the top'
        ? 'Set the work zero on the new top: X and Y at its front-left corner, Z on its surface.'
        : `Set the work zero on the new top: X and Y ${zero.replace(/^the /, 'at the ')}, Z on its surface.`,
      'Start the setup.',
    ],
    start: (n: number) => `Start setup ${n}`,
    /** DF78: the alignment step (docs/modes/alignment.md#run-the-alignment-step). */
    align: {
      title: 'Alignment',
      intro: (n: number) =>
        `After the work zero is set, the spindle points at the zero and ${n === 1 ? 'the alignment point' : `the ${n} alignment points`} in turn. Turn or slide the stock until each lines up, check it, then confirm.`,
      start: 'Start alignment',
      confirmTitle: 'Move the spindle over the alignment points?',
      confirmDescription:
        'It moves at the clearance height each time you press Previous or Next. Keep your hands clear while it moves; the spindle must be off.',
      previous: 'Previous',
      next: 'Next',
      listLabel: 'Alignment points',
      at: (x: string, y: string) => `X ${x} · Y ${y}`,
      current: 'pointer here',
      linesUp: (name: string) => `${name} lines up`,
      setZeroHere: 'Set zero here',
      setZeroHereHint: 'Sets X and Y of the work zero at the pointer; clears every check.',
      zeroOnPoint: 'Zero on this point',
      zeroOnPointHint:
        'For a sawn or cut-away corner: the work zero follows this point. Clears every check.',
      confirm: 'Confirm alignment',
      confirmed: (skipped: number) =>
        skipped === 0 ? 'Alignment confirmed.' : `Alignment confirmed, ${skipped} not checked.`,
      skipTitle: (unticked: number, all: number) =>
        `${unticked} of ${all} points not checked. Continue anyway?`,
      skipDescription: 'The setup starts without them being lined up.',
      skipConfirm: 'Continue',
      pending: 'Confirm the alignment first.',
      zeroName: 'Work zero',
      /** Q108 (assumed): a mark on a side wall checks one axis. */
      oneAxis: (axis: 'x' | 'y') => `${axis.toUpperCase()} only`,
      oneAxisHint: (axis: 'x' | 'y') =>
        `On a side of the stock: it checks ${axis.toUpperCase()} only. Lower the pointer beside the side to sight it.`,
      /** Q107 (assumed): the step is a docked Run panel; the prompt points to it. */
      panelLabel: (setup: string) => `Alignment of ${setup}`,
      handover: (n: number) =>
        `Line up the stock in the Alignment panel beside the DRO (${n === 1 ? '1 point' : `${n} points`}): the jog pad and the position stay in view while you nudge it. Come back here to start.`,
      handoverDone: 'Alignment confirmed in the Alignment panel.',
      openPanel: 'Align in the Run panel',
      backToChange: (n: number) => `Back to the setup change (start setup ${n})`,
      setupFor: (n: number, name: string) => `Setup ${n}, ${name}`,
    },
    /** Like the pauses' "Close (stay paused)" (DF46): says what closing does (DF48). */
    later: 'Close (start later)',
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
    /** A real connection lost during the run (run-machine.md#lost-connection-m2). */
    lostTitle: 'Connection to the machine lost',
    lostText: 'It may still be moving and the spindle may still be on: use the emergency stop.',
    lostNext:
      'Check the cable and the controller’s power, then connect again and home the machine before the next run.',
    close: 'Close',
  },

  noPlan: 'Choose a plan in the navigator.',
}
