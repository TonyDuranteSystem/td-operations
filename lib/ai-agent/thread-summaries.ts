/**
 * Hermes ↔ Claude bridge — Phase C: thread summaries (durable thread memory).
 *
 * dev_task: 1a0d1354 (Hermes operating agent) — Phase C (intelligence)
 *
 * A "thread" ties a chain of agent_messages (+ any approval_queue rows) together
 * under one thread_id. thread_summaries is the durable, searchable record of that
 * thread: its type, title, outcome, what it changed, and a one-paragraph summary.
 * It is the bridge's long-term memory — it lets Hermes reference a past
 * investigation ("remember the tax-return mismatch thread?") instead of re-deriving.
 *
 * Schema (Phase A migration 20260604-2200-phase-a-core.sql, verified live):
 *   thread_id (PK, uuid), thread_type (NOT NULL text), created_at, resolved_at,
 *   title, outcome, files_changed[], tasks_created[], accounts_affected[],
 *   summary_text, tags[], prompt_version.  NOTE: there is NO updated_at column.
 *
 * Posture: RLS-enabled, no policies → service-role-only (supabaseAdmin).
 *
 * The free-text search is done with a PURE filter (filterThreadSummaries) over
 * rows fetched with cheap structured filters — robust against PostgREST array/or
 * fragility and trivially unit-testable. The table is one row per resolved thread,
 * so the fetch-then-filter cost is negligible for the foreseeable future.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { normalizeThreadType, type ThreadType } from "./thread-routing"

export interface ThreadSummary {
  thread_id: string
  thread_type: string
  created_at: string | null
  resolved_at: string | null
  title: string | null
  outcome: string | null
  files_changed: string[] | null
  tasks_created: string[] | null
  accounts_affected: string[] | null
  summary_text: string | null
  tags: string[] | null
  prompt_version: string | null
}

const SELECT_COLS =
  "thread_id, thread_type, created_at, resolved_at, title, outcome, files_changed, tasks_created, accounts_affected, summary_text, tags, prompt_version"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

/**
 * Create a thread_summaries row (idempotent). thread_id is the PK, so a repeat
 * call for the same thread returns the EXISTING row rather than erroring — the
 * worker calls this at the start of every threaded turn and we never want a
 * duplicate-key failure to break processing.
 *
 * thread_type is NOT NULL; an unknown/absent type is coerced to the default
 * ('investigation') so the column constraint is always satisfied.
 *
 * accountsAffected (WP2) — optional uuid[] of entities this thread concerns. The
 * thread_create MCP tool passes account_id and/or contact_id here when Hermes
 * starts a thread about a specific client (accounts_affected is the only
 * affected-entities array on the table — there is no separate contacts column).
 * Empty/absent → NULL. callWorker creates threads WITHOUT this arg, so an
 * existing thread_create-seeded row keeps its accounts_affected (PK-idempotent
 * insert returns the existing row rather than overwriting).
 */
export async function createThreadSummary(
  threadId: string,
  type: unknown,
  title?: string | null,
  promptVersion?: string | null,
  accountsAffected?: string[] | null,
): Promise<ThreadSummary | null> {
  if (!threadId || typeof threadId !== "string") return null
  const threadType: ThreadType = normalizeThreadType(type)

  const cleanedAccounts = Array.isArray(accountsAffected)
    ? accountsAffected.filter((x): x is string => typeof x === "string" && x.length > 0)
    : []

  const { data, error } = await db()
    .from("thread_summaries")
    .insert({
      thread_id: threadId,
      thread_type: threadType,
      title: typeof title === "string" && title.length > 0 ? title.slice(0, 300) : null,
      // Fingerprint of the worker's base system prompt at thread creation (Phase D)
      // so the instructions can be reconstructed later. NULL when not supplied.
      prompt_version: typeof promptVersion === "string" && promptVersion.length > 0 ? promptVersion : null,
      // WP2: entities this thread concerns (account_id / contact_id from thread_create).
      accounts_affected: cleanedAccounts.length > 0 ? cleanedAccounts : null,
    })
    .select(SELECT_COLS)
    .single()

  if (error) {
    // 23505 = unique_violation — the thread already exists. Return the existing row.
    if (error.code === "23505") {
      return getThreadSummary(threadId)
    }
    throw new Error(`createThreadSummary failed: ${error.message ?? "unknown error"}`)
  }
  return (data as ThreadSummary | null) ?? null
}

/**
 * Resolve a thread: stamp resolved_at, record the outcome and the one-paragraph
 * summary. UPDATE-only — the row must already exist (callWorker creates it first).
 * Returns the updated row, or null if no such (unresolved) thread row exists.
 *
 * There is NO updated_at column on thread_summaries — do not set it.
 */
