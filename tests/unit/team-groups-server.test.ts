/**
 * Team GROUP chats — the server functions (lib/team/groups.ts) against a small in-memory fake of the three tables, plus
 * source guards that every route taking a thread/message id from the browser checks membership.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  tables: { internal_threads: [] as Row[], internal_thread_members: [] as Row[] } as Record<string, Row[]>,
  staff: [] as Array<{ id: string }>,
  nextId: 1,
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/team/directory', () => ({ listTeamMembers: async () => h.staff }))
vi.mock('@/lib/supabase-admin', () => {
  function builder(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let patch: Row | Row[] = {}
    const filters: Array<(r: Row) => boolean> = []
    let single: 'single' | 'maybe' | null = null
    const api: Record<string, unknown> = {}
    const run = () => {
      const rows = h.tables[table]
      if (op === 'insert') {
        const list = (Array.isArray(patch) ? patch : [patch]).map(r => ({ id: `id-${h.nextId++}`, ...r }))
        rows.push(...list)
        return { data: single ? list[0] : list, error: null }
      }
      const hit = rows.filter(r => filters.every(f => f(r)))
      if (op === 'update') { hit.forEach(r => Object.assign(r, patch)); return { data: hit, error: null } }
      if (op === 'delete') { h.tables[table] = rows.filter(r => !hit.includes(r)); return { data: null, error: null } }
      return { data: single ? (hit[0] ?? null) : hit, error: null }
    }
    for (const m of ['select']) api[m] = () => api
    api.insert = (p: Row | Row[]) => { op = 'insert'; patch = p; return api }
    api.update = (p: Row) => { op = 'update'; patch = p; return api }
    api.delete = () => { op = 'delete'; return api }
    api.eq = (c: string, v: unknown) => { filters.push(r => r[c] === v); return api }
    api.in = (c: string, v: unknown[]) => { filters.push(r => v.includes(r[c])); return api }
    api.single = () => { single = 'single'; return api }
    api.maybeSingle = () => { single = 'maybe'; return api }
    api.then = (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res)
    return api
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } }
})

import { addGroupMembers, assertGroupAccess, createGroup, groupMembersFor, leaveGroup, listGroupMemberIds, renameGroup } from '@/lib/team/groups'

beforeEach(() => {
  h.tables = { internal_threads: [], internal_thread_members: [] }
  h.staff = ['antonio', 'luca', 'jodi', 'support'].map(id => ({ id }))
  h.nextId = 1
})

describe('createGroup', () => {
  it('creates a private group of me, Luca and Jodi with a member row each', async () => {
    const r = await createGroup('antonio', '  Office  ', ['luca', 'jodi'])
    expect(r.ok).toBe(true)
    expect(h.tables.internal_threads).toHaveLength(1)
    expect(h.tables.internal_threads[0]).toMatchObject({ thread_type: 'group', title: 'Office', created_by: 'antonio' })
    expect(h.tables.internal_thread_members.map(m => m.user_id).sort()).toEqual(['antonio', 'jodi', 'luca'])
    expect(h.tables.internal_thread_members.every(m => m.added_by === 'antonio')).toBe(true)
  })
  it('refuses a too-small group, a nameless group and strangers, creating nothing', async () => {
    expect((await createGroup('antonio', 'x', ['luca'])).status).toBe(400)
    expect((await createGroup('antonio', '', ['luca', 'jodi'])).status).toBe(400)
    expect((await createGroup('antonio', 'x', ['luca', 'stranger'])).status).toBe(400)
    expect(h.tables.internal_threads).toHaveLength(0)
    expect(h.tables.internal_thread_members).toHaveLength(0)
  })
})

describe('membership and access', () => {
  async function group() {
    const r = await createGroup('antonio', 'Office', ['luca', 'jodi'])
    return (r.value!.thread as { id: string }).id
  }
  it('a member has access; a non-member is denied; another kind of thread is not a group', async () => {
    const id = await group()
    expect((await assertGroupAccess(id, 'luca')).kind).toBe('member')
    expect((await assertGroupAccess(id, 'support')).kind).toBe('denied')
    h.tables.internal_threads.push({ id: 'dm1', thread_type: 'dm' })
    expect((await assertGroupAccess('dm1', 'support')).kind).toBe('not_group')
    expect((await assertGroupAccess('missing', 'support')).kind).toBe('not_group')
    expect((await listGroupMemberIds(id)).sort()).toEqual(['antonio', 'jodi', 'luca'])
    expect((await groupMembersFor([id]))[id]).toHaveLength(3)
    expect(await groupMembersFor([])).toEqual({})
  })

  it('ANY member can add people; a non-member cannot; strangers are refused', async () => {
    const id = await group()
    const ok = await addGroupMembers(id, 'jodi', ['support'])
    expect(ok.ok).toBe(true)
    expect(ok.value!.members.sort()).toEqual(['antonio', 'jodi', 'luca', 'support'])
    expect(h.tables.internal_thread_members.find(m => m.user_id === 'support')?.added_by).toBe('jodi')
    expect((await addGroupMembers(id, 'support2', ['support'])).status).toBe(403)
    expect((await addGroupMembers(id, 'luca', ['stranger'])).status).toBe(400)
    expect((await addGroupMembers('missing', 'luca', ['support'])).status).toBe(404)
  })

  it('ANY member can rename; a non-member cannot; an empty name is refused', async () => {
    const id = await group()
    expect((await renameGroup(id, 'luca', ' New  name ')).value?.name).toBe('New name')
    expect(h.tables.internal_threads[0].title).toBe('New name')
    expect((await renameGroup(id, 'support', 'x')).status).toBe(403)
    expect((await renameGroup(id, 'luca', '   ')).status).toBe(400)
  })

  it('leaving removes only yourself; the last person out archives the group', async () => {
    const id = await group()
    expect((await leaveGroup(id, 'luca')).value).toEqual({ left: true, archived: false })
    expect((await listGroupMemberIds(id)).sort()).toEqual(['antonio', 'jodi'])
    expect((await assertGroupAccess(id, 'luca')).kind).toBe('denied') // gone from the group
    expect((await leaveGroup(id, 'luca')).status).toBe(403) // not a member any more
    await leaveGroup(id, 'jodi')
    const last = await leaveGroup(id, 'antonio')
    expect(last.value).toEqual({ left: true, archived: true })
    expect(h.tables.internal_threads[0].archived_at).toBeTruthy()
  })
})

describe('every route that takes a thread or message id from the browser checks the group', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')
  it('the thread read route refuses a non-member', () => {
    const src = read('app/api/team/threads/[id]/route.ts')
    expect(src).toContain("thread_type === 'group'")
    expect(src).toContain('isGroupMember(groupMembers, user.id)')
    expect(src).toContain("'You are not in this group.'")
  })
  it('the send route refuses a non-member and notifies the other members as a direct-message-type push', () => {
    const src = read('app/api/team/threads/[id]/messages/route.ts')
    expect(src).toContain("thread.thread_type === 'group'")
    expect(src).toContain('isGroupMember(groupMembers, user.id)')
    expect(src).toMatch(/team-group-\$\{threadId\}[\s\S]{0,40}dm: true/)
  })
  it('the reaction route refuses a non-member', () => {
    const src = read('app/api/team/messages/[id]/react/route.ts')
    expect(src).toContain('assertGroupAccess')
    expect(src).toContain("access.kind === 'denied'")
  })
  it('the two read functions only return a group to a member', () => {
    const sql = read('scripts/migrations/20261009-2100-team-groups.sql')
    const occurrences = sql.match(/t\.thread_type = 'group' AND EXISTS \(/g) ?? []
    expect(occurrences.length).toBe(2)
    expect(sql).toContain('FUNCTION public.get_team_threads')
    expect(sql).toContain('FUNCTION public.search_team_messages')
  })
})
