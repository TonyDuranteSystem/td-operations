// ============================================================
// Decision Memory System — Phase 2 (embedding + CRUD utility)
// ============================================================
// Semantic store of "situation → decision taken". Recalled by vector
// similarity so the agent can surface how a comparable situation was
// decided before (and the reasoning / who decided it).
//
// Backing store: decision_memory table + match_decision_memory RPC
//   (scripts/migrations/20260611-decision-memory.sql).
// Embeddings: OpenAI text-embedding-3-small (1536 dims) via fetch — no SDK
//   dependency, matching the existing OpenAI call pattern in providers.ts.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const EMBEDDING_MODEL = "text-embedding-3-small"
export const EMBEDDING_DIM = 1536

// `decision_memory` + the `match_decision_memory` RPC are not yet in the
// generated lib/database.types.ts. Types are generated from the PRODUCTION
// schema (npm run gen:types → project ydzipybqeebtpcvsbtvs), which only gets
// this table on promotion of 20260611-decision-memory.sql. Until then a typed
// client can't reference the table, so we use a schema-agnostic view here.
// FOLLOW-UP: after production promotion + `npm run gen:types`, delete this cast
// and use the typed `supabaseAdmin` directly (per the no-restricted-syntax rule).
// eslint-disable-next-line no-restricted-syntax -- table not yet in generated types; see note above
const db = supabaseAdmin as unknown as SupabaseClient

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

/** A row returned by the match_decision_memory RPC (recall result). */
export interface DecisionMemoryMatch {
  id: string
  situation: string
  decision: string
  reasoning: string | null
  tags: string[]
  domain: string | null
  confidence: number
  source_type: string
  created_at: string
  similarity: number
}

/** Parameters accepted by saveDecisionMemory. */
export interface SaveDecisionMemoryParams {
  /** The situation/context the decision applied to. Used to build the embedding. */
  situation: string
  /** The decision that was taken. */
  decision: string
  /** Why the decision was taken. */
  reasoning?: string
  /** What the bot/agent had originally said (for correction-type memories). */
  botSaid?: string
  /** Classification of the correction, e.g. "factual", "policy", "tone". */
  correctionType?: string
  /** Free-form tags for filtering. */
  tags?: string[]
  /** Domain bucket, e.g. "billing", "formation", "tax". */
  domain?: string
  /** Where this memory came from, e.g. "chat", "manual", "correction". Required. */
  sourceType: string
  /** Opaque reference to the source (message id, task id, etc.). */
  sourceRef?: string
  /** Who was involved, e.g. ["antonio", "claude"]. */
  actors?: string[]
  /** 0..1 confidence in this memory. Defaults to 0.8 (DB default). */
  confidence?: number
  /**
   * Client scope, "account:<id>" | "contact:<id>" | "lead:<id>" (Phase 3). When set,
   * the memory is recallable per-client via match_decision_memory_client. Null = global.
   */
  clientKey?: string | null
}

/** Options for recallDecisionMemory. */
export interface RecallDecisionMemoryOptions {
  /** Minimum cosine similarity (0..1). Defaults to 0.7. */
  matchThreshold?: number
  /** Max rows to return. Defaults to 10. */
  matchCount?: number
  /** Restrict to a single domain. */
  domain?: string
  /** Memory status to match. Defaults to "active". */
  status?: string
  /** When true, bump times_recalled + last_recalled_at on returned rows. Defaults to true. */
  trackRecall?: boolean
}

// ------------------------------------------------------------
// Embedding generation
// ------------------------------------------------------------

/**
 * Generate a 1536-dim embedding for `text` using OpenAI text-embedding-3-small.
 *
 * Requires OPENAI_API_KEY (set on Vercel; runs server-side only). Throws a
 * clear error if the key is missing or the API call fails — callers should
 * surface this rather than silently storing a null embedding.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured — cannot generate embedding")

  const input = text.trim()
  if (!input) throw new Error("generateEmbedding: empty input text")

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  let res: Response
  try {
    res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input,
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`OpenAI embeddings error ${res.status}: ${JSON.stringify(err)}`)
  }

  const data = await res.json()
  const embedding: unknown = data?.data?.[0]?.embedding
  if (!Array.isArray(embedding)) {
    throw new Error("OpenAI embeddings: malformed response (no embedding array)")
  }
  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(
      `OpenAI embeddings: expected ${EMBEDDING_DIM} dims, got ${embedding.length}`
    )
  }
  return embedding as number[]
}

// ------------------------------------------------------------
// Save
// ------------------------------------------------------------

/**
 * Persist a decision memory. Embeds the `situation` (so recall compares
 * situation-to-situation) and inserts the row. Returns the new row id.
 */
