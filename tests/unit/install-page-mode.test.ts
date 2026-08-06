import { describe, it, expect } from 'vitest'
import {
  detectDevice,
  isInAppBrowser,
  resolveInstallPageMode,
  resolveInstallLanguage,
  normalizeInstallSrc,
  INSTALL_SRC_VALUES,
} from '@/lib/portal/install-page-mode'

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipad:
    'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  // iPadOS 13+ "Request Desktop Website" default — indistinguishable from a Mac by UA alone
  ipadDesktopUA:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36',
  iphoneInstagram:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 334.0.0.0',
  iphoneGoogleApp:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/324.0 Mobile/15E148 Safari/604.1',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
}

describe('detectDevice', () => {
  it('detects iPhone', () => {
    expect(detectDevice(UA.iphoneSafari)).toBe('ios')
  })
  it('detects iPad with mobile UA', () => {
    expect(detectDevice(UA.ipad)).toBe('ios')
  })
  it('detects Android', () => {
    expect(detectDevice(UA.androidChrome)).toBe('android')
  })
  it('desktop UAs resolve to desktop', () => {
    expect(detectDevice(UA.windowsChrome)).toBe('desktop')
    expect(detectDevice(UA.macSafari)).toBe('desktop')
  })
  it('server-side (no touch info) misclassifies iPadOS desktop-UA as desktop — documented limitation', () => {
    expect(detectDevice(UA.ipadDesktopUA)).toBe('desktop')
  })
  it('client refinement corrects iPadOS desktop-UA via MacIntel + multi-touch', () => {
    expect(detectDevice(UA.ipadDesktopUA, { platform: 'MacIntel', maxTouchPoints: 5 })).toBe('ios')
  })
  it('a real Mac (no touch) stays desktop', () => {
    expect(detectDevice(UA.macSafari, { platform: 'MacIntel', maxTouchPoints: 0 })).toBe('desktop')
  })
  it('explicit Android UA beats the iPadOS heuristic (emulators report MacIntel + touch)', () => {
    expect(detectDevice(UA.androidChrome, { platform: 'MacIntel', maxTouchPoints: 5 })).toBe('android')
  })
})

describe('isInAppBrowser', () => {
  it('flags Instagram on iPhone', () => {
    expect(isInAppBrowser(UA.iphoneInstagram)).toBe(true)
  })
  it('flags the Google app (GSA)', () => {
    expect(isInAppBrowser(UA.iphoneGoogleApp)).toBe(true)
  })
  it('flags Android WebView ("; wv)")', () => {
    expect(isInAppBrowser(UA.androidWebView)).toBe(true)
  })
  it('does not flag plain Safari / Chrome', () => {
    expect(isInAppBrowser(UA.iphoneSafari)).toBe(false)
    expect(isInAppBrowser(UA.androidChrome)).toBe(false)
    expect(isInAppBrowser(UA.windowsChrome)).toBe(false)
  })
})

describe('resolveInstallPageMode', () => {
  const base = { standalone: false, inAppBrowser: false, installPrompt: 'waiting' as const }

  it('standalone wins over everything', () => {
    expect(resolveInstallPageMode({ ...base, device: 'ios', standalone: true })).toBe('installed')
    expect(resolveInstallPageMode({ ...base, device: 'android', standalone: true, installPrompt: 'captured' })).toBe('installed')
  })
  it('iOS: safari vs in-app', () => {
    expect(resolveInstallPageMode({ ...base, device: 'ios' })).toBe('ios-safari')
    expect(resolveInstallPageMode({ ...base, device: 'ios', inAppBrowser: true })).toBe('ios-inapp')
  })
  it('Android: waiting → prompt when the event arrives', () => {
    expect(resolveInstallPageMode({ ...base, device: 'android' })).toBe('android-waiting')
    expect(resolveInstallPageMode({ ...base, device: 'android', installPrompt: 'captured' })).toBe('android-prompt')
  })
  it('Android: timeout without event degrades to manual — never a dead button', () => {
    expect(resolveInstallPageMode({ ...base, device: 'android', installPrompt: 'timeout' })).toBe('android-manual')
  })
  it('Android WebView goes straight to manual (cannot fire the prompt)', () => {
    expect(resolveInstallPageMode({ ...base, device: 'android', inAppBrowser: true, installPrompt: 'captured' })).toBe('android-manual')
  })
  it('desktop', () => {
    expect(resolveInstallPageMode({ ...base, device: 'desktop' })).toBe('desktop')
  })
})

describe('resolveInstallLanguage', () => {
  it('null/empty → en', () => {
    expect(resolveInstallLanguage(null)).toBe('en')
    expect(resolveInstallLanguage(undefined)).toBe('en')
    expect(resolveInstallLanguage('')).toBe('en')
  })
  it('Italian phone header', () => {
    expect(resolveInstallLanguage('it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7')).toBe('it')
  })
  it('English phone header', () => {
    expect(resolveInstallLanguage('en-US,en;q=0.9')).toBe('en')
  })
  it('q-values rank: Italian preferred even when listed after English', () => {
    expect(resolveInstallLanguage('en;q=0.5,it;q=0.9')).toBe('it')
  })
  it('unsupported languages fall through to en', () => {
    expect(resolveInstallLanguage('fr-FR,fr;q=0.9,de;q=0.8')).toBe('en')
  })
  it('unsupported first, supported later → the supported one wins', () => {
    expect(resolveInstallLanguage('fr-FR,it;q=0.8')).toBe('it')
  })
  it('accepts navigator.languages-style arrays', () => {
    expect(resolveInstallLanguage(['it-IT', 'en-US'])).toBe('it')
    expect(resolveInstallLanguage(['de-DE', 'en-US'])).toBe('en')
  })
  it('malformed q-values do not crash and rank lowest', () => {
    expect(resolveInstallLanguage('it;q=abc,en;q=0.5')).toBe('en')
  })
})

describe('normalizeInstallSrc', () => {
  it('accepts every declared channel', () => {
    for (const src of INSTALL_SRC_VALUES) {
      expect(normalizeInstallSrc(src)).toBe(src)
    }
  })
  it('drops unknown, empty, and injection-shaped values', () => {
    expect(normalizeInstallSrc('evil<script>')).toBeNull()
    expect(normalizeInstallSrc('qr-printX')).toBeNull()
    expect(normalizeInstallSrc('')).toBeNull()
    expect(normalizeInstallSrc(null)).toBeNull()
    expect(normalizeInstallSrc(undefined)).toBeNull()
  })
})
