/* eslint-disable no-console -- CLI tool, stdout IS the UI */
/**
 * One-off batch backfill: embed every resolved thread_summaries row that has a
 * summary but no embedding yet, so OLD conversations become recallable by the
 * worker's semantic cross-thread recall (persistent memory Phase 2).
 *
 * Run AFTER applying scripts/migrations/20260623-1900-thread-summaries-embedding.sql
 * (which adds the embedding column + match_thread_summaries RPC).
 *
 * Usage: npx tsx scripts/backfill-thread-summary-embeddings.ts
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY in .env.local.
 * Idempotent: only touches rows where embedding IS NULL and summary_text IS NOT NULL.
 * Serial + cheap (text-embedding-3-small). Safe to re-run.
 */

import { createClient } from "@supabase/supabase-js"
import { resolve } from "path"
import { config } from "dotenv"
import { composeThreadEmbeddingText } from "../lib/ai-agent/thread-recall"
import { generateEmbedding } from "../lib/ai-agent/decision-memory"

config({ path: resolve(__dirname, "../.env.local") })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}
if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY (needed to generate embeddings)")
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY)

async function main() {
  console.log(`Backfilling thread_summaries embeddings on ${SUPABASE_URL}`)
  const { data, error } = await db
    .from("thread_summaries")
    .select("thread_id, title, outcome, summary_text, tags")
    .is("embedding", null)
    .not("summary_text", "is", null)
  if (error) {
    console.error("query failed:", error.message)
    process.exit(1)
  }
  const rows = data ?? []
  console.log(`${rows.length} row(s) need an embedding`)

  let done = 0
  let skipped = 0
  for (const row of rows) {
    const text = composeThreadEmbeddingText(row)
    if (!text) {
      skipped++
      continue
    }
    try {
      const embedding = await generateEmbedding(text)
      const { error: upErr } = await db
        .from("thread_summaries")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update({ embedding: embedding as any })
        .eq("thread_id", row.thread_id)
      if (upErr) {
        console.warn(`  ✗ ${row.thread_id}: ${upErr.message}`)
        continue
      }
      done++
      if (done % 25 === 0) console.log(`  …${done} embedded`)
    } catch (err) {
      console.warn(`  ✗ ${row.thread_id}: ${err instanceof Error ? err.message : err}`)
    }
  }
  console.log(`Done. Embedded ${done}, skipped ${skipped} (no usable summary).`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