export async function saveDecisionMemory(params: SaveDecisionMemoryParams): Promise<string> {
  if (!params.situation?.trim()) throw new Error("saveDecisionMemory: situation is required")
  if (!params.decision?.trim()) throw new Error("saveDecisionMemory: decision is required")
  if (!params.sourceType?.trim()) throw new Error("saveDecisionMemory: sourceType is required")

  const embedding = await generateEmbedding(params.situation)

  const { data, error } = await db
    .from("decision_memory")
    .insert({
      situation: params.situation,
      decision: params.decision,
      reasoning: params.reasoning ?? null,
      bot_said: params.botSaid ?? null,
      correction_type: params.correctionType ?? null,
      tags: params.tags ?? [],
      domain: params.domain ?? null,
      embedding: embedding as unknown as string,
      source_type: params.sourceType,
      source_ref: params.sourceRef ?? null,
      actors: params.actors ?? [],
      confidence: params.confidence ?? 0.8,
      client_key: params.clientKey ?? null,
    })
    .select("id")
    .single()

  if (error) throw new Error(`saveDecisionMemory insert failed: ${error.message}`)
  if (!data?.id) throw new Error("saveDecisionMemory: insert returned no id")
  return data.id as string
}

// ------------------------------------------------------------
// Recall
// ------------------------------------------------------------

/**
 * Recall the decision memories most similar to `query`. Embeds the query and
 * calls match_decision_memory. By default bumps recall stats on the hits.
 */
export async function recallDecisionMemory(
  query: string,
  opts: RecallDecisionMemoryOptions = {}
): Promise<DecisionMemoryMatch[]> {
  if (!query?.trim()) throw new Error("recallDecisionMemory: query is required")

  const embedding = await generateEmbedding(query)

  const { data, error } = await db.rpc("match_decision_memory", {
    query_embedding: embedding as unknown as string,
    match_threshold: opts.matchThreshold ?? 0.7,
    match_count: opts.matchCount ?? 10,
    filter_domain: opts.domain ?? undefined,
    filter_status: opts.status ?? "active",
  })

  if (error) throw new Error(`recallDecisionMemory RPC failed: ${error.message}`)

  const matches = (data ?? []) as DecisionMemoryMatch[]

  // Track recall stats unless explicitly disabled.
  if (matches.length > 0 && opts.trackRecall !== false) {
    await bumpRecallStats(matches.map((m) => m.id)).catch(() => {
      /* recall-stat tracking is best-effort; never fail a recall over it */
    })
  }

  return matches
}

/**
 * Recall the memories most similar to `query` SCOPED TO ONE CLIENT (Phase 3).
 * Calls match_decision_memory_client (separate from the global recall). Best-effort
 * stat bump. Returns [] when the client has no memories yet.
 */
export async function recallClientDecisionMemory(
  query: string,
  clientKey: string,
  opts: { matchThreshold?: number; matchCount?: number; status?: string; trackRecall?: boolean } = {},
): Promise<DecisionMemoryMatch[]> {
  if (!query?.trim() || !clientKey?.trim()) return []
  const embedding = await generateEmbedding(query)
  const { data, error } = await db.rpc("match_decision_memory_client", {
    query_embedding: embedding as unknown as string,
    filter_client_key: clientKey,
    match_threshold: opts.matchThreshold ?? 0.4,
    match_count: opts.matchCount ?? 5,
    filter_status: opts.status ?? "active",
  })
  if (error) throw new Error(`recallClientDecisionMemory RPC failed: ${error.message}`)
  const matches = (data ?? []) as DecisionMemoryMatch[]
  if (matches.length > 0 && opts.trackRecall !== false) {
    await bumpRecallStats(matches.map((m) => m.id)).catch(() => {})
  }
  return matches
}

/** Increment times_recalled and stamp last_recalled_at for the given ids. */
async function bumpRecallStats(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const nowIso = new Date().toISOString()
  // Read-modify-write per row (low concurrency; recall is human-paced).
  const { data, error } = await db
    .from("decision_memory")
    .select("id, times_recalled")
    .in("id", ids)
  if (error || !data) return
  await Promise.all(
    data.map((row: { id: string; times_recalled: number | null }) =>
      db
        .from("decision_memory")
        .update({
          times_recalled: (row.times_recalled ?? 0) + 1,
          last_recalled_at: nowIso,
        })
        .eq("id", row.id)
    )
  )
}

