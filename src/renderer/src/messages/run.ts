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
    /** The step picker (DF88, docs/conventions/ui.md#jog-position-and-probing-df88). */
    stepCaption: 'Step',
    stepPresets: 'Jog step presets',
    stepPreset: (value: string, unit: string) => `${value} ${unit}`,
    customStep: 'Custom jog step',
    customPlaceholder: 'Custom',
    customInvalid: (max: string, unit: string) => `Above 0, at most ${max} ${unit}`,
    jogFeed: 'Jog feed',
    /** How the pad works, the pad's description. */
    jogHint: 'Click to jog one step; hold to jog until released.',
    /** After a real connection was lost without a reset (run-machine.md#lost-connection-m2). */
    lost: 'Connection to the machine lost. It may still be moving and the spindle may still be on: use the emergency stop.',
    /**
     * DF129 RC4: auto-reconnect after a connection lost during a run, calm and polite
     * (docs/modes/run-recovery.md#implementation-rc4).
     */
    reconnect: {
      region: 'Reconnecting',
      trying: (attempt: number) => `Reconnecting… attempt ${attempt}`,
      tryingHint:
        'DFYOM connects again by itself. Reconnecting restarts the controller, which stops it; nothing moves until you say so.',
      reconnected: 'Reconnected — machine needs homing',
      reconnectedHint:
        'The controller restarted, so it no longer knows where the spindle is. Home it before you continue.',
      gaveUp: 'Gave up after 2 min — reconnect manually',
      gaveUpHint: 'Check the cable and the controller’s power, then connect again.',
      stop: 'Stop trying',
      simulate: 'Simulate a lost connection',
      simulateHint: 'Practise: pull the virtual machine’s cable mid-run and see it reconnect.',
    },
    /** DF88: only Probe Z is left of the former "Work zero" section. */
    probing: 'Probing',
    noPlate: 'Set the machine’s touch plate thickness in the Library to probe Z.',
    zeroAxis: (axis: string) => `Zero ${axis}`,
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
    /** DF88: per library machine, cleared in Settings. */
    dontAsk: 'Don’t ask again for this machine',
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
    /** DF129 RC3: the pre-flight's start line, the skipped lines and the lead-in. */
    startLegend:
      'Muted lines are skipped. The highlighted line is where the run starts, after its lead-in.',
    startLine: (n: number) => `Starts at line ${n.toLocaleString('en-GB')}`,
    startFromHere: 'Start from here…',
    rowMenu: (n: number) => `Line ${n.toLocaleString('en-GB')}`,
    /** DF129 RC6: an interrupted run's range of lines. */
    interruptedLegend:
      'Muted lines had run. The highlighted lines are where the run was interrupted; a hollow mark: sent, the controller may have run it too.',
    interruptedAt: (from: number, to: number) =>
      from === to
        ? `Interrupted at line ${from.toLocaleString('en-GB')}`
        : `Interrupted at lines ${from.toLocaleString('en-GB')}–${to.toLocaleString('en-GB')}`,
  },

  /**
   * DF129 RC3: the pre-flight's "Start at" (docs/modes/run-recovery.md#start-from-a-line): where
   * the program starts, the lead-in that brings the tool there, and the findings of a chosen line.
   */
  startAt: {
    label: 'Start at',
    beginning: 'Beginning',
    chooseLine: 'Choose a line…',
    lineField: 'Line',
    lineHint: (total: number) =>
      `1 to ${total.toLocaleString('en-GB')}. Press Enter to check the line.`,
    loading: 'Reading the program…',
    noPoints: 'No resume points found in this program: choose a line.',
    /** An option of the select: an operation's first pass, or a later pass. */
    operationStart: (line: number) => `Operation start · line ${line.toLocaleString('en-GB')}`,
    pass: (k: number, line: number) => `Pass ${k} · line ${line.toLocaleString('en-GB')}`,
    beforeOperations: 'Before the first operation',
    skipped: (from: number) =>
      from <= 2
        ? 'Line 1 is skipped.'
        : `Lines 1–${(from - 1).toLocaleString('en-GB')} are skipped: the machine runs from line ${from.toLocaleString('en-GB')} on.`,
    snapped: (asked: number, at: number) =>
      `Line ${asked.toLocaleString('en-GB')} is not a resume point: the run starts at the pass start on line ${at.toLocaleString('en-GB')} before it.`,
    useAnyway: (n: number) => `Start at line ${n.toLocaleString('en-GB')} anyway`,
    notAPoint: (n: number) =>
      `Line ${n.toLocaleString('en-GB')} is not an operation or pass start. Read what the lead-in does there.`,
    usePoint: (n: number, where: 'before' | 'after') =>
      `Use line ${n.toLocaleString('en-GB')} (resume point ${where})`,
    checking: 'Checking the start…',
    failed: 'The run cannot start at this line:',
    leadIn: 'Lead-in',
    leadInIntro: 'Before the program, the machine runs these steps:',
    leadInCode: 'Show the lead-in gCode',
    /** Q167: every lead-in waits at the tool. */
    toolWaitTitle: (n: number, name: string) => `The run first waits at tool ${n}: ${name}`,
    toolWaitText:
      'Nothing cuts before you continue: check or change the bit, set Z zero (Probe Z or Set Z zero here), then Continue.',
    steps: {
      retract: 'Spindle and coolant off, then straight up to the machine top.',
      toolWait: (n: number) => `Waits at tool ${n} (the tool-change dialog).`,
      coolant: (flood: boolean) => (flood ? 'Coolant on (flood).' : 'Coolant on (mist).'),
      spindle: (rpm: string, ccw: boolean, dwell: string | undefined) =>
        `Spindle on at ${rpm} rpm${ccw ? ' (counter-clockwise)' : ''}${dwell === undefined ? '.' : `, then waits ${dwell} s for it to spin up.`}`,
      spindleManual: (rpm: string) => `Pauses: start the spindle by hand at ${rpm} rpm.`,
      moveXY: (x: string, y: string, unit: string) => `Rapid to X ${x} Y ${y} ${unit} at the top.`,
      approach: (z: string, unit: string) => `Rapid down to Z ${z} ${unit}.`,
      plunge: (z: string, unit: string, feed: string | undefined) =>
        feed === undefined
          ? `Down to Z ${z} ${unit}.`
          : `Plunges to Z ${z} ${unit} at ${feed} ${unit}/min.`,
      program: (line: number) => `Runs the program from line ${line.toLocaleString('en-GB')}.`,
    },
    findings: {
      inMaterial: (z: string, unit: string) =>
        `The line starts in the material at Z ${z} ${unit}: the bit plunges straight into the cut. Fine for an end mill that cuts at its centre; a V-bit or a drill-style plunge may not be.`,
      ramp: (helix: boolean, from: number) =>
        `This line is part of ${helix ? 'a helical entry' : 'a ramp'}; starting here plunges straight down. Start at its first line (line ${from.toLocaleString('en-GB')}) instead.`,
      rampAction: (from: number) => `Start at line ${from.toLocaleString('en-GB')}`,
      incremental: 'This part of the program moves incrementally (G91).',
    },
    startAtLine: (n: number) => `Start at line ${n.toLocaleString('en-GB')}`,
    startMachineAtLine: (n: number) => `Start on the machine at line ${n.toLocaleString('en-GB')}`,
    /** The tool-change dialog of a lead-in. */
    waitNote:
      'This is the start’s tool wait: check the bit is intact and tight, set Z zero, then continue. The spindle starts and the machine moves to the start line after it.',
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
    /** DF88: the per-axis zero buttons in the table. */
    zero: '0',
    setZero: (axis: string) => `Set ${axis} zero`,
    /** DF128: a coordinate's Go to button. */
    goTo: (axis: string, value: string, frame: 'work' | 'machine') =>
      `Go to: ${axis} ${value} ${frame}`,
    workZeroHint: 'Set the work zero (G54) per axis at the current tool position with its 0.',
  },

  /**
   * DF133: the setup's workholding in the Run scene and its status line under the Position table
   * (docs/modes/run-workholding.md#trust-what-the-guard-knows). RW1 draws; the jog guard (RW3)
   * replaces "are not checked" with the doc's guard wording.
   */
  guard: {
    noItems: 'No workholding in this setup.',
    notHomed: 'Clamps outlined: home the machine to place them at the work zero.',
    zeroUnset: 'Clamps hidden: set the work zero to place them.',
    trusted: 'Clamps drawn as placed in Plan, at the work zero. Jogs are not checked against them.',
    /** The holder ghost's chip: the tool the scene assumes in the spindle (Q189). */
    tool: (n: number, diameter: string, stickout: string, holder: string) =>
      `T${n} Ø${diameter} · stickout ${stickout} · ${holder}`,
    /** A measured holder has no name. */
    nut: (diameter: string) => `nut Ø${diameter}`,
  },

  /** DF128: the Go to dialog (docs/modes/run-goto.md). */
  goTo: {
    title: 'Go to',
    description: 'Type where the spindle should go. Nothing moves until Go.',
    frame: 'Frame',
    work: 'Work (G54)',
    machine: 'Machine (G53)',
    mode: 'Target',
    absolute: 'Absolute',
    relative: 'Relative',
    relativeFrame: 'Relative moves are the same in both frames.',
    axis: (axis: string, unit: string) => `${axis} (${unit})`,
    invalid: 'Not a length: type a number or an expression (12.5, 3/8in, 100 - 2).',
    shortcuts: 'Fill in',
    workZeroXY: 'Work zero XY',
    workZero: 'Work zero',
    machineTop: 'Machine top Z',
    liftTop: 'Lift to the top first',
    steps: 'Steps',
    stepUp: (z: string) => `Up to Z ${z}`,
    stepDown: (z: string) => `Down to Z ${z}`,
    stepXY: (x: string, y: string) => `To X ${x} Y ${y}`,
    feed: (xy: string, z: string, unit: string) =>
      xy === z ? `at ${xy} ${unit}` : `at ${xy} ${unit} (Z ${z})`,
    seconds: (s: number) =>
      s < 60
        ? `about ${s} s`
        : `about ${Math.floor(s / 60)} min${s % 60 === 0 ? '' : ` ${s % 60} s`}`,
    /** GT2: the target marker's chip in the 3D view. */
    target: 'Go to target',
    /** GT2: the jog section's menu (Q157). */
    menu: 'Jog options',
    open: 'Go to…',
    openHint: 'Type coordinates to move to, in work or machine coordinates',
    already: 'Already there.',
    travel: (axis: string, target: string, min: string, max: string, unit: string) =>
      `${axis} would leave the travel: the target is at machine ${target}, the travel is ${min} to ${max} ${unit}.`,
    unknown: 'Home the machine first: the position is unknown.',
    jogging: 'The machine is still jogging.',
    spindleOn: 'Stop the spindle first.',
    spindleReal: 'Make sure the spindle is off.',
    moving: (n: number, of: number) => `Moving: step ${n} of ${of}`,
    stopped: (x: string, y: string, z: string) => `Stopped at X ${x} Y ${y} Z ${z}.`,
    go: 'Go',
    stop: 'Stop',
    cancel: 'Cancel',
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

  /** DF93: an external gCode file (docs/modes/run.md#run-an-external-g-code-file-df93). */
  file: {
    open: 'Run gCode file…',
    openHint:
      'A program from another CAM, or an earlier export. It runs after the same checks as a plan.',
    recent: 'Recent files',
    close: 'Close file',
    loading: (name: string) => `Reading ${name}…`,
    failed: (name: string) => `${name} cannot be read.`,
    facts: 'File',
    lines: 'Lines',
    units: 'Units',
    unitNames: { mm: 'mm (G21)', inch: 'inch (G20)', unknown: 'not set (runs in mm)' },
    toolChanges: 'Tool changes',
    noToolChanges: 'None',
    toolChange: (n: number, name: string) => `${n}: ${name}`,
    extent: 'Extent (work coordinates)',
    extentAxis: (axis: string, min: string, max: string, unit: string) =>
      `${axis} ${min} to ${max} ${unit}`,
    warnings: 'Warnings',
    refusals: (n: number) => (n === 1 ? '1 line cannot run' : `${n} lines cannot run`),
    refusalsFix: 'Change these lines in the CAM post, then open the file again.',
    issue: (line: number, message: string) => `Line ${line}: ${message}`,
    more: (n: number) => `and ${n} more`,
    runOf: (name: string) => `File ${name}`,
    startRun: 'Start run',
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
    /** DF93: a file run. */
    file: 'File',
    fileSettingsMismatch:
      'The controller’s settings differ from the connection’s machine (see Connection).',
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
    /** DF132 H3: the program's reason line before the marker ("Collet nut must clear Toe clamp 2, holder ER11"). */
    stickoutReason: (reason: string) =>
      `${reason}: chuck the tool with at least the stickout above.`,
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

  /**
   * DF129 RC5: the recovery panel after an interrupted run, calm and step by step
   * (docs/modes/run-recovery.md#the-recovery-panel, #implementation-rc5).
   */
  recovery: {
    region: 'Interrupted run',
    title: 'The run was interrupted',
    subtitle: 'DFYOM kept where the job was. Follow the steps to continue.',
    /** The short sheet that replaces the failure dialog. */
    sheetDescription:
      'DFYOM kept where the job was. The Run inspector takes you through continuing.',
    showSteps: 'Show the steps',
    later: 'Later',
    happened: {
      connectionLost: (time: string, into: string) =>
        `The USB connection dropped at ${time}, ${into} into the run.`,
      hostExit: (time: string, into: string) =>
        `DFYOM’s machine connection stopped at ${time}, ${into} into the run.`,
      controllerReset: (time: string, into: string) =>
        `The controller restarted by itself at ${time}, ${into} into the run.`,
      machinePowerLost: (time: string) =>
        `You said the machine lost power (marked at ${time}). DFYOM cannot tell when it went, so it counts the position as lost.`,
      appCrashed: (time: string) =>
        `DFYOM was closed unexpectedly while the run was streaming (last saved ${time}).`,
    },
    practice: 'A practice run on the virtual machine.',
    factsLabel: 'Where the job was',
    operation: 'Operation',
    operationOf: (label: string, n: number, of: number) => `${label} (operation ${n} of ${of})`,
    tool: 'Tool',
    toolName: (n: number, name: string) => `Tool ${n}: ${name}`,
    lastSeen: 'Last seen',
    work: 'work',
    machine: 'machine',
    seenBefore: (seconds: string) => `${seconds} s before the run ended`,
    feedSpindle: 'Feed, spindle',
    spindleOff: 'spindle off',
    spindleRpm: (rpm: string) => `spindle ${rpm} rpm`,
    lines: 'Lines',
    range: (from: number, to: number) =>
      from === to
        ? `It was cutting around line ${from}`
        : `It was cutting around lines ${from}–${to}`,
    mayHaveContinued: (sent: number) => `; the controller may have continued up to line ${sent}.`,
    percent: (p: number) => `About ${p} % into the program.`,
    from: {
      reported: 'The controller reported the line.',
      estimate: 'Estimated from the last status report.',
      planner: 'Counted back from the lines the controller confirmed.',
    },
    notYet: 'No line had started yet.',
    steps: 'Steps',
    done: 'Done',
    stepState: { done: 'done', current: 'next step', upcoming: 'later' },
    safe: {
      title: 'Make it safe',
      moving:
        'The machine may still be moving, and the spindle may still be on. If it is, press the emergency stop.',
      stopped: 'The machine is stopped',
      reconnected:
        'Reconnected. The controller restarted, so it stopped moving and switched the spindle output off. A spindle switched by hand is still on: switch it off.',
      confirmed: 'You confirmed the machine is stopped.',
      reset: 'The controller restarted, so it stopped moving and switched the spindle output off.',
    },
    reconnect: {
      waiting: (attempt: number, seconds: number) =>
        attempt === 0
          ? `Reconnecting… next attempt in ${seconds} s`
          : `Reconnecting… attempt ${attempt} failed, next in ${seconds} s`,
      connecting: (attempt: number) => `Connecting… attempt ${Math.max(1, attempt)}`,
      gaveUp: 'DFYOM stopped trying after 2 minutes.',
      gaveUpHint: 'Check the cable, switch the controller off and on, then try again.',
      closed: 'Not connected.',
      now: 'Reconnect now',
      again: 'Try again',
      connect: 'Connect',
      stop: 'Stop trying',
    },
    check: {
      title: 'Check the machine',
      intro: 'Have a look before anything moves. Nothing here is enforced.',
      items: {
        bit: 'The bit is intact and tight in the collet.',
        stock: 'The stock has not moved (clamps, screws, tape).',
        chips: 'Chips are cleared and nothing is in the way.',
      },
      gantry: 'Moving the gantry by hand does not matter now: homing finds the position again.',
      done: 'Checked',
      summary: (n: number, of: number) =>
        n === of ? 'Everything checked.' : `${n} of ${of} checked.`,
    },
    home: {
      title: 'Connect and home',
      why: 'The controller restarted, so it no longer knows where the spindle is. Homing finds it again.',
      whyPower: 'The machine lost power, so its position is lost. Homing finds it again.',
      button: 'Home the machine',
      homed: 'The machine is homed.',
      alarmFirst: 'Clear the alarm first: see the steps in the navigator.',
    },
    zero: {
      title: 'Check the work zero',
      same: (xyz: string) =>
        `The controller kept the work zero: ${xyz} (G54), the same as during the run.`,
      differs: (now: string, then: string) =>
        `The work zero differs from the run’s: ${now} now, ${then} during the run.`,
      restore: 'Restore the run’s work zero',
      restoreTitle: 'Restore the run’s work zero?',
      restoreDescription: (xyz: string) =>
        `G54 is set back to ${xyz} (machine), as it was during the run.`,
      unknown: 'Home the machine to compare the work zero with the run’s.',
      goLast: 'Go to the last position',
      goLastHint: 'Above the stock: the bit should hang right over the cut it was making.',
      goZero: 'Go to the work zero',
      goZeroHint: 'Above the zero corner, to see that it lines up.',
      moved:
        'You did not tick “the stock has not moved”: jog to the stock’s zero corner and set X and Y zero. Resuming after the stock moved may leave a visible step.',
      zNote: 'If the bit was changed or slipped, Z zero is set again at the resume’s tool wait.',
      next: 'The work zero is right',
    },
    goTo: {
      title: (what: string) => `${what}?`,
      description: (xy: string, z: string) =>
        `The bit moves up to Z ${z} first, above the stock, then across to ${xy} (work coordinates).`,
      up: (z: string) => `Up to Z ${z}`,
      across: (xy: string) => `Across to ${xy}`,
      down: (z: string) => `Down to Z ${z}`,
      seconds: (s: number) => `About ${s} s.`,
      already: 'The bit is already there.',
      move: 'Move',
    },
    choose: {
      title: 'Choose how to continue',
      recommended: 'Recommended',
      near: 'Resume near where it stopped',
      nearText: (line: number, label: string | undefined, from: number) =>
        `From ${label === undefined ? 'the pass start' : label} at line ${line}, just before the interrupted lines. Lines ${line}–${from} are cut again, mostly in air.`,
      nearStart: (line: number) =>
        `From line ${line}, where the cut it had reached starts. Whatever it already cut there is cut again, mostly in air.`,
      operation: 'Resume from the operation’s start',
      operationText: (line: number, label: string | undefined) =>
        `From the start of ${label ?? 'the operation'} (line ${line}): the safest choice if you are unsure the stock stayed put.`,
      line: 'Choose a line…',
      lineText: 'Pick another start line in the pre-flight.',
      again: 'Start again from the beginning',
      againText: 'Everything already cut is cut again in air.',
      after: 'The pre-flight shows the lead-in and checks the travel before anything moves.',
      noProgram: 'Open the project or the file the run was from to resume it.',
      changed: 'The plan changed since the run: resume from an operation instead.',
      fileChanged: 'The file changed since the run.',
    },
    dismiss: 'Dismiss…',
    dismissAsk: 'Forget where the job stopped? The suggested resume point is gone after this.',
    dismissConfirm: 'Forget it',
    keep: 'Keep',
    why: 'Why does this happen?',
    causes: [
      'The computer went to sleep (DFYOM keeps it awake during real runs).',
      'The USB cable runs next to the spindle or VFD wires; a shielded cable with a ferrite helps.',
      'An unpowered USB hub, or a loose connector.',
      'Electrical noise from the spindle through a shared ground.',
    ],
    /** Q171: after a Stop, in the run section. */
    powerLost: 'The machine lost power',
    powerLostHint:
      'If the machine’s power went while the controller stayed on USB: DFYOM marks the position lost and helps you resume.',
    /** Q171 while idle: the Position table's menu (RC6). */
    positionMenu: 'Position options',
    powerLostItem: 'The machine lost power…',
    powerLostItemHint: 'Marks the position lost, so the machine is homed before it moves',
    powerLostTitle: 'The machine lost power?',
    powerLostDescription:
      'If the machine’s power went while the controller stayed on USB, the position shown is wrong. DFYOM marks it lost: home the machine before moving it.',
    powerLostConfirm: 'Mark the position lost',
    powerLostNotNow: 'Only while the machine is connected, homed and idle.',
    /** RC6: the run the last session left interrupted (the journal at launch). */
    launch: {
      source: 'From',
      plan: (plan: string, setup: number, setups: number, setupName: string) =>
        setups > 1
          ? `${plan}, setup ${setup} of ${setups} (${setupName})`
          : `${plan} (${setupName})`,
      project: (name: string) => `Project ${name}`,
      untitled: 'An unsaved project: restore it from the start panel’s unsaved changes.',
      openProject: 'Open project',
      projectMissing: 'The project is no longer at its path.',
      locateProject: 'Locate project…',
      file: (name: string) => `File ${name}`,
      openFile: 'Open file',
      fileMissing: 'The file is no longer at its path.',
      fileChanged:
        'The file changed since the run, so it cannot resume by line. If you kept the original, locate it.',
      locateFile: 'Locate file…',
      located: 'This window has the file with the run’s content.',
      notKept:
        'DFYOM did not find its copy of the program, so it cannot suggest where to resume: choose an operation or a line.',
      moving:
        'The machine ran out the lines it had and stopped, but the spindle may still be on. If it is, switch it off or press the emergency stop. Connecting restarts the controller, which switches the spindle output off.',
      connect: (port: string) => `Connect to ${port}`,
      connectVirtual: 'Connect to the virtual machine',
      connectHint:
        'DFYOM does not connect by itself after a restart: the machine may have been moved, or nobody is near it.',
      portMissing: (port: string) => `${port} is not listed: plug the machine in, then connect.`,
      virtualNote:
        'The virtual machine does not keep its work zero across a restart of DFYOM: restore the run’s work zero after homing.',
    },
  },

  noPlan: 'Choose a plan in the navigator.',
}
