import { describe, it, expect } from 'vitest'
import { resolveInstallNudge } from '@/lib/portal/install-state'

const base = {
  isMobile: true,
  standalone: false,
  pushSupported: true,
  permission: 'default' as NotificationPermission,
  subscribed: false,
}

describe('resolveInstallNudge — THE one nudge decision (non-dismissible by spec)', () => {
  it('funnel complete (installed + subscribed) → total silence', () => {
    expect(resolveInstallNudge({ ...base, standalone: true, subscribed: true })).toBe('none')
  })

  it('mobile browser, not installed → install stage', () => {
    expect(resolveInstallNudge(base)).toBe('install')
  })

  it('install stage persists regardless of push state (not installed yet)', () => {
    expect(resolveInstallNudge({ ...base, subscribed: true })).toBe('install')
    expect(resolveInstallNudge({ ...base, permission: 'denied' })).toBe('install')
  })

  it('installed but not subscribed → push stage', () => {
    expect(resolveInstallNudge({ ...base, standalone: true })).toBe('push')
  })

  it('push stage also on desktop standalone installs', () => {
    expect(resolveInstallNudge({ ...base, isMobile: false, standalone: true })).toBe('push')
  })

  it('push permission denied → nothing (only fixable in OS settings)', () => {
    expect(resolveInstallNudge({ ...base, standalone: true, permission: 'denied' })).toBe('none')
  })

  it('standalone without push support → nothing to ask', () => {
    expect(resolveInstallNudge({ ...base, standalone: true, pushSupported: false })).toBe('none')
  })

  it('desktop browser → none (sidebar entry covers desktop)', () => {
    expect(resolveInstallNudge({ ...base, isMobile: false })).toBe('none')
  })

  it('granted-but-unsubscribed still asks (subscription is the truth, not permission)', () => {
    expect(resolveInstallNudge({ ...base, standalone: true, permission: 'granted' })).toBe('push')
  })
})
