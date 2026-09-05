/**
 * postTeamMessage — which real party a dictated DM's thread gets keyed to.
 *
 * Bug-hunter regression pin, 2026-09-05: a real production message dictated
 * by Antonio to Luca via team_chat_send's dm_user_id path was permanently
 * invisible to Antonio, because the thread was always keyed to the Claude
 * sentinel identity rather than whoever actually dictated it — every listing
 * surface gates visibility on "does dm_key contain MY id", so the dictating
 * human's own id being absent made the conversation unreachable to them,
 * forever, from message one. The fix moved acting-user resolution before
 * target-thread resolution so a dictated DM can be keyed to the real acting
 * user instead. This is the one line of that fix with no other direct test —
 * everything else (the push-targeting half) is pinned in
 * tests/unit/team-workspace.test.ts's otherDmParty tests.
 *
 * Mocked at the lib/team/dm + lib/team/directory module boundary rather than
 * the raw Supabase client — the property under test is "which id gets passed
 * to findOrCreateDm", not the full send pipeline (attachments, push, mentions
 * are already covered elsewhere).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// lib/team/post-message.ts (and its imports) are marked 'server-only', which
// is a real npm package only in Next.js's own build — not installed for
// plain vitest. Stub it so importing postTeamMessage here doesn't throw.
vi.mock('server-only', () => ({}))

let findOrCreateDmCalls: Array<[string, string]> = []

vi.mock('@/lib/team/dm', () => ({
  findOrCreateDm: vi.fn(async (userId: string, otherId: string) => {
    findOrCreateDmCalls.push([userId, otherId])
    return { thread: { id: 'thread-1', dm_key: [userId, otherId].sort().join(':') }, reused: false }
  }),
}))

vi.mock('@/lib/team/directory', () => ({
  listTeamMembers: vi.fn(async () => [
    { id: '11111111-1111-1111-1111-111111111111', email: 'antonio.durante@tonydurante.us', name: 'Antonio', role: 'admin' as const, handles: ['antonio'] },
    { id: '22222222-2222-2222-2222-222222222222', email: 'support@tonydurante.us', name: 'Luca', role: 'team' as const, handles: ['luca'] },
  ]),
  resolveMentions: vi.fn(async () => ({ userIds: [], claude: false, matchedHandles: [] })),
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'msg-1' }, error: null }) }) }),
      update: () => ({ eq: async () => ({ data: null, error: null }) }),
      upsert: async () => ({ data: null, error: null }),
    }),
  },
}))

vi.mock('@/lib/portal/web-push', () => ({ sendPushToAdminUsers: vi.fn(async () => {}) }))
vi.mock('@/lib/team/notify', () => ({ sendPushToStaffExcept: vi.fn(async () => {}) }))
vi.mock('@/lib/team/channel-notify', () => ({
  channelNotifiesStaff: () => false,
  conversationNotifiesParticipants: () => false,
}))

import { postTeamMessage } from '@/lib/team/post-message'
import { CLAUDE_SENDER_UUID } from '@/lib/team/workspace'

beforeEach(() => {
  findOrCreateDmCalls = []
})

describe('postTeamMessage — DM keying', () => {
  it('keys the DM to the real acting user when on_behalf_of resolves to a real staff member — the fix', async () => {
    await postTeamMessage({ dm_user_id: '22222222-2222-2222-2222-222222222222', message: 'hi', on_behalf_of: '11111111-1111-1111-1111-111111111111' })
    expect(findOrCreateDmCalls).toEqual([['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']])
  })

  it('resolves on_behalf_of by email too, with the same result', async () => {
    await postTeamMessage({ dm_user_id: '22222222-2222-2222-2222-222222222222', message: 'hi', on_behalf_of: 'antonio.durante@tonydurante.us' })
    expect(findOrCreateDmCalls).toEqual([['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']])
  })

  it('falls back to the Claude sentinel when no acting user is given — a genuinely autonomous send', async () => {
    await postTeamMessage({ dm_user_id: '22222222-2222-2222-2222-222222222222', message: 'hi' })
    expect(findOrCreateDmCalls).toEqual([[CLAUDE_SENDER_UUID, '22222222-2222-2222-2222-222222222222']])
  })

  it('falls back to the sentinel when on_behalf_of does not resolve to any real staff member — never guesses', async () => {
    await postTeamMessage({ dm_user_id: '22222222-2222-2222-2222-222222222222', message: 'hi', on_behalf_of: 'nobody@nowhere.com' })
    expect(findOrCreateDmCalls).toEqual([[CLAUDE_SENDER_UUID, '22222222-2222-2222-2222-222222222222']])
  })

  it('a self-dictated DM (on_behalf_of the same person the DM targets) still resolves — the self-DM case', async () => {
    await postTeamMessage({ dm_user_id: '11111111-1111-1111-1111-111111111111', message: 'note to self', on_behalf_of: '11111111-1111-1111-1111-111111111111' })
    expect(findOrCreateDmCalls).toEqual([['11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111']])
  })
})
