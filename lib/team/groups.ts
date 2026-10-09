/**
 * Team GROUP chats — server side (dev job c1e326dd, TD Talk groups). Pure rules live in lib/team/groups-rules.ts.
 *
 * Private by construction: get_team_threads / search_team_messages only return a group to a member, and every route that
 * takes a thread id from the browser calls `assertGroupAccess` below. Never insert a 'group' thread anywhere else.
 */
import 'server-only'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { listTeamMembers } from '@/lib/team/directory'
import {
  GROUP_THREAD_TYPE, isGroupMember, normalizeGroupName, validateAddMembers, validateNewGroup,
} from '@/lib/team/groups-rules'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

export async function listGroupMemberIds(threadId: string): Promise<string[]> {
  const { data } = await db().from('internal_thread_members').select('user_id').eq('thread_id', threadId)
  return ((data ?? []) as Array<{ user_id: string }>).map(r => r.user_id)
}

/** Members of several groups at once: { threadId: [userId…] }. */
export async function groupMembersFor(threadIds: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  if (threadIds.length === 0) return out
  const { data } = await db().from('internal_thread_members').select('thread_id, user_id').in('thread_id', threadIds)
  for (const r of (data ?? []) as Array<{ thread_id: string; user_id: string }>) (out[r.thread_id] ??= []).push(r.user_id)
  return out
}

export interface GroupAccess {
  kind: 'not_group' | 'member' | 'denied'
  /** Present when kind is 'member'. */
  members: string[]
}

/**
 * For a thread id taken from the browser: is it a group, and is `userId` in it? Returns `not_group` for every other
 * kind of thread (their own rules apply), `denied` for a group the person is not in — and for a thread that does not
 * exist the caller's own not-found handling runs, so this returns `not_group`.
 */
export async function assertGroupAccess(threadId: string, userId: string): Promise<GroupAccess> {
  const { data: thread } = await db().from('internal_threads').select('thread_type').eq('id', threadId).maybeSingle()
  if (!thread || thread.thread_type !== GROUP_THREAD_TYPE) return { kind: 'not_group', members: [] }
  const members = await listGroupMemberIds(threadId)
  return isGroupMember(members, userId) ? { kind: 'member', members } : { kind: 'denied', members: [] }
}

// A plain shape (not a discriminated union): the project's non-strict tsc does not narrow unions on `ok`.
export interface GroupResult<T> {
  ok: boolean
  value?: T
  status?: number
  error?: string
}

export async function createGroup(creatorId: string, nameRaw: unknown, memberIdsRaw: unknown): Promise<GroupResult<{ thread: Record<string, unknown>; members: string[] }>> {
  const staff = await listTeamMembers()
  const check = validateNewGroup({ name: nameRaw, creatorId, memberIds: memberIdsRaw, staffIds: staff.map(m => m.id) })
  if (!check.ok) return { ok: false, status: 400, error: check.error }
  const now = new Date().toISOString()
  const { data: thread, error } = await db().from('internal_threads')
    .insert({ thread_type: GROUP_THREAD_TYPE, title: check.name, created_by: creatorId, last_activity_at: now })
    .select().single()
  if (error || !thread) return { ok: false, status: 500, error: error?.message || 'Could not create the group.' }
  const { error: memErr } = await db().from('internal_thread_members')
    .insert((check.members ?? []).map(user_id => ({ thread_id: thread.id, user_id, added_by: creatorId })))
  if (memErr) {
    await db().from('internal_threads').delete().eq('id', thread.id) // never leave a group with no member list
    return { ok: false, status: 500, error: memErr.message }
  }
  return { ok: true, value: { thread, members: check.members ?? [] } }
}

export async function addGroupMembers(threadId: string, actorId: string, userIdsRaw: unknown): Promise<GroupResult<{ members: string[] }>> {
  const access = await assertGroupAccess(threadId, actorId)
  if (access.kind !== 'member') return { ok: false, status: access.kind === 'denied' ? 403 : 404, error: access.kind === 'denied' ? 'You are not in this group.' : 'Group not found.' }
  const staff = await listTeamMembers()
  const check = validateAddMembers({ userIds: userIdsRaw, currentMembers: access.members, staffIds: staff.map(m => m.id) })
  if (!check.ok) return { ok: false, status: 400, error: check.error }
  const { error } = await db().from('internal_thread_members')
    .insert((check.toAdd ?? []).map(user_id => ({ thread_id: threadId, user_id, added_by: actorId })))
  if (error) return { ok: false, status: 500, error: error.message }
  await db().from('internal_threads').update({ last_activity_at: new Date().toISOString() }).eq('id', threadId)
  return { ok: true, value: { members: [...access.members, ...(check.toAdd ?? [])] } }
}

export async function renameGroup(threadId: string, actorId: string, nameRaw: unknown): Promise<GroupResult<{ name: string }>> {
  const access = await assertGroupAccess(threadId, actorId)
  if (access.kind !== 'member') return { ok: false, status: access.kind === 'denied' ? 403 : 404, error: access.kind === 'denied' ? 'You are not in this group.' : 'Group not found.' }
  const name = normalizeGroupName(nameRaw)
  if (!name) return { ok: false, status: 400, error: 'Give the group a name.' }
  const { error } = await db().from('internal_threads').update({ title: name }).eq('id', threadId)
  if (error) return { ok: false, status: 500, error: error.message }
  return { ok: true, value: { name } }
}

/** Leave a group (only yourself). The last person out archives the group so it disappears for good. */
export async function leaveGroup(threadId: string, userId: string): Promise<GroupResult<{ left: true; archived: boolean }>> {
  const access = await assertGroupAccess(threadId, userId)
  if (access.kind !== 'member') return { ok: false, status: access.kind === 'denied' ? 403 : 404, error: access.kind === 'denied' ? 'You are not in this group.' : 'Group not found.' }
  const { error } = await db().from('internal_thread_members').delete().eq('thread_id', threadId).eq('user_id', userId)
  if (error) return { ok: false, status: 500, error: error.message }
  const remaining = access.members.filter(id => id !== userId)
  const archived = remaining.length === 0
  const patch: Record<string, unknown> = { last_activity_at: new Date().toISOString() }
  if (archived) patch.archived_at = new Date().toISOString()
  await db().from('internal_threads').update(patch).eq('id', threadId)
  return { ok: true, value: { left: true, archived } }
}
