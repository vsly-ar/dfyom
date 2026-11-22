/* global process, console, document */
// Renders the B21/B22 icon proposals to PNG with Playwright's headless Chromium (no window).
// Usage: node design/icons/render.mjs [outDir]   (default design/icons/renders)
// Writes the standalone B22 SVGs to design/icons/b22/svg/ as well. Doc: design/icons/README.md
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { ICONS, iconSvg } from './b22/icons.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const OUT = resolve(process.argv[2] ?? join(HERE, 'renders'))
const TOKENS = pathToFileURL(join(ROOT, 'src/renderer/src/ui/tokens.css')).href
const AMBER = '#f5b700'
const CONCEPTS = [
  ['a', 'concept-a-flute.svg', 'A · Flute'],
  ['b', 'concept-b-spiral.svg', 'B · Spiral pocket'],
  ['c', 'concept-c-monogram.svg', 'C · Routed D'],
]

mkdirSync(OUT, { recursive: true })
mkdirSync(join(HERE, 'b22/svg'), { recursive: true })
for (const icon of ICONS) {
  const svg = iconSvg(icon, { standalone: true, accent: AMBER, color: '#5b6462', size: 16 })
  writeFileSync(join(HERE, 'b22/svg', `${icon.id}.svg`), `${svg}\n`)
}

const dataUri = (file) =>
  `data:image/svg+xml;base64,${readFileSync(join(HERE, 'b21', file)).toString('base64')}`

const page = (theme, body, extraCss = '') => `<!doctype html><html data-theme="${theme}">
<head><meta charset="utf-8"><link rel="stylesheet" href="${TOKENS}"><style>
*{box-sizing:border-box}body{margin:0;background:var(--bg-app);color:var(--text);font:13px/1.4 var(--font-ui)}
h1{font-size:15px;font-weight:600;margin:0 0 4px}h2{font-size:11px;font-weight:600;letter-spacing:.06em;
text-transform:uppercase;color:var(--text-muted);margin:20px 0 8px}p{margin:0;color:var(--text-muted)}
.ic{color:var(--text-muted)}.ic [data-accent]{transition:none}
.on [data-accent]{stroke:var(--accent-icon);filter:var(--accent-icon-edge)}
.on [data-accent][fill]:not([fill=none]){fill:var(--accent-icon);stroke:none}
.off{opacity:.45}${extraCss}</style></head><body>${body}</body></html>`

// ---------- B22 specimen ----------
function specimen(theme) {
  const groups = [...new Set(ICONS.map((i) => i.group))]
  const cell = (i) => `<div class="cell">
    <div class="row">
      <span class="ic">${iconSvg(i)}</span>
      <span class="ic on">${iconSvg(i)}</span>
      <span class="ic off">${iconSvg(i)}</span>
      <span class="ic on">${iconSvg(i, { size: 20 })}</span>
      <span class="ic on big">${iconSvg(i, { size: 48 })}</span>
    </div>
    <div class="lab">${i.label}<span class="src ${i.src}">${i.src}</span></div></div>`
  const body = `<div class="sheet"><h1>B22 icon set · specimen (${theme})</h1>
  <p>16 px grid · 1.35 px stroke · round caps and joins · one amber part per icon.
  Each cell: 16 rest · 16 active · 16 disabled · 20 active · 48 active (zoom).</p>
  ${groups
    .map(
      (g) =>
        `<h2>${g}</h2><div class="grid">${ICONS.filter((i) => i.group === g)
          .map(cell)
          .join('')}</div>`,
    )
    .join('')}
  <p class="foot">Provenance: approved = approved before B22 · b22 = drawn for the proposal · redraw = drawn for B22-1 b in place of a former Lucide glyph. All own, GPL-3.0-or-later.</p></div>`
  const css = `.sheet{padding:24px 28px;width:1040px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
  .cell{background:var(--bg-chrome);border:1px solid var(--border);border-radius:6px;padding:10px 12px}
  .row{display:flex;align-items:center;gap:14px;height:52px}.row svg{display:block}
  .lab{margin-top:6px;display:flex;justify-content:space-between;color:var(--text)}
  .src{font-size:10px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.05em}
  .src.b22,.src.redraw{color:var(--text-accent)}.big{margin-left:auto}.foot{margin-top:16px;font-size:11px}`
  return page(theme, body, css)
}

