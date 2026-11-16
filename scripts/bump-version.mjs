#!/usr/bin/env node
// Bumps the patch version when a commit touches app code. Run by .githooks/pre-commit.
// Rules and rationale: docs/conventions/versioning.md
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Path prefixes / files whose changes count as "app code". Keep in sync with docs/conventions/versioning.md */
export const APP_CODE_PATTERNS = [/^src\//, /^resources\//, /^electron\.vite\.config\.ts$/]

/** Files that never trigger a bump on their own, even under src/ */
const IGNORED_PATTERNS = [/\.test\.[cm]?[jt]sx?$/, /\.md$/]

/** @param {string[]} paths repo-relative staged paths */
export function touchesAppCode(paths) {
  return paths.some(
    (p) => APP_CODE_PATTERNS.some((re) => re.test(p)) && !IGNORED_PATTERNS.some((re) => re.test(p)),
  )
}

/** @param {string} version semver "x.y.z" (pre-release suffix is dropped) */
export function bumpPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!m) throw new Error(`Cannot bump non-semver version "${version}"`)
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function main() {
  if (process.env.SKIP_VERSION_BUMP === '1') return

  const staged = git('diff', '--cached', '--name-only', '--diff-filter=ACMRD')
    .split('\n')
    .filter(Boolean)
  if (!touchesAppCode(staged)) return

  // Refuse to silently stage unrelated unstaged edits of these files.
  const files = ['package.json', 'package-lock.json'].filter((f) => existsSync(f))
  const dirty = git('diff', '--name-only', '--', ...files)
    .split('\n')
    .filter(Boolean)
  if (dirty.length > 0) {
    console.error(
      `[bump-version] ${dirty.join(', ')} has unstaged changes; stage or stash them first ` +
        '(or commit with SKIP_VERSION_BUMP=1).',
    )
    process.exit(1)
  }

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const next = bumpPatch(pkg.version)
  pkg.version = next
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')

  if (existsSync('package-lock.json')) {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
    lock.version = next
    if (lock.packages?.['']) lock.packages[''].version = next
    writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n')
  }

  git('add', ...files)
  console.log(`[bump-version] app code changed → version ${next}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
