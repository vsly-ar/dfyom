// Rebuilds the vendored CavalierContours WASM module (vendor/cavalier-contours/) and its SHA-256
// file. CI never runs this: it only checks the checksum (build-cavalier-wasm.test.mjs), so no Rust
// toolchain is needed there (plans/v0.3.md Q26, ADR 0019). Run it after changing the crate pin,
// Cargo.lock or src/lib.rs, and commit the three outputs together.
//
//   npm run wasm:cavalier            rebuild and overwrite the vendored module and checksum
//   npm run wasm:cavalier -- --check rebuild into a temp folder and compare with the vendored file
//
// Needs rustup's toolchain RUST_VERSION with the wasm32-unknown-unknown target
// (`rustup toolchain install <version> --target wasm32-unknown-unknown`); Homebrew's cargo cannot
// build for wasm. Paths are remapped so the module does not depend on the machine it was built on.
// Doc: docs/architecture/shapes.md#2d-port
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The pinned Rust toolchain (the vendored module was built with it). */
export const RUST_VERSION = '1.100.0'
export const CRATE_DIR = resolve(import.meta.dirname, '../vendor/cavalier-contours')
export const WASM_PATH = join(CRATE_DIR, 'cavalier_contours.wasm')
export const SHA256_PATH = `${WASM_PATH}.sha256`
const TARGET = 'wasm32-unknown-unknown'

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** `<hex>  <file name>` as `shasum -a 256` writes it. */
export const checksumLine = (bytes) => `${sha256(bytes)}  cavalier_contours.wasm\n`

/** The hex digest recorded in the `.sha256` file. */
export const recordedSha256 = (text) => text.trim().split(/\s+/)[0]

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.error) throw r.error
  return r
}

/**
 * `cargo` and `rustc` of rustup's toolchain with the pinned version (named after it, or `stable`
 * if that matches), by absolute path: `rustup run` keeps a Homebrew `rustc` first on the PATH.
 */
function toolchain() {
  for (const name of [RUST_VERSION, 'stable']) {
    const which = (bin) => run('rustup', ['which', '--toolchain', name, bin])
    const rustc = which('rustc')
    const cargo = which('cargo')
    if (rustc.status !== 0 || cargo.status !== 0) continue
    const tc = { rustc: rustc.stdout.trim(), cargo: cargo.stdout.trim() }
    const version = run(tc.rustc, ['--version'])
    if (version.status !== 0 || !version.stdout.startsWith(`rustc ${RUST_VERSION} `)) continue
    const libdir = run(tc.rustc, ['--print', 'target-libdir', '--target', TARGET])
    if (libdir.status === 0 && existsSync(libdir.stdout.trim())) return tc
    throw new Error(
      `Rust ${RUST_VERSION} lacks the ${TARGET} target: rustup target add ${TARGET} --toolchain ${name}`,
    )
  }
  throw new Error(
    `Rust ${RUST_VERSION} not found; install it: rustup toolchain install ${RUST_VERSION} --target ${TARGET}`,
  )
}

/** Builds the module and returns its bytes. */
export function build() {
  const tc = toolchain()
  const targetDir = mkdtempSync(join(tmpdir(), 'dfyom-cavalier-'))
  try {
    const cargoHome = process.env['CARGO_HOME'] ?? join(homedir(), '.cargo')
    const rustflags = [
      `--remap-path-prefix=${cargoHome}=/cargo`,
      `--remap-path-prefix=${CRATE_DIR}=/dfyom_cavalier`,
    ].join(' ')
    const r = run(tc.cargo, ['build', '--release', '--locked', '--target', TARGET], {
      cwd: CRATE_DIR,
      stdio: 'inherit',
      env: { ...process.env, CARGO_TARGET_DIR: targetDir, RUSTC: tc.rustc, RUSTFLAGS: rustflags },
    })
    if (r.status !== 0) throw new Error(`cargo build failed (exit ${r.status})`)
    return readFileSync(join(targetDir, TARGET, 'release', 'dfyom_cavalier.wasm'))
  } finally {
    rmSync(targetDir, { recursive: true, force: true })
  }
}

function main() {
  const bytes = build()
  if (process.argv.includes('--check')) {
    const vendored = readFileSync(WASM_PATH)
    if (sha256(bytes) !== sha256(vendored)) {
      console.error(`rebuilt module differs: ${sha256(bytes)} vs vendored ${sha256(vendored)}`)
      process.exit(1)
    }
    console.log(`rebuilt module matches the vendored one (${sha256(bytes)})`)
    return
  }
  writeFileSync(WASM_PATH, bytes)
  writeFileSync(SHA256_PATH, checksumLine(bytes))
  console.log(`wrote ${WASM_PATH} (${bytes.length} bytes, sha256 ${sha256(bytes)})`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) main()
