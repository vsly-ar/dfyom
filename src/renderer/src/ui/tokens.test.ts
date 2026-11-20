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
  ...['feed', 'rapid', 'tool', 'axis-x', 'axis-y', 'axis-z'].map((s) => `--vp-${s}`),
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
 * in that order (APCA is polarity-aware), with the role that sets the target. `below` pins pairs
 * that miss the target in a theme (Lc noted; colours left as approved; v0.1 plan known issues):
 * they run as `it.fails`, so fixing a colour turns the test red until the entry is removed.
 */
const PAIRS: [
  fg: string,
  bg: string,
  role: Role,
  where: string,
  below?: Partial<Record<Theme, number>>,
][] = [
  ['--text', '--bg-app', 'read', 'body text'],
  ['--text', '--bg-chrome', 'read', 'toolbar, status bar, support area'],
  ['--text', '--bg-field', 'read', 'input values'],
  ['--text', '--bg-raised', 'read', 'menus, popovers, dialogs'],
  ['--text', '--bg-control', 'label', 'button labels (13 px / 500)'],
  ['--text', '--accent-subtle', 'read', 'selected row'],
  ['--text', '--warning-subtle', 'read', 'hard warning text (12 px)'],
  ['--text', '--danger-subtle', 'read', 'error banner text'],
  ['--bg-app', '--text', 'label', 'tooltip, inverted (12 px / 500)'],
  ['--text-muted', '--bg-app', 'read', 'labels, secondary text', { dark: -51.9 }],
  [
    '--text-muted',
    '--bg-chrome',
    'read',
    'support area notes (12 px), status bar',
    { light: 70.9, dark: -50.1 },
  ],
  ['--text-muted', '--bg-field', 'read', 'read-only values', { dark: -53.1 }],
  ['--text-muted', '--bg-raised', 'read', 'dialog body', { dark: -47.8 }],
  [
    '--text-muted',
    '--bg-control',
    'label',
    'ghost buttons, segmented items (500)',
    { dark: -47.8 },
  ],
  ['--text-faint', '--bg-app', 'spot', 'metadata (non-essential)'],
  ['--text-faint', '--bg-field', 'spot', 'unit suffix, placeholder'],
  ['--text-accent', '--bg-app', 'label', 'label of the suggested action'],
  ['--text-accent', '--accent-subtle', 'label', 'suggested action on selection'],
  ['--text-on-accent', '--accent', 'label', 'segmented thumb label (12 px / 500), check mark'],
  ['--accent-border', '--bg-field', 'mark', 'edge of amber fills'],
  ['--border-control', '--bg-field', 'mark', 'input, checkbox outline', { dark: -26.9 }],
  ['--border-control', '--bg-app', 'mark', 'switch track, button outline', { dark: -25.8 }],
  ['--border-control', '--bg-chrome', 'mark', 'control outlines in toolbars', { dark: -24.0 }],
  ['--focus', '--bg-app', 'mark', 'focus ring (2 px)'],
  ['--focus', '--bg-field', 'mark', 'focus ring'],
  ['--focus', '--bg-chrome', 'mark', 'focus ring in toolbars'],
  ['--focus', '--bg-raised', 'mark', 'focus ring in dialogs'],
  ['--danger', '--bg-field', 'mark', 'invalid field outline'],
  ['--warning', '--bg-app', 'icon', 'warning icon'],
  ['--warning', '--warning-subtle', 'icon', 'hard warning icon'],
  ['--success', '--bg-app', 'icon', 'done icon (status chip)'],
  ['--info', '--bg-app', 'icon', 'info icon'],
  ['--safety-stop-fg', '--safety-stop', 'label', 'Stop label'],
  ['--safety-alarm-fg', '--safety-alarm', 'label', 'Alarm badge (12 px / 600)'],
  ['--safety-hold-fg', '--safety-hold', 'label', 'Feed hold badge', { light: 44.9, dark: 53.2 }],
  ['--safety-action-fg', '--safety-action', 'label', 'Tool change badge', { dark: 49.1 }],
  ['--safety-moving-fg', '--accent-subtle', 'label', 'Running badge'],
  ['--safety-idle', '--bg-field', 'mark', 'Idle badge dot (solid)'],
  ['--safety-offline', '--bg-field', 'icon', 'Not connected badge ring (1.5 px)', { dark: -32.6 }],
  ['--danger', '--bg-control', 'label', 'danger button label (13 px / 500)', { dark: -35.5 }],
  ['--danger', '--bg-raised', 'read', 'danger menu item', { light: 74.2, dark: -35.5 }],
  ['--danger', '--danger-subtle', 'label', 'danger chip (12 px / 500)', { dark: -38.7 }],
  [
    '--danger',
    '--bg-chrome',
    'read',
    'field error text in the support area (12 px)',
    { light: 64.7, dark: -37.8 },
  ],
  ['--info', '--info-subtle', 'label', 'agent tag (10 px / 500)', { dark: -47.5 }],
]

const themes = { light, dark }
const lc = (theme: Theme, fg: string, bg: string): number =>
  apcaLc(themes[theme].get(fg) ?? '', themes[theme].get(bg) ?? '')
const cases = (pinned: boolean) =>
  PAIRS.flatMap(([fg, bg, role, where, below]) =>
    (['light', 'dark'] as const)
      .filter((t) => (below?.[t] !== undefined) === pinned)
      .map((t) => [fg, bg, t, role, ROLES[role], where] as const),
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

  describe('APCA contrast (Lc), ui.md#colour', () => {
    it.each(cases(false))('%s on %s, %s: |Lc| ≥ %s target %s (%s)', (fg, bg, theme, _r, min) => {
      expect(Math.abs(lc(theme, fg, bg))).toBeGreaterThanOrEqual(min)
    })

    it.fails.each(cases(true))(
      'below target (reported): %s on %s, %s: |Lc| ≥ %s target %s (%s)',
      (fg, bg, theme, _r, min) => {
        expect(Math.abs(lc(theme, fg, bg))).toBeGreaterThanOrEqual(min)
      },
    )

    it('notes the current Lc of every pinned pair', () => {
      const noted = PAIRS.flatMap(([fg, bg, , , below]) =>
        Object.entries(below ?? {}).map(([t, v]) => [fg, bg, t, v]),
      )
      const actual = noted.map(([fg, bg, t]) => [
        fg,
        bg,
        t,
        Math.round(lc(t as Theme, fg as string, bg as string) * 10) / 10,
      ])
      expect(actual).toEqual(noted)
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
