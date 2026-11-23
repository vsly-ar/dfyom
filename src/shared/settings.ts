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

export const THEMES = ['system', 'light', 'dark'] as const
export type ThemeSetting = (typeof THEMES)[number]

/** Panel layout of one panel group: panel id → size in % of the group (react-resizable-panels). */
export const PanelLayoutSchema = z.record(z.string(), z.number().min(0).max(100))
export type PanelLayout = z.output<typeof PanelLayoutSchema>

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
})

export type AppSettings = Readonly<z.output<typeof AppSettingsSchema>>

/** A partial update (no defaults); `layouts` entries replace the named groups only. */
export const AppSettingsPatchSchema = z.object(fields).partial().strict()
export type AppSettingsPatch = Readonly<z.input<typeof AppSettingsPatchSchema>>

export const DEFAULT_SETTINGS: AppSettings = AppSettingsSchema.parse({})

/** Applies a validated patch: plain fields replace, `layouts` and `sidePanels` merge by key. */
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
  }
}
