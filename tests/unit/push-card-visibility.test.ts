import { describe, it, expect } from 'vitest'
import {
  shouldShowEnablePushCard,
  PUSH_CARD_SNOOZE_DAYS,
  type PushCardEnv,
} from '@/lib/portal/push-card-visibility'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

function env(overrides: Partial<PushCardEnv> = {}): PushCardEnv {
  return {
    standalone: true,
    pushSupported: true,
    permission: 'default',
    subscribed: false,
    dismissedAt: null,
    now: NOW,
    ...overrides,
  }
}

describe('shouldShowEnablePushCard', () => {
  it('shows in the installed app when push is possible and missing', () => {
    expect(shouldShowEnablePushCard(env())).toBe(true)
  })

  it('hides outside the installed app (plain browser tab)', () => {
    expect(shouldShowEnablePushCard(env({ standalone: false }))).toBe(false)
  })

  it('hides when the browser has no push support', () => {
    expect(shouldShowEnablePushCard(env({ pushSupported: false }))).toBe(false)
  })

  it('hides when permission was denied (button could never succeed)', () => {
    expect(shouldShowEnablePushCard(env({ permission: 'denied' }))).toBe(false)
  })

  it('still shows when permission is granted but no subscription exists', () => {
    // Granted-but-unsubscribed devices still get fallback emails — the
    // subscription, not the permission, is what stops them.
    expect(shouldShowEnablePushCard(env({ permission: 'granted' }))).toBe(true)
  })

  it('hides once subscribed', () => {
    expect(shouldShowEnablePushCard(env({ subscribed: true }))).toBe(false)
  })

  it('hides during the snooze window after a dismissal', () => {
    expect(
      shouldShowEnablePushCard(env({ dismissedAt: NOW - DAY_MS })),
    ).toBe(false)
  })

  it('reappears after the snooze window expires', () => {
    expect(
      shouldShowEnablePushCard(
        env({ dismissedAt: NOW - (PUSH_CARD_SNOOZE_DAYS + 1) * DAY_MS }),
      ),
    ).toBe(true)
  })

  it('hides exactly at the snooze boundary minus one ms', () => {
    const snoozeMs = PUSH_CARD_SNOOZE_DAYS * DAY_MS
    expect(
      shouldShowEnablePushCard(env({ dismissedAt: NOW - snoozeMs + 1 })),
    ).toBe(false)
    expect(
      shouldShowEnablePushCard(env({ dismissedAt: NOW - snoozeMs })),
    ).toBe(true)
  })
})
