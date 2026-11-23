// Help → Connect an agent… (hardening A4), windows hidden: the dialog shows this installation's
// real launcher (the built CLI in development, Contents/Resources/bin/dfyom when packaged) in the
// `claude mcp add` lines. With DFYOM_RENDERS=1 it writes the light and dark review renders to
// design/features/renders/ (with a neutral installed path instead of this checkout's).
// Doc: docs/conventions/ui.md#connect-an-agent-hardening-a4
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { ConnectInfo } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

async function theme(page: Page, name: 'light' | 'dark'): Promise<void> {
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.getByRole('button', { name: 'Settings' }).click()
  await settings.getByRole('radio', { name: name === 'light' ? 'Light' : 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', name)
  await settings.getByRole('button', { name: 'Done' }).click()
  await expect(settings).toBeHidden()
}

test('Help → Connect an agent… shows the claude mcp add lines with the real launcher', async ({
  dfyom,
}) => {
  const { app } = dfyom
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 800 })
  const openDialog = async () => {
    await app.evaluate(({ Menu }) => {
      const help = Menu.getApplicationMenu()?.items.find((i) => i.role === 'help')
      help?.submenu?.items.find((i) => i.label === 'Connect an agent…')?.click()
    })
    const dialog = page.getByRole('dialog', { name: 'Connect an agent' })
    await expect(dialog).toBeVisible()
    return dialog
  }
  let dialog = await openDialog()
  const connect = dialog.getByRole('textbox', { name: 'Work in this app' })
  const launcher = process.env['DFYOM_E2E_APP']
    ? /\/Contents\/Resources\/bin\/dfyom$/
    : /^node \S+\/out\/main\/cli\.js$/
  await expect(dialog.getByRole('textbox', { name: 'Command line' })).toHaveValue(launcher)
  await expect(connect).toHaveValue(/^claude mcp add --scope user dfyom -- .+ mcp --connect$/)
  await expect(dialog.getByRole('textbox', { name: 'Without the app' })).toHaveValue(
    /^claude mcp add --scope user dfyom -- .+ mcp$/,
  )
  // local HTTP is on by default: no note about the setting
  await expect(dialog.getByText(/is off/)).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()

  if (RENDERS) {
    const bin = '/Users/you/Applications/DFYOM.app/Contents/Resources/bin/dfyom'
    const info: ConnectInfo = {
      connect: `claude mcp add --scope user dfyom -- ${bin} mcp --connect`,
      headless: `claude mcp add --scope user dfyom -- ${bin} mcp`,
      cli: bin,
      development: false,
      localAgents: true,
    }
    await app.evaluate(({ ipcMain }, i) => {
      ipcMain.removeHandler('dfyom:agents.connectInfo')
      ipcMain.handle('dfyom:agents.connectInfo', () => i)
    }, info)
    for (const t of ['light', 'dark'] as const) {
      await theme(page, t)
      dialog = await openDialog()
      await expect(dialog.getByRole('textbox', { name: 'Command line' })).toHaveValue(bin)
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${rendersDir}/a4-connect-agent-${t}.png` })
      await dialog.getByRole('button', { name: 'Close' }).click()
      await expect(dialog).toBeHidden()
    }
    await theme(page, 'light')
  }
  expect(dfyom.rendererErrors).toEqual([])
})
