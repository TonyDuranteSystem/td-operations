import { chromium, type FullConfig } from '@playwright/test'
import * as path from 'path'

const STORAGE_FILE = path.join(__dirname, '.auth-state.json')

async function globalSetup(_config: FullConfig) {
  const browser = await chromium.launch()
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  await page.goto('https://portal.tonydurante.us/portal/login')
  await page.fill('input[type="email"]', 'housedurante@icloud.com')
  await page.fill('input[type="password"]', 'TDz5q24tmg!')
  await page.click('button[type="submit"]')
  await page.waitForURL('**/portal**', { timeout: 15000 })

  await ctx.storageState({ path: STORAGE_FILE })
  await browser.close()
}

export default globalSetup
