/**
 * Team GROUP chats — the pure rules (dev job c1e326dd, TD Talk groups). No I/O: the routes and the screens share these,
 * and the unit tests pin them.
 *
 * A group is an `internal_threads` row of type 'group' with an explicit member list (`internal_thread_members`). It is
 * PRIVATE to its members. Anyone in a group may add people, rename it, or leave it (Antonio, 2026-10-09: "anyone").
 */

export const GROUP_THREAD_TYPE = 'group'
/** A group is at least three people counting the creator (two people are a direct message). */
export const MIN_GROUP_MEMBERS = 3
export const MAX_GROUP_MEMBERS = 30
export const MAX_GROUP_NAME = 60

/** Trim, collapse inner whitespace and cap the length. Returns '' for anything unusable. */
export function normalizeGroupName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME)
}

// A plain shape (not a discriminated union): the project's non-strict tsc does not narrow unions on `ok`.
export interface NewGroupCheck {
  ok: boolean
  name?: string
  members?: string[]
  error?: string
}

/**
 * Validate a "create group" request. `staffIds` is the set of real staff ids (the team directory). The creator is always
 * included; duplicates and unknown ids are refused (never silently dropped — the person would not be in the chat they
 * thought they added them to).
 */
export function validateNewGroup(input: { name: unknown; creatorId: string; memberIds: unknown; staffIds: Iterable<string> }): NewGroupCheck {
  const name = normalizeGroupName(input.name)
  if (!name) return { ok: false, error: 'Give the group a name.' }
  if (!Array.isArray(input.memberIds)) return { ok: false, error: 'Pick the people for the group.' }
  const staff = new Set(input.staffIds)
  const members: string[] = [input.creatorId]
  for (const raw of input.memberIds) {
    if (typeof raw !== 'string' || !raw) return { ok: false, error: 'Pick the people for the group.' }
    if (!staff.has(raw)) return { ok: false, error: 'One of the people you picked is not on the team.' }
    if (!members.includes(raw)) members.push(raw)
  }
  if (members.length < MIN_GROUP_MEMBERS) return { ok: false, error: 'A group needs at least two other people. For one person, just message them.' }
  if (members.length > MAX_GROUP_MEMBERS) return { ok: false, error: `A group can have at most ${MAX_GROUP_MEMBERS} people.` }
  return { ok: true, name, members }
}

export interface AddMembersCheck {
  ok: boolean
  toAdd?: string[]
  error?: string
}

/** Validate "add people": real staff only, not already in the group; the group size cap still applies. */
export function validateAddMembers(input: { userIds: unknown; currentMembers: readonly string[]; staffIds: Iterable<string> }): AddMembersCheck {
  if (!Array.isArray(input.userIds) || input.userIds.length === 0) return { ok: false, error: 'Pick who to add.' }
  const staff = new Set(input.staffIds)
  const toAdd: string[] = []
  for (const raw of input.userIds) {
    if (typeof raw !== 'string' || !raw) return { ok: false, error: 'Pick who to add.' }
    if (!staff.has(raw)) return { ok: false, error: 'One of the people you picked is not on the team.' }
    if (!input.currentMembers.includes(raw) && !toAdd.includes(raw)) toAdd.push(raw)
  }
  if (toAdd.length === 0) return { ok: false, error: 'They are already in the group.' }
  if (input.currentMembers.length + toAdd.length > MAX_GROUP_MEMBERS) return { ok: false, error: `A group can have at most ${MAX_GROUP_MEMBERS} people.` }
  return { ok: true, toAdd }
}

/** True when this group chat is visible to `userId` (a member). Used wherever a thread id is accepted from the browser. */
export function isGroupMember(members: readonly string[] | null | undefined, userId: string | null | undefined): boolean {
  return !!userId && !!members && members.includes(userId)
}

/** The other people in a group, i.e. who a new message should notify. */
export function otherMembers(members: readonly string[], senderId: string, exclude: readonly string[] = []): string[] {
  return members.filter(id => id && id !== senderId && !exclude.includes(id))
}
