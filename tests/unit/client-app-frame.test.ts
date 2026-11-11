import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLIENT_APP_UA_TOKEN, APP_MODE_UA_TOKEN, isAppModeUserAgent, isClientAppUserAgent } from '@/lib/app-mode/app-mode'
import { selectionQuery } from '@/lib/portal-app/selection-query'
import { screenTitleFor, TITLE_IN_ROW } from '@/lib/portal-app/frame'

// Client iPhone app, Step 3 (dev job 056a70d0): the frame of a portal page inside the app.

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

describe('isClientAppUserAgent', () => {
  it('is on only when the client app adds its own token', () => {
    expect(isClientAppUserAgent(`${iphone} TDClient/2.0`)).toBe(true)
    expect(isClientAppUserAgent(`${iphone} TDClient/2.0.1 (sandbox)`)).toBe(true)
  })

  it('is off for a normal browser, for no browser name, and for look-alikes', () => {
    expect(isClientAppUserAgent(iphone)).toBe(false)
    expect(isClientAppUserAgent(null)).toBe(false)
    expect(isClientAppUserAgent(undefined)).toBe(false)
    expect(isClientAppUserAgent('')).toBe(false)
    expect(isClientAppUserAgent('tdclient/2.0')).toBe(false)
    expect(isClientAppUserAgent('TDClient')).toBe(false)
  })

  it('is not the TD Social token: neither app is mistaken for the other', () => {
    expect(CLIENT_APP_UA_TOKEN).toBe('TDClient/')
    expect(isClientAppUserAgent(`${iphone} TDSocial/1.0`)).toBe(false)
    expect(isAppModeUserAgent(`${iphone} TDClient/2.0`)).toBe(false)
    expect(APP_MODE_UA_TOKEN).toBe('TDSocial/')
  })
})

describe('selectionQuery', () => {
  it('names the selected company, formation or onboarding', () => {
    expect(selectionQuery({ kind: 'account', id: 'a-1' })).toBe('account=a-1')
    expect(selectionQuery({ kind: 'formation', id: 'f-1' })).toBe('formation=f-1')
    expect(selectionQuery({ kind: 'onboarding', id: 'o-1' })).toBe('onboarding=o-1')
  })

  it('writes the partner view only; the default client view is not written', () => {
    expect(selectionQuery({ kind: 'account', id: 'a-1', mode: 'client' })).toBe('account=a-1')
    expect(selectionQuery({ kind: 'account', id: 'a-1', mode: 'partner' })).toBe('account=a-1&mode=partner')
    expect(selectionQuery({ kind: 'none', mode: 'partner' })).toBe('mode=partner')
  })

  it('is empty with nothing selected, so the door answers for the first company', () => {
    expect(selectionQuery({ kind: 'none' })).toBe('')
    expect(selectionQuery({ kind: 'account' })).toBe('')
  })

  it('escapes what it is given', () => {
    expect(selectionQuery({ kind: 'account', id: 'a&b=c' })).toBe('account=a%26b%3Dc')
  })
})

describe('screenTitleFor', () => {
  const items = [
    { key: 'nav.overview', path: '/portal', label: 'Overview' },
    { key: 'nav.chat', path: '/portal/chat', label: 'Chat' },
    { key: 'nav.invoices', path: '/portal/invoices', label: 'Invoices' },
    { key: 'nav.tdBilling', path: '/portal/invoices?tab=expenses', label: 'TD Billing' },
  ]

  it('gives no name to a screen that still draws its own heading', () => {
    // every screen is in this state until it is dressed for the app (TITLE_IN_ROW grows then)
    for (const p of ['/portal', '/portal/documents', '/portal/profile']) {
      if (!TITLE_IN_ROW.includes(p)) expect(screenTitleFor(p, items)).toBeNull()
    }
  })

  it('never names the Overview (the company chooser sits there)', () => {
    expect(screenTitleFor('/portal', items)).toBeNull()
  })
})

// The layout may only drop the website's chrome behind the app marker, never for the website itself.
describe('portal layout wiring', () => {
  const layout = readFileSync(join(process.cwd(), 'app/portal/layout.tsx'), 'utf8')

  it('reads the client app marker once and hands it to the app-mode wrapper (signed out, access removed, team member, client)', () => {
    expect(layout).toContain("getClientAppModeActive()")
    expect((layout.match(/<AppModeProvider initial=\{clientApp\}>/g) ?? []).length).toBe(4)
  })

  it('leaves out the website chrome only when in the app', () => {
    for (const piece of ['<PortalSidebar', '<PwaInstallPrompt', '<DashboardInstallBanner', '<EnablePushCard', '<PortalSwRegister']) {
      const lines = layout.split('\n').filter(l => l.includes(piece))
      expect(lines.length, piece).toBeGreaterThan(0)
      for (const l of lines) expect(l, `${piece} must sit behind !clientApp`).toMatch(/!clientApp/)
    }
  })

  it('draws the app frame in the app and the website spacer otherwise', () => {
    expect((layout.match(/<ClientAppFrame /g) ?? []).length).toBe(2)
    expect((layout.match(/<div className="h-14" \/>/g) ?? []).length).toBe(2)
  })

  it('shows the company chooser in the app only for people the website top bar shows it to', () => {
    expect(layout).toContain('!isPartnerPortal(effectivePortalRole) && !portalModeCtx.dual && accounts.length > 0')
  })
})
