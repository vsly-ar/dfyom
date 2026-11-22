#!/usr/bin/env node
/* global document */
// Builds the app icon (B21 concept C "Routed D", approved in L3, D33) into electron-builder's
// `buildResources` slot: build/icon.png (1024 px), build/icon.icns (macOS) and build/icon.ico
// (Windows). 16 and 32 px images use the simplified drawing (the D alone, B21-2 a); larger ones
// the full drawing. Renders with Playwright's headless Chromium (no window), packs the .icns with
// macOS `iconutil` and writes the .ico itself (PNG entries). Run `npm run icon` after changing a
// source SVG and commit build/icon.*; the outputs are deterministic for a given Chromium.
// Usage: node scripts/app-icon.mjs [outDir]   (default build/); CHROMIUM_PATH picks a browser.
// Doc: docs/conventions/ui.md#app-name-and-icon, design/icons/README.md#b21-app-icon
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'

const ROOT = join(import.meta.dirname, '..')
const OUT = resolve(process.argv[2] ?? join(ROOT, 'build'))
const FULL = join(ROOT, 'design/icons/b21/concept-c-monogram.svg')
const SMALL = join(ROOT, 'design/icons/b21/concept-c-small.svg')
/** Pixel sizes up to this use the simplified drawing. */
const SMALL_MAX = 32

/** The .icns members: file name in the .iconset → pixel size. */
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

const svgFor = (px) => readFileSync(px <= SMALL_MAX ? SMALL : FULL)

/** A PNG of the SVG at `px` × `px`, transparent around the body. */
async function render(browser, px) {
  const page = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 })
  const uri = `data:image/svg+xml;base64,${svgFor(px).toString('base64')}`
  await page.setContent(
    `<!doctype html><body style="margin:0;background:transparent">` +
      `<img src="${uri}" width="${px}" height="${px}" style="display:block"></body>`,
  )
  await page.waitForFunction(() => document.images[0]?.complete)
  const png = await page.screenshot({ omitBackground: true })
  await page.close()
  return png
}

/** An .ico holding each PNG as is (PNG entries are valid from Windows Vista on). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(([px, png], i) => {
    const e = 6 + 16 * i
    header.writeUInt8(px >= 256 ? 0 : px, e) // 0 means 256
    header.writeUInt8(px >= 256 ? 0 : px, e + 1)
    header.writeUInt16LE(1, e + 4) // colour planes
    header.writeUInt16LE(32, e + 6) // bits per pixel
    header.writeUInt32LE(png.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map(([, png]) => png)])
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
})
const pngs = new Map()
for (const px of new Set([...ICONSET.map(([, px]) => px), ...ICO_SIZES]))
  pngs.set(px, await render(browser, px))
await browser.close()

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'icon.png'), pngs.get(1024))
writeFileSync(join(OUT, 'icon.ico'), ico(ICO_SIZES.map((px) => [px, pngs.get(px)])))
if (process.platform === 'darwin') {
  const tmp = mkdtempSync(join(tmpdir(), 'dfyom-icon-'))
  const set = join(tmp, 'icon.iconset')
  mkdirSync(set)
  for (const [name, px] of ICONSET) writeFileSync(join(set, name), pngs.get(px))
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(OUT, 'icon.icns')])
  rmSync(tmp, { recursive: true, force: true })
} else {
  console.warn('app-icon: build/icon.icns needs macOS iconutil; left unchanged')
}
console.log(
  `app-icon: icon.png, icon.ico${process.platform === 'darwin' ? ', icon.icns' : ''} in ${OUT}`,
)
