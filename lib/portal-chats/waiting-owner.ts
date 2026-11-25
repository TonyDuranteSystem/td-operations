/**
 * Who a "Waiting on us" / "Waiting for client" conversation belongs to (Antonio, 2026-11-25, dev job 40b5fd59).
 *
 * A conversation the client is waiting on us for has ONE owner: a team member (staff login) who answers it, or nobody yet.
 * Since 2026-11-25 (later) a conversation WE are waiting on the client for has one too: the team member who follows it up.
 * Each chip's card lists its conversations with the owner and a filter per team member; each person's card opens on their own.
 * Pure rules (no React, no database) so they are unit-tested; the cards and the routes only call these.
 */

/** The team member shape the card needs (the server turns the staff directory into this). */
export interface WaitingStaff {
  id: string
  name: string
  initials: string
}

/** Filter on the card: everyone, nobody assigned yet, or one team member (their user id). */
export type OwnerFilter = 'all' | 'none' | (string & {})

/** Which mark: "us" = the client waits for the team; "client" = the team waits for the client. */
export type WaitingKind = 'client' | 'us'

export interface OwnedThread {
  /** When it was marked "waiting on us" (ISO); null/undefined = not waiting on us. */
  waiting_us_since?: string | null
  /** Staff user id of the owner; null/undefined = not assigned. */
  waiting_us_owner?: string | null
  /** When it was marked "waiting for client" (ISO); null/undefined = not waiting for the client. */
  waiting_since?: string | null
  /** Staff user id who follows the "waiting for client" conversation up; null/undefined = not assigned. */
  waiting_owner?: string | null
}

/** When this conversation was marked, for the given kind (null = it is not marked that way). */
export function waitingSinceOf(t: OwnedThread, kind: WaitingKind): string | null {
  return (kind === 'us' ? t.waiting_us_since : t.waiting_since) ?? null
}

/** The staff user id that owns this conversation's mark of the given kind (null = not assigned). */
export function waitingOwnerOf(t: OwnedThread, kind: WaitingKind): string | null {
  return (kind === 'us' ? t.waiting_us_owner : t.waiting_owner) ?? null
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

/** Does this conversation belong under the card's filter? (`kind` = which chip's card; "us" unless said otherwise.) */
export function matchesOwnerFilter(t: OwnedThread, filter: OwnerFilter, kind: WaitingKind = 'us'): boolean {
  if (filter === 'all') return true
  const owner = waitingOwnerOf(t, kind)
  if (filter === 'none') return !owner
  return owner === filter
}

export interface OwnerCounts {
  all: number
  none: number
  byOwner: Record<string, number>
}

/** How many conversations each pill holds. Only conversations that are marked with this `kind` are counted. */
export function ownerCounts(threads: ReadonlyArray<OwnedThread>, kind: WaitingKind = 'us'): OwnerCounts {
  const out: OwnerCounts = { all: 0, none: 0, byOwner: {} }
  for (const t of threads) {
    if (!waitingSinceOf(t, kind)) continue
    out.all++
    const owner = waitingOwnerOf(t, kind)
    if (!owner) out.none++
    else out.byOwner[owner] = (out.byOwner[owner] ?? 0) + 1
  }
  return out
}

/** The conversations marked with this `kind` for the card: the chosen filter applied, longest-waiting first. */
export function waitingForCard<T extends OwnedThread>(threads: ReadonlyArray<T>, filter: OwnerFilter, kind: WaitingKind = 'us'): T[] {
  return threads
    .filter(t => !!waitingSinceOf(t, kind) && matchesOwnerFilter(t, filter, kind))
    .sort((a, b) => (waitingSinceOf(a, kind) ?? '').localeCompare(waitingSinceOf(b, kind) ?? ''))
}

/** The waiting-on-us conversations for the card (see waitingForCard). */
export function waitingUsForCard<T extends OwnedThread>(threads: ReadonlyArray<T>, filter: OwnerFilter): T[] {
  return waitingForCard(threads, filter, 'us')
}

/** One flat shape (not a union): this project's TypeScript is not strict, so `if (!d.ok)` would not narrow a union. */
export interface OwnerDecision {
  ok: boolean
  owner: string | null
  error?: string
}

/**
 * Who a NEW mark belongs to. Both kinds have an owner and follow the same rules (before 2026-11-25 "later" only "waiting on us" did).
 * - not asked for (undefined) → the person marking it, if they are on the team list (that is the menu's default);
 * - asked for nobody (null or empty) → not assigned;
 * - asked for a person → they must be on the team list.
 */
export function decideOwnerForMark(opts: {
  kind: WaitingKind
  requested: string | null | undefined
  markerId: string
  staffIds: ReadonlyArray<string>
}): OwnerDecision {
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