export async function resolveThread(
  threadId: string,
  outcome: string | null,
  summaryText: string | null,
): Promise<ThreadSummary | null> {
  if (!threadId || typeof threadId !== "string") return null

  const { data, error } = await db()
    .from("thread_summaries")
    .update({
      resolved_at: new Date().toISOString(),
      outcome: typeof outcome === "string" && outcome.length > 0 ? outcome.slice(0, 300) : null,
      summary_text: typeof summaryText === "string" ? summaryText : null,
    })
    .eq("thread_id", threadId)
    .select(SELECT_COLS)
    .maybeSingle()

  if (error) throw new Error(`resolveThread failed: ${error.message ?? "unknown error"}`)
  return (data as ThreadSummary | null) ?? null
}

/** Read a single thread summary by id, or null if absent. */
export async function getThreadSummary(threadId: string): Promise<ThreadSummary | null> {
  if (!threadId || typeof threadId !== "string") return null
  const { data, error } = await db()
    .from("thread_summaries")
    .select(SELECT_COLS)
    .eq("thread_id", threadId)
    .maybeSingle()
  if (error) throw new Error(`getThreadSummary failed: ${error.message ?? "unknown error"}`)
  return (data as ThreadSummary | null) ?? null
}

export interface SearchThreadsOptions {
  /** Restrict to one thread_type. */
  type?: string
  /** Require ALL of these tags to be present on the row. */
  tags?: string[]
  /** Max rows to return after filtering (default 20). */
  limit?: number
  /** Candidate pool fetched before free-text filtering (default 500). */
  scanLimit?: number
}

/**
 * Pure free-text matcher: does this thread row match the query across its
 * title, thread_type, tags, accounts_affected (and, as a bonus, outcome +
 * summary_text)? Case-insensitive substring / exact-id match. Exported for tests.
 *
 * An empty/whitespace query matches everything (so searchThreads with no query
 * lists recent threads).
 */
export function threadMatchesQuery(row: ThreadSummary, query: string): boolean {
  const q = (query ?? "").trim().toLowerCase()
  if (!q) return true
  const haystacks: string[] = []
  if (row.title) haystacks.push(row.title.toLowerCase())
  if (row.thread_type) haystacks.push(row.thread_type.toLowerCase())
  if (row.outcome) haystacks.push(row.outcome.toLowerCase())
  if (row.summary_text) haystacks.push(row.summary_text.toLowerCase())
  for (const t of row.tags ?? []) haystacks.push(String(t).toLowerCase())
  for (const a of row.accounts_affected ?? []) haystacks.push(String(a).toLowerCase())
  return haystacks.some((h) => h.includes(q))
}

/**
 * Pure filter: apply the optional structured filters (type, tags) AND the
 * free-text query to an in-memory row set, newest-first, capped at limit.
 * Exported for tests. (searchThreads applies type/tags at the DB for cheapness,
 * but this re-applies them so the helper is correct on any input.)
 */
export function filterThreadSummaries(
  rows: ThreadSummary[],
  query: string,
  opts: SearchThreadsOptions = {},
): ThreadSummary[] {
  const limit = opts.limit ?? 20
  const wantTags = (opts.tags ?? []).map((t) => String(t).toLowerCase())
  return rows
    .filter((r) => (opts.type ? r.thread_type === opts.type : true))
    .filter((r) => {
      if (wantTags.length === 0) return true
      const have = new Set((r.tags ?? []).map((t) => String(t).toLowerCase()))
      return wantTags.every((t) => have.has(t))
    })
    .filter((r) => threadMatchesQuery(r, query))
    .sort((a, b) => (String(a.created_at) < String(b.created_at) ? 1 : -1))
    .slice(0, limit)
}

/**
 * Search thread summaries by free-text query, with optional type / tags filters.
 * Lets Hermes reference past investigations.
 *
 * Strategy: push the cheap, index-friendly filters (type, tags) to Postgres, pull
 * a bounded candidate pool newest-first, then apply the free-text match + final
 * limit in JS (filterThreadSummaries). scanLimit bounds the pool — if it's hit
 * the result is best-effort over the most-recent threads (returned in `truncated`).
 */
export async function searchThreads(
  query: string,
  opts: SearchThreadsOptions = {},
): Promise<{ rows: ThreadSummary[]; scanned: number; truncated: boolean }> {
  const scanLimit = opts.scanLimit ?? 500

  let builder = db()
    .from("thread_summaries")
    .select(SELECT_COLS)
    .order("created_at", { ascending: false })
    .limit(scanLimit)

  if (opts.type) builder = builder.eq("thread_type", opts.type)
  if (opts.tags && opts.tags.length > 0) builder = builder.contains("tags", opts.tags)

  const { data, error } = await builder
  if (error) throw new Error(`searchThreads failed: ${error.message ?? "unknown error"}`)

  const candidates = (data ?? []) as ThreadSummary[]
  const rows = filterThreadSummaries(candidates, query, { ...opts, type: undefined, tags: undefined })
  return { rows, scanned: candidates.length, truncated: candidates.length >= scanLimit }
}
