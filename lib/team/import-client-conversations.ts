/**
 * Bring the client conversations that live in Slack into Team Chat as real threads.
 *
 * Antonio, 2026-07-31: "can you import all Slack conversations and match them in Team
 * Chat where you can see the conversation with the client already exists with the
 * history that we have on Slack… as today Slack works." Scoped by him to the 116 open
 * Slack-sourced ones, and to the CONVERSATION only — "I don't need an attachment. I
 * need the conversation."
 *
 * The shapes already line up, which is why this is an import and not a redesign: a
 * Team Chat discussion thread carries the same client link (account / contact / lead)
 * and the same topic a client conversation does — 103 discussions already exist, 87
 * with an account and 74 with a topic. An imported conversation is therefore
 * indistinguishable from one started here.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 *   - Files. Slack holds them and a link to them dies with the workspace; Antonio
 *     ruled them out of scope. Message TEXT carries whatever was typed.
 *   - Reactions, edits, threading of replies. A client conversation is read as a
 *     sequence; recreating Slack's structure would invent information.
 *   - Touch Slack. Every Slack call here is a read.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { listTeamMembers } from "@/lib/team/directory"
import {
  fetchThreadForArchive,
  makeAuthorResolver,
  parseSourceRef,
  type ArchivedMessage,
} from "@/lib/ai-agent/client-thread-rescue"

/**
 * The author of an imported line, as far as the database is concerned.
 *
 * Stable and non-random so imported rows are identifiable for ever (and a re-run can
 * never be mistaken for a person posting). `sender_name` carries the REAL author, so
 * the conversation still reads as itself. There is no foreign key on the sender, which
 * is what makes a non-user author possible at all — checked, not assumed.
 */
export const IMPORTED_SENDER_UUID = "00000000-0000-4000-8000-00005141c000"
export const IMPORTED_SENDER_NAME = "Imported"

export interface ImportReport {
  considered: number
  imported: number
  messages: number
  /** Already had a Team Chat thread — a re-run leaves it alone. */
  skipped: number
  /** Nothing to import: no archive here and Slack returned an empty thread. */
  empty: number
  failed: Array<{ id: string; reason: string }>
  dryRun: boolean
}

interface ThreadRow {
  id: string
  account_id: string | null
  contact_id: string | null
  lead_id: string | null
  topic_slug: string | null
  source_ref: string | null
  thread_id: string | null
  transcript: unknown
  summary: string | null
  created_at: string
}

/** A readable title for the Team Chat thread: the client, then what it is about. */
export function buildThreadTitle(clientName: string | null, topicSlug: string | null): string {
  const topic = (topicSlug ?? "general").replace(/[-_]/g, " ")
  const name = clientName?.trim()
  return name ? `${name} — ${topic}` : `Client conversation — ${topic}`
}

/** The client's own name, for the thread title. Never fails the import. */
async function resolveClientName(row: ThreadRow): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  try {
    if (row.account_id) {
      const { data } = await db.from("accounts").select("company_name").eq("id", row.account_id).maybeSingle()
      return data?.company_name ?? null
    }
    if (row.contact_id) {
      const { data } = await db.from("contacts").select("full_name").eq("id", row.contact_id).maybeSingle()
      return data?.full_name ?? null
    }
    if (row.lead_id) {
      const { data } = await db.from("leads").select("full_name").eq("id", row.lead_id).maybeSingle()
      return data?.full_name ?? null
    }
  } catch {
    // A missing name is cosmetic — it must not cost us the conversation.
  }
  return null
}

/**
 * Slack stamps a message with epoch seconds ("1712345678.9012"). Team Chat orders by
 * a timestamp, so the original times have to survive or the imported conversation
 * arrives in one indistinguishable clump at import time.
 */
/** The later of two timestamps, either of which may be unparseable. */
export function maxIso(a: string, b: string): string {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (!Number.isFinite(ta)) return b
  if (!Number.isFinite(tb)) return a
  return ta >= tb ? a : b
}

export function slackTsToIso(ts: string, fallbackIso: string): string {
  const seconds = Number.parseFloat(ts)
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackIso
  return new Date(seconds * 1000).toISOString()
}

/**
 * Import one conversation. Returns the number of messages written, or throws with a
 * reason the caller reports.
 *
 * ORDER MATTERS: the thread and its messages are written BEFORE the conversation
 * record is pointed at them. The reverse order can leave a record claiming a thread
 * that has no messages in it, which reads to a human as "the history was lost".
 */
