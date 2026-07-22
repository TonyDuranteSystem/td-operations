/**
 * Team Workspace — staff directory + @mention resolution (server-only).
 *
 * Resolves the @handles parsed by lib/team/workspace.ts (pure) into real staff
 * auth user ids, so the send route can target push notifications and the UI can
 * offer mention autocomplete. Depends on listAllAuthUsers (Supabase admin), so
 * it must never be imported into client code.
 */
import 'server-only'
import { listAllAuthUsers } from '@/lib/auth-admin-helpers'
import { parseMentionHandles, CLAUDE_MENTION_ID, isStaffAuthRole } from '@/lib/team/workspace'

export interface TeamMember {
  id: string
  email: string | null
  name: string
  role: 'admin' | 'team'
  /** Candidate @handles this member answers to (all lower-case). */
  handles: string[]
}

/** Handle candidates for a member: email local-part + each name token + full. */
function handlesFor(email: string | null, name: string): string[] {
  const out = new Set<string>()
  const local = (email || '').split('@')[0].toLowerCase()
  if (local) {
    out.add(local)
    // dotted local-part also matches its first token (e.g. antonio.durante → antonio)
    const firstDotToken = local.split('.')[0]
    if (firstDotToken) out.add(firstDotToken)
  }
  const tokens = (name || '').toLowerCase().split(/\s+/).filter(Boolean)
  for (const t of tokens) {
    const clean = t.replace(/[^a-z0-9._-]/g, '')
    if (clean) out.add(clean)
  }
  // full name with no spaces (e.g. "antoniodurante")
  const joined = tokens.join('')
  if (joined) out.add(joined)
  return Array.from(out)
}

/**
 * List all TD STAFF as team members with mention handles.
 * Excludes banned/disabled users so a revoked teammate isn't mentionable.
 *
 * ⚠️ PARTNERS ARE NOT STAFF, AND THIS IS WHERE THAT IS ENFORCED.
 * This used to exclude only `role === 'client'` and then coerce every survivor
 * to 'admin' | 'team' — so a partner (`role === 'partner'`, e.g. Cris, who is a
 * partner in TD Communication and not a member of the team) came back RELABELLED
 * AS STAFF. Every caller treats this list as staff, so that one omission reached:
 * the floating chat's person picker, team-chat @mention autocomplete AND its push
 * targeting, DM creation, thread assignee, /api/team/share — and, worst,
 * staff-notes sharing, which would hand a PRIVATE post-it (and a push carrying
 * its body) to a partner. Note that the notes route filters `admin|team`
 * believing that excludes partners; it never did, because of the coercion below.
 * Found in production 2026-07-22.
 *
 * Callers filtering on `role` are therefore NOT a second line of defence — the
 * role is derived here. Keep the exclusion at THIS level.
 */
export async function listTeamMembers(): Promise<TeamMember[]> {
  const users = await listAllAuthUsers()
  return users
    // isStaffAuthRole is the ONE definition of "is this person TD staff",
    // shared with the UI so the two can never drift apart.
    .filter(u => isStaffAuthRole(u.app_metadata?.role) && !u.banned_until)
    .map(u => {
      const email = u.email ?? null
      const name = (u.user_metadata?.full_name as string) || email?.split('@')[0] || 'User'
      const role: 'admin' | 'team' = u.app_metadata?.role === 'admin' ? 'admin' : 'team'
      return { id: u.id, email, name, role, handles: handlesFor(email, name) }
    })
}

export interface ResolvedMentions {
  /** Staff user ids to notify (deduped, never includes the sender). */
  userIds: string[]
  /** True when @claude / @ai was mentioned (triggers the AI worker). */
  claude: boolean
  /** The raw handles that matched a real member (for storing on the message). */
  matchedHandles: string[]
}

/**
 * Resolve the @mentions in a message body against the staff directory.
 *
 * @param body        the message text
 * @param senderId    the sender's user id (excluded from userIds — you don't
 *                    notify yourself)
 * @param members     optional pre-fetched directory (avoids a second lookup when
 *                    the caller already listed members)
 */
export async function resolveMentions(
  body: string,
  senderId: string,
  members?: TeamMember[],
): Promise<ResolvedMentions> {
  const handles = parseMentionHandles(body)
  if (handles.length === 0) {
    return { userIds: [], claude: false, matchedHandles: [] }
  }

  const claude = handles.includes(CLAUDE_MENTION_ID) || handles.includes('ai')

  const dir = members ?? (await listTeamMembers())
  const handleToId = new Map<string, string>()
  for (const m of dir) {
    for (const h of m.handles) {
      // First writer wins; a later collision keeps the earlier member. Rare
      // (would need two staff sharing a token) and non-critical for push.
      if (!handleToId.has(h)) handleToId.set(h, m.id)
    }
  }

  const userIds = new Set<string>()
  const matched = new Set<string>()
  for (const h of handles) {
    if (h === CLAUDE_MENTION_ID || h === 'ai') {
      matched.add(h)
      continue
    }
    const id = handleToId.get(h)
    if (id) {
      matched.add(h)
      if (id !== senderId) userIds.add(id)
    }
  }

  return {
    userIds: Array.from(userIds),
    claude,
    matchedHandles: Array.from(matched),
  }
}
