/**
 * App settings (GUI preferences): one store per app instance, owned by the main process and
 * persisted in `<appData>/settings.json`; every window mirrors it.
 * Doc: docs/conventions/ui.md#settings
 *
 * Settings are not part of any project and not reachable by agents: "Allow local agents to
 * connect" guards the agents' own access (docs/architecture/llm-api.md#local-http).
 */
import { z } from 'zod'

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
}

/** The settings file; a missing field takes its default (new settings need no migration). */
export const AppSettingsSchema = z.object({
  theme: fields.theme.default('system'),
  reduceMotion: fields.reduceMotion.default(false),
  allowLocalAgents: fields.allowLocalAgents.default(true),
  layouts: fields.layouts.default({}),
})

export type AppSettings = Readonly<z.output<typeof AppSettingsSchema>>

/** A partial update (no defaults); `layouts` entries replace the named groups only. */
export const AppSettingsPatchSchema = z.object(fields).partial().strict()
export type AppSettingsPatch = Readonly<z.input<typeof AppSettingsPatchSchema>>

export const DEFAULT_SETTINGS: AppSettings = AppSettingsSchema.parse({})

/** Applies a validated patch: plain fields replace, `layouts` merges by group id. */
export function mergeSettings(
  current: AppSettings,
  patch: z.output<typeof AppSettingsPatchSchema>,
): AppSettings {
  return {
    theme: patch.theme ?? current.theme,
    reduceMotion: patch.reduceMotion ?? current.reduceMotion,
    allowLocalAgents: patch.allowLocalAgents ?? current.allowLocalAgents,
    layouts: { ...current.layouts, ...(patch.layouts ?? {}) },
  }
}