async function importOne(row: ThreadRow, messages: ArchivedMessage[], dryRun: boolean): Promise<number> {
  if (dryRun) return messages.length
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const clientName = await resolveClientName(row)

  const { data: thread, error: threadErr } = await db
    .from("internal_threads")
    .insert({
      thread_type: "discussion",
      // REQUIRED — the column is NOT NULL, which only surfaced running this against a
      // real database (the unit tests' fake table has no constraints). The same fixed
      // "Imported" identity as the messages: nobody here created this conversation,
      // and attributing it to a person would be a small lie that outlives the import.
      created_by: IMPORTED_SENDER_UUID,
      title: buildThreadTitle(clientName, row.topic_slug),
      account_id: row.account_id,
      contact_id: row.contact_id,
      lead_id: row.lead_id,
      topic_slug: row.topic_slug,
      topic: row.topic_slug,
      description: row.summary,
      created_at: row.created_at,
      // The later of "when it was last spoken in" and "when it began" — a thread whose
      // activity stamp predates its own creation sorts to the bottom of the list and
      // reads as dead. Slack timestamps and the record's date come from different
      // clocks, so this cannot be assumed to be in order.
      last_activity_at: maxIso(
        slackTsToIso(messages[messages.length - 1]?.ts ?? "", row.created_at),
        row.created_at,
      ),
    })
    .select("id")
    .single()
  if (threadErr || !thread) throw new Error(`could not create the Team Chat thread: ${threadErr?.message ?? "no row"}`)

  const rows = messages.map((m) => ({
    thread_id: thread.id,
    sender_id: IMPORTED_SENDER_UUID,
    sender_name: m.author || IMPORTED_SENDER_NAME,
    message: m.text,
    created_at: slackTsToIso(m.ts, row.created_at),
    // Imported history is history: it must not arrive as unread work for anyone.
    read_at: new Date().toISOString(),
  }))
  const { error: msgErr } = await db.from("internal_messages").insert(rows)
  if (msgErr) throw new Error(`could not write the messages: ${msgErr.message}`)

  // MAKE THE STAFF PARTICIPANTS, WITH THE HISTORY ALREADY READ.
  //
  // Two things depend on this one row per person, and they pull in opposite
  // directions. A client discussion only notifies its PARTICIPANTS, and being a
  // participant here means nothing more than having a read row — without one, an
  // imported conversation would be silent for ever, which is worse than not
  // importing it. But seeding at the epoch (what a newly created conversation does)
  // would dump every imported message back as unread: 116 conversations arriving as
  // 116 badges on a Monday morning.
  //
  // Seeding at NOW does both: the imported history counts as read, and anything said
  // from here on notifies normally. `ignoreDuplicates` so a teammate who already has
  // a pointer on some thread can never be clobbered backwards.
  try {
    const others = (await listTeamMembers()).map((m) => m.id).filter(Boolean)
    if (others.length > 0) {
      const now = new Date().toISOString()
      await db.from("internal_thread_reads").upsert(
        others.map((uid: string) => ({
          thread_id: thread.id,
          user_id: uid,
          last_read_at: now,
          updated_at: now,
        })),
        { onConflict: "thread_id,user_id", ignoreDuplicates: true },
      )
    }
  } catch (err) {
    // The conversation and its history are already safely in. A missing read pointer
    // costs a stray unread badge, never the import.
    console.warn("[import-client-conversations] could not seed read pointers:", err)
  }

  const { error: linkErr } = await db
    .from("client_threads")
    .update({ thread_id: thread.id, transcript: messages, updated_at: new Date().toISOString() })
    .eq("id", row.id)
  if (linkErr) throw new Error(`messages imported but the record could not be linked: ${linkErr.message}`)

  return rows.length
}

/**
 * Import every open Slack-sourced client conversation that is not in Team Chat yet.
 *
 * Uses the stored archive when there is one and reads Slack only when there is not —
 * so this works before OR after the rescue job, and needs Slack only for what has
 * never been copied. Idempotent: a conversation already pointing at a Team Chat
 * thread is skipped, so a re-run after a partial failure fills only the gaps.
 */
export async function importClientConversations(opts: {
  dryRun: boolean
  limit?: number
  token?: string
  fetchImpl?: typeof fetch
}): Promise<ImportReport> {
  const report: ImportReport = { considered: 0, imported: 0, messages: 0, skipped: 0, empty: 0, failed: [], dryRun: opts.dryRun }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  const { data: rows, error } = await db
    .from("client_threads")
    .select("id, account_id, contact_id, lead_id, topic_slug, source_ref, thread_id, transcript, summary, created_at")
    .eq("source", "slack")
    .eq("status", "open")
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 500)
  if (error) {
    report.failed.push({ id: "*", reason: `could not list conversations: ${error.message}` })
    return report
  }

  const token = opts.token ?? process.env.SLACK_BOT_TOKEN_CLAUDE ?? ""
  const fetchImpl = opts.fetchImpl ?? fetch
  const resolveAuthor = makeAuthorResolver(token, fetchImpl)

  for (const row of (rows ?? []) as ThreadRow[]) {
    report.considered++
    if (row.thread_id) {
      report.skipped++
      continue
    }

    let messages: ArchivedMessage[] = []
    if (Array.isArray(row.transcript) && row.transcript.length > 0) {
      messages = row.transcript as ArchivedMessage[]
    } else {
      const ref = parseSourceRef(row.source_ref)
      if (!ref) {
        report.failed.push({ id: row.id, reason: "no stored copy and no usable Slack pointer" })
        continue
      }
      if (!token) {
        report.failed.push({ id: row.id, reason: "no stored copy, and no Slack token to read it with" })
        continue
      }
      const fetched = await fetchThreadForArchive(ref.channelId, ref.threadTs, token, resolveAuthor, fetchImpl)
      if (!fetched.ok) {
        // NEVER create an empty thread off a failed read — an empty conversation in
        // Team Chat looks like the history was lost, and the record would then be
        // marked done and skipped for ever.
        report.failed.push({ id: row.id, reason: fetched.reason ?? "unknown error" })
        continue
      }
      messages = fetched.messages
    }

    if (messages.length === 0) {
      report.empty++
      continue
    }

    try {
      const written = await importOne(row, messages, opts.dryRun)
      report.imported++
      report.messages += written
    } catch (err) {
      report.failed.push({ id: row.id, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return report
}
