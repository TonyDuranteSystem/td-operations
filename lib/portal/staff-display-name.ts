// Which team member answered (Antonio, 2026-11-26, dev job 8d077f3b: "I want the name who is answering from us to appear instead of TD Team").
//
// A staff message in Portal Chats now shows the sender's FIRST NAME (Antonio, Luca, Jodi) in the CRM, in TD Social and in the client's portal chat.
// A shared login (the support mailbox, the QA login) or a sender nobody can name stays "TD Team". WhatsApp keeps its own "TD Team" label (25 Sep
// decision) and is not touched here.
//
// The name is kept on the row (portal_messages.sender_name) when a staff message is sent, so a message that arrives live already carries it;
// older messages (they all carry sender_id, no name) are named from the sender's login when they are read. A staff row's sender_name must NEVER
// fall back to the row's contact: on a staff send that contact is only a routing tag (an arbitrary company member), not the author.

/** Logins that belong to no single person: the label stays "TD Team". Compared in lower case against the part of the email before the "@". */
export const SHARED_STAFF_LOGINS = ['support', 'info', 'admin', 'team', 'hello', 'contact', 'office', 'noreply', 'no-reply', 'qa', 'qa-staff', 'test'] as const
/** Display names that are not a person's name either (the support login's name is literally "Support"). */
const NON_PERSON_NAMES = new Set(['support', 'admin', 'team', 'td team', 'staff', 'qa staff', 'qa-staff', 'test', 'user'])

// letters only (Latin, with accents), plus ' and - inside a name; no `u` flag so it compiles for every build target (R115: a regex LITERAL, not a string)
const WORD = /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’-]*$/

function capitalise(word: string): string {
  return word.charAt(0).toLocaleUpperCase() + word.slice(1)
}

/** The first name to show for a staff login, or null when it should stay "TD Team". */
export function staffFirstName(fullName?: string | null, email?: string | null): string | null {
  const local = (email ?? '').split('@')[0].trim().toLowerCase()
  if (local && (SHARED_STAFF_LOGINS as readonly string[]).includes(local)) return null

  const full = (fullName ?? '').trim()
  if (full) {
    if (NON_PERSON_NAMES.has(full.toLowerCase())) return null
    const first = full.split(/\s+/)[0]
    return WORD.test(first) && first.length >= 2 ? capitalise(first) : null
  }

  // no full name on the login: use the part of the email before the first dot, underscore or dash ("antonio.durante" -> "Antonio")
  const token = local.split(/[._-]/)[0]
  return token && WORD.test(token) && token.length >= 2 ? capitalise(token) : null
}

/** What a staff message's sender_name should say: the stored name if there is one, else the name worked out from the login, else nothing. */
export function adminSenderName(stored?: string | null, resolved?: string | null): string | null {
  const own = stored?.trim()
  if (own) return own
  const found = resolved?.trim()
  return found || null
}

export interface StaffLookupUser { email?: string | null; user_metadata?: { full_name?: unknown } | null }
export type StaffLookup = (userId: string) => Promise<StaffLookupUser | null>
export interface StaffLabelCache { map: Map<string, { label: string | null; at: number }>; ttlMs: number }

export const STAFF_LABEL_TTL_MS = 10 * 60 * 1000
const MAX_LOOKUPS_PER_CALL = 20

export function newStaffLabelCache(ttlMs: number = STAFF_LABEL_TTL_MS): StaffLabelCache {
  return { map: new Map(), ttlMs }
}

/**
 * Names for a handful of staff user ids (a page of messages has at most a few different senders). Remembered for ten minutes so a busy
 * chat does not look the same login up on every read. A lookup that fails is NOT remembered (it is tried again next time) and gives
 * "TD Team" for now: naming a sender never blocks a message from showing.
 */
export async function resolveStaffLabels(
  ids: Iterable<string | null | undefined>,
  lookup: StaffLookup,
  cache: StaffLabelCache,
  now: number = Date.now(),
): Promise<Map<string, string | null>> {
  const wanted = Array.from(new Set(Array.from(ids).filter((x): x is string => typeof x === 'string' && x.length > 0))).slice(0, MAX_LOOKUPS_PER_CALL)
  const out = new Map<string, string | null>()
  const missing: string[] = []
  for (const id of wanted) {
    const hit = cache.map.get(id)
    if (hit && now - hit.at < cache.ttlMs) out.set(id, hit.label)
    else missing.push(id)
  }
  await Promise.all(missing.map(async id => {
    try {
      const user = await lookup(id)
      const label = user ? staffFirstName(typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : null, user.email ?? null) : null
      cache.map.set(id, { label, at: now })
      out.set(id, label)
    } catch {
      out.set(id, null)
    }
  }))
  return out
}
