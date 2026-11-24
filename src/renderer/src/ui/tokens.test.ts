// Token checks: both themes define every semantic colour token, the two dark blocks agree, and
// the contrast pairs meet their APCA Lc targets per role in both themes. Rules: docs/conventions/ui.md#colour
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apcaLc } from './apca'

// Runs in the node test project and is typechecked by tsconfig.node.json (it reads the file).
const CSS = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

type Block = { selector: string; media: string | null; decls: Map<string, string> }

/** Minimal parser for tokens.css: top-level rules and rules nested one level in `@media`. */
function parseBlocks(css: string): Block[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks: Block[] = []
  const re = /([^{}]+)\{([^{}]*)\}|(@media[^{]+)\{|\}/g
  let media: string | null = null
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[3] !== undefined) media = m[3].trim()
    else if (m[1] !== undefined && m[2] !== undefined) {
      const decls = new Map<string, string>()
      for (const d of m[2].split(';')) {
        const i = d.indexOf(':')
        if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim())
      }
      blocks.push({ selector: m[1].trim().replace(/\s+/g, ' '), media, decls })
    } else media = null
  }
  return blocks
}

const blocks = parseBlocks(CSS)
const find = (selector: string, media: string | null): Map<string, string> => {
  const b = blocks.find((x) => x.selector === selector && x.media === media)
  if (!b) throw new Error(`tokens.css has no block ${selector} (media: ${media})`)
  return b.decls
}

const light = find(':root, .t-light', null)
const dark = find(":root[data-theme='dark'], .t-dark", null)
const darkOs = find(":root:not([data-theme='light'])", '@media (prefers-color-scheme: dark)')
const shared = find(':root', null)

/** Semantic colour tokens per ui.md#colour (token groups); every theme must define each one. */
const SEMANTIC = [
  ...['app', 'chrome', 'viewport', 'field', 'control', 'raised', 'hover', 'active', 'overlay'].map(
    (s) => `--bg-${s}`,
  ),
  '--text',
  '--text-muted',
  '--text-faint',
  '--text-on-accent',
  '--text-on-solid',
  '--text-accent',
  '--border',
  '--border-control',
  '--focus',
  '--accent',
  '--accent-hover',
  '--accent-border',
  '--accent-subtle',
  '--accent-icon',
  '--accent-icon-edge',
  ...['info', 'success', 'warning', 'danger'].flatMap((f) => [`--${f}`, `--${f}-subtle`]),
  '--danger-text',
  ...['stop', 'alarm', 'hold', 'moving', 'action'].flatMap((s) => [
    `--safety-${s}`,
    `--safety-${s}-fg`,
  ]),
  '--safety-moving-edge',
  '--safety-idle',
  '--safety-offline',
  ...['grid', 'grid-major', 'stock', 'part', 'edge', 'removal', 'selected', 'selected-halo'].map(
    (s) => `--vp-${s}`,
  ),
  ...['feed', 'rapid', 'plunge', 'tool', 'axis-x', 'axis-y', 'axis-z', 'hover', 'outdated'].map(
    (s) => `--vp-${s}`,
  ),
  // alignment aids (alignment.md S13): their rows' edge and icon, the viewport's pick targets
  '--aid',
  '--shadow-1',
  '--shadow-2',
  '--shadow-3',
]

/** Theme-independent tokens (ui.md#type, #spacing-radii-sizes, #elevation, #motion). */
const SHARED = [
  '--font-ui',
  '--font-mono',
  ...['xs', 'sm', 'md', 'lg', 'xl', 'dro'].flatMap((s) => [`--text-${s}`, `--lh-${s}`]),
  '--weight-regular',
  '--weight-medium',
  '--weight-bold',
  ...['0-5', '1', '2', '3', '4', '5', '6', '8'].map((s) => `--space-${s}`),
  ...['xs', 'sm', 'md', 'lg', 'full'].map((s) => `--radius-${s}`),
  '--control-sm',
  '--control-md',
  '--control-lg',
  ...['sm', 'md', 'lg', 'xl'].map((s) => `--icon-${s}`),
  '--icon-stroke',
  ...['toolbar', 'popover', 'dialog', 'toast', 'safety'].map((s) => `--z-${s}`),
  ...MOTION_DURATIONS(),
  '--ease-standard',
  '--ease-emphasized',
  '--ease-exit',
  '--delay-tooltip',
  '--delay-indicator',
]
function MOTION_DURATIONS(): string[] {
  return ['instant', 'fast', 'base', 'slow', 'emphasis', 'draw'].map((s) => `--motion-${s}`)
}

