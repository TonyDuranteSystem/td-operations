/**
 * A contact merge gives the removed contact's team document shares to the kept contact (dev job e59dd470 bug hunt).
 * The shares table has no foreign key on purpose, so the database merge function skips it; without this the login silently loses the documents.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type ShareRow = { team_member_id: string; account_id: string; owner_contact_id: string }
type Fail = null | 'read-removed' | 'read-kept' | 'delete' | 'update'

const state = vi.hoisted(() => ({
  shares: [] as Array<{ team_member_id: string; account_id: string; owner_contact_id: string }>,
  events: [] as Array<Record<string, unknown>>,
  fail: null as null | string,
  selects: 0,
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const filters: Array<(r: Record<string, unknown>) => boolean> = []
      let op: 'select' | 'delete' | 'update' = 'select'
      let patch: Record<string, unknown> = {}
      const run = () => {
        const hit = state.shares.filter((r) => filters.every((f) => f(r as unknown as Record<string, unknown>)))
        if (op === 'select') {
          state.selects += 1
          if (state.fail === 'read-removed' && state.selects === 1) return { data: null, error: { message: 'read failed' } }
          if (state.fail === 'read-kept' && state.selects === 2) return { data: null, error: { message: 'read failed' } }
          return { data: hit.map((r) => ({ ...r })), error: null }
        }
        if (op === 'delete') {
          if (state.fail === 'delete') return { data: null, error: { message: 'delete failed' } }
          state.shares = state.shares.filter((r) => !hit.includes(r))
          return { data: null, error: null }
        }
        if (state.fail === 'update') return { data: null, error: { message: 'update failed' } }
        for (const r of hit) Object.assign(r, patch)
        return { data: null, error: null }
      }
      const chain: Record<string, unknown> = {
        select: () => chain,
        delete: () => { op = 'delete'; return chain },
        update: (p: Record<string, unknown>) => { op = 'update'; patch = p; return chain },
        insert: async (row: Record<string, unknown>) => { if (table === 'portal_team_events') state.events.push(row); return { error: null } },
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return chain },
        in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return chain },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      }
      return chain
    },
  },
}))

import { planShareMove } from '@/lib/portal/team/personal-docs-share'
import { moveSharesToContact } from '@/lib/portal/team/personal-docs-server'

const REMOVED = 'contact-removed'
const KEPT = 'contact-kept'
const ACC = 'account-1'
const share = (member: string, owner: string, account = ACC): ShareRow => ({ team_member_id: member, account_id: account, owner_contact_id: owner })

beforeEach(() => {
  state.shares = []
  state.events = []
  state.fail = null
  state.selects = 0
})

describe('planShareMove (pure)', () => {
  it('moves every share when the kept contact has none for those logins', () => {
    const plan = planShareMove([{ team_member_id: 'm1', account_id: ACC }, { team_member_id: 'm2', account_id: ACC }], [])
    expect(plan.move.map((r) => r.team_member_id)).toEqual(['m1', 'm2'])
    expect(plan.drop).toEqual([])
  })

  it('drops the removed contact\'s row when that login already has a share from the kept contact', () => {
    const plan = planShareMove([{ team_member_id: 'm1', account_id: ACC }, { team_member_id: 'm2', account_id: ACC }], ['m2'])
    expect(plan.move.map((r) => r.team_member_id)).toEqual(['m1'])
    expect(plan.drop.map((r) => r.team_member_id)).toEqual(['m2'])
  })

  it('lists a login once even if the same row came twice, and handles nothing to move', () => {
    expect(planShareMove([{ team_member_id: 'm1', account_id: ACC }, { team_member_id: 'm1', account_id: ACC }], []).move).toHaveLength(1)
    expect(planShareMove([], ['m1'])).toEqual({ move: [], drop: [] })
  })
})

describe('moveSharesToContact', () => {
  it('moves the removed contact\'s shares to the kept contact and writes one team-record line each', async () => {
    state.shares = [share('m1', REMOVED), share('m2', REMOVED)]
    const result = await moveSharesToContact(REMOVED, KEPT, 'staff@example.test')
    expect(result).toEqual({ moved: 2, dropped: 0 })
    expect(state.shares.map((r) => r.owner_contact_id)).toEqual([KEPT, KEPT])
    expect(state.events).toHaveLength(2)
    expect(state.events[0]).toMatchObject({ event: 'powers_changed', actor_kind: 'td', actor_staff_email: 'staff@example.test', account_id: ACC })
    expect((state.events[0].detail as Record<string, unknown>)).toMatchObject({ personal_documents: true, owner_contact_id: KEPT, moved_from_contact_id: REMOVED, because: 'contact_merged' })
  })

  it('keeps the kept contact\'s own share and drops the removed contact\'s duplicate (one row per login and owner)', async () => {
    state.shares = [share('m1', REMOVED), share('m2', REMOVED), share('m2', KEPT)]
    const result = await moveSharesToContact(REMOVED, KEPT, 'staff@example.test')
    expect(result).toEqual({ moved: 1, dropped: 1 })
    const rows = state.shares.map((r) => `${r.team_member_id}:${r.owner_contact_id}`).sort()
    expect(rows).toEqual(['m1:contact-kept', 'm2:contact-kept'])
    expect(state.events).toHaveLength(1) // only the real move is written down
  })

  it('never touches another owner\'s shares or the kept contact\'s other shares', async () => {
    state.shares = [share('m1', REMOVED), share('m3', 'someone-else'), share('m4', KEPT)]
    await moveSharesToContact(REMOVED, KEPT, 'staff@example.test')
    expect(state.shares.find((r) => r.team_member_id === 'm3')?.owner_contact_id).toBe('someone-else')
    expect(state.shares.find((r) => r.team_member_id === 'm4')?.owner_contact_id).toBe(KEPT)
  })

  it('does nothing when the removed contact shared nothing (no read of the kept side, no event)', async () => {
    state.shares = [share('m4', KEPT)]
    expect(await moveSharesToContact(REMOVED, KEPT, 'staff@example.test')).toEqual({ moved: 0, dropped: 0 })
    expect(state.selects).toBe(1)
    expect(state.events).toHaveLength(0)
  })

  it('does nothing for the same contact twice or an empty id', async () => {
    state.shares = [share('m1', REMOVED)]
    expect(await moveSharesToContact(REMOVED, REMOVED, 'staff@example.test')).toEqual({ moved: 0, dropped: 0 })
    expect(await moveSharesToContact('', KEPT, 'staff@example.test')).toEqual({ moved: 0, dropped: 0 })
    expect(state.shares[0].owner_contact_id).toBe(REMOVED)
  })

  it('writes no team-record line when no staff login is known, but still moves the share', async () => {
    state.shares = [share('m1', REMOVED)]
    expect(await moveSharesToContact(REMOVED, KEPT, null)).toEqual({ moved: 1, dropped: 0 })
    expect(state.shares[0].owner_contact_id).toBe(KEPT)
    expect(state.events).toHaveLength(0)
  })

  const failures: Fail[] = ['read-removed', 'read-kept', 'delete', 'update']
  for (const failure of failures) {
    it(`THROWS (never reports "nothing to move") when the database fails at: ${failure}`, async () => {
      state.shares = [share('m1', REMOVED), share('m2', REMOVED), share('m2', KEPT)]
      state.fail = failure
      await expect(moveSharesToContact(REMOVED, KEPT, 'staff@example.test')).rejects.toThrow(/failed/)
    })
  }

  it('a failed move leaves the removed contact\'s own rows in place (nothing is half-lost)', async () => {
    state.shares = [share('m1', REMOVED)]
    state.fail = 'update'
    await expect(moveSharesToContact(REMOVED, KEPT, 'staff@example.test')).rejects.toThrow()
    expect(state.shares).toEqual([share('m1', REMOVED)])
    expect(state.events).toHaveLength(0)
  })
})

describe('the merge route calls it', () => {
  const route = readFileSync(join(process.cwd(), 'app/api/crm/admin-actions/delete-contact/route.ts'), 'utf8')

  it('moves the shares right after the merge function and before the "nothing left behind" check', () => {
    const rpc = route.indexOf('"merge_contacts", {')
    const move = route.indexOf('moveSharesToContact(contact_id, merge_into_contact_id')
    const check = route.indexOf('Never trust the merge silently')
    expect(rpc).toBeGreaterThan(0)
    expect(move).toBeGreaterThan(rpc)
    expect(check).toBeGreaterThan(move)
  })

  it('stops with a plain message when the move fails, and deletes nothing', () => {
    const start = route.indexOf('could not be moved to')
    expect(start).toBeGreaterThan(0)
    expect(route.slice(start - 400, start + 200)).toContain('status: 500')
    const removeLogins = route.indexOf('Remove the loser\'s portal login(s)')
    expect(removeLogins).toBeGreaterThan(start)
  })
})
