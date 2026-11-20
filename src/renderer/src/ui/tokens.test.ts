// Token checks: both themes define every semantic colour token, the two dark blocks agree, and
// the contrast pairs meet ui.md's thresholds in both themes. Rules: docs/conventions/ui.md#colour
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

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

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m?.[1]) throw new Error(`not an opaque #rrggbb colour: ${hex}`)
  const h = m[1]
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(theme: Map<string, string>, fg: string, bg: string): number {
  const a = luminance(theme.get(fg) ?? '')
  const b = luminance(theme.get(bg) ?? '')
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const TEXT = 4.5
const UI = 3

/**
 * Pairs the components actually draw, with ui.md's thresholds: text ≥ 4.5:1; UI boundaries,
 * focus ring and meaningful icons ≥ 3:1. `--text-faint` is for units, metadata and disabled
 * text only (never essential), so it is held to 3:1 like the page does.
 */
const PAIRS: [fg: string, bg: string, min: number, where: string][] = [
  ['--text', '--bg-app', TEXT, 'body text'],
  ['--text', '--bg-chrome', TEXT, 'toolbar, status bar, support area'],
  ['--text', '--bg-field', TEXT, 'input values'],
  ['--text', '--bg-raised', TEXT, 'menus, popovers, dialogs'],
  ['--text', '--bg-control', TEXT, 'button labels'],
  ['--text', '--accent-subtle', TEXT, 'selected row'],
  ['--text', '--warning-subtle', TEXT, 'hard warning text'],
  ['--text', '--danger-subtle', TEXT, 'error banner text'],
  ['--bg-app', '--text', TEXT, 'tooltip (inverted)'],
  ['--text-muted', '--bg-app', TEXT, 'labels, secondary text'],
  ['--text-muted', '--bg-chrome', TEXT, 'support area notes, status bar'],
  ['--text-muted', '--bg-field', TEXT, 'read-only values'],
  ['--text-muted', '--bg-raised', TEXT, 'dialog body'],
  ['--text-muted', '--bg-control', TEXT, 'ghost buttons, toolbar icons on controls'],
  ['--text-faint', '--bg-app', UI, 'metadata (non-essential)'],
  ['--text-faint', '--bg-field', UI, 'unit suffix, placeholder'],
  ['--text-accent', '--bg-app', TEXT, 'amber-toned text'],
  ['--text-accent', '--accent-subtle', TEXT, 'amber-toned text on selection'],
  ['--text-on-accent', '--accent', TEXT, 'segmented thumb label, check mark'],
  ['--accent-border', '--bg-field', UI, 'edge of amber fills'],
  ['--border-control', '--bg-field', UI, 'input, checkbox outline'],
  ['--border-control', '--bg-app', UI, 'switch track, button outline'],
  ['--focus', '--bg-app', UI, 'focus ring'],
  ['--focus', '--bg-field', UI, 'focus ring'],
  ['--focus', '--bg-chrome', UI, 'focus ring in toolbars'],
  ['--focus', '--bg-raised', UI, 'focus ring in dialogs'],
  ['--danger', '--bg-field', TEXT, 'invalid field text'],
  ['--warning', '--bg-app', UI, 'warning icon'],
  ['--warning', '--warning-subtle', UI, 'hard warning icon'],
  ['--success', '--bg-app', TEXT, 'done'],
  ['--info', '--bg-app', TEXT, 'info'],
  ['--safety-stop-fg', '--safety-stop', TEXT, 'Stop label'],
  ['--safety-alarm-fg', '--safety-alarm', TEXT, 'Alarm badge'],
  ['--safety-hold-fg', '--safety-hold', TEXT, 'Feed hold badge'],
  ['--safety-action-fg', '--safety-action', TEXT, 'Tool change badge'],
  ['--safety-moving-fg', '--accent-subtle', TEXT, 'Running badge'],
  ['--safety-idle', '--bg-field', UI, 'Idle badge dot'],
  ['--safety-offline', '--bg-field', UI, 'Not connected badge ring'],
]

/**
 * Pairs the approved page draws that miss the threshold (reported to the user, colours left
 * unchanged pending a decision; v0.1 plan known issues). `it.fails`: when a colour is fixed,
 * this turns red; move the pair to PAIRS.
 */
const BELOW: [fg: string, bg: string, min: number, theme: 'light' | 'dark', where: string][] = [
  ['--danger', '--bg-control', TEXT, 'dark', 'danger button label (3.52)'],
  ['--danger', '--bg-raised', TEXT, 'dark', 'danger menu item (3.52)'],
  ['--danger', '--danger-subtle', TEXT, 'dark', 'danger chip (4.22)'],
  ['--danger', '--bg-chrome', TEXT, 'light', 'field error text in the support area (4.48)'],
  ['--danger', '--bg-chrome', TEXT, 'dark', 'field error text in the support area (3.96)'],
  ['--info', '--info-subtle', TEXT, 'light', 'agent tag (4.40)'],
]

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

  describe.each([
    ['light', light],
    ['dark', dark],
  ] as const)('contrast, %s theme', (_name, theme) => {
    it.each(PAIRS)('%s on %s ≥ %s:1 (%s)', (fg, bg, min) => {
      expect(contrast(theme, fg, bg)).toBeGreaterThanOrEqual(min)
    })
  })

  describe('contrast pairs below the threshold on the approved page (reported)', () => {
    it.fails.each(BELOW)('%s on %s ≥ %s:1 in %s (%s)', (fg, bg, min, theme) => {
      expect(contrast(theme === 'light' ? light : dark, fg, bg)).toBeGreaterThanOrEqual(min)
    })
  })
})
