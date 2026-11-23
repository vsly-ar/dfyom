// Help → Connect an agent… (hardening A4): the commands that attach an MCP client to this
// installation, with its real launcher path. Kept free of Electron so it is unit-tested;
// src/main/ipc.ts answers `agents.connectInfo` with it.
// Doc: docs/conventions/ui.md#connect-an-agent-hardening-a4,
// docs/architecture/llm-api.md#amendment-hardening-a4-launcher-and-connect-an-agent
import { join } from 'node:path'
import type { ConnectInfo } from '../shared/preload-api'

/** The MCP server's name in the client's configuration. */
export const MCP_SERVER_NAME = 'dfyom'

/** Where this installation runs from (src/main/index.ts passes Electron's values). */
export interface Installation {
  readonly packaged: boolean
  readonly platform: NodeJS.Platform
  /** `process.resourcesPath` (packaged: `DFYOM.app/Contents/Resources`). */
  readonly resourcesPath: string
  /** `process.execPath`: the app binary. */
  readonly execPath: string
  /** The folder of the built main entry (`out/main`, inside the asar when packaged). */
  readonly mainDir: string
}

/** How the CLI starts: the command and its leading arguments, and environment it needs. */
export interface Launcher {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/**
 * The packaged macOS app's `bin/dfyom` (packaging.md#launcher); another packaged platform (none
 * is built yet) runs the binary as Node itself; development runs the built CLI with `node`.
 */
export function launcher(i: Installation): Launcher {
  if (i.packaged && i.platform === 'darwin')
    return { argv: [join(i.resourcesPath, 'bin', 'dfyom')], env: {} }
  const cli = join(i.mainDir, 'cli.js')
  if (i.packaged) return { argv: [i.execPath, cli], env: { ELECTRON_RUN_AS_NODE: '1' } }
  return { argv: ['node', cli], env: {} }
}

const SAFE = /^[A-Za-z0-9_@%+=:,./~-]+$/

/** One POSIX shell word: as is when it needs no quoting, else in single quotes. */
export function shellQuote(word: string): string {
  if (word !== '' && SAFE.test(word)) return word
  return `'${word.replaceAll("'", `'\\''`)}'`
}

const line = (words: readonly string[]): string => words.map(shellQuote).join(' ')

/** The lines the dialog shows (ui.md#connect-an-agent-hardening-a4). */
export function connectInfo(i: Installation, localAgents: boolean): ConnectInfo {
  const l = launcher(i)
  const env = Object.entries(l.env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  // `-e` takes several values, so it follows the name and `--` ends it
  const add = (...args: string[]) =>
    line([
      'claude',
      'mcp',
      'add',
      '--scope',
      'user',
      MCP_SERVER_NAME,
      ...env,
      '--',
      ...l.argv,
      ...args,
    ])
  const envPrefix = Object.entries(l.env).map(([k, v]) => `${k}=${v}`)
  return {
    connect: add('mcp', '--connect'),
    headless: add('mcp'),
    cli: line([...envPrefix, ...l.argv]),
    development: !i.packaged,
    localAgents,
  }
}
