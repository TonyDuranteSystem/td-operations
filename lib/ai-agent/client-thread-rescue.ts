/**
 * Copy every open client conversation OUT of Slack and into our own database.
 *
 * WHY THIS EXISTS (Antonio, 2026-07-30: "we have to use team chat, not Slack"):
 * a client conversation sourced from Slack keeps NO copy here. The page fetches its
 * messages live on every open, and closing one freezes a snapshot — so the content of
 * an OPEN conversation exists only inside Slack. Verified on production the same day:
 * 116 open Slack-sourced rows, every one of them with an empty transcript. Switching
 * the Slack app off before this runs destroys all 116 permanently.
 *
 * So this is a RESCUE, deliberately separate from the move into Team Chat: it is
 * read-only towards Slack, writes only into a column the read path already
 * understands, and is idempotent. It buys the time to do the migration carefully.
 *
 * NOT `fetchSlackThreadMessages` (slack-claude.ts): that helper returns [] on a
 * missing token, an API error and an empty thread alike. For a migration those must
 * never look the same — "Slack said no" would be written down as "this conversation
 * was empty", which is silent data loss wearing a success message. Every failure mode
 * here is named and reported, and a row is written ONLY on a confirmed fetch.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

/** One archived message, in the shape the conversations page already renders. */
export interface ArchivedMessage {
  author: string
  text: string
  ts: string
}

/**
 * ONE shape, not a discriminated union: this project compiles with `strict` off, and
 * without strictNullChecks TypeScript will not narrow a union on its `ok` flag — the
 * failure branch would silently read as the success branch at the call site.
 * `messages` is meaningful only when `ok`; `reason` only when not.
 */
export interface FetchOutcome {
  ok: boolean
  messages: ArchivedMessage[]
  reason?: string
}

export interface RescueRow {
  id: string
  source_ref: string | null
}

export interface RescueReport {
  considered: number
  archived: number
  /** Fetched cleanly but the Slack thread genuinely had nothing in it. */
  empty: number
  skipped: number
  failed: Array<{ id: string; reason: string }>
  dryRun: boolean
}

/** `C123ABC:1712345678.9012` → the pair, or null if it isn't a usable pointer. */
export function parseSourceRef(ref: string | null | undefined): { channelId: string; threadTs: string } | null {
  if (typeof ref !== "string" || !ref.includes(":")) return null
  const [channelId, threadTs] = ref.split(":")
  if (!channelId || !threadTs) return null
  return { channelId, threadTs }
}

/**
 * Slack's own display names, resolved once per run.
 *
 * The live path hardcodes three user ids and calls everyone else "Team". That is
 * tolerable for a panel you can re-read at any time; in a permanent archive it would
 * flatten real people into an anonymous label for ever. Names are looked up and
 * cached, and only fall back to "Team" when Slack itself cannot say who someone was.
 */
export function makeAuthorResolver(
  token: string,
  fetchImpl: typeof fetch = fetch,
): (m: Record<string, unknown>) => Promise<string> {
  const cache = new Map<string, string>()
  return async (m) => {
    const bot = m.bot_profile as { name?: string } | undefined
    if (bot?.name) return bot.name
    const userId = typeof m.user === "string" ? m.user : ""
    if (!userId) return "Team"
    const hit = cache.get(userId)
    if (hit) return hit
    let name = "Team"
    try {
      const res = await fetchImpl(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await res.json()) as {
        ok?: boolean
        user?: { real_name?: string; profile?: { real_name?: string; display_name?: string } }
      }
      if (data.ok) {
        name =
          data.user?.profile?.real_name ||
          data.user?.real_name ||
          data.user?.profile?.display_name ||
          "Team"
      }
    } catch {
      // Leave the fallback — a name we could not resolve must not fail the rescue.
    }
    cache.set(userId, name)
    return name
  }
}

/**
 * Read one Slack thread, in full.
 *
 * Paginated: `conversations.replies` caps a page at 100 (the live path asks for 100
 * and takes whatever comes back, so a long conversation is silently truncated there).
 * An archive that quietly drops the tail of a thread is worse than no archive, because
 * nobody can tell it happened.
 */
