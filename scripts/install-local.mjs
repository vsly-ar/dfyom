#!/usr/bin/env node
// Installs the packaged app (release/mac-arm64/DFYOM.app, from `npm run package`) to
// ~/Applications/DFYOM.app, replacing an older copy only while that copy is not running.
// macOS only; no sudo. Doc: docs/conventions/packaging.md#install
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SOURCE = join(ROOT, 'release', 'mac-arm64', 'DFYOM.app')
const DIR = join(homedir(), 'Applications')
const TARGET = join(DIR, 'DFYOM.app')

function fail(message) {
  console.error(`install:local: ${message}`)
  process.exit(1)
}

if (process.platform !== 'darwin') fail('only macOS is packaged so far')
if (!existsSync(SOURCE)) fail(`${SOURCE} is missing; run \`npm run package\` first`)

// pgrep exits 0 when a process's command line contains the installed app's path
const running = spawnSync('pgrep', ['-f', TARGET], { encoding: 'utf8' })
if (running.status === 0)
  fail(
    `${TARGET} is running (pid ${running.stdout.trim().split('\n').join(', ')}); ` +
      'quit DFYOM and run `npm run install:local` again',
  )

// copy next to the target first, then swap, so a failed copy leaves the old app in place
mkdirSync(DIR, { recursive: true })
const staging = join(DIR, '.DFYOM.app.installing')
rmSync(staging, { recursive: true, force: true })
execFileSync('ditto', [SOURCE, staging])
rmSync(TARGET, { recursive: true, force: true })
renameSync(staging, TARGET)

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
console.log(`install:local: DFYOM ${version} installed at ${TARGET}`)
