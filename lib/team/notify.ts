/**
 * Team Workspace — push to STAFF, by name (server-only).
 *
 * ⛔ THIS REPLACES `sendPushToAdminExcluding`, WHICH IS GONE. DO NOT REINTRODUCE
 * A BROADCAST. That helper selected every row of the admin push table except the
 * sender's — i.e. every device that had ever registered, whoever owned it. Two
 * facts made that a leak waiting to happen (both verified 2026-07-24):
 *   1. the endpoint that registers a device only required *a* logged-in user —
 *      not a staff one. A partner's browser, or a client's portal login, could
 *      put itself in that table (now closed at that endpoint too, but a single
 *      gate is not a design).
 *   2. it was used for internal team chat and for staff notes on client
 *      messages, so the body of an internal note would have gone with it.
 * Production was clean when this was written — exactly two devices, Antonio's
 * and Luca's — so nothing leaked. The door was open, not the room.
 *
 * Antonio, 2026-07-24, verbatim: "I don't care about Chris, and the client's
 * browser never has to get anything about our business."
 *
 * The staff list comes from `listTeamMembers`, which is the ONE place that
 * decides who is staff and already excludes partners and clients. Do not add a
 * second role filter here — that would be a copy of the rule, free to drift.
 *
 * ⚠️ KNOWN RESIDUAL, stated rather than hidden: that list works by exclusion, so
 * a FUTURE non-employee auth role ('contractor', 'auditor') would count as staff
 * and start receiving internal pushes until it is added to NON_STAFF_AUTH_ROLES.
 * Adding any non-employee login MUST include that line in the same change.
 */
import 'server-only'
import { listTeamMembers } from '@/lib/team/directory'
import { sendPushToAdminUsers } from '@/lib/portal/web-push'

/**
 * Push to every staff member except one (normally the sender — you are never
 * notified of your own message).
 *
 * @param excludeUserId the id to leave out. Pass the sender, or the Claude
 *                      sentinel when Claude is the author (it is not a real
 *                      user, so nobody is actually excluded).
 */
export async function sendPushToStaffExcept(
  excludeUserId: string | null | undefined,
  payload: Parameters<typeof sendPushToAdminUsers>[1],
  /**
   * Extra ids to leave out — for a caller that has ALREADY pushed those people a
   * more specific message (e.g. "@mentioned you") and must not push them the
   * generic one as well.
   */
  alsoExclude?: string[],
) {
  let ids: string[]
  try {
    const members = await listTeamMembers()
    const skip = new Set<string>([...(alsoExclude ?? [])])
    ids = members.map(m => m.id).filter(id => id && id !== excludeUserId && !skip.has(id))
  } catch {
    // Fail CLOSED. A directory lookup that errors must not fall back to "push to
    // everyone registered" — that is the exact behaviour this module deletes.
    return { sent: 0, failed: 0 }
  }
  if (ids.length === 0) return { sent: 0, failed: 0 }
  return sendPushToAdminUsers(ids, payload)
}

/**
 * Push to every staff member — for events with no human author (a client
 * message arriving, a system alert). Same staff resolution, same fail-closed
 * behaviour; replaces the deleted `sendPushToAdmin`.
 */
export async function sendPushToStaff(
  payload: Parameters<typeof sendPushToAdminUsers>[1],
) {
  return sendPushToStaffExcept(null, payload)
}