export async function fetchThreadForArchive(
  channelId: string,
  threadTs: string,
  token: string,
  resolveAuthor: (m: Record<string, unknown>) => Promise<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchOutcome> {
  const out: ArchivedMessage[] = []
  let cursor: string | undefined
  // Bounded so a malformed cursor can never spin: 20 pages = 2,000 messages, far
  // beyond any real client conversation.
  for (let page = 0; page < 20; page++) {
    let data: {
      ok?: boolean
      error?: string
      messages?: Array<Record<string, unknown>>
      response_metadata?: { next_cursor?: string }
    }
    try {
      const url = new URL("https://slack.com/api/conversations.replies")
      url.searchParams.set("channel", channelId)
      url.searchParams.set("ts", threadTs)
      url.searchParams.set("limit", "100")
      if (cursor) url.searchParams.set("cursor", cursor)
      const res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
      data = (await res.json()) as typeof data
    } catch (err) {
      return { ok: false, messages: [], reason: `network: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (!data.ok) return { ok: false, messages: [], reason: `slack: ${data.error ?? "unknown error"}` }
    for (const m of data.messages ?? []) {
      out.push({
        author: await resolveAuthor(m),
        text: typeof m.text === "string" ? m.text : "",
        ts: typeof m.ts === "string" ? m.ts : "",
      })
    }
    cursor = data.response_metadata?.next_cursor || undefined
    if (!cursor) return { ok: true, messages: out }
  }
  return { ok: true, messages: out }
}

/**
 * Archive every open Slack-sourced client conversation that has no copy yet.
 *
 * Idempotent: a row that already carries an archive is skipped, so a re-run after a
 * partial failure only picks up what is still missing. A row whose fetch failed is
 * left UNTOUCHED and named in the report — never written as empty.
 */
export async function rescueClientThreads(opts: {
  dryRun: boolean
  limit?: number
  token?: string
  fetchImpl?: typeof fetch
}): Promise<RescueReport> {
  const token = opts.token ?? process.env.SLACK_BOT_TOKEN_CLAUDE ?? ""
  const report: RescueReport = { considered: 0, archived: 0, empty: 0, skipped: 0, failed: [], dryRun: opts.dryRun }
  if (!token) {
    report.failed.push({ id: "*", reason: "no Slack token configured — nothing was read or written" })
    return report
  }
  const fetchImpl = opts.fetchImpl ?? fetch
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  const { data: rows, error } = await db
    .from("client_threads")
    .select("id, source_ref, transcript")
    .eq("source", "slack")
    // NOT filtered to open. Closing a conversation used to evict it from this job for
    // ever: a staff member clicks Close on the Conversations page (one click, no
    // confirmation), the row leaves this query, and once Slack is switched off its
    // content is gone with no way to ask for it again. Status is a workflow state,
    // not a statement about whether we hold a copy — rows that already have one are
    // skipped below either way.
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 500)
  if (error) {
    report.failed.push({ id: "*", reason: `could not list conversations: ${error.message}` })
    return report
  }

  const resolveAuthor = makeAuthorResolver(token, fetchImpl)

  for (const row of (rows ?? []) as Array<RescueRow & { transcript: unknown }>) {
    report.considered++
    if (Array.isArray(row.transcript) && row.transcript.length > 0) {
      report.skipped++
      continue
    }
    const ref = parseSourceRef(row.source_ref)
    if (!ref) {
      report.failed.push({ id: row.id, reason: "no usable Slack pointer on the record" })
      continue
    }
    const result = await fetchThreadForArchive(ref.channelId, ref.threadTs, token, resolveAuthor, fetchImpl)
    if (!result.ok) {
      report.failed.push({ id: row.id, reason: result.reason ?? "unknown error" })
      continue
    }
    if (result.messages.length === 0) {
      // A confirmed-empty thread is not a failure, but it is not an archive either —
      // writing [] would mark it "rescued" and hide it from a later retry.
      report.empty++
      continue
    }
    if (opts.dryRun) {
      report.archived++
      continue
    }
    const { error: writeErr } = await db
      .from("client_threads")
      .update({ transcript: result.messages, updated_at: new Date().toISOString() })
      .eq("id", row.id)
    if (writeErr) {
      report.failed.push({ id: row.id, reason: `write failed: ${writeErr.message}` })
      continue
    }
    report.archived++
  }
  return report
}