/**
 * APCA roles and minimum |Lc| (APCA readability criterion, "Bronze simple mode" levels, applied
 * to the sizes and weights the components use; ui.md#colour). Our text is 10–13 px, smaller than
 * the font minimums Bronze attaches to these levels, so the targets are floors, not comfort levels.
 */
const ROLES = {
  /** Text read for content at 11–13 px, regular weight (400): body, values, labels, notes. */
  read: 75,
  /**
   * Secondary text at 11–13 px (`--text-muted`): field labels, hints, notes, ids, dialog and
   * empty-state descriptions under a title. Below body text on purpose, so the hierarchy shows
   * (ADR 0018); body copy uses `--text`.
   */
  secondary: 60,
  /** Text at 10–13 px, medium/bold (500–600): button labels, chips, badges, tooltips. */
  label: 60,
  /** Non-content "spot" text: placeholders, unit suffixes, metadata, disabled. */
  spot: 30,
  /** Outline pictograms with fine detail (1.5 px stroke, 12–16 px icons). */
  icon: 45,
  /** Semantic marks: 1–2 px control outlines, focus ring, solid indicators ≥ 5.5 px. */
  mark: 30,
} as const
type Role = keyof typeof ROLES
type Theme = 'light' | 'dark'

/**
 * Pairs the components and the approved page draw: foreground (text or mark) on background,
 * in that order (APCA is polarity-aware), with the role that sets the target. Every pair meets
 * its target in both themes (tokens adjusted for APCA: ui.md#colour).
 */
