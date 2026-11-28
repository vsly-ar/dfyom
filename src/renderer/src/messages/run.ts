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
    /** DF143: backed off a limit switch without homing (docs/modes/run-machine.md#unlock-and-back-off-df143). */
    unverified: 'Position unverified — re-home before cutting',
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
    /** v0.5 RV1: the jog feed while the spindle turns (Q217). */
    cuttingJogFeed: 'Cutting jog feed',
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
    /** DF134: `Pn:` shows a limit switch still pressed (homing would take it for home). */
    limitPressed: (axes: readonly string[]) =>
      `Release the ${axes.join(' and ')} limit switch${axes.length > 1 ? 'es' : ''} first.`,
    /** DF134: `Pn:D`: GRBL refuses to home or unlock while the safety door is open. */
    doorOpen: 'Close the safety door first.',
    noPlan: 'Choose a plan first.',
    nothingToStop: 'Nothing to stop: the machine is not moving.',
    otherPlan: 'The connection emulates another plan’s machine. Disconnect to switch plans.',
    /** DF143: backed off a limit switch: steps may be lost. */
    unverified: 'Home the machine first: the position is unverified after the limit switch.',
    /** DF143: the probe check (docs/modes/run-probing.md#probe-check-df143). */
    probeCheck: 'Touch the plate to the bit to test the probe first.',
  },

  /** A jog refused for leaving the travel (`run.travel`, docs/modes/run.md DF33), in the project's unit. */
  travel: (axis: string, side: 'max' | 'min', limit: string, target: string, unit: string) =>
    `${axis} would leave the travel: ${side} ${limit} ${unit}, the jog would end at ${target} ${unit}.`,
  travelUnknown: 'The jog would leave the machine travel (soft limits).',
  /** A continuous jog from the end of the travel (`run.travel`, `atEdge`). */
  travelAtEdge: (axis: string, side: 'max' | 'min', limit: string, unit: string) =>
    `${axis} is at the end of its travel (${side} ${limit} ${unit}).`,
  /** v0.5 RV7: the same against the work area (docs/modes/run.md#work-area-rv7). */
  workAreaJog: (axis: string, side: 'max' | 'min', limit: string, target: string, unit: string) =>
    `${axis} would leave the work area: ${side} ${limit} ${unit}, the jog would end at ${target} ${unit}.`,
  workAreaAtEdge: (axis: string, side: 'max' | 'min', limit: string, unit: string) =>
    `${axis} is at the end of the work area (${side} ${limit} ${unit}).`,

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
        what: 'A limit switch tripped; the controller stopped everything and the position may be lost.',
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
    /**
     * DF134: after Reset (immediate) from a hard or soft limit the controller waits locked: home
     * (recommended) or unlock, one line why (docs/modes/run-machine.md#after-a-hard-limit-df134).
     */
    afterReset: {
      title: (code: number) => `Alarm ${code}: reset done, still locked`,
      choice: {
        1: 'Home the machine (recommended): a hard limit stops the motors at once, so steps may be lost. Unlock keeps the position and the work zero as they are.',
        2: 'Home the machine (recommended), or unlock: the controller kept the position and the work zero.',
      } as Readonly<Record<number, string>>,
      limitPressed: (axes: readonly string[]) =>
        `The ${axes.join(' and ')} limit switch${axes.length > 1 ? 'es are' : ' is'} still pressed. Release it, then home. If the axis rests on its switch, unlock and jog it off (letting go may trip the alarm once more: reset again).`,
    },
    /**
     * DF143 (advanced user): a hard limit hit while jogging, outside a run
     * (docs/modes/run-machine.md#unlock-and-back-off-df143).
     */
    backOff: {
      button: 'Unlock and back off',
      what: (move: string, unit: string) =>
        `Resets the controller if needed, unlocks it and jogs ${move} ${unit} off the switch, slowly. Jogging waits meanwhile.`,
      unknown: 'The way off the switch is not known: home, or unlock and jog off it by hand.',
      after:
        'The position may be off (a hard stop can lose steps): it stays unverified until you home again, and runs wait for that.',
    },
    /** DF134: `Pn:` letters in words, for "Inputs active: …". */
    pins: {
      label: 'Inputs active',
      names: {
        X: 'X limit switch',
        Y: 'Y limit switch',
        Z: 'Z limit switch',
        P: 'probe',
        D: 'safety door',
        H: 'feed hold button',
        R: 'reset / emergency stop',
        S: 'cycle start button',
      } as Readonly<Record<string, string>>,
    },
    /**
     * DF134: the safety door outside a run (no Resume there): close it, then reset; GRBL keeps the
     * position when it was not moving.
     */
    door: {
      region: 'Safety door',
      open: 'Safety door open',
      openWhat: 'The safety door (or the input wired to it) is open: the controller holds.',
      openNext: 'Close it.',
      closed: 'Safety door closed',
      closedWhat: 'The controller waits for a cycle start before it takes commands again.',
      closedNext: 'Reset (immediate) to continue; the position and the work zero are kept.',
    },
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
    /** v0.5 RV3: Test probe (docs/modes/run-probing.md#test-probe-rv3). */
    input: (touching: boolean) =>
      touching
        ? 'Probe input: touching. Probing waits until it reads open.'
        : 'Probe input: open. Touch the clip to the plate to test it.',
    /** DF143: the probe check and the live input (docs/modes/run-probing.md#probe-check-df143). */
    check: {
      region: 'Probe input',
      open: 'Open',
      touching: 'Touching',
      label: 'Probe input',
      prompt: 'Touch the plate to the bit to test the probe.',
      release: 'Touching: now let go.',
      ok: 'Probe tested: probing is enabled.',
      waits: 'Touching: probing waits until it reads open.',
      touch: 'Touch probe',
      touchHint: 'The virtual machine: closes the probe input for a moment.',
    },
  },

  /** v0.5 RV5: Set X/Y zero (docs/modes/run-probing.md#set-xy-zero-rv5). */
  xyZero: {
    button: 'Set X/Y zero…',
    undo: 'Undo zero change',
    undoHint: (x: string, y: string, unit: string) =>
      `Puts G54 back to X ${x} Y ${y} ${unit} (machine).`,
    title: 'Set X/Y zero',
    description:
      'Pick a stock edge or corner, probe it or touch it with the bit, then set G54 so the plan’s zero lands right.',
    pick: 'Edge or corner',
    picks: {
      '-1,-1': 'Front left corner (X− Y−)',
      '0,-1': 'Front edge (Y−)',
      '1,-1': 'Front right corner (X+ Y−)',
      '-1,0': 'Left edge (X−)',
      '1,0': 'Right edge (X+)',
      '-1,1': 'Back left corner (X− Y+)',
      '0,1': 'Back edge (Y+)',
      '1,1': 'Back right corner (X+ Y+)',
    } as Record<string, string>,
    zeroOn: 'Plan zero: this corner.',
    zeroNear: 'Plan zero: at the ring.',
    noPlan: 'No plan: enter where the edge is in work coordinates.',
    edgeIs: (axis: string) => `This edge is ${axis} =`,
    method: 'Method',
    probe: 'Probe',
    touch: 'Touch',
    probeKindNo:
      'Probe X/Y needs an XYZ corner plate, the bit on a conductive stock or a 3D probe: set the probe kind in Machine settings (Probe), or touch the edge.',
    probeGeometryNo:
      'Set the corner plate’s thickness and wall offsets in Machine settings (Probe) to probe with it.',
    bit: 'Bit Ø',
    bitFromSpindle: (n: number) =>
      `From tool ${n} in the spindle; enter a measured Ø if you have one.`,
    bitEnter: 'No tool in the spindle is known: enter the bit’s Ø.',
    ball: (d: string, unit: string) => `3D probe ball Ø ${d} ${unit} (Machine settings).`,
    feeler: 'Feeler',
    feelerHint: 'Paper ≈ 0.1 mm; 0 when the bit itself touches.',
    probeSteps: (what: string, kind: 'xyzPlate' | 'tool' | '3d', reach: string, unit: string) =>
      kind === 'xyzPlate'
        ? `Hook the corner plate on the ${what}, put the clip on the bit and the bit over the plate top within ${reach} ${unit} of the ${what}. It probes Z on the plate, then each side from outside.`
        : kind === 'tool'
          ? `Put the clip on the bit and on the stock (it must conduct), and the bit over the stock top within ${reach} ${unit} of the ${what}. It probes Z, then each side from outside.`
          : `Put the 3D probe over the stock top within ${reach} ${unit} of the ${what}. It probes Z, then each side from outside.`,
    spindleOff: 'The spindle must be off. Nothing moves until you press Probe.',
    probeGo: 'Probe',
    probing: 'Probing…',
    touchSteps: (what: string) =>
      `Jog the bit beside the ${what}, below the top, with the feeler between. Use small steps (0.1 mm or a custom one) until the feeler just drags, then press Touching.`,
    touching: (edge: string) => `Touching ${edge} edge`,
    touched: (edge: string, at: string, unit: string) => `${edge} edge: touched at ${at} ${unit}.`,
    input: (touching: boolean) => (touching ? 'Probe input: touching.' : 'Probe input: open.'),
    measured: 'Measured',
    edge: (edge: string, value: string, pm: string, unit: string) =>
      `${edge} edge at ${value} ± ${pm} ${unit} (machine)`,
    radiusNote: (d: string, unit: string) => `With the Ø ${d} ${unit} as entered.`,
    newZero: 'New zero',
    change: (axis: string, from: string, to: string, delta: string, unit: string) =>
      `G54 ${axis}: ${from} → ${to} ${unit} (${delta})`,
    review: 'Review',
    set: 'Set zero',
    back: 'Back',
    cancel: 'Cancel',
    gate: {
      running: 'Not while a program runs.',
      spindle: 'Stop the spindle first.',
      invalid: 'Enter a valid Ø.',
      touchFirst: 'Touch each edge first.',
    },
  },

  /** v0.5 RV6: Check alignment (docs/modes/alignment.md#check-alignment-rv6). */
  /** v0.5 RV8: Test homing repeatability (docs/modes/run-machine.md#homing-repeatability-rv8). */
  /** v0.5 RV9: Calibration cut (docs/modes/run-calibration.md). */
  calibration: {
    button: 'Calibration cut…',
    title: 'Calibration cut',
    description:
      'Cut a small test on a free spot of the stock, measure it and get suggested corrections for steps/mm, the tool diameter or the feed.',
    test: 'Test',
    tests: { dimension: 'Dimension test', feedLadder: 'Feed ladder' },
    testHint: {
      dimension:
        'A square pocket, a square boss and a slot: measure them with calipers to check steps/mm, backlash and the tool diameter.',
      feedLadder:
        "Slots side by side at the tool's feed and stepped percentages: pick the one that cut best for a new preset.",
    } as Record<string, string>,
    tool: 'Tool',
    spotX: 'Centre X',
    spotY: 'Centre Y',
    suggestSpot: 'Suggest a free spot',
    size: 'Size',
    depth: 'Depth',
    vary: 'Vary',
    varies: { feed: 'Feed', stepdown: 'Stepdown' },
    spread: 'Spread ±%',
    steps: 'Steps',
    checking: 'Checking…',
    program: (lines: number, time: string) => `${lines} lines, about ${time}.`,
    previewed: 'Shown in the viewport.',
    travelNotChecked: 'Connect and home to check the soft limits and the work area.',
    finding: 'The program leaves the soft limits or the work area here: move the spot.',
    problems: {
      outsideStock: 'Not on the stock top (2 mm clear of its edges): move the spot.',
      operation: (what: string) => `Overlaps ${what}: move the spot.`,
      earlierCut: 'Overlaps an earlier calibration cut: move the spot.',
      workholding: (message: string) => message,
    },
    invalid: 'Enter a number.',
    run: 'Run calibration cut',
    homeFirst: 'Home the machine first.',
    noMachine: 'Choose a library machine: the results are kept with it.',
    fixFirst: 'Fix the problems above first.',
    confirm: {
      title: 'Run the calibration cut',
      description:
        'The machine cuts the test on the stock at the spot shown. It first waits for the tool and its Z zero. Keep clear of the machine; Stop halts it at once.',
      confirm: 'Run',
    },
    progress: 'Calibration cut',
    running: (done: number, total: number) => `Line ${done} of ${total}`,
    waitTool: 'Install the tool and zero Z, then continue.',
    waitPause: 'The program paused: continue when ready.',
    continue: 'Continue',
    stop: 'Stop',
    stopped: 'The cut was stopped: run it again on a fresh spot.',
    close: 'Close',
    last: (date: string, tool: string) => `Last cut ${date} with ${tool}.`,
    none: 'No calibration cut for this test yet.',
    readings: 'Measured',
    reading: {
      pocketX: 'Pocket X',
      pocketY: 'Pocket Y',
      bossX: 'Boss X',
      bossY: 'Boss Y',
      slot: 'Slot width',
      depth: 'Depth',
    } as Record<string, string>,
    nominal: (size: string, depth: string, unit: string) =>
      `Nominal: ${size} ${unit} square, ${depth} ${unit} deep.`,
    pick: 'Best step',
    stepLabel: (n: number, value: string, percent: number) =>
      `Step ${n}: ${value} (${percent > 0 ? '+' : ''}${percent} %)`,
    save: 'Save results',
    saved: 'Results saved.',
    suggestions: 'Suggestions',
    suggest: {
      ok: 'Every reading is within tolerance: nothing to correct.',
      toolDiameter: (d: string, delta: string, unit: string) =>
        `The tool cuts as Ø ${d} ${unit} (${delta} ${unit} off the library).`,
      stepsPerMm: (axis: string, percent: string) =>
        `${axis} moves ${percent} % off: correct its steps/mm.`,
      stepsNoLine: 'Connect to read the controller value for the exact line.',
      backlash: (axis: string, mm: string, unit: string) =>
        `X and Y differ by ${mm} ${unit} (${axis} wider): check for backlash or a loose belt on ${axis}.`,
      depth: (mm: string, unit: string) =>
        `The depth is ${mm} ${unit} off: check the Z zero and the Z steps/mm.`,
      ladder: (vary: string, value: string, percent: number) =>
        `Set the tool's ${vary} preset to ${value} (${percent > 0 ? '+' : ''}${percent} % of the current).`,
      ladderHint:
        "Presets follow the calculator unless you lock them: edit the tool's preset in the Library.",
    },
    copy: 'Copy',
    copied: (line: string) => `Copied ${line}`,
    applyDiameter: (d: string, unit: string) => `Set library Ø to ${d} ${unit}`,
    applied: (d: string, unit: string) => `Library Ø set to ${d} ${unit}.`,
    undo: 'Undo',
    undone: 'Library Ø restored.',
    noLibraryTool: 'The tool is not from the library: edit its Ø in the plan.',
  },

  /** v0.5 RV10: Map stock surface (docs/modes/run-surface.md). */
  surface: {
    button: 'Map stock surface…',
    title: 'Map stock surface',
    description:
      'Probe a grid of heights on the stock top; a run can then follow the measured surface.',
    steps:
      'Put the bit or probe a few mm above the first point (front left) of the stock top, within the search depth. Map surface probes the points row by row; the heat map fills as each one ends.',
    margin: 'Margin from the edges (mm)',
    layout: 'Points',
    layouts: { count: 'Columns × rows', spacing: 'Spacing' } as Record<'count' | 'spacing', string>,
    cols: 'Columns',
    rows: 'Rows',
    spacing: 'Spacing (mm)',
    clearance: 'Clearance between points (mm)',
    depth: 'Search depth (mm)',
    gridSummary: (
      cols: number,
      rows: number,
      dx: string,
      dy: string,
      unit: string,
      n: number,
      minutes: number,
    ) =>
      `${cols} × ${rows} points, ${dx} × ${dy} ${unit} apart: ${n} to probe, about ${minutes} min.`,
    skipped: (n: number, items: string) =>
      `${n} ${n === 1 ? 'point' : 'points'} skipped under ${items}: filled from their neighbours.`,
    probeHint: {
      zPlate:
        'The probe clip needs a conductive top (aluminium, or a foil on the stock); wood or MDF needs a 3D probe.',
      xyzPlate:
        'The probe clip needs a conductive top (aluminium, or a foil on the stock); wood or MDF needs a 3D probe.',
      tool: 'The bit probes the top: it needs a conductive top (aluminium, or a foil on the stock).',
      '3d': 'The 3D probe touches each point.',
    } as Record<string, string>,
    areaTooSmall: 'The margin leaves no area on the stock top.',
    countRange: (min: number, max: number) => `Columns and rows: ${min} to ${max}.`,
    positive: 'Clearance and search depth must be above 0.',
    allSkipped: 'Every point is under workholding: change the margin or the grid.',
    noPlan: 'Choose a plan: the map is kept with its setup.',
    spindleOn: 'Turn the spindle off first.',
    idleFirst: 'Wait until the machine is idle.',
    run: 'Map surface',
    retry: 'Retry from here',
    stop: 'Stop map',
    close: 'Close',
    stopped: 'Stopped: the points measured so far are kept.',
    failed: (n: number) => `Point ${n} failed: the points before it are kept.`,
    progress: 'Mapping',
    running: (k: number, n: number) => `Point ${k} of ${n}…`,
    result: 'Surface map',
    when: (date: string, probe: string) => `Taken ${date} with the ${probe} probe.`,
    clear: 'Clear map',
    heatLabel: (min: string, max: string, range: string, unit: string, k: number, n: number) =>
      `Surface map: lowest ${min}, highest ${max}, range ${range} ${unit}; ${k} of ${n} points.`,
    range: (range: string, unit: string) => `Range ${range} ${unit}`,
    points: (k: number, n: number) => `${k} of ${n} points`,
    filledNote: 'hatched: filled',
    overLimit: (range: string, limit: string, unit: string) =>
      `The surface varies by ${range} ${unit}, more than the ${limit} ${unit} limit (Settings › Run).`,
    cellValue: (n: number, z: string, unit: string) => `Point ${n}: ${z} ${unit}`,
    cellFilled: (n: number, z: string, unit: string) => `Point ${n}: ${z} ${unit} (filled)`,
    cellMissing: (n: number) => `Point ${n}: not measured`,
    confirm: {
      title: 'Map stock surface',
      description: (n: number) =>
        `The machine probes ${n} points on the stock top, moving between them at the clearance with probe moves. Keep clear of the machine; Stop resets it at once.`,
    },
    follow: 'Follow the surface map',
    followHint: (date: string, range: string, unit: string, k: number) =>
      `The map of ${date}: range ${range} ${unit}, ${k} points. The program's Z follows it.`,
    followed: (dz: string, unit: string) => `The program moves by up to ${dz} ${unit}.`,
  },
  repeat: {
    button: 'Test homing repeatability…',
    title: 'Homing repeatability',
    description:
      'Home several times and probe the same fixed target after each: the spread shows how well homing returns to the same place.',
    steps: (what: string) =>
      `Fix ${what} on the bed where nothing will move it. Jog the tool a few mm above it, then press Use this position. Each cycle homes, moves above the target at the top, comes down with a probe move and probes it.`,
    target: {
      zPlate: 'the touch plate',
      xyzPlate: 'the XYZ corner plate (probed on its front-left corner)',
      tool: 'a metal block with a square front-left corner (the bit probes it)',
      '3d': 'a block with a square front-left corner (the 3D probe touches it)',
    } as Record<string, string>,
    useHere: 'Use this position',
    start: (x: string, y: string, z: string, unit: string) =>
      `Start: X ${x} Y ${y} Z ${z} ${unit} (machine)`,
    noStart: 'No start yet.',
    cycles: 'Homings',
    run: 'Start test',
    checkSteps: 'Check for lost steps',
    checkHint:
      'After a run, probe the target once without homing: a drift from the test shows lost steps.',
    homeFirst: 'Home the machine first.',
    idleFirst: 'Wait until the machine is idle.',
    noMachine: 'Choose a library machine: the result is kept with it.',
    spindleOn: 'Turn the spindle off first.',
    confirm: {
      title: 'Test homing repeatability',
      description: (n: number) =>
        `The machine homes ${n} times and probes the target after each, moving above it at the top and down with a probe move. Keep clear of the machine; Stop resets it at once.`,
      confirm: 'Start test',
    },
    running: (n: number, of: number, phase: string) =>
      `Cycle ${n} of ${of}: ${phase === 'home' ? 'homing' : 'probing'}`,
    progress: 'Repeatability test',
    stop: 'Stop test',
    stopped: 'The test was stopped.',
    result: 'Result',
    columns: { axis: 'Axis', spread: 'Spread', stdDev: 'Std dev', mean: 'Mean (machine)' },
    pass: (threshold: string, unit: string) => `Pass: every spread under ${threshold} ${unit}.`,
    fail: (threshold: string, unit: string) =>
      `Over ${threshold} ${unit}: check the homing switches and their mounts, the pull-off and the homing feeds ($24, $25), then test again.`,
    when: (date: string, n: number) => `Tested ${date}, ${n} homings.`,
    drift: 'Drift since the test',
    driftAxis: (axis: string, mm: string, unit: string) => `${axis} ${mm} ${unit}`,
    driftOk: (threshold: string, unit: string) => `No lost steps (under ${threshold} ${unit}).`,
    driftBad: 'Steps were lost: the position is off by the drift. Home before the next job.',
    summary: 'Homing repeatability',
    summaryNone: 'Not tested.',
    summaryPass: (worst: string, unit: string, date: string) => `Pass, ${worst} ${unit} (${date})`,
    summaryFail: (worst: string, unit: string, date: string) => `Over, ${worst} ${unit} (${date})`,
    open: 'Test…',
    close: 'Close',
  },

  /** v0.5 RV7: the Work area dialog (docs/modes/run.md#work-area-rv7). */
  workArea: {
    button: 'Work area…',
    title: 'Work area',
    description:
      'Jog slowly to each end the machine reaches safely and mark it. Moves stay inside the marks less the margin; the controller’s soft limits stay the outer bound.',
    steps:
      'Jog slowly to the last safe point of each end (the spindle body clear of the gantry, fixtures and cables), then press its Mark button. An end you do not mark stays bounded by the travel.',
    homeFirst: 'Home the machine first: marks are machine coordinates.',
    noMachine: 'Choose a library machine: the work area is saved with it.',
    idleFirst: 'Wait until the machine is idle to mark.',
    table: 'Marked ends',
    columns: { axis: 'Axis', min: 'Min', max: 'Max', travel: 'Travel' },
    unmarked: '—',
    mark: (axis: string, side: 'min' | 'max') => `Mark ${axis} ${side}`,
    clearSide: (axis: string, side: 'min' | 'max') => `Clear ${axis} ${side}`,
    crossed: (axis: string) =>
      `${axis} min must stay below ${axis} max: clear the other mark first.`,
    margin: 'Margin',
    marginHint:
      'Kept inside every marked end: jogs, Go to and probing stop this far before a mark.',
    marginTooWide: (axis: string) =>
      `The margin is wider than half the marked ${axis} span: nothing can move on ${axis}.`,
    clear: 'Clear work area',
    clearHint: 'To mark an end further out, clear it first: moves stay inside the current marks.',
    saved: (what: string) => `${what} saved.`,
    cleared: 'Work area cleared.',
    /** A `$13n` line to copy (Q219: DFYOM never writes `$` settings). */
    lower: (axis: string, reach: string, travel: string, setting: string, unit: string) =>
      `The marked ${axis} end is ${reach} ${unit} from the homing switch; the controller allows ${travel} ${unit} (${setting}). To make its soft limits stop there too, set:`,
    raise: (axis: string, reach: string, travel: string, setting: string, unit: string) =>
      `Your machine reaches ${reach} ${unit} in ${axis}; the controller allows ${travel} ${unit} (${setting}). Raise ${setting} with your controller’s tool to use it:`,
    copy: (line: string) => `Copy ${line}`,
    copied: (line: string) => `${line} copied to the clipboard.`,
    copyFailed: 'Could not copy to the clipboard.',
    close: 'Close',
  },

  checkAlign: {
    button: 'Check alignment…',
    zeroFirst: 'Set the X/Y zero first: the stops are where the plan puts the stock.',
    title: 'Check alignment',
    description:
      'Move the bit around the stock at a gap to see whether it is square to the axes, or measure an edge with the probe.',
    view: 'Check',
    pointer: 'Pointer',
    measure: 'Measure',
    stockPlan: (l: string, w: string, unit: string, setup: string) =>
      `Stock ${l} × ${w} ${unit}, from ${setup}.`,
    noPlan: 'No plan: enter the stock and where the work zero is on it.',
    length: 'Length (X)',
    width: 'Width (Y)',
    zeroAt: 'Work zero at',
    zeroCorners: {
      '-1,-1': 'Front left',
      '1,-1': 'Front right',
      '1,1': 'Back right',
      '-1,1': 'Back left',
    } as Record<string, string>,
    pattern: 'Pattern',
    patterns: { corners: 'Corners', edges: 'Edges', perimeter: 'Perimeter', both: 'Both' },
    gap: 'Gap',
    gapHint: 'The bit’s axis this far outside each stock edge.',
    height: 'Height',
    heightHint: 'The tip this far above the stock top; below 0 it passes beside the edge.',
    pointerSteps: (gap: string, height: string, unit: string) =>
      `The bit’s axis stops ${gap} ${unit} outside the stock’s edges, the tip ${height} ${unit} ${height.startsWith('-') ? 'below' : 'above'} the top. Compare the gap between the bit and the edge at each stop: where it differs, the stock is turned. Move the stock, not the program, then set the X/Y zero again.`,
    spindleOff: 'The spindle must be off. The machine moves only when you press a button.',
    traceFeed: (feed: string, unit: string) =>
      `Along the stock at ${feed} ${unit}; to the first stop at the jog feed, raised to the safe height first.`,
    stops: 'Stops',
    corners: {
      '-1,-1': 'Front left corner',
      '1,-1': 'Front right corner',
      '1,1': 'Back right corner',
      '-1,1': 'Back left corner',
    } as Record<string, string>,
    edges: {
      'y-1': 'Front edge',
      y1: 'Back edge',
      'x-1': 'Left edge',
      x1: 'Right edge',
    } as Record<string, string>,
    ends: {
      y: { '-1': 'left end', '1': 'right end' },
      x: { '-1': 'front end', '1': 'back end' },
    } as Record<'x' | 'y', Record<string, string>>,
    stopAt: (x: string, y: string) => `X ${x} Y ${y}`,
    start: 'Go to the first stop',
    startTrace: 'Start the trace',
    next: 'Next',
    previous: 'Previous',
    continue: 'Continue',
    again: 'Trace again',
    moving: (name: string) => `Moving to the ${name}…`,
    at: (name: string, n: number, total: number) =>
      `At the ${name} (${n} of ${total}). Look at the gap to the stock edge.`,
    traceDone: 'Back at the start: the trace is done.',
    travel: 'A stop lies outside the machine’s travel: check the zero, or make the gap smaller.',
    stopped: (x: string, y: string, z: string, unit: string) =>
      `Stopped at X ${x} Y ${y} Z ${z} ${unit} (work).`,
    problem: {
      belowBottom: 'The height is below the stock’s bottom.',
      sideTouches: (min: string, unit: string) =>
        `Below the top the bit’s side would touch the edge: make the gap at least ${min} ${unit}.`,
      negativeGap: 'The gap cannot be negative.',
      invalid: 'Enter valid sizes.',
    },
    edge: 'Edge',
    measureEdges: {
      'y-1': 'Front edge (Y−)',
      y1: 'Back edge (Y+)',
      'x-1': 'Left edge (X−)',
      x1: 'Right edge (X+)',
    } as Record<string, string>,
    measureNo:
      'Measure touches the edge at two points: it needs the bit on a conductive stock or a 3D probe (Machine settings, Probe). Use the pointer to check by eye.',
    measureSteps: (edge: string, kind: 'tool' | '3d', between: string, unit: string) =>
      kind === 'tool'
        ? `Put the clip on the bit and on the stock (it must conduct). It probes the ${edge} at two points ${between} ${unit} apart: Z on the top, then the edge from outside, at each.`
        : `It probes the ${edge} with the 3D probe at two points ${between} ${unit} apart: Z on the top, then the edge from outside, at each.`,
    measureGo: 'Measure',
    measuring: (n: number) => `Probing point ${n} of 2…`,
    measureFailed: 'Measure stopped: nothing was measured. The message above says why.',
    points: 'Probed',
    point: (
      n: number,
      edgeAxis: string,
      value: string,
      alongAxis: string,
      along: string,
      pm: string,
      unit: string,
    ) => `${n} · ${edgeAxis} ${value} ± ${pm} ${unit} at ${alongAxis} ${along} (machine)`,
    angle: (deg: string, pm: string, ccw: boolean) =>
      `Turned ${deg}° ${ccw ? 'counter-clockwise' : 'clockwise'} (± ${pm}°).`,
    square: (tol: string, unit: string) =>
      `Square: the far end is within ${tol} ${unit} of the near one.`,
    nudge: (keep: string, move: string, mm: string, unit: string, toward: string) =>
      `Keep the ${keep} where it is and move the ${move} ${mm} ${unit} toward ${toward}.`,
    after:
      'Then set the X/Y zero again and measure once more. Nothing was written: the program is not rotated.',
    again2: 'Measure again',
    close: 'Close',
    gate: {
      invalid: 'Enter a valid Ø.',
    },
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

  /** v0.5 RV1: the spindle under the jog pad (docs/modes/run-machine.md#spindle-while-jogging-rv1). */
  spindle: {
    title: 'Spindle',
    off: 'Off',
    on: (rpm: string, dir: 'cw' | 'ccw' | undefined) =>
      dir === undefined ? `${rpm} rpm` : `${rpm} rpm · ${dir === 'cw' ? 'CW' : 'CCW'}`,
    speed: 'Spindle speed',
    rpm: (rpm: string) => `${rpm} rpm`,
    start: 'Start spindle',
    stop: 'Stop spindle',
    notIdle: 'Stop the jog first: the spindle turns on only while the machine is idle.',
    runOwns: 'The run controls the spindle: Stop stops the run and the spindle.',
    manual: 'The spindle speed is set by hand: switch the router on and off at the router.',
    laser: 'The controller is in laser mode ($32=1): no spindle control.',
    confirm: {
      title: 'Start the spindle?',
      description: (rpm: string) =>
        `The spindle starts at ${rpm} rpm. Keep hands and loose clothing clear. Off stops it, also while jogging.`,
      confirm: 'Start spindle',
    },
    /** Refusals by rule (`run.state`), in the navigator's banner. */
    refused: {
      spindleNotIdle: 'Stop the jog first: the spindle turns on only while the machine is idle.',
      spindleStopping: 'The spindle is stopping: jog again once it is off.',
      runSpindle: 'The run controls the spindle: Stop stops the run and the spindle.',
      spindleOn: 'Stop the spindle first.',
      manualSpindle:
        'The spindle speed is set by hand: switch the router on and off at the router.',
      laserMode: 'The controller is in laser mode ($32=1): no spindle control.',
      spindleReset:
        'The jog did not stop in time: the controller was reset to stop the spindle. Home again.',
    } as Readonly<Record<string, string>>,
  },

  unlockConfirm: {
    title: 'Unlock without homing?',
    description:
      'Position is not known until homed. Soft limits and the work zero may be wrong until you home the machine.',
    confirm: 'Unlock',
  },

  /** v0.5 RV2: the Run inspector's "Machine settings" (docs/conventions/ui.md#run-settings-v05-rv2). */
  machineSettings: {
    title: 'Machine settings',
    noMachine: 'Choose a machine to see its settings.',
    of: (name: string) =>
      `Library machine “${name}”. Saved values apply to manual control, the settings check and new plans.`,
    planCopy:
      "The plan uses its own copy of the machine; update the plan's machine to use these values.",
    unsaved: 'Unsaved',
    save: 'Save',
    revert: 'Revert',
    conflict: 'The machine changed elsewhere.',
    reload: 'Reload',
    controller: 'Controller settings',
    controllerHint:
      'Read from the controller ($$). DFYOM never changes them: copy a line into your sender’s console, or import $$ into the machine in the Library.',
    columns: { setting: 'Setting', controller: 'Controller', machine: 'Machine' },
    differs: 'Differs from the machine',
    copy: (line: string) => `Copy ${line}`,
    copied: (line: string) => `${line} copied to the clipboard.`,
    copyFailed: 'Could not copy to the clipboard.',
    /** v0.5 RV7: the work area's summary (docs/modes/run.md#work-area-rv7). */
    workArea: 'Work area',
    workAreaNone: 'Not marked: moves are bounded by the travel.',
    workAreaAxis: (axis: string, min: string, max: string, unit: string) =>
      `${axis} ${min} … ${max} ${unit}`,
    workAreaMargin: (margin: string, unit: string) => `margin ${margin} ${unit}`,
    workAreaEdit: 'Work area…',
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
    zero: '=0',
    setZero: (axis: string) => `Set ${axis} zero`,
    /** DF140: the tooltips say exactly what each button does. */
    setZeroTip: (axis: string) =>
      `Set ${axis} zero: the current ${axis} position becomes work ${axis} 0 (G54). Nothing moves.`,
    /** DF140: go to the work zero of one axis (docs/modes/run-goto.md#go-to-work-zero-per-axis-df140). */
    goZeroLabel: '→0',
    goZero: (axis: string) => `Go to work ${axis} zero`,
    goZeroTip: (axis: string) =>
      axis === 'Z'
        ? 'Go to work Z 0: moves Z only, down or up to the work zero. The machine moves.'
        : `Go to work ${axis} 0: raises Z to the safe height first if it is lower, then moves ${axis} only; Z stays up. The machine moves.`,
    /** DF128: a coordinate's Go to button. */
    goTo: (axis: string, value: string, frame: 'work' | 'machine') =>
      `Go to: ${axis} ${value} ${frame}`,
    workZeroHint: 'Set the work zero (G54) per axis at the current tool position with its =0.',
  },

  /**
   * DF133: the workholding in the Run scene and the jog guard: the Position panel's status line
   * per trust state (docs/modes/run-workholding.md#trust-what-the-guard-knows), the jog notice and
   * the Jog menu's switch (#jogs, RW3).
   */
  guard: {
    noItems: 'No workholding in this setup.',
    notHomed: 'Home the machine to check jogs against the workholding.',
    zeroUnset: 'Set the work zero to check jogs against the workholding.',
    /** RW6: after a setup change, until G54 changes: the items stand at the old setup's zero. */
    zeroStale: 'New setup: set its work zero to check jogs against the workholding.',
    /** RW6: the setup-change dialog's line under its jog pad, until the new zero is set. */
    setupChange:
      'Clamps outlined: jogs are not checked against them until you set this setup’s work zero.',
    trusted: 'Checks the clamps as placed in Plan, at the work zero.',
    /** A setup with items and no tool: nothing to check a jog with. */
    unchecked:
      'Clamps drawn as placed in Plan, at the work zero. Jogs are not checked against them.',
    /** Q190: after a tool-change wait, until Probe Z or Set Z zero. */
    zUnset: 'Z not set for this tool yet: heights may be off by the difference in tool length.',
    off: 'Workholding guard off.',
    /** The jog notice (Q185). */
    stopped: (gap: string, item: string, part: string) => `Stopped ${gap} from ${item} (${part}).`,
    blocked: (item: string, part: string) =>
      `Not moved: the ${part} would come within the margin of ${item}.`,
    moving: 'Not moved: wait for the machine to stop, the guard needs its position.',
    part: { tool: 'tool', nut: 'collet nut', body: 'spindle body' },
    stockTop: 'the stock top',
    anItem: 'an item',
    /** Q186: the notice's button; one deliberate click, no hotkey. */
    pastOnce: 'Jog past once',
    pastOnceHint: 'The next jog or Go to within 30 s is not checked against the workholding.',
    pastOnceArmed: 'Next jog unguarded.',
    /** RW4 (Q187): a Go to's or a touch-off move's finding, under its steps. */
    moveHit: (
      n: number,
      step: string,
      item: string,
      part: string,
      gap: string,
      rel: 'above' | 'from',
      at: string,
    ) => `Step ${n} (${step}) hits ${item}: the ${part} stops ${gap} ${rel} it at ${at}.`,
    moveDeeper: (n: number, step: string, item: string, part: string) =>
      `Step ${n} (${step}) takes the ${part} deeper into ${item}.`,
    anyway: 'Go anyway (the clamps are not where the plan says)',
    anywayPastOnce: 'Jog past once is armed: this move is not checked.',
    /** RW5 (Q192): the live clearance chip under the Position table. */
    clearance: (gap: string, item: string, part: string) => `Clear: ${gap} to ${item} (${part})`,
    /** RW6: under 2 × the margin (amber): "Clear" would read as all clear. */
    clearanceClose: (gap: string, item: string, part: string) =>
      `Close: ${gap} to ${item} (${part})`,
    clearanceInside: (gap: string, item: string, part: string) =>
      `Within the margin: ${gap} to ${item} (${part})`,
    /** Its polite announcement: only a change of item or colour is read. */
    clearanceSays: {
      clear: (item: string) => `Nearest item: ${item}.`,
      close: (item: string) => `Close to ${item}.`,
      inside: (item: string) => `Within the margin of ${item}.`,
    },
    /** RW5 (Q189, Q190): the tool-change dialog's line under its jog pad. */
    toolChangeChecks: (tool: string) => `Jogs here are checked against the clamps with ${tool}.`,
    /** Q186: the Jog menu's switch. */
    switchLabel: 'Workholding guard',
    switchHint:
      'Stops jogs short of the clamps as placed in Plan. Off until you switch it on, reconnect or change the setup.',
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
    /** v0.5 RV7: a step outside the work area (its bound, the margin in). */
    workArea: (axis: string, target: string, min: string, max: string, unit: string) =>
      `${axis} would leave the work area: the target is at machine ${target}, the work area is ${min} to ${max} ${unit}.`,
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

  /** DF135 C2: already-cut marks from Run (docs/modes/cut-state.md#marking). */
  cutMarks: {
    region: 'Already cut',
    marked: (n: number) =>
      n === 1
        ? 'Marked 1 operation as already cut in Design.'
        : `Marked ${n} operations as already cut in Design.`,
    undone: 'The already-cut marks were taken back.',
    undo: 'Undo',
    offer: (n: number) =>
      n === 1
        ? 'Mark the finished operation as already cut?'
        : `Mark the ${n} finished operations as already cut?`,
    offerHint:
      'Only operations the machine finished. The one in progress stays not cut: resume it or run it again.',
    mark: 'Mark as already cut',
    notNow: 'Not now',
    changed:
      'The plan changed since this program was exported, so nothing was marked. Mark operations by hand in Design.',
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
    /** v0.5 RV7: one `workArea` finding: inside the travel, outside the marked work area. */
    softLimitsArea: (
      axis: string,
      from: string,
      to: string,
      min: string,
      max: string,
      unit: string,
    ) =>
      `${axis} leaves the work area: the program spans ${from} to ${to} ${unit}, the work area is ${min} to ${max} ${unit}.`,
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
    /** DF143: "Finalize and start" (docs/modes/run-machine.md#pre-flight-on-a-real-machine). */
    finalizeOffer:
      'A real machine runs only finalized plans. Finalize and start finalizes this plan (it becomes read-only; set it back to Settled design in Plan to edit it), then starts once the checks pass.',
    finalizeStart: 'Finalize and start',
    finalizing: 'Finalizing…',
    finalizeFailed: 'The plan could not be finalized:',
    /** DF135 Q199 (cut-state.md § A new blank): every operation of the setup is already cut. */
    allCut: (setup: string) =>
      `Everything in ${setup} is marked already cut. Cutting a new blank? Clear the marks to cut it all again.`,
    allCutGate: (setup: string) =>
      `Nothing to cut in ${setup}: every operation is marked already cut.`,
    clearMarks: 'Clear marks',
    allCutSnapshot: (plan: string, status: string) =>
      `${plan} (${status}) keeps its own copy of the marks: after clearing them, rebuild it in Plan (Settled design, then Rebuild).`,
    allCutCleared: (plan: string) =>
      `The marks are cleared in Design. ${plan} keeps its own copy until it is rebuilt in Plan (Settled design, then Rebuild).`,
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
