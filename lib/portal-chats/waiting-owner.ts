/**
 * Who a "Waiting on us" conversation belongs to (Antonio, 2026-11-25, dev job 40b5fd59).
 *
 * A conversation the client is waiting on us for has ONE owner: a team member (staff login) who answers it, or nobody yet.
 * The "Waiting on us" card lists them with the owner and a filter per team member; each person's card opens on their own.
 * Pure rules (no React, no database) so they are unit-tested; the card and the routes only call these.
 */

/** The team member shape the card needs (the server turns the staff directory into this). */
export interface WaitingStaff {
  id: string
  name: string
  initials: string
}

/** Filter on the card: everyone, nobody assigned yet, or one team member (their user id). */
export type OwnerFilter = 'all' | 'none' | (string & {})

export interface OwnedThread {
  /** When it was marked "waiting on us" (ISO); null/undefined = not waiting on us. */
  waiting_us_since?: string | null
  /** Staff user id of the owner; null/undefined = not assigned. */
  waiting_us_owner?: string | null
}

/**
 * A readable name for a staff login. A login without a full name shows its email prefix ("antonio.durante"), so dots, dashes and
 * underscores become spaces and every word starts with a capital ("Antonio Durante"). A real full name is left exactly as written.
 */
export function tidyStaffName(raw: string | null | undefined): string {
  const s = (raw ?? '').trim()
  if (!s) return 'Team member'
  if (/\s/.test(s) || !/[._-]/.test(s)) return s
  return s.split(/[._-]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/** Up to two capital letters: first letters of the first two words ("Luca Degasper" → LD, "Jodi" → J). */
export function staffInitials(name: string): string {
  const words = tidyStaffName(name).split(/\s+/).filter(Boolean)
  return words.slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('') || '?'
}

/** The card opens on the viewer's own conversations when the viewer is on the team list; otherwise on everyone's. */
export function defaultOwnerFilter(viewerId: string | null | undefined, staff: ReadonlyArray<WaitingStaff>): OwnerFilter {
  return viewerId && staff.some(s => s.id === viewerId) ? viewerId : 'all'
}

/** Does this conversation belong under the card's filter? */
export function matchesOwnerFilter(t: OwnedThread, filter: OwnerFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'none') return !t.waiting_us_owner
  return t.waiting_us_owner === filter
}

export interface OwnerCounts {
  all: number
  none: number
  byOwner: Record<string, number>
}

/** How many waiting-on-us conversations each pill holds. Only conversations that are waiting on us are counted. */
export function ownerCounts(threads: ReadonlyArray<OwnedThread>): OwnerCounts {
  const out: OwnerCounts = { all: 0, none: 0, byOwner: {} }
  for (const t of threads) {
    if (!t.waiting_us_since) continue
    out.all++
    if (!t.waiting_us_owner) out.none++
    else out.byOwner[t.waiting_us_owner] = (out.byOwner[t.waiting_us_owner] ?? 0) + 1
  }
  return out
}

/** The waiting-on-us conversations for the card: the chosen filter applied, longest-waiting first. */
export function waitingUsForCard<T extends OwnedThread>(threads: ReadonlyArray<T>, filter: OwnerFilter): T[] {
  return threads
    .filter(t => !!t.waiting_us_since && matchesOwnerFilter(t, filter))
    .sort((a, b) => (a.waiting_us_since ?? '').localeCompare(b.waiting_us_since ?? ''))
}

/** One flat shape (not a union): this project's TypeScript is not strict, so `if (!d.ok)` would not narrow a union. */
export interface OwnerDecision {
  ok: boolean
  owner: string | null
  error?: string
}

/**
 * Who a NEW mark belongs to. Only "waiting on us" has an owner.
 * - not asked for (undefined) → the person marking it, if they are on the team list (that is the menu's default);
 * - asked for nobody (null or empty) → not assigned;
 * - asked for a person → they must be on the team list.
 */
export function decideOwnerForMark(opts: {
  kind: 'client' | 'us'
  requested: string | null | undefined
  markerId: string
  staffIds: ReadonlyArray<string>
}): OwnerDecision {
  if (opts.kind !== 'us') return { ok: true, owner: null }
  const { requested, markerId, staffIds } = opts
  if (requested === undefined) return { ok: true, owner: staffIds.includes(markerId) ? markerId : null }
  if (requested === null || requested === '') return { ok: true, owner: null }
  if (!staffIds.includes(requested)) return { ok: false, owner: null, error: 'That person is not on the team list.' }
  return { ok: true, owner: requested }
}

/**
 * Logins that are on the staff directory but are not a person who answers clients, so they are never offered as an owner
 * (Antonio, 2026-11-25: "remove QA staff"). The login itself is untouched; it just does not appear in the owner picker and
 * cannot be chosen as an owner. Compared in lower case.
 */
export const OWNER_PICKER_HIDDEN_EMAILS: ReadonlyArray<string> = ['qa-staff@tonydurante.us']

/** The staff directory without the logins in OWNER_PICKER_HIDDEN_EMAILS. The one list the picker AND the owner checks both use. */
export function ownerPickerMembers<T extends { email: string | null }>(members: ReadonlyArray<T>): T[] {
  return members.filter(m => !OWNER_PICKER_HIDDEN_EMAILS.includes((m.email ?? '').trim().toLowerCase()))
}
