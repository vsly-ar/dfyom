// Spike S1 (docs/decisions/0019-2d-geometry-library.md): bundle size of what the app would ship
// per candidate (minified ESM, tree-shaken to the functions the spike uses), raw and gzip -9.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'

const dir = import.meta.dirname
const entries: [string, string][] = [
  [
    'cavalier-contours-js (Shape offset + boolean)',
    `import { Polyline, Shape } from 'cavalier-contours-js'; export { Polyline, Shape }`,
  ],
  [
    'clipper2-ts (inflatePathsD, unionD, differenceD)',
    `export { inflatePathsD, unionD, differenceD } from 'clipper2-ts'`,
  ],
  [
    'clipper2-ts + spike re-fit + flatten',
    `export { inflatePathsD, unionD, differenceD } from 'clipper2-ts'; export { refit } from './refit.ts'; export { flatten } from './geom.ts'`,
  ],
  [
    'cc-wasm JS glue (candidates.ts adapter only)',
    `export { cavalierWasm } from './candidates.ts'`,
  ],
]

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KiB`

console.log('| Candidate | Minified | gzip -9 |')
console.log('| --- | --- | --- |')
for (const [name, contents] of entries) {
  const r = await build({
    stdin: { contents, resolveDir: dir, loader: 'ts' },
    bundle: true,
    minify: true,
    format: 'esm',
    write: false,
    // the WASM adapter lives next to the other candidates; keep them out of its measurement
    external: name.startsWith('cc-wasm') ? ['cavalier-contours-js', 'clipper2-ts'] : [],
  })
  const code = r.outputFiles[0]!.contents
  console.log(`| ${name} | ${kb(code.length)} | ${kb(gzipSync(code, { level: 9 }).length)} |`)
}
const wasm = join(dir, 'cc-wasm', 'cc_wasm.wasm')
if (existsSync(wasm)) {
  const b = readFileSync(wasm)
  console.log(
    `| cc_wasm.wasm (cavalier_contours 0.9.0, opt-level 3, LTO, no wasm-opt) | ${kb(b.length)} | ${kb(gzipSync(b, { level: 9 }).length)} |`,
  )
}
