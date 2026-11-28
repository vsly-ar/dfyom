/**
 * App settings (GUI preferences): one store per app instance, owned by the main process and
 * persisted in `<appData>/settings.json`; every window mirrors it.
 * Doc: docs/conventions/ui.md#settings
 *
 * Settings are not part of any project and not reachable by agents: "Allow local agents to
 * connect" guards the agents' own access (docs/architecture/llm-api.md#local-http).
 */
import { z } from 'zod'
import { AnchorDtoSchema } from '../core/design/part.dto'
import { UnitSystemSchema } from '../core/project/document'
import { APP_MODES } from '../core/modes'
import { BACK_OFF_DEFAULT_MM, BACK_OFF_MAX_MM, BACK_OFF_MIN_MM } from '../core/run/back-off'

export const THEMES = ['system', 'light', 'dark'] as const
export type ThemeSetting = (typeof THEMES)[number]

/**
 * Jog hotkey styles in Run mode (DF88, docs/conventions/ui.md#jog-hotkeys): videogame (WASD,
 * Shift/Space for Z), gSender's defaults, arrow keys, or none. Custom keys are backlog.
 */
export const JOG_KEY_STYLES = ['game', 'gsender', 'arrows', 'off'] as const
export type JogKeyStyle = (typeof JOG_KEY_STYLES)[number]

/** DF140: the `jogFeed` / `jogStep` key while no library machine is known. */
export const NO_MACHINE_KEY = '*'

/** Panel layout of one panel group: panel id → size in % of the group (react-resizable-panels). */
export const PanelLayoutSchema = z.record(z.string(), z.number().min(0).max(100))
export type PanelLayout = z.output<typeof PanelLayoutSchema>

const AxisResultSchema = z.object({
  spread: z.number().finite(),
  stdDev: z.number().finite(),
  mean: z.number().finite(),
})
const ReadingSchema = z.object({
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  z: z.number().finite().optional(),
})

/**
 * v0.5 RV8: a machine's last homing repeatability test (docs/modes/run-machine.md#homing-repeatability-rv8):
 * when, where the target's start was (MPos), the probe kind, per axis the spread, standard
 * deviation and mean (mm), pass (Q224: every spread under 0.02 mm); `check`: the last lost-steps
 * check against it (one probe without homing: the drift from the means).
 */
export const RepeatabilityResultSchema = z.object({
  date: z.string().min(1).max(40),
  at: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  probe: z.string().min(1).max(20),
  cycles: z.number().int().min(1).max(20),
  readings: z.array(ReadingSchema).max(20),
  axes: z.object({
    x: AxisResultSchema.optional(),
    y: AxisResultSchema.optional(),
    z: AxisResultSchema.optional(),
  }),
  pass: z.boolean(),
  check: z.object({ date: z.string().min(1).max(40), drift: ReadingSchema }).optional(),
})
export type RepeatabilityResult = z.output<typeof RepeatabilityResultSchema>

