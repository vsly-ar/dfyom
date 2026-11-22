#!/usr/bin/env node
// Development on macOS: the unpackaged app runs inside node_modules/electron's Electron.app, whose
// bundle name ("Electron") and icon are what the Dock, Cmd+Tab and the bold app menu show;
// `app.setName` cannot change them. This renames that local bundle to DFYOM (CFBundleName,
// CFBundleDisplayName), gives it the app icon (build/icon.icns over its CFBundleIconFile) and
// re-signs it ad hoc so its signature stays valid. Runs before `npm run dev`; idempotent, a no-op
// on other platforms and when already done. Reinstalling Electron undoes it (the next `npm run dev`
// does it again). Packaged builds take the name from `productName` and the icon from build/.
// Doc: docs/conventions/ui.md#app-name-and-icon
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const NAME = 'DFYOM'
const ICON = join(import.meta.dirname, '..', 'build', 'icon.icns')

if (process.platform === 'darwin') {
  try {
    // node_modules/electron exports the path of its binary: <app>/Contents/MacOS/Electron
    const binary = createRequire(import.meta.url)('electron')
    const app = dirname(dirname(dirname(binary)))
    const plist = join(app, 'Contents', 'Info.plist')
    const read = (key) =>
      execFileSync('plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim()
    let changed = false
    if (read('CFBundleName') !== NAME || read('CFBundleDisplayName') !== NAME) {
      for (const key of ['CFBundleName', 'CFBundleDisplayName'])
        execFileSync('plutil', ['-replace', key, '-string', NAME, plist])
      changed = true
    }
    const icon = join(app, 'Contents', 'Resources', read('CFBundleIconFile'))
    if (existsSync(ICON) && !(existsSync(icon) && readFileSync(icon).equals(readFileSync(ICON)))) {
      copyFileSync(ICON, icon)
      changed = true
    }
    if (changed) {
      execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' })
      console.log(`dev-app-name: ${app} now shows as ${NAME} with its icon`)
    }
  } catch (e) {
    // Only a dev convenience: the app still runs, named "Electron".
    console.warn(`dev-app-name: could not rename the Electron bundle (${String(e)})`)
  }
}
