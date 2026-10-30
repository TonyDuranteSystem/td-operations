/**
 * The chats-and-notes half of the Bank Feed investigator's guaranteed searches.
 *
 * Antonio, 2026-10-30: "the AI must look also in the portal chats and everywhere." The investigator's AI had
 * the tools to read a client's portal chat, but whether it did was left to its habits: one run read the chat,
 * another never opened it, and the mailbox sweep was the only search the CODE guaranteed. This is the same
 * kind of guarantee for the places a payer talks to us besides email — so "searched" is a fact the screen
 * can show, not something the AI claims.
 *
 * Client-first, capped, read-only:
 *  - the payer's name is looked up in the CRM (companies and people), and what those clients wrote or were
 *    told around the payment date is read;
 *  - the payer's name, the email in the memo and any invoice number written on the bank line are also searched
 *    as plain text in a wider window, so a message from someone the CRM does not know is still found.
 *
 * Five places: portal chats, the CRM conversation log, WhatsApp/Telegram, team chat and staff notes.
 * PRIVACY — the same rules the rest of the system applies, so the AI never reads what the owner could not
 * open himself on screen: team chat is searched in CHANNELS and DISCUSSIONS only (direct messages and groups
 * are private to their members), and staff notes only when visible to the person running the investigation.
 *
 * Everything returned is text written by third parties: the caller puts it in the prompt as untrusted data.
 * Nothing here writes anything. A place that cannot be searched is NAMED, never skipped quietly.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { cleanText } from "@/lib/finance/feed-investigation"
import { escapeLikePattern, isUsablePayerName, normalizePayerName, parsePayerEmail } from "@/lib/finance/payer-suggestions"
import { visibleToOrClause } from "@/lib/notes/staff-notes"

export const CHAT_STORES = ["portal_chat", "conversation_log", "whatsapp_telegram", "team_chat", "staff_notes"] as const
export type ChatStoreKey = (typeof CHAT_STORES)[number]

/** Plain words for the screen and the prompt. */
export const CHAT_STORE_LABEL: Record<ChatStoreKey, string> = {
  portal_chat: "portal chats",
  conversation_log: "conversation log",
  whatsapp_telegram: "WhatsApp/Telegram",
  team_chat: "team chat (channels, not direct messages)",
  staff_notes: "staff notes",
}

/** The thread kinds of the team chat that are NOT private to a few people. */
export const TEAM_CHAT_OPEN_THREAD_TYPES = ["channel", "discussion"] as const

/** Days around the payment date for the client-first read, and for the plain-text search. */
export const CLIENT_WINDOW_DAYS = 30
export const TEXT_WINDOW_DAYS = 45
/** Most hits kept per place, and the longest text kept per hit. The AI run has a time budget: this stays small. */
export const MAX_HITS_PER_STORE = 12
export const MAX_HIT_CHARS = 240
const MAX_TERMS = 6
const MAX_CLIENTS = 3
const PER_QUERY_LIMIT = 8

export interface ChatHit {
  store: ChatStoreKey
  id: string
  /** YYYY-MM-DD */
  date: string
  who: string
  text: string
  /** "client" = found because it belongs to a client the payer's name matched; "text" = found by the words. */
  how: "client" | "text"
}

export interface ChatStoreResult {
  store: ChatStoreKey
  /** Plain words for this place ("portal chats"), so a reader of the result never needs the table above. */
  label: string
  /** True only when every search of this place ran. A partial or failed search is false, with the reason. */
  searched: boolean
  error: string | null
  hits: ChatHit[]
}

export interface ChatClient {
  kind: "account" | "contact"
  id: string
  name: string
}

export interface ChatSweep {
  terms: string[]
  clients: ChatClient[]
  /** Why the CRM could not be asked who this payer is (the text searches still ran). */
  clientLookupError: string | null
  /** The client-first window, YYYY-MM-DD; null when the payment has no usable date. */
  window: { from: string; to: string } | null
  stores: ChatStoreResult[]
}

/** What is kept on the payment: the counts, never the text. */
export interface ChatStoreSummary {
  store: ChatStoreKey
  label: string
  searched: boolean
  count: number
  error: string | null
}

