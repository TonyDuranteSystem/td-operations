/**
 * Persistent worker memory — Phase 2: semantic cross-thread recall ("connect the dots").
 *
 * Phase 1 (recall_thread / buildThreadContext) gives the worker THIS conversation's own
 * history. This module is the cross-CONVERSATION half: when a new message arrives, find
 * RELATED PAST threads (weeks/months old, different conversations) by semantic similarity
 * of their durable summaries, and surface them so the worker connects the dots instead of
 * treating every thread as brand new.
 *
 * Built on the SAME proven engine as decision-memory (OpenAI text-embedding-3-small +
 * pgvector cosine). `thread_summaries.embedding` + the `match_thread_summaries` RPC are
 * added by scripts/migrations/20260623-1900-thread-summaries-embedding.sql.
 *
 * Everything here is BEST-EFFORT: a missing OPENAI_API_KEY, an un-applied migration, or any
 * network/db error degrades to "no recall" (empty string / silent skip) and NEVER fails the
 * worker's reply. Gated to the Slack worker only (callWorker, enableThreadRecall) — the
 * Hermes/Telegram research worker never triggers it (R108).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { generateEmbedding } from "./decision-memory"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

/** Default similarity floor + result cap for related-thread recall (tunable via env). */
export const RELATED_THREADS_THRESHOLD = Number(process.env.THREAD_RECALL_THRESHOLD) || 0.72
export const RELATED_THREADS_COUNT = Number(process.env.THREAD_RECALL_COUNT) || 4
/** Max chars of a recalled summary rendered into the prompt block. */
const RELATED_SUMMARY_MAX = 280

/**
 * Master kill-switch for the Phase 2 SEMANTIC layer (embedding-on-resolve +
 * related-thread recall). OFF by default so the code can ship to production DARK
 * before its DB migration (`thread_summaries.embedding` + `match_thread_summaries`)
 * is applied sandbox-first and backfilled — flipping it ON before the migration
 * exists would just waste an embedding call + fail a DB call on every worker turn.
 * Phase 1 (`recall_thread`) needs NO DB change and is always on, independent of this.
 * Activate by setting THREAD_RECALL_SEMANTIC_ENABLED=true once the migration + backfill
 * are done. Read per-call (not module-load) so a Vercel env flip needs no redeploy.
 */
export function semanticRecallEnabled(): boolean {
  return process.env.THREAD_RECALL_SEMANTIC_ENABLED === "true"
}

export interface RelatedThreadMatch {
  thread_id: string
  thread_type: string | null
  title: string | null
  outcome: string | null
  summary_text: string | null
  tags: string[] | null
  created_at: string | null
  similarity: number
}

/**
 * Compose the text we embed to REPRESENT a thread for recall. Richer than the bare
 * last-reply summary: title + outcome + tags + the one-paragraph summary. Pure +
 * exported for tests. Returns "" when there's nothing meaningful to embed.
 */
export function composeThreadEmbeddingText(row: {
  title?: string | null
  outcome?: string | null
  summary_text?: string | null
  tags?: string[] | null
}): string {
  const parts: string[] = []
  if (row.title) parts.push(String(row.title))
  if (Array.isArray(row.tags) && row.tags.length > 0) parts.push(`Topics: ${row.tags.join(", ")}`)
  if (row.outcome) parts.push(`Outcome: ${row.outcome}`)
  if (row.summary_text) parts.push(String(row.summary_text))
  return parts.join("\n").trim()
}

/**
 * Embed a thread's current summary into thread_summaries.embedding so future
 * conversations can recall it. Best-effort: returns false (logged) on any failure
 * — missing key, un-applied migration, empty summary — and never throws.
 */
export async function embedThreadSummary(threadId: string): Promise<boolean> {
  if (!threadId || !semanticRecallEnabled()) return false
  try {
    const { data, error } = await db()
      .from("thread_summaries")
      .select("title, outcome, summary_text, tags")
      .eq("thread_id", threadId)
      .maybeSingle()
    if (error || !data) return false
    const text = composeThreadEmbeddingText(data)
    if (!text) return false // nothing to represent yet
    const embedding = await generateEmbedding(text)
    const { error: upErr } = await db()
      .from("thread_summaries")
      .update({ embedding: embedding as unknown as string })
      .eq("thread_id", threadId)
    if (upErr) return false
    return true
  } catch (err) {
    console.warn("[thread-recall] embedThreadSummary failed (non-fatal):", err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Find resolved threads semantically related to `query`, excluding the current
 * thread. Best-effort: returns [] on any failure (no key, no migration, network).
 */
export async function recallRelatedThreads(
  query: string,
  excludeThreadId: string | null,
  opts: { threshold?: number; count?: number } = {},
): Promise<RelatedThreadMatch[]> {
  if (!query?.trim() || !semanticRecallEnabled()) return []
  try {
    const embedding = await generateEmbedding(query)
    const { data, error } = await db().rpc("match_thread_summaries", {
      query_embedding: embedding as unknown as string,
      match_threshold: opts.threshold ?? RELATED_THREADS_THRESHOLD,
      match_count: opts.count ?? RELATED_THREADS_COUNT,
      exclude_thread_id: excludeThreadId ?? null,
    })
    if (error) return []
    return (data ?? []) as RelatedThreadMatch[]
  } catch (err) {
    console.warn("[thread-recall] recallRelatedThreads failed (non-fatal):", err instanceof Error ? err.message : err)
    return []
  }
}

/**
 * PURE: render related-thread matches into a prompt block the worker can use to
 * connect the dots. Returns "" when there are no matches. Exported for tests.
 */
export function formatRelatedThreadsSuffix(matches: RelatedThreadMatch[]): string {
  if (!matches.length) return ""
  const lines = matches.map((m) => {
    const when = (m.created_at ?? "").slice(0, 10)
    const title = m.title || "(untitled conversation)"
    const summary = (m.summary_text || "").slice(0, RELATED_SUMMARY_MAX).trim()
    const pct = Math.round((m.similarity ?? 0) * 100)
    return `- ${title}${when ? ` (${when})` : ""} — ${summary}${summary.length >= RELATED_SUMMARY_MAX ? "…" : ""} [~${pct}% related]`
  })
  return [
    "",
    "RELATED PAST CONVERSATIONS (from your durable memory — earlier threads that look related to this message; use them to connect the dots, but verify before relying on a detail, and don't assume this conversation is about the same thing):",
    ...lines,
  ].join("\n")
}

/**
 * Orchestrate cross-thread recall for a worker turn: embed the query, find related
 * past threads, format them into a prompt suffix. Best-effort "" on anything. This
 * is what callWorker prepends (Slack-only, gated by enableThreadRecall).
 */
export async function buildRelatedThreadsSuffix(query: string, excludeThreadId: string | null): Promise<string> {
  const matches = await recallRelatedThreads(query, excludeThreadId)
  return formatRelatedThreadsSuffix(matches)
}
