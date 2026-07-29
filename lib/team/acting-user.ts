/**
 * Team Chat "on behalf of" — pure helpers (no server-only imports, unit-tested).
 *
 * A Claude-sent team message carries sender = the Claude sentinel; this module
 * decides WHICH staff user, if any, gets stamped as the human who dictated it
 * (`internal_messages.on_behalf_of_user_id`). The council-pinned rule
 * (2026-07-29, dev job 8537adf9): on ANY ambiguity the answer is null — an
 * unstamped message notifies everyone, which is today's behavior. A wrong guess
 * would silently silence the wrong person's notifications, the exact bug this
 * feature fixes, inverted.
 */
import { CLAUDE_SENDER_UUID } from '@/lib/team/workspace'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Minimal staff-member shape (matches lib/team/directory.ts::TeamMember). */
export interface ActingUserCandidate {
  id: string
  email: string | null
}

/**
 * Sanitize a caller-supplied acting-user id: must be a UUID and must not be the
 * Claude sentinel (Claude cannot dictate to itself). Anything else → null.
 */
export function sanitizeOnBehalfOfUserId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!UUID_RE.test(v)) return null
  if (v.toLowerCase() === CLAUDE_SENDER_UUID.toLowerCase()) return null
  return v
}

/**
 * Resolve an acting user against the staff directory by id OR email.
 * Unknown / non-staff → null (notify everyone). Case-insensitive email match.
 */
export function resolveActingUser(
  members: ActingUserCandidate[],
  idOrEmail: string | null | undefined,
): string | null {
  const v = (idOrEmail ?? '').trim()
  if (!v) return null
  if (UUID_RE.test(v)) {
    const cleaned = sanitizeOnBehalfOfUserId(v)
    if (!cleaned) return null
    return members.some(m => m.id === cleaned) ? cleaned : null
  }
  const email = v.toLowerCase()
  const match = members.find(m => (m.email ?? '').toLowerCase() === email)
  return match ? match.id : null
}