const PAIRS: [fg: string, bg: string, role: Role, where: string][] = [
  ['--text', '--bg-app', 'read', 'body text'],
  ['--text', '--bg-chrome', 'read', 'toolbar, status bar, support area'],
  ['--text', '--bg-field', 'read', 'input values'],
  ['--text', '--bg-raised', 'read', 'menus, popovers, dialogs'],
  ['--text', '--bg-control', 'label', 'button labels (13 px / 500)'],
  ['--text', '--accent-subtle', 'read', 'selected row'],
  ['--text', '--warning-subtle', 'read', 'hard warning text (12 px)'],
  ['--text', '--danger-subtle', 'read', 'error banner text'],
  ['--bg-app', '--text', 'label', 'tooltip, inverted (12 px / 500)'],
  ['--text-muted', '--bg-app', 'secondary', 'labels, secondary text'],
  ['--text-muted', '--bg-chrome', 'secondary', 'support area notes (12 px), status bar'],
  ['--text-muted', '--bg-field', 'secondary', 'read-only values'],
  ['--text-muted', '--bg-raised', 'secondary', 'dialog description under its title'],
  ['--text-muted', '--bg-control', 'label', 'ghost buttons, segmented items (500)'],
  ['--text-faint', '--bg-app', 'spot', 'metadata (non-essential)'],
  ['--text-faint', '--bg-field', 'spot', 'unit suffix, placeholder'],
  ['--text-accent', '--bg-app', 'label', 'label of the suggested action'],
  ['--text-accent', '--accent-subtle', 'label', 'suggested action on selection'],
  ['--text-on-accent', '--accent', 'label', 'segmented thumb label (12 px / 500), check mark'],
  ['--accent-border', '--bg-field', 'mark', 'edge of amber fills'],
  ['--border-control', '--bg-field', 'mark', 'input, checkbox outline'],
  ['--border-control', '--bg-app', 'mark', 'switch track, button outline'],
  ['--border-control', '--bg-chrome', 'mark', 'control outlines in toolbars'],
  ['--focus', '--bg-app', 'mark', 'focus ring (2 px)'],
  ['--focus', '--bg-field', 'mark', 'focus ring'],
  ['--focus', '--bg-chrome', 'mark', 'focus ring in toolbars'],
  ['--focus', '--bg-raised', 'mark', 'focus ring in dialogs'],
  ['--danger', '--bg-field', 'mark', 'invalid field outline'],
  // field illustrations keep full colour focused or not (user, 2026-11-21; ui.md#field)
  ['--text-muted', '--bg-app', 'icon', 'field illustration drawing (1 px, 28 px icon)'],
  ['--text-muted', '--bg-chrome', 'icon', 'field illustration drawing in the inspector'],
  ['--warning', '--bg-app', 'icon', 'warning icon'],
  ['--warning', '--warning-subtle', 'icon', 'hard warning icon'],
  ['--success', '--bg-app', 'icon', 'done icon (status chip)'],
  ['--info', '--bg-app', 'icon', 'info icon'],
  ['--safety-stop-fg', '--safety-stop', 'label', 'Stop label'],
  ['--safety-alarm-fg', '--safety-alarm', 'label', 'Alarm badge (12 px / 600)'],
  ['--safety-hold-fg', '--safety-hold', 'label', 'Feed hold badge'],
  ['--safety-action-fg', '--safety-action', 'label', 'Tool change badge'],
  ['--safety-moving-fg', '--accent-subtle', 'label', 'Running badge'],
  ['--safety-idle', '--bg-field', 'mark', 'Idle badge dot (solid)'],
  ['--safety-offline', '--bg-field', 'icon', 'Not connected badge ring (1.5 px)'],
  // red text takes --danger-text; --danger stays saturated for outlines, markers and icons (ADR 0018)
  ['--danger-text', '--bg-control', 'label', 'danger button label (13 px / 500)'],
  ['--danger-text', '--danger-subtle', 'label', 'danger button label on hover, danger chip'],
  ['--danger-text', '--bg-raised', 'read', 'danger menu item'],
  ['--danger-text', '--bg-chrome', 'read', 'field error text in the support area (12 px)'],
  ['--danger', '--bg-app', 'icon', 'failed operation icon in the navigator'],
  ['--danger', '--bg-chrome', 'icon', 'error icon in the status bar'],
  ['--danger', '--danger-subtle', 'icon', 'error banner and error-tier list icon'],
  ['--info', '--info-subtle', 'label', 'agent tag (10 px / 500)'],
  // viewport lines (1–2 px) on what they are drawn over; grid and surface tints are area fills
  // kept deliberately quiet, with no target (ui.md#colour)
  ['--vp-edge', '--vp-part', 'mark', 'feature edges on the part'],
  ['--vp-edge', '--vp-hover', 'mark', 'feature edges on a hovered operation'],
  ['--vp-edge', '--vp-outdated', 'mark', 'feature edges on an outdated part'],
  ['--vp-edge', '--vp-removal', 'mark', 'feature edges on removed material'],
  ['--vp-selected', '--vp-part', 'mark', 'selection outline on the part'],
  ['--vp-stock', '--bg-viewport', 'mark', 'stock outline (dashed)'],
  ['--vp-feed', '--bg-viewport', 'mark', 'feed moves'],
  ['--vp-feed', '--vp-part', 'mark', 'feed moves over the part'],
  ['--vp-rapid', '--bg-viewport', 'mark', 'rapid moves'],
  ['--vp-plunge', '--bg-viewport', 'mark', 'plunges'],
  ['--vp-plunge', '--vp-part', 'mark', 'plunges over the part'],
  ['--vp-tool', '--bg-viewport', 'mark', 'tool marker'],
  ['--aid', '--bg-viewport', 'mark', 'alignment pick target'],
  ['--aid', '--bg-chrome', 'mark', 'alignment aid row icon'],
  ['--vp-axis-x', '--bg-viewport', 'mark', 'X axis'],
  ['--vp-axis-y', '--bg-viewport', 'mark', 'Y axis'],
  ['--vp-axis-z', '--bg-viewport', 'mark', 'Z axis'],
  ['--danger', '--bg-viewport', 'mark', 'error marker in the viewport'],
  // the compare map's ends against the neutral part (DF60 P5, ui.md § Reference tools)
  ['--danger', '--vp-part', 'mark', 'compare map: missing material at full colour'],
  ['--info', '--vp-part', 'mark', 'compare map: extra material at full colour'],
]

