import { describe, it, expect } from 'vitest'
import { APP_MODE_UA_TOKEN, isAppModeUserAgent } from '@/lib/app-mode/app-mode'

// The switch behind "app mode" (TD Social, Step 1b): only the app's own token turns it on.
describe('isAppModeUserAgent', () => {
  const iphoneWebView =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

  it('is on when the app adds its token to the browser name', () => {
    expect(isAppModeUserAgent(`${iphoneWebView} TDSocial/1.0`)).toBe(true)
    expect(isAppModeUserAgent(`${iphoneWebView} TDSocial/2.3.1 (sandbox)`)).toBe(true)
    expect(isAppModeUserAgent(`TDSocial/1.0`)).toBe(true)
  })

  it('is off for a normal browser, Safari, Chrome and the installed web apps', () => {
    expect(isAppModeUserAgent(iphoneWebView)).toBe(false)
    expect(isAppModeUserAgent(`${iphoneWebView} Version/17.5 Safari/604.1`)).toBe(false)
    expect(isAppModeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36')).toBe(false)
  })

  it('is off when there is no browser name at all', () => {
    expect(isAppModeUserAgent(null)).toBe(false)
    expect(isAppModeUserAgent(undefined)).toBe(false)
    expect(isAppModeUserAgent('')).toBe(false)
  })

  it('does not match a look-alike (the token is exact and case-sensitive)', () => {
    expect(isAppModeUserAgent('tdsocial/1.0')).toBe(false)
    expect(isAppModeUserAgent('TDSocial')).toBe(false)
    expect(isAppModeUserAgent('MyTDSocialish 1.0')).toBe(false)
  })

  it('uses one token everywhere', () => {
    expect(APP_MODE_UA_TOKEN).toBe('TDSocial/')
  })
})
