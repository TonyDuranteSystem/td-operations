/**
 * Client iPhone app, Step 2: the two runtime switches (dev job 056a70d0).
 * client_app_enabled FAILS CLOSED (only a stored true turns the app on). client_app_pay_enabled is the opposite kind: Pay stays on
 * unless the stored value says false (the true/false value, or the text "false" if it was typed by hand), and a failed read keeps it on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ value: undefined as unknown, throws: false }))
vi.mock('@/lib/settings', () => ({
  getAppSetting: async (_key: string, fallback: unknown) => {
    if (h.throws) throw new Error('database went away')
    return h.value === undefined ? fallback : h.value
  },
}))

import { isClientAppEnabled, isClientAppPayEnabled } from '@/lib/portal-app/enabled'

beforeEach(() => { h.value = undefined; h.throws = false })

describe('client_app_enabled (fails closed)', () => {
  it('is on only for a stored true', async () => {
    h.value = true
    expect(await isClientAppEnabled()).toBe(true)
  })
  it('is off when the row is missing, false, text, a number, or the read fails', async () => {
    expect(await isClientAppEnabled()).toBe(false)
    for (const v of [false, 'true', 1, null, {}]) { h.value = v; expect(await isClientAppEnabled(), String(v)).toBe(false) }
    h.throws = true
    expect(await isClientAppEnabled()).toBe(false)
  })
})

describe('client_app_pay_enabled (Pay stays on unless switched off)', () => {
  it('is on when the row is missing, true, or the read fails', async () => {
    expect(await isClientAppPayEnabled()).toBe(true)
    h.value = true
    expect(await isClientAppPayEnabled()).toBe(true)
    h.throws = true
    expect(await isClientAppPayEnabled()).toBe(true)
  })
  it('is off for false, and for the text false typed by hand', async () => {
    for (const v of [false, 'false', ' False ', 'FALSE']) { h.value = v; expect(await isClientAppPayEnabled(), String(v)).toBe(false) }
  })
  it('stays on for other odd values (only an explicit false hides Pay)', async () => {
    for (const v of ['no', 0, null, 'off']) { h.value = v; expect(await isClientAppPayEnabled(), String(v)).toBe(true) }
  })
})