const fields = {
  /** Light / Dark / System (follow the OS); `data-theme` on the root (ui.md decision 1). */
  theme: z.enum(THEMES),
  /** App-level reduced motion, independent of the OS preference; `data-motion='reduce'`. */
  reduceMotion: z.boolean(),
  /** Serve agents over local HTTP (llm-api.md#local-http); default on. */
  allowLocalAgents: z.boolean(),
  /** Last panel layout per panel group id; new windows start from it. */
  layouts: z.record(z.string(), PanelLayoutSchema),
  /**
   * Placement anchor of new positioned operations made in the UI (design-v0.2.md#placement-anchors);
   * the window passes it as `anchor` (agents pass their own or get the centre).
   */
  defaultAnchor: AnchorDtoSchema,
  /**
   * Unit system of the Library window's forms when it was opened without a project: the last one
   * chosen there (docs/conventions/ui-library-window.md, L5).
   */
  libraryUnits: UnitSystemSchema,
  /**
   * Snap grid step per unit system, each in its own unit (mm, inch): the Shape Editor and the tab
   * markers snap to it in projects of that system (task U3, docs/conventions/ui.md#snap-and-measure).
   */
  snapGrid: z.object({ mm: z.number().positive().finite(), inch: z.number().positive().finite() }),
  /**
   * Seconds without a new edit after which a window applies its pending changes by itself
   * (DF28, docs/architecture/apply.md#auto-apply-df28); 0 = off (Apply by hand only).
   */
  autoApplyDelay: z.number().int().min(0).max(600),
  /**
   * Side panels shown per mode (DF30, docs/conventions/ui.md#mode-switching): a mode without an
   * entry shows both. Only the panel toggles write it.
   */
  sidePanels: z.partialRecord(
    z.enum(APP_MODES),
    z.object({ navigator: z.boolean(), inspector: z.boolean() }),
  ),
  /**
   * Machine library id of the machine last chosen for a plan (DF45): preselected by the Plan start
   * card (docs/conventions/ui.md#plan-start-df29). `null`: none yet. Only plan mode writes it.
   */
  lastMachine: z.string().min(1).nullable(),
  /** Jog hotkey style in Run mode (DF88, docs/conventions/ui.md#jog-hotkeys). */
  jogKeys: z.enum(JOG_KEY_STYLES),
  /**
   * Library machine ids whose real-machine Home confirmation was turned off with "Don't ask again"
   * (DF88, docs/conventions/ui.md#jog-position-and-probing-df88); the settings dialog clears it.
   */
  skipHomeConfirm: z.array(z.string().min(1)).max(1000),
  /**
   * Hardening DF143: "Advanced user" (off by default): skips the motion confirmations listed in
   * docs/modes/run.md#advanced-user-df143 and offers "Unlock and back off" after a limit switch hit
   * while jogging. Confirmations that guard data or a run's pre-flight stay.
   */
  advancedUser: z.boolean(),
  /** DF143: how far "Unlock and back off" jogs off a limit switch (mm). */
  limitBackOff: z.number().min(BACK_OFF_MIN_MM).max(BACK_OFF_MAX_MM),
  /**
   * DF129 RC4: after a connection lost during a run, reconnect to the same device by itself (reads
   * only, never moves; docs/modes/run-recovery.md#auto-reconnect); default on.
   */
  autoReconnect: z.boolean(),
  /**
   * Jog feed (mm/min) per library machine id: the jog feed slider's last value (DF88); since
   * DF140 the key `*` (`NO_MACHINE_KEY`) holds it while no library machine is known.
   */
  jogFeed: z.record(z.string().min(1), z.number().positive().finite()),
  /**
   * Cutting jog feed (mm/min) per library machine id (`*` without one), as `jogFeed`: the jog feed
   * while the spindle turns (v0.5 RV1, Q217, docs/modes/run-machine.md#spindle-while-jogging-rv1).
   */
  cuttingJogFeed: z.record(z.string().min(1), z.number().positive().finite()),
  /**
   * Jog step per library machine id (`*` without one), as `jogFeed` (hardening DF140,
   * docs/conventions/ui.md#jog-pad-df140): the chosen step and the step picker's custom value (mm).
   */
  jogStep: z.record(
    z.string().min(1),
    z.object({
      step: z.number().positive().finite(),
      custom: z.number().positive().finite().optional(),
    }),
  ),
  /**
   * Open state of inspector accordions and More rows per inspector kind and group id
   * (`pocket.corners`: true = open), written when the user toggles one (DF110,
   * docs/conventions/inspector-layout.md#accordions). Not in the dialog.
   */
  inspectorGroups: z.record(z.string().min(1).max(100), z.boolean()),
  /** Selected tab per inspector kind (`plan.op` → `feeds`), as `inspectorGroups` (DF110). */
  inspectorTabs: z.record(z.string().min(1).max(100), z.string().min(1).max(100)),
  /**
   * v0.5 RV8: the last homing repeatability test per library machine id (app state, not copied
   * into plans; docs/modes/run-machine.md#homing-repeatability-rv8).
   */
  homingRepeatability: z.record(z.string().min(1), RepeatabilityResultSchema),
}