// ---------- B22 in context ----------
const byId = Object.fromEntries(ICONS.map((i) => [i.id, i]))
const ic = (id, cls = '', size = 16) =>
  `<span class="ic ${cls}">${iconSvg(byId[id], { size })}</span>`
const field = (
  label,
  illo,
  value,
  focused = false,
) => `<div class="field ${focused ? 'focus' : ''}">
  <span class="illo">${illo}</span><span class="flab">${label}</span><span class="input">${value}</span></div>`
// Field illustrations are the approved FieldIcon shapes (viewBox 20, 1 px grey, amber measured line).
const fillo = (grey, accent) =>
  `<svg viewBox="0 0 20 20" width="28" height="28" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <path d="${grey}" stroke="currentColor" stroke-width="1"/><path d="${accent}" stroke="var(--accent-icon)" stroke-width="1.4" stroke-linecap="butt"/></svg>`
function inContext(theme) {
  const tb = (id, label, cls = '') =>
    `<button class="tbtn ${cls}" title="${label}">${ic(id, cls.includes('pressed') ? 'on' : '')}</button>`
  const op = (id, name, sel = false, meta = '', off = false) =>
    `<div class="oprow ${sel ? 'sel' : ''} ${off ? 'dis' : ''}">${ic(id, sel ? 'on' : off ? 'off' : '')}<span>${name}</span><span class="meta">${meta}</span></div>`
  const body = `<div class="app">
  <header class="bar">
    <div class="modes"><span class="mode active">Design</span><span class="mode">Plan</span><span class="mode">Run</span></div>
    <div class="sep"></div>${tb('undo', 'Undo')}${tb('redo', 'Redo')}<div class="sep"></div>
    ${tb('measure', 'Measure')}${tb('snap', 'Snap', 'pressed')}${tb('reference', 'Reference model')}${tb('work-zero', 'Work zero')}
    <div class="grow"></div>${tb('library', 'Library')}${tb('settings', 'Settings')}
  </header>
  <div class="main">
    <nav class="nav"><h2>Shapes</h2>${op('shape-import', 'Enclosure outline', false, 'used by 2')}
      <h2>Operations</h2>${op('facing', 'Facing 1')}${op('pocket', 'Pocket 1', true, 'T2')}${op('profile', 'Profile 1', false, 'T1')}
      ${op('groove', 'Groove 1', false, 'T3')}${op('drilling', 'Drilling 1', false, 'T4')}${op('fillet', 'Fillet (disabled)', false, '', true)}
      <div class="primary">${ic('export-gcode', 'on')}Export gCode…</div>
    </nav>
    <div class="vp"><span>viewport</span></div>
    <aside class="insp"><h1>Pocket 1</h1><p class="sub">Pocket · Enclosure outline</p>
      <div class="toolpick">${ic('flat-end-mill', 'on', 20)}<div><b>T2 · Flat end mill 6 mm</b><p>2 flutes · carbide</p></div></div>
      <div class="tools">${ic('flat-end-mill', 'on')}${ic('bull-nose-end-mill')}${ic('ball-end-mill')}${ic('chamfer-mill')}${ic('drill', 'off')}</div>
      ${field('Depth', fillo('M2 6H6V14H14V6H18', 'M6 6V14'), '12 mm', true)}
      ${field('Stepdown', fillo('M2 5H7V9H12V13H18', 'M7 5V9'), '2 mm')}
      ${field('Corner radius', fillo('M3 3V10A7 7 0 0 0 10 17H17', 'M3 10A7 7 0 0 0 10 17'), '3.2 mm')}
      <div class="tabsrow">${ic('tabs', 'on')}<span>Tabs</span><span class="meta">4 · 6 × 2 mm</span></div>
    </aside>
  </div></div>`
  const css = `.app{width:1120px;height:430px;display:flex;flex-direction:column;background:var(--bg-app)}
  .bar{height:40px;display:flex;align-items:center;gap:2px;padding:0 10px;background:var(--bg-chrome);border-bottom:1px solid var(--border)}
  .modes{display:flex;gap:4px;margin-right:8px}.mode{display:flex;align-items:center;gap:6px;padding:6px 10px;color:var(--text-muted);border-bottom:2px solid transparent}
  .mode.active{color:var(--text);border-bottom-color:var(--accent)}.mode .ic{color:inherit}
  .sep{width:1px;height:20px;background:var(--border);margin:0 6px}.grow{flex:1}
  .tbtn{all:unset;width:28px;height:28px;display:grid;place-items:center;border-radius:4px}
  .tbtn.pressed{background:var(--bg-active)}.ic svg{display:block}
  .main{flex:1;display:flex;min-height:0}.nav{width:240px;background:var(--bg-chrome);border-right:1px solid var(--border);padding:4px 8px}
  .oprow{display:flex;align-items:center;gap:8px;height:30px;padding:0 8px;border-radius:4px}
  .oprow.sel{background:var(--accent-subtle)}.oprow .meta,.tabsrow .meta{margin-left:auto;color:var(--text-muted);font-size:12px}
  .oprow.dis{color:var(--text-faint)}
  .primary{margin:14px 4px 0;display:flex;gap:8px;align-items:center;justify-content:center;height:30px;border:1px solid var(--border-control);border-radius:5px;background:var(--bg-control);font-weight:600}
  .vp{flex:1;background:var(--bg-viewport);display:grid;place-items:center;color:var(--text-faint)}
  .insp{width:330px;background:var(--bg-chrome);border-left:1px solid var(--border);padding:12px 14px}.sub{margin-bottom:10px}
  .toolpick{display:flex;gap:10px;align-items:center;padding:8px;border:1px solid var(--border-control);border-radius:5px;background:var(--bg-field)}
  .tools{display:flex;gap:14px;padding:10px 8px}
  .field{display:grid;grid-template-columns:32px 100px 1fr;align-items:center;gap:6px;margin:6px 0}
  .field .illo{color:var(--text-muted)}.input{height:28px;display:flex;align-items:center;padding:0 8px;border:1px solid var(--border-control);border-radius:4px;background:var(--bg-field)}
  .field.focus .input{outline:2px solid var(--focus);outline-offset:-1px}.field.focus .illo path:last-child{stroke-width:1.6}
  .tabsrow{display:flex;align-items:center;gap:8px;margin-top:8px}`
  return page(theme, body, css)
}