const themes = { light, dark }
const lc = (theme: Theme, fg: string, bg: string): number =>
  apcaLc(themes[theme].get(fg) ?? '', themes[theme].get(bg) ?? '')
const cases = PAIRS.flatMap(([fg, bg, role, where]) =>
  (['light', 'dark'] as const).map((t) => [fg, bg, t, role, ROLES[role], where] as const),
)

describe('tokens.css', () => {
  it.each([
    ['light', light],
    ['dark', dark],
    ['dark (OS)', darkOs],
  ] as const)('%s theme defines every semantic colour token', (_name, theme) => {
    expect(SEMANTIC.filter((t) => !theme.has(t))).toEqual([])
  })

  it('defines no colour token outside the semantic list (docs-only --accent-calm* dropped)', () => {
    expect([...light.keys()].filter((t) => t !== 'color-scheme' && !SEMANTIC.includes(t))).toEqual(
      [],
    )
  })

  it('keeps the OS dark block identical to the explicit dark block', () => {
    expect(Object.fromEntries(darkOs)).toEqual(Object.fromEntries(dark))
  })

  it('defines the theme-independent tokens on :root', () => {
    expect(SHARED.filter((t) => !shared.has(t))).toEqual([])
  })

  it('uses rem for type and spacing, so Electron zoom scales the UI', () => {
    const typeAndSpace = SHARED.filter((t) => /^--(text|lh|space|control)-/.test(t))
    expect(typeAndSpace.filter((t) => !/^\d+(\.\d+)?rem$/.test(shared.get(t) ?? ''))).toEqual([])
  })

  it.each([
    ['OS', find(':root', '@media (prefers-reduced-motion: reduce)')],
    ['app setting', find(":root[data-motion='reduce']", null)],
  ])('sets every motion duration to 0 under reduced motion (%s)', (_name, reduced) => {
    expect(MOTION_DURATIONS().map((t) => reduced.get(t))).toEqual(
      MOTION_DURATIONS().map(() => '0ms'),
    )
  })

  it.each(['light', 'dark'] as const)('%s: plunges differ from feeds and rapids', (t) => {
    const v = (name: string): string | undefined => themes[t].get(name)
    expect(v('--vp-plunge')).not.toBe(v('--vp-feed'))
    expect(v('--vp-plunge')).not.toBe(v('--vp-rapid'))
  })

  describe('APCA contrast (Lc), ui.md#colour', () => {
    it.each(cases)('%s on %s, %s: |Lc| ≥ %s target %s (%s)', (fg, bg, theme, _r, min) => {
      expect(Math.abs(lc(theme, fg, bg))).toBeGreaterThanOrEqual(min)
    })
  })
})

describe('apcaLc (APCA-W3 0.0.98G-4g reference values)', () => {
  it.each([
    ['#888888', '#ffffff', 63.056],
    ['#ffffff', '#888888', -68.541],
    ['#000000', '#ffffff', 106.041],
    ['#ffffff', '#000000', -107.885],
    ['#777777', '#777777', 0],
  ])('%s on %s → Lc %s', (text, bg, expected) => {
    expect(apcaLc(text, bg)).toBeCloseTo(expected, 2)
  })
})
