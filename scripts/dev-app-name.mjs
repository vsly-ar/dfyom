#!/usr/bin/env node
// Development on macOS: the unpackaged app runs inside node_modules/electron's Electron.app, whose
// bundle name ("Electron") is what the Dock, Cmd+Tab and the bold app menu show; `app.setName`
// cannot change it. This renames that local bundle to DFYOM (CFBundleName, CFBundleDisplayName)
// and re-signs it ad hoc so its signature stays valid. Runs before `npm run dev`; idempotent, a
// no-op on other platforms and when already renamed. Reinstalling Electron undoes it (the next
// `npm run dev` renames again). Packaged builds take the name from `productName`.
// Doc: docs/conventions/ui.md#app-name-and-icon
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const NAME = 'DFYOM'

if (process.platform === 'darwin') {
  try {
    // node_modules/electron exports the path of its binary: <app>/Contents/MacOS/Electron
    const binary = createRequire(import.meta.url)('electron')
    const app = dirname(dirname(dirname(binary)))
    const plist = join(app, 'Contents', 'Info.plist')
    const read = (key) =>
      execFileSync('plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim()
    if (read('CFBundleName') !== NAME || read('CFBundleDisplayName') !== NAME) {
      for (const key of ['CFBundleName', 'CFBundleDisplayName'])
        execFileSync('plutil', ['-replace', key, '-string', NAME, plist])
      execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' })
      console.log(`dev-app-name: ${app} now shows as ${NAME}`)
    }
  } catch (e) {
    // Only a dev convenience: the app still runs, named "Electron".
    console.warn(`dev-app-name: could not rename the Electron bundle (${String(e)})`)
  }
}
