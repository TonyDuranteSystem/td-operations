/**
 * Team Powers bug hunt (dev job e59dd470): a COMPANY's chat alert reaches a team login's phone or browser only while that login is ACTIVE and
 * may see CHAT (the client iPhone app already did this; the browser alert did not), and the daily summary email no longer counts a team login's
 * device as "the owner has the app". Pure rules + the two database helpers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const fx = vi.hoisted(() => ({
  logins: [] as Array<{ account_id: string; auth_user_id: string; status: string; capabilities: unknown }>,
  deleted: [] as string[],
  failLogins: false,
  failDelete: false,
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const filters: Record<string, string> = {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select: () => b,
        delete: () => { b._delete = true; return b },
        eq: (c: string, v: string) => { filters[c] = v; return b },
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'portal_team_members') {
            if (fx.failLogins) return resolve({ data: null, error: { message: 'boom' } })
            return resolve({ data: fx.logins.filter((l) => Object.entries(filters).every(([k, v]) => (l as Record<string, unknown>)[k] === v)), error: null })
          }
          if (table === 'push_subscriptions' && b._delete) {
            if (fx.failDelete) return resolve({ data: null, error: { message: 'boom' } })
            fx.deleted.push(filters.user_id)
            return resolve({ data: [{ id: 'd1' }, { id: 'd2' }], error: null })
          }
          throw new Error(`unexpected ${table}`)
        },
      }
      return b
    },
  },
}))

import { teamLoginsBarredFromAlerts, filterAlertDevices, barredTeamLoginIds, endAlertDevicesOfLogin } from '@/lib/portal/team/push-devices'

const login = (auth_user_id: string, status: string, capabilities: unknown) => ({ auth_user_id, status, capabilities })

beforeEach(() => { fx.logins = []; fx.deleted = []; fx.failLogins = false; fx.failDelete = false })

describe('teamLoginsBarredFromAlerts', () => {
  it('an active login with the chat tick is NOT barred', () => {
    expect(teamLoginsBarredFromAlerts([login('u1', 'active', { chat: true })]).size).toBe(0)
  })
  it('a removed or switched-off login is barred (status is not active)', () => {
    expect(Array.from(teamLoginsBarredFromAlerts([login('u1', 'revoked', { chat: true })]))).toEqual(['u1'])
  })
  it('an active login WITHOUT the chat tick is barred (the alert is a chat alert), even with other ticks', () => {
    expect(Array.from(teamLoginsBarredFromAlerts([login('u1', 'active', { documents: true }), login('u2', 'active', null), login('u3', 'active', {})])).sort()).toEqual(['u1', 'u2', 'u3'])
  })
  it('only the barred ones are named', () => {
    expect(Array.from(teamLoginsBarredFromAlerts([login('ok', 'active', { chat: true }), login('gone', 'revoked', { chat: true })]))).toEqual(['gone'])
  })
})

describe('filterAlertDevices', () => {
  const devices = [{ id: 'a', user_id: 'u-ok' }, { id: 'b', user_id: 'u-gone' }, { id: 'c', user_id: null }, { id: 'd' }]
  it('drops only the barred logins\' devices; a device with no sign-in id cannot be shown to be one and stays', () => {
    expect(filterAlertDevices(devices, new Set(['u-gone'])).map((d) => d.id)).toEqual(['a', 'c', 'd'])
  })
  it('nothing barred: nothing changes', () => {
    expect(filterAlertDevices(devices, new Set())).toBe(devices)
  })
})

describe('barredTeamLoginIds (reads this company\'s logins)', () => {
  it('only this company\'s logins are looked at', async () => {
    fx.logins = [
      { account_id: 'a1', ...login('u1', 'revoked', { chat: true }) },
      { account_id: 'a2', ...login('u2', 'revoked', { chat: true }) },
    ]
    expect(Array.from(await barredTeamLoginIds('a1'))).toEqual(['u1'])
  })
  it('a database error is thrown, never turned into "nobody is barred"', async () => {
    fx.failLogins = true
    await expect(barredTeamLoginIds('a1')).rejects.toThrow('boom')
  })
})

describe('endAlertDevicesOfLogin (removal clean-up)', () => {
  it('deletes the login\'s devices by its sign-in id and says how many', async () => {
    expect(await endAlertDevicesOfLogin('u1')).toBe(2)
    expect(fx.deleted).toEqual(['u1'])
  })
  it('a database error is thrown (the caller notes it)', async () => {
    fx.failDelete = true
    await expect(endAlertDevicesOfLogin('u1')).rejects.toThrow('boom')
  })
})

describe('the daily summary email (portal-digest cron)', () => {
  const route = readFileSync(join(process.cwd(), 'app/api/cron/portal-digest/route.ts'), 'utf8')
  it('asks the shared rule that ignores team logins\' devices for a company-wide notice', () => {
    expect(route).toContain('companyHasDeviceBesidesTeamLogins(id)')
  })
  it('no longer counts "any device of the company" itself', () => {
    expect(route).not.toMatch(/from\('push_subscriptions'\)[\s\S]{0,160}\.eq\('account_id'/)
  })
})
