// Help → Connect an agent… (hardening A4): the launcher of each installation kind and the
// `claude mcp add` lines, shell-quoted.
// Doc: docs/conventions/ui.md#connect-an-agent-hardening-a4
import { describe, expect, it } from 'vitest'
import { connectInfo, launcher, shellQuote, type Installation } from './connect-agent'

const PACKAGED_MAC: Installation = {
  packaged: true,
  platform: 'darwin',
  resourcesPath: '/Users/ana/Applications/DFYOM.app/Contents/Resources',
  execPath: '/Users/ana/Applications/DFYOM.app/Contents/MacOS/DFYOM',
  mainDir: '/Users/ana/Applications/DFYOM.app/Contents/Resources/app.asar/out/main',
}

describe('launcher', () => {
  it('the packaged macOS app runs bin/dfyom in its Resources', () => {
    expect(launcher(PACKAGED_MAC)).toEqual({
      argv: ['/Users/ana/Applications/DFYOM.app/Contents/Resources/bin/dfyom'],
      env: {},
    })
  })

  it('another packaged platform runs the binary as Node on the CLI entry', () => {
    expect(
      launcher({
        packaged: true,
        platform: 'linux',
        resourcesPath: '/opt/DFYOM/resources',
        execPath: '/opt/DFYOM/dfyom',
        mainDir: '/opt/DFYOM/resources/app.asar/out/main',
      }),
    ).toEqual({
      argv: ['/opt/DFYOM/dfyom', '/opt/DFYOM/resources/app.asar/out/main/cli.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('development runs the built CLI with node', () => {
    expect(
      launcher({
        packaged: false,
        platform: 'darwin',
        resourcesPath: '/x/node_modules/electron/dist/Electron.app/Contents/Resources',
        execPath: '/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
        mainDir: '/src/dfyom/out/main',
      }),
    ).toEqual({ argv: ['node', '/src/dfyom/out/main/cli.js'], env: {} })
  })
})

describe('shellQuote', () => {
  it('leaves plain words, single-quotes the rest', () => {
    expect(shellQuote('/Users/ana/bin/dfyom')).toBe('/Users/ana/bin/dfyom')
    expect(shellQuote('--connect')).toBe('--connect')
    expect(shellQuote('/Volumes/My Disk/DFYOM.app')).toBe("'/Volumes/My Disk/DFYOM.app'")
    expect(shellQuote("/p/ana's")).toBe(`'/p/ana'\\''s'`)
    expect(shellQuote('$HOME')).toBe("'$HOME'")
    expect(shellQuote('')).toBe("''")
  })
})

describe('connectInfo', () => {
  it('gives the connect, headless and command-line lines of the installed app', () => {
    const bin = '/Users/ana/Applications/DFYOM.app/Contents/Resources/bin/dfyom'
    expect(connectInfo(PACKAGED_MAC, true)).toEqual({
      connect: `claude mcp add --scope user dfyom -- ${bin} mcp --connect`,
      headless: `claude mcp add --scope user dfyom -- ${bin} mcp`,
      cli: bin,
      development: false,
      localAgents: true,
    })
  })

  it('quotes a path with spaces and says when local agents are off', () => {
    const i = connectInfo(
      { ...PACKAGED_MAC, resourcesPath: '/Volumes/Work Disk/DFYOM.app/Contents/Resources' },
      false,
    )
    expect(i.connect).toBe(
      "claude mcp add --scope user dfyom -- '/Volumes/Work Disk/DFYOM.app/Contents/Resources/bin/dfyom' mcp --connect",
    )
    expect(i.localAgents).toBe(false)
  })

  it('passes the environment with -e after the name when the binary runs as Node', () => {
    const i = connectInfo(
      {
        packaged: true,
        platform: 'win32',
        resourcesPath: 'C:/DFYOM/resources',
        execPath: 'C:/DFYOM/DFYOM.exe',
        mainDir: 'C:/DFYOM/resources/app.asar/out/main',
      },
      true,
    )
    expect(i.headless).toMatch(
      /^claude mcp add --scope user dfyom -e ELECTRON_RUN_AS_NODE=1 -- C:\/DFYOM\/DFYOM\.exe .*cli\.js mcp$/,
    )
    expect(i.cli).toMatch(/^ELECTRON_RUN_AS_NODE=1 C:\/DFYOM\/DFYOM\.exe /)
  })

  it('marks a development build', () => {
    const i = connectInfo(
      { ...PACKAGED_MAC, packaged: false, mainDir: '/src/dfyom/out/main' },
      true,
    )
    expect(i.development).toBe(true)
    expect(i.headless).toBe(
      'claude mcp add --scope user dfyom -- node /src/dfyom/out/main/cli.js mcp',
    )
  })
})