// ---------- L1 contact sheet (v0.4 icons and the B22 follow-ups) ----------
// The drawings before the L1 redraw, for the side-by-side review only.
const BEFORE = {
  groove: [
    { d: 'M2 4.5h6a5.5 5.5 0 0 1 5.5 5.5v4M2 9.5h6a.5.5 0 0 1 .5.5v4' },
    { d: 'M2 7h6a3 3 0 0 1 3 3v4', a: true },
  ],
  pick: [
    { circle: [8, 8, 4.5] },
    { d: 'M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2' },
    { circle: [8, 8, 1.2], a: true, fill: true },
  ],
  disconnect: [{ d: 'M6 1.5v3M10 1.5v3M8 11.5v3M4 4.5h8v2.5a4 4 0 0 1-8 0zM1.5 14.5l13-13' }],
}
const L1 = [
  ['hole-simple', 'hole-counterbore', 'hole-countersink', 'chamfer', 'chamfer-mill', 'clones'],
  ['row-grid', 'row-offset', 'row-polar', 'row-arc', 'row-point', 'row-along'],
  ['groove', 'pick', 'drilling', 'disconnect', 'connect'],
]
function l1Sheet(theme) {
  const sizes = (i) =>
    [16, 20, 32]
      .map(
        (s) =>
          `<span class="ic">${iconSvg(i, { size: s })}</span><span class="ic on">${iconSvg(i, { size: s })}</span>`,
      )
      .join('')
  const row = (id) => {
    const i = byId[id]
    const before = BEFORE[id]
      ? `<span class="was">was</span>${sizes({ id, parts: BEFORE[id] })}`
      : ''
    return `<div class="r"><span class="lab">${ic(id)}<span>${i.label}</span></span>
      <span class="lab sel">${ic(id, 'on')}<span>${i.label}</span></span>${sizes(i)}${before}<code>${id}</code></div>`
  }
  const body = `<div class="sheet"><h1>L1 icons · contact sheet (${theme})</h1>
  <p>Each row: 16 px beside its label at rest and selected · then 16 / 20 / 32 px, each at rest and active ·
  redrawn icons also show the drawing they replace. Drilling and Connect are unchanged, shown for comparison.</p>
  ${L1.map((g, n) => `<h2>${['Features', 'Clones row kinds', 'B22 follow-ups'][n]}</h2>${g.map(row).join('')}`).join('')}</div>`
  const css = `.sheet{padding:20px 24px;width:900px}.r{display:flex;align-items:center;gap:12px;height:44px;border-bottom:1px solid var(--border)}
  .lab{display:flex;flex:none;align-items:center;gap:8px;width:170px;height:28px;padding:0 8px;border-radius:4px;color:var(--text)}
  .lab.sel{background:var(--accent-subtle)}.r>.ic{flex:none}.ic svg{display:block}.was{margin-left:12px;color:var(--text-faint);font-size:11px}
  code{margin-left:auto;color:var(--text-faint);font-size:11px}`
  return page(theme, body, css)
}