// ------------------------------------------------------------
// Confirm / Contradict
// ------------------------------------------------------------

/** Increment times_confirmed for a memory (the decision held up / was reused). */
export async function confirmMemory(id: string): Promise<void> {
  if (!id) throw new Error("confirmMemory: id is required")

  const { data, error } = await db
    .from("decision_memory")
    .select("times_confirmed")
    .eq("id", id)
    .single()
  if (error) throw new Error(`confirmMemory read failed: ${error.message}`)
  if (!data) throw new Error(`confirmMemory: memory ${id} not found`)

  const { error: updErr } = await db
    .from("decision_memory")
    .update({
      times_confirmed: (data.times_confirmed ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
  if (updErr) throw new Error(`confirmMemory update failed: ${updErr.message}`)
}

/**
 * Record that a memory was contradicted: bump its times_contradicted, mark it
 * superseded, and create a fresh memory carrying `newDecision`, linked back via
 * superseded_by. Returns the new id.
 *
 * `opts.newSituation` / `opts.newReasoning` (Business Brain P4): a real correction
 * often carries a freshly-captured situation and the NEW reasoning (the why). When
 * given, the replacement uses them instead of copying the old row's — otherwise the
 * new context/reasoning would be silently discarded. Omitted → keep the old row's
 * (backwards-compatible with the confirm/void callers).
 */
export async function contradictMemory(
  id: string,
  newDecision: string,
  opts: { newSituation?: string; newReasoning?: string } = {},
): Promise<string> {
  if (!id) throw new Error("contradictMemory: id is required")
  if (!newDecision?.trim()) throw new Error("contradictMemory: newDecision is required")

  // Load the old memory so the replacement keeps the same situation/context.
  // client_key + bot_said are LOAD-BEARING here (WS1.5 fix, 2026-07-17): before,
  // they were not selected, so correcting a CLIENT-scoped lesson produced a new
  // GLOBAL lesson — the client-specific fact leaked into every client's recall
  // and vanished from that client's brain.
  const { data: old, error } = await db
    .from("decision_memory")
    .select(
      "situation, reasoning, tags, domain, actors, source_type, source_ref, confidence, times_contradicted, client_key, bot_said"
    )
    .eq("id", id)
    .single()
  if (error) throw new Error(`contradictMemory read failed: ${error.message}`)
  if (!old) throw new Error(`contradictMemory: memory ${id} not found`)

  // Create the replacement memory — preserving the client scope so a client-specific
  // correction stays client-specific, and carrying the fresh situation/reasoning when
  // the caller captured them.
  const newId = await saveDecisionMemory({
    situation: opts.newSituation?.trim() || (old.situation as string),
    decision: newDecision,
    reasoning: opts.newReasoning?.trim() || (old.reasoning as string | null) || undefined,
    tags: (old.tags as string[] | null) ?? undefined,
    domain: (old.domain as string | null) ?? undefined,
    actors: (old.actors as string[] | null) ?? undefined,
    sourceType: (old.source_type as string) ?? "contradiction",
    sourceRef: (old.source_ref as string | null) ?? undefined,
    confidence: (old.confidence as number | null) ?? undefined,
    clientKey: (old.client_key as string | null) ?? undefined,
    botSaid: (old.bot_said as string | null) ?? undefined,
  })

  // Mark the old memory contradicted + superseded, pointing at the replacement.
  const { error: updErr } = await db
    .from("decision_memory")
    .update({
      times_contradicted: ((old.times_contradicted as number | null) ?? 0) + 1,
      status: "superseded",
      superseded_by: newId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
  if (updErr) throw new Error(`contradictMemory update failed: ${updErr.message}`)

  return newId
}

/**
 * VOID a memory (WS1.5, 2026-07-17) — remove a wrong lesson WITHOUT a
 * replacement. `contradictMemory` requires a new decision and creates a fresh
 * active row, so it can't express "this is just wrong, drop it" (wiring a Void
 * button to it would plant an active "(voided)" lesson). This flips status to
 * 'voided'; recall filters `status='active'`, so a voided lesson is immediately
 * excluded from every prompt, while the row is preserved for audit. Idempotent.
 */
export async function voidMemory(id: string): Promise<void> {
  if (!id) throw new Error("voidMemory: id is required")
  const { error } = await db
    .from("decision_memory")
    .update({ status: "voided", updated_at: new Date().toISOString() })
    .eq("id", id)
  if (error) throw new Error(`voidMemory failed: ${error.message}`)
}