/** The settings file; a missing field takes its default (new settings need no migration). */
export const AppSettingsSchema = z.object({
  theme: fields.theme.default('system'),
  reduceMotion: fields.reduceMotion.default(false),
  allowLocalAgents: fields.allowLocalAgents.default(true),
  layouts: fields.layouts.default({}),
  defaultAnchor: fields.defaultAnchor.default({ u: 'centre', v: 'centre' }),
  libraryUnits: fields.libraryUnits.default('mm'),
  snapGrid: fields.snapGrid.default({ mm: 1, inch: 1 / 16 }),
  autoApplyDelay: fields.autoApplyDelay.default(10),
  sidePanels: fields.sidePanels.default({}),
  lastMachine: fields.lastMachine.default(null),
  jogKeys: fields.jogKeys.default('game'),
  skipHomeConfirm: fields.skipHomeConfirm.default([]),
  autoReconnect: fields.autoReconnect.default(true),
  advancedUser: fields.advancedUser.default(false),
  limitBackOff: fields.limitBackOff.default(BACK_OFF_DEFAULT_MM),
  jogFeed: fields.jogFeed.default({}),
  cuttingJogFeed: fields.cuttingJogFeed.default({}),
  jogStep: fields.jogStep.default({}),
  inspectorGroups: fields.inspectorGroups.default({}),
  inspectorTabs: fields.inspectorTabs.default({}),
  homingRepeatability: fields.homingRepeatability.default({}),
})

export type AppSettings = Readonly<z.output<typeof AppSettingsSchema>>

/** A partial update (no defaults); `layouts` entries replace the named groups only. */
export const AppSettingsPatchSchema = z.object(fields).partial().strict()
export type AppSettingsPatch = Readonly<z.input<typeof AppSettingsPatchSchema>>

export const DEFAULT_SETTINGS: AppSettings = AppSettingsSchema.parse({})

/**
 * Applies a validated patch: plain fields replace, `layouts`, `sidePanels`, `jogFeed`,
 * `cuttingJogFeed`, `jogStep`,
 * `inspectorGroups`, `inspectorTabs` and `homingRepeatability` merge by key.
 */
export function mergeSettings(
  current: AppSettings,
  patch: z.output<typeof AppSettingsPatchSchema>,
): AppSettings {
  return {
    theme: patch.theme ?? current.theme,
    reduceMotion: patch.reduceMotion ?? current.reduceMotion,
    allowLocalAgents: patch.allowLocalAgents ?? current.allowLocalAgents,
    layouts: { ...current.layouts, ...(patch.layouts ?? {}) },
    defaultAnchor: patch.defaultAnchor ?? current.defaultAnchor,
    libraryUnits: patch.libraryUnits ?? current.libraryUnits,
    snapGrid: patch.snapGrid ?? current.snapGrid,
    autoApplyDelay: patch.autoApplyDelay ?? current.autoApplyDelay,
    sidePanels: { ...current.sidePanels, ...(patch.sidePanels ?? {}) },
    lastMachine: patch.lastMachine === undefined ? current.lastMachine : patch.lastMachine,
    jogKeys: patch.jogKeys ?? current.jogKeys,
    skipHomeConfirm: patch.skipHomeConfirm ?? current.skipHomeConfirm,
    autoReconnect: patch.autoReconnect ?? current.autoReconnect,
    advancedUser: patch.advancedUser ?? current.advancedUser,
    limitBackOff: patch.limitBackOff ?? current.limitBackOff,
    jogFeed: { ...current.jogFeed, ...(patch.jogFeed ?? {}) },
    cuttingJogFeed: { ...current.cuttingJogFeed, ...(patch.cuttingJogFeed ?? {}) },
    jogStep: { ...current.jogStep, ...(patch.jogStep ?? {}) },
    inspectorGroups: { ...current.inspectorGroups, ...(patch.inspectorGroups ?? {}) },
    inspectorTabs: { ...current.inspectorTabs, ...(patch.inspectorTabs ?? {}) },
    homingRepeatability: {
      ...current.homingRepeatability,
      ...(patch.homingRepeatability ?? {}),
    },
  }
}