// ───────────────────────────────────────────────────────────────────────────────────────
// Pure parts
// ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The company or person's name inside a bank line: the text before an invoice reference
 * ("Active Acres Properties LLC - INV 2026 001" → "Active Acres Properties LLC"), after "From … Via" for
 * Wise-style lines, first part before ";" or "|".
 */
export function payerNameCore(raw: string | null | undefined): string {
  let s = String(raw ?? "")
  s = s.replace(/\bmerchant name:.*$/i, "")
  const fromVia = /\bfrom\s+(.+?)\s+via\b/i.exec(s)
  if (fromVia) s = fromVia[1]
  s = s.split(/[;|]/)[0]
  s = s.replace(/\s*[—–-]\s*(?:inv(?:oice)?\b|#).*$/i, "")
  return s.replace(/\s+/g, " ").trim()
}

/**
 * Invoice numbers written on the bank line, in every way a person writes them: the digits are kept and joined
 * with a dash and with a space ("INV 2026 001" → "INV-2026-001" and "INV 2026 001"; "inv001389" →
 * "INV-001389" and "INV 001389"), so a chat that wrote the other form is still found. Never more than 6.
 */
export function invoiceNumberVariants(text: string | null | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /\binv(?:oice)?[\s#:._-]*(\d{3,}(?:[\s._-]\d{1,})*)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(String(text ?? ""))) !== null) {
    const groups = m[1].split(/[\s._-]+/).filter(Boolean)
    for (const variant of [`INV-${groups.join("-")}`, `INV ${groups.join(" ")}`]) {
      const key = variant.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        out.push(variant)
      }
    }
    if (out.length >= MAX_TERMS) break
  }
  return out.slice(0, MAX_TERMS)
}

/** Strip what must not reach a search pattern: control characters and quotes; squeeze spaces. */
function cleanTerm(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f"'`]/g, " ").replace(/\s+/g, " ").trim()
}

/**
 * What the code searches the chats for: the payer's name (when it says something), the email the processor
 * put in the memo, and every invoice number written on the bank line. Never more than 6, no duplicates.
 */
export function chatSearchTerms(feed: { sender_name?: string | null; memo?: string | null; payer_name?: string | null }): string[] {
  const terms: string[] = []
  const add = (t: string) => {
    const clean = cleanTerm(t)
    if (clean.length >= 4 && !terms.some((x) => x.toLowerCase() === clean.toLowerCase())) terms.push(clean)
  }
  const core = payerNameCore(feed.payer_name || feed.sender_name)
  if (isUsablePayerName(normalizePayerName(core))) add(core)
  const email = parsePayerEmail(feed.memo)
  if (email) add(email)
  for (const v of invoiceNumberVariants(`${feed.sender_name ?? ""} ${feed.memo ?? ""}`)) add(v)
  return terms.slice(0, MAX_TERMS)
}

const DAY_MS = 86_400_000

/** `days` before and after a YYYY-MM-DD date; null when the date is missing or not a date. */
export function chatWindow(date: string | null | undefined, days: number): { from: string; to: string } | null {
  const text = String(date ?? "").slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const t = Date.parse(`${text}T00:00:00Z`)
  if (!Number.isFinite(t)) return null
  return { from: new Date(t - days * DAY_MS).toISOString().slice(0, 10), to: new Date(t + days * DAY_MS).toISOString().slice(0, 10) }
}

/** What goes on the payment: one line per place, counts only. */
export function summarizeChatSweep(sweep: ChatSweep): ChatStoreSummary[] {
  return sweep.stores.map((s) => ({
    store: s.store,
    label: s.label,
    searched: s.searched,
    count: s.hits.length,
    error: s.error,
  }))
}

/** Keep the first hit per id, newest first, capped. */
export function mergeHits(hits: readonly ChatHit[], cap = MAX_HITS_PER_STORE): ChatHit[] {
  const seen = new Set<string>()
  const unique: ChatHit[] = []
  for (const h of hits) {
    if (!h.id || seen.has(h.id)) continue
    seen.add(h.id)
    unique.push(h)
  }
  unique.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return unique.slice(0, cap)
}

// ───────────────────────────────────────────────────────────────────────────────────────
// Reading the database
// ───────────────────────────────────────────────────────────────────────────────────────

type Db = typeof supabaseAdmin
interface QueryResult { data: unknown; error: { message: string } | null }
type Query = PromiseLike<QueryResult>

const day = (value: unknown): string => String(value ?? "").slice(0, 10)
const startOf = (d: string) => `${d}T00:00:00Z`
const endOf = (d: string) => `${d}T23:59:59Z`
const likeAny = (term: string) => `%${escapeLikePattern(term)}%`
const rowsOf = (r: QueryResult): Array<Record<string, unknown>> => (Array.isArray(r.data) ? (r.data as Array<Record<string, unknown>>) : [])

/**
 * Run every query of ONE place. "Searched" means EVERY query worked: one that failed is named, and a place
 * where all of them failed has no hits to show. Rows are turned into hits by `toHit`.
 */
async function runStore(
  store: ChatStoreKey,
  queries: Array<{ how: ChatHit["how"]; run: () => Query }>,
  toHit: (row: Record<string, unknown>, how: ChatHit["how"]) => ChatHit | null,
): Promise<ChatStoreResult> {
  if (queries.length === 0) {
    return { store, label: CHAT_STORE_LABEL[store], searched: false, error: "nothing in this payment could be searched for here", hits: [] }
  }
  const settled = await Promise.all(
    queries.map(async (q) => {
      try {
        return { how: q.how, result: (await q.run()) as QueryResult }
      } catch (err) {
        return { how: q.how, result: { data: null, error: { message: err instanceof Error ? err.message : String(err) } } as QueryResult }
      }
    }),
  )
  const hits: ChatHit[] = []
  const errors: string[] = []
  for (const s of settled) {
    if (s.result.error) {
      errors.push(s.result.error.message)
      continue
    }
    for (const row of rowsOf(s.result)) {
      const hit = toHit(row, s.how)
      if (hit) hits.push(hit)
    }
  }
  const failed = errors.length
  return {
    store,
    label: CHAT_STORE_LABEL[store],
    searched: failed === 0,
    error: failed === 0 ? null : failed === queries.length ? cleanText(errors[0], 200) : `only ${queries.length - failed} of ${queries.length} searches worked (${cleanText(errors[0], 160)})`,
    hits: mergeHits(hits),
  }
}

interface SweepInput {
  facts: { transaction_date?: string | null; sender_name?: string | null; memo?: string | null; payer_name?: string | null }
  /** The person running the investigation — staff notes are filtered to what this person may see. */
  userId: string
  db?: Db
}

async function findClients(db: Db, core: string, email: string | null): Promise<{ clients: ChatClient[]; error: string | null }> {
  const clients: ChatClient[] = []
  const errors: string[] = []
  const usable = isUsablePayerName(normalizePayerName(core))
  const jobs: PromiseLike<unknown>[] = []
  if (usable) {
    jobs.push(
      db.from("accounts").select("id, company_name").ilike("company_name", likeAny(core)).limit(MAX_CLIENTS).then((r) => {
        if (r.error) errors.push(r.error.message)
        for (const a of r.data ?? []) clients.push({ kind: "account", id: a.id, name: String(a.company_name ?? "") })
      }),
      db.from("contacts").select("id, full_name").ilike("full_name", likeAny(core)).limit(MAX_CLIENTS).then((r) => {
        if (r.error) errors.push(r.error.message)
        for (const c of r.data ?? []) clients.push({ kind: "contact", id: c.id, name: String(c.full_name ?? "") })
      }),
    )
  }
  if (email) {
    jobs.push(
      db.from("contacts").select("id, full_name").ilike("email", escapeLikePattern(email)).limit(MAX_CLIENTS).then((r) => {
        if (r.error) errors.push(r.error.message)
        for (const c of r.data ?? []) clients.push({ kind: "contact", id: c.id, name: String(c.full_name ?? "") })
      }),
    )
  }
  await Promise.all(jobs)
  const seen = new Set<string>()
  const unique = clients.filter((c) => (seen.has(`${c.kind}:${c.id}`) ? false : (seen.add(`${c.kind}:${c.id}`), true))).slice(0, MAX_CLIENTS * 2)
  return { clients: unique, error: errors.length ? cleanText(errors[0], 200) : null }
}

/**
 * Search the five places. NEVER throws: a place that fails is reported as not searched, with the reason.
 */
export async function runChatSweep(input: SweepInput): Promise<ChatSweep> {
  const db = input.db ?? supabaseAdmin
  const facts = input.facts
  const terms = chatSearchTerms(facts)
  const core = payerNameCore(facts.payer_name || facts.sender_name)
  const email = parsePayerEmail(facts.memo)
  const clientWindow = chatWindow(facts.transaction_date, CLIENT_WINDOW_DAYS)
  const textWindow = chatWindow(facts.transaction_date, TEXT_WINDOW_DAYS)

  let clients: ChatClient[] = []
  let clientLookupError: string | null = null
  try {
    const found = await findClients(db, core, email)
    clients = found.clients
    clientLookupError = found.error
  } catch (err) {
    clientLookupError = cleanText(err instanceof Error ? err.message : String(err), 200)
  }
  const accountIds = clients.filter((c) => c.kind === "account").map((c) => c.id)
  const contactIds = clients.filter((c) => c.kind === "contact").map((c) => c.id)

  // ── portal chats ─────────────────────────────────────────────────────────────────────
  const portal = () => {
    const q: Array<{ how: ChatHit["how"]; run: () => Query }> = []
    const base = () => db.from("portal_messages").select("id, created_at, sender_type, sender_name, message").is("deleted_at", null)
    if (clientWindow) {
      if (accountIds.length) q.push({ how: "client", run: () => base().in("account_id", accountIds).gte("created_at", startOf(clientWindow.from)).lte("created_at", endOf(clientWindow.to)).order("created_at", { ascending: false }).limit(PER_QUERY_LIMIT * 2) })
      if (contactIds.length) q.push({ how: "client", run: () => base().in("contact_id", contactIds).gte("created_at", startOf(clientWindow.from)).lte("created_at", endOf(clientWindow.to)).order("created_at", { ascending: false }).limit(PER_QUERY_LIMIT * 2) })
    }
    for (const term of terms) {
      q.push({ how: "text", run: () => { let b = base().ilike("message", likeAny(term)); if (textWindow) b = b.gte("created_at", startOf(textWindow.from)).lte("created_at", endOf(textWindow.to)); return b.order("created_at", { ascending: false }).limit(PER_QUERY_LIMIT) } })
    }
    return runStore("portal_chat", q, (r, how) => {
      const text = cleanText(r.message, MAX_HIT_CHARS)
      if (!r.id || !text) return null
      return { store: "portal_chat", id: String(r.id), date: day(r.created_at), who: cleanText(r.sender_name || r.sender_type || "unknown", 60), text, how }
    })
  }

  // ── the CRM conversation log ─────────────────────────────────────────────────────────
  const log = () => {
    const q: Array<{ how: ChatHit["how"]; run: () => Query }> = []
    const base = () => db.from("conversations").select("id, date, channel, direction, client_message, internal_notes")
    if (clientWindow) {
      if (accountIds.length) q.push({ how: "client", run: () => base().in("account_id", accountIds).gte("date", clientWindow.from).lte("date", clientWindow.to).order("date", { ascending: false }).limit(PER_QUERY_LIMIT) })
      if (contactIds.length) q.push({ how: "client", run: () => base().in("contact_id", contactIds).gte("date", clientWindow.from).lte("date", clientWindow.to).order("date", { ascending: false }).limit(PER_QUERY_LIMIT) })
    }
    for (const term of terms) {
      for (const column of ["client_message", "internal_notes"] as const) {
        q.push({ how: "text", run: () => { let b = base().ilike(column, likeAny(term)); if (textWindow) b = b.gte("date", textWindow.from).lte("date", textWindow.to); return b.order("date", { ascending: false }).limit(PER_QUERY_LIMIT / 2) } })
      }
    }
    return runStore("conversation_log", q, (r, how) => {
      const text = cleanText([r.client_message, r.internal_notes].filter(Boolean).join(" | "), MAX_HIT_CHARS)
      if (!r.id || !text) return null
      return { store: "conversation_log", id: String(r.id), date: day(r.date), who: cleanText(`${r.channel ?? "conversation"}${r.direction ? ` (${r.direction})` : ""}`, 60), text, how }
    })
  }

  // ── WhatsApp / Telegram ──────────────────────────────────────────────────────────────
  const whatsapp = () => {
    const q: Array<{ how: ChatHit["how"]; run: () => Query }> = []
    const base = () => db.from("messages").select("id, created_at, direction, sender_name, content_text").is("deleted_at", null)
    if (clientWindow) {
      if (accountIds.length) q.push({ how: "client", run: () => base().in("account_id", accountIds).gte("created_at", startOf(clientWindow.from)).lte("created_at", endOf(clientWindow.to)).order("created_at", { ascending: false }).limit(PER_QUERY_LIMIT * 2) })
      if (contactIds.length) q.push({ how: "client", run: () => base().in("contact_id", contactIds).gte("created_at", startOf(clientWindow.from)).lte("created_at", endOf(clientWindow.to)).order("created_at", { ascending: false }).limit(PER_QUERY_LIMIT * 2) })
    }
    for (const term of terms) {
      q.push({ how: "text", run: () => { let b = base().ilike("content_text", likeAny(term)); if (textWindow) b = b.gte("created_at", startOf(textWindow.from)).lte("created_at", endOf(textWindow.to)); return b.order("created_at", { ascending: false }).limit(PER_QUERY_LIMIT) } })
    }
    return runStore("whatsapp_telegram", q, (r, how) => {
      const text = cleanText(r.content_text, MAX_HIT_CHARS)
      if (!r.id || !text) return null
      return { store: "whatsapp_telegram", id: String(r.id), date: day(r.created_at), who: cleanText(r.sender_name || r.direction || "unknown", 60), text, how }
    })
  }

  // ── team chat: channels and discussions only — direct messages and groups are private ─
  const team = () => {
    const q: Array<{ how: ChatHit["how"]; run: () => Query }> = []
    const base = () =>
      db.from("internal_messages")
        .select("id, created_at, sender_name, message, internal_threads!inner(thread_type, account_id)")
        .is("deleted_at", null)
        .in("internal_threads.thread_type", [...TEAM_CHAT_OPEN_THREAD_TYPES])
    if (clientWindow && accountIds.length) {
      q.push({ how: "client", run: () => base().in("internal_threads.account_id", accountIds).gte("created_at", startOf(clientWindow.from)).lte("created_at", endOf(clientWindow.to)).order("created_at", { ascending: false }).limit(PER_QUERY_LIMIT) })
    }
    for (const term of terms) {
      q.push({ how: "text", run: () => { let b = base().ilike("message", likeAny(term)); if (textWindow) b = b.gte("created_at", startOf(textWindow.from)).lte("created_at", endOf(textWindow.to)); return b.order("created_at", { ascending: false }).limit(PER_QUERY_LIMIT / 2) } })
    }
    return runStore("team_chat", q, (r, how) => {
      const text = cleanText(r.message, MAX_HIT_CHARS)
      if (!r.id || !text) return null
      return { store: "team_chat", id: String(r.id), date: day(r.created_at), who: cleanText(r.sender_name || "staff", 60), text, how }
    })
  }

  // ── staff notes: only what the person running this could open themselves ─────────────
  const notes = () => {
    const q: Array<{ how: ChatHit["how"]; run: () => Query }> = []
    const base = () => db.from("staff_notes").select("id, created_at, author_name, title, body").or(visibleToOrClause(input.userId))
    if (accountIds.length) q.push({ how: "client", run: () => base().in("account_id", accountIds).order("created_at", { ascending: false }).limit(PER_QUERY_LIMIT / 2) })
    if (contactIds.length) q.push({ how: "client", run: () => base().in("contact_id", contactIds).order("created_at", { ascending: false }).limit(PER_QUERY_LIMIT / 2) })
    for (const term of terms) {
      q.push({ how: "text", run: () => base().ilike("body", likeAny(term)).order("created_at", { ascending: false }).limit(PER_QUERY_LIMIT / 2) })
    }
    return runStore("staff_notes", q, (r, how) => {
      const text = cleanText([r.title, r.body].filter(Boolean).join(" — "), MAX_HIT_CHARS)
      if (!r.id || !text) return null
      return { store: "staff_notes", id: String(r.id), date: day(r.created_at), who: cleanText(r.author_name || "staff", 60), text, how }
    })
  }

  const stores = await Promise.all([portal(), log(), whatsapp(), team(), notes()])
  return { terms, clients, clientLookupError, window: clientWindow, stores }
}
