// Which team member answered (Antonio, 2026-11-26, dev job 8d077f3b: "I want the name who is answering from us to appear instead of TD Team").
//
// A staff message in Portal Chats now shows the sender's FIRST NAME (Antonio, Luca, Jodi) in the CRM, in TD Social and in the client's portal chat.
// A shared login (the support mailbox, the QA login) or a sender nobody can name stays "TD Team". WhatsApp keeps its own "TD Team" label (25 Sep
// decision) and is not touched here.
//
// The name is kept on the row (portal_messages.sender_name) when a staff message is TYPED in the CRM / TD Social, so a message that arrives live
// already carries it. Older messages (they all carry sender_id, no name) are named from the sender's login when they are read — EXCEPT the one
// shared "system admin" sender id (see AUTOMATION_SENDER_IDS): about twenty automatic writers (reminders, welcome notes, document alerts, Claude /
// the MCP tools, the AI worker) post under it, so a row carrying it was usually NOT typed by a person and stays "TD Team". A staff row's
// sender_name must NEVER fall back to the row's contact: on a staff send that contact is only a routing tag (an arbitrary company member).

/** Logins that belong to no single person: the label stays "TD Team". Compared in lower case against the part of the email before the "@". */
export const SHARED_STAFF_LOGINS = ['support', 'info', 'admin', 'team', 'hello', 'contact', 'office', 'noreply', 'no-reply', 'qa', 'qa-staff', 'test'] as const
/**
 * Sender ids that automatic writers share. portal_messages.sender_id = this id means "the system posted it for the team", not "Antonio typed it":
 * the reminders, welcome notes, document alerts, service-stage notices, Claude's MCP send and the AI worker all stamp it. An OLD row (no stored
 * name) carrying one of these is never named from the login. A message Antonio types himself is different: it stores "Antonio" on the row at send.
 */
export const AUTOMATION_SENDER_IDS: readonly string[] = ['b0da5d9c-acf6-4761-9cae-2c3b14dbc631']

export function isAutomationSenderId(id: string | null | undefined): boolean {
  return !!id && AUTOMATION_SENDER_IDS.includes(id.toLowerCase())
}

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

export interface StaffRowLike { sender_type?: string | null; sender_id?: string | null; sender_name?: string | null }

/** The staff user ids worth a login lookup: staff rows with no stored name whose sender is a real login (not the shared automation id). */
export function senderIdsToName(rows: readonly StaffRowLike[]): string[] {
  const out = new Set<string>()
  for (const r of rows) {
    if (r.sender_type !== 'admin' || !r.sender_id) continue
    if (r.sender_name?.trim()) continue
    if (isAutomationSenderId(r.sender_id)) continue
    out.add(r.sender_id)
  }
  return Array.from(out)
}

/**
 * The name to show on one staff row: the name stored when it was typed, else the name of its own login — but never from the shared automation
 * id, and never from the row's contact. null = "TD Team".
 */
export function staffRowSenderName(row: StaffRowLike, resolved: ReadonlyMap<string, string | null>): string | null {
  const stored = row.sender_name?.trim()
  if (stored) return stored
  if (!row.sender_id || isAutomationSenderId(row.sender_id)) return null
  return resolved.get(row.sender_id)?.trim() || null
}

export interface StaffLookupUser { email?: string | null; user_metadata?: { full_name?: unknown } | null }
export type StaffLookup = (userId: string) => Promise<StaffLookupUser | null>
export interface StaffLabelCache { map: Map<string, { label: string | null; at: number }>; ttlMs: number }

export const STAFF_LABEL_TTL_MS = 10 * 60 * 1000
/** A login lookup that has not answered in this long is given up on: the chat must open without waiting for a name (Bug-Hunter 2026-11-26). */
export const STAFF_LOOKUP_TIMEOUT_MS = 2000
const MAX_LOOKUPS_PER_CALL = 20

/** Races a lookup against a timer; the timer is always cleared so nothing is left running. */
async function lookupWithTimeout(lookup: StaffLookup, id: string, timeoutMs: number): Promise<StaffLookupUser | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      lookup(id),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('staff lookup timed out')), timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function newStaffLabelCache(ttlMs: number = STAFF_LABEL_TTL_MS): StaffLabelCache {
  return { map: new Map(), ttlMs }
}

/**
 * Names for a handful of staff user ids (a page of messages has at most a few different senders). Remembered for ten minutes so a busy
 * chat does not look the same login up on every read. A lookup that fails is NOT remembered (it is tried again next time) and gives
 * "TD Team" for now: naming a sender never blocks a message from showing. A lookup is given STAFF_LOOKUP_TIMEOUT_MS (2 s) and then abandoned, also
 * without being remembered, so a slow login service cannot hold the chat open.
 */
export async function resolveStaffLabels(
  ids: Iterable<string | null | undefined>,
  lookup: StaffLookup,
  cache: StaffLabelCache,
  now: number = Date.now(),
  timeoutMs: number = STAFF_LOOKUP_TIMEOUT_MS,
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
      const user = await lookupWithTimeout(lookup, id, timeoutMs)
      const label = user ? staffFirstName(typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : null, user.email ?? null) : null
      cache.map.set(id, { label, at: now })
      out.set(id, label)
    } catch {
      out.set(id, null)
    }
  }))
  return out
}