// ---------- B21 small sizes ----------
function smallSizes() {
  const rows = CONCEPTS.map(
    ([, file, name]) => `<div class="r"><div class="nm">${name}</div>
    ${[128, 64, 32, 16].map((s) => `<img src="${dataUri(file)}" width="${s}" height="${s}">`).join('')}
    <canvas data-src="${dataUri(file)}" data-size="32" width="192" height="192"></canvas>
    <canvas data-src="${dataUri(file)}" data-size="16" width="192" height="192"></canvas></div>`,
  ).join('')
  const block = (cls, title) => `<section class="${cls}"><h2>${title}</h2>${rows}</section>`
  const body = `<div class="wrap"><h1>B21 app icon · small sizes</h1>
  <p>128 / 64 / 32 / 16 px at actual pixels (1×), then the 32 and 16 px renders enlarged 6× (nearest neighbour).</p>
  ${block('lt', 'On a light desktop')}${block('dk', 'On a dark desktop')}</div>
  <script>document.querySelectorAll('canvas').forEach((c)=>{const s=+c.dataset.size;const img=new Image();
  img.onload=()=>{const o=document.createElement('canvas');o.width=o.height=s;o.getContext('2d').drawImage(img,0,0,s,s);
  const x=c.getContext('2d');x.imageSmoothingEnabled=false;x.drawImage(o,0,0,s,s,0,0,192,192);c.dataset.done='1'};img.src=c.dataset.src})</script>`
  const css = `.wrap{padding:20px 24px;width:880px}section{padding:4px 16px 12px;border-radius:8px;margin-top:12px}
  .lt{background:#dfe5ee}.dk{background:#1b1e24}.dk h2,.dk .nm{color:#b9c4c1}
  .r{display:flex;align-items:center;gap:18px;margin:8px 0}.nm{width:130px;font-weight:600}canvas{width:96px;height:96px;image-rendering:pixelated}`
  return page('light', body, css)
}

const browser = await chromium.launch({
  headless: true,
  // Optional: an already-installed Chromium when the bundled one is missing.
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
})
async function shot(html, file, { width, height, scale = 2, transparent = false, selector } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale })
  const p = await ctx.newPage()
  const tmp = join(OUT, '.tmp.html')
  writeFileSync(tmp, html)
  await p.goto(pathToFileURL(tmp).href)
  await p.waitForFunction(() =>
    [...document.querySelectorAll('canvas')].every((c) => c.dataset.done),
  )
  const target = selector ? p.locator(selector) : p
  await target.screenshot({
    path: join(OUT, file),
    omitBackground: transparent,
    fullPage: !selector,
  })
  await ctx.close()
}

for (const [key, file] of CONCEPTS) {
  const html = `<!doctype html><body style="margin:0;background:transparent"><img src="${dataUri(file)}" width="1024" height="1024" style="display:block"></body>`
  await shot(html, `b21-concept-${key}.png`, {
    width: 1024,
    height: 1024,
    scale: 1,
    transparent: true,
  })
}
await shot(smallSizes(), 'b21-small-sizes.png', {
  width: 930,
  height: 600,
  scale: 1,
  selector: '.wrap',
})
for (const theme of ['light', 'dark']) {
  await shot(specimen(theme), `b22-specimen-${theme}.png`, {
    width: 1100,
    height: 800,
    selector: '.sheet',
  })
  await shot(inContext(theme), `b22-in-context-${theme}.png`, {
    width: 1120,
    height: 430,
    selector: '.app',
  })
  await shot(l1Sheet(theme), `l1-contact-${theme}.png`, {
    width: 960,
    height: 900,
    selector: '.sheet',
  })
}
await browser.close()
rmSync(join(OUT, '.tmp.html'), { force: true })
console.log(`renders in ${OUT}`)
