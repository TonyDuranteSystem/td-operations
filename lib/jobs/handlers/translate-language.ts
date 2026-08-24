/**
 * Job Handler: translate_language (dev job 12cab351).
 *
 * One invocation = one chunk of AI translation batches for ONE content source
 * (the central dictionary, then the wizard field labels, then the
 * help-article library) of ONE language, bounded by the runner's deadline.
 * Same chained-chunk shape as recategorize_ai — reuses decideChunkFollowup
 * rather than reinventing continue/done/halt logic.
 *
 * Enqueued by the language-picker API route (app/api/portal/language/route.ts)
 * right after it seeds 'pending' rows for a language that isn't fully
 * translated yet. Also safe to enqueue manually for a language that needs a
 * top-up (e.g. after new dictionary keys are added).
 */

import { triggerWorker, type Job, type JobResult } from "../queue"
import type { JobRunContext } from "../registry"
import { AI_CHAIN_CHUNK_CAP, AI_CHAIN_JOB_PRIORITY, decideChunkFollowup } from "../chain-state"
import { generateTranslationsForLanguage, seedPendingTranslations } from "@/lib/portal/translation-generator"
import { getEnglishDictionary } from "@/lib/portal/i18n"
import { getWizardTranslatableText } from "@/lib/portal/wizard-translatable-text"
import { getGuideTranslatableText } from "@/lib/portal/guide-translatable-text"

type Source = "dictionary" | "wizard" | "guide"

// Chain order: dictionary finishing hops into wizard, wizard finishing hops
// into guide, guide finishing ends the chain for this language. Kept as one
// map (rather than three copy-pasted "if source === X" blocks) so adding a
// fourth source later is a one-line change, not another duplicated branch.
const NEXT_SOURCE: Record<Source, Source | null> = {
  dictionary: "wizard",
  wizard: "guide",
  guide: null,
}

interface TranslateLanguagePayload {
  language_code: string
  language_name: string
  source?: Source
  chunk_index?: number
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

function sourceDictionaryFor(source: Source): Record<string, string> {
  if (source === "wizard") return getWizardTranslatableText()
  if (source === "guide") return getGuideTranslatableText()
  return getEnglishDictionary()
}

export async function handleTranslateLanguage(job: Job, ctx?: JobRunContext): Promise<JobResult> {
  const p = job.payload as unknown as TranslateLanguagePayload
  const result: JobResult = { steps: [] }
  const source: Source = p.source === "wizard" ? "wizard" : p.source === "guide" ? "guide" : "dictionary"
  const chunkIndex = p.chunk_index ?? 0

  if (!p.language_code || !p.language_name) {
    result.steps.push(step("validate", "error", "Missing language_code or language_name"))
    result.ok = false
    result.summary = "Invalid translate_language payload"
    return result
  }

  const r = await generateTranslationsForLanguage(
    p.language_code,
    p.language_name,
    sourceDictionaryFor(source),
    { deadlineAt: ctx?.deadlineAt },
  )

  const followup = decideChunkFollowup({
    stoppedOnDeadline: r.stoppedOnDeadline,
    batchesSent: r.batchesSent,
    batchesFailed: r.batchesFailed,
    progressed: r.generated > 0,
    chunkIndex,
    noCandidates: r.noCandidates,
  })

  result.steps.push(step(
    `translate_${source}`,
    followup === "halt_no_progress" ? "error" : "ok",
    `chunk=${chunkIndex}, followup=${followup}, generated=${r.generated}, failed=${r.failed}, alreadyDone=${r.alreadyDone}/${r.requested}`,
  ))

  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  if (followup === "continue") {
    try {
      const { data: live } = await db
        .from("job_queue")
        .select("id")
        .eq("job_type", "translate_language")
        .eq("payload->>language_code", p.language_code)
        .eq("payload->>source", source)
        .in("status", ["pending", "processing"])
        .neq("id", job.id)
        .limit(1)
      if (!live || live.length === 0) {
        const nextChunkIndex = r.batchesSent > 0 ? chunkIndex + 1 : chunkIndex
        const { error } = await db.from("job_queue").insert({
          job_type: "translate_language",
          // auto_retry: 0 — this is a handler-driven continuation (real
          // progress or a normal deadline stop), not a watchdog retry after a
          // terminal failure. Only translation-watchdog.ts increments this,
          // the same convention recategorize-ai.ts already uses.
          payload: { language_code: p.language_code, language_name: p.language_name, source, chunk_index: nextChunkIndex, auto_retry: 0 },
          priority: AI_CHAIN_JOB_PRIORITY,
          created_by: "chain",
        })
        if (error) throw new Error(error.message)
        result.steps.push(step("chain_continuation", "ok", `chunk ${nextChunkIndex} enqueued (source=${source})`))
        // Raw insert, not enqueueJob() — nothing proactively kicks this
        // continuation without this call. Without it, every chunk after the
        // first waited on the 5-minute safety-net cron alone (found live: a
        // real client's French pick sat on one un-picked-up chunk for
        // minutes with nothing visibly happening — 2026-08-23).
        triggerWorker().catch(() => {})
      } else {
        result.steps.push(step("chain_continuation", "skipped", "another chain job already live"))
      }
    } catch (e) {
      console.error("[translate-language] continuation insert failed (watchdog cron will still catch pending rows):", e)
      result.steps.push(step("chain_continuation", "error", e instanceof Error ? e.message : String(e)))
    }
    if (r.batchesSent === 0) {
      // Late-claim relay: this runner had no usable window left. Stop its
      // claim loop so the continuation waits for a fresh invocation.
      result.deferRunner = true
    }
    result.summary = `translate_language chunk ${chunkIndex} done (${source}) — continuing for ${p.language_code}`
    return result
  }

  // This source finished, halted on the chunk cap, or got stuck making no
  // progress → chain into the next content source this system knows about
  // (see NEXT_SOURCE above). halt_no_progress is included deliberately
  // (2026-08-24, found live: German's dictionary source halted repeatedly for
  // ~2.5h and blocked wizard/guide from even starting the whole time) — a
  // source stuck failing no longer blocks its siblings; it keeps being
  // retried independently by translation-watchdog.ts on its own backoff
  // ladder regardless of what happens here. The last source in the chain
  // finishing (or halting) ends the whole chain for this language — nothing
  // to chain into.
  const nextSource = NEXT_SOURCE[source]
  if (nextSource && (followup === "done" || followup === "halt_cap" || followup === "halt_no_progress")) {
    try {
      // Skip if nextSource has no missing work at all — cheap, AI-free check
      // (seedPendingTranslations only reads + upserts brand-new rows). Without
      // this, a source stuck retrying on the watchdog ladder would re-hit this
      // branch on every retry and re-enqueue an already-finished sibling each
      // time — harmless (it would just no-op as noCandidates→"done") but noisy
      // job_queue churn for no reason (ai-architect review finding, 2026-08-24).
      const seed = await seedPendingTranslations(p.language_code, sourceDictionaryFor(nextSource))
      if (seed.missing === 0) {
        result.steps.push(step("chain_next_source", "skipped", `${nextSource} already fully translated`))
      } else {
        // Same dedup guard as the "continue" branch above (found missing in
        // review, 2026-08-23): two independently-finishing chains for the same
        // language — e.g. a route-triggered pick racing a watchdog retry —
        // could otherwise each insert their own chunk-0 job for the next source.
        const { data: live } = await db
          .from("job_queue")
          .select("id")
          .eq("job_type", "translate_language")
          .eq("payload->>language_code", p.language_code)
          .eq("payload->>source", nextSource)
          .in("status", ["pending", "processing"])
          .neq("id", job.id)
          .limit(1)
        if (!live || live.length === 0) {
          const { data: inserted, error } = await db
            .from("job_queue")
            .insert({
              job_type: "translate_language",
              payload: { language_code: p.language_code, language_name: p.language_name, source: nextSource, chunk_index: 0, auto_retry: 0 },
              priority: AI_CHAIN_JOB_PRIORITY,
              created_by: "chain",
            })
            .select("id")
            .single()
          if (error) throw new Error(error.message)
          // Post-insert verify (same non-atomic SELECT-then-INSERT guard
          // translation-watchdog.ts already uses for its own re-enqueue): if a
          // concurrent runner ALSO inserted a live job for this exact
          // (language, nextSource) scope in the gap between our SELECT and our
          // INSERT, delete OUR row and let theirs run. This matters more now
          // than before this change — widening the trigger to halt_no_progress
          // means this whole branch fires on every watchdog retry of a stuck
          // source, not just once, so the race window gets exercised
          // repeatedly instead of a single time (senior-engineer review
          // finding, 2026-08-24).
          const { data: liveAfter } = await db
            .from("job_queue")
            .select("id")
            .in("status", ["pending", "processing"])
            .eq("job_type", "translate_language")
            .eq("payload->>language_code", p.language_code)
            .eq("payload->>source", nextSource)
          if ((liveAfter ?? []).length > 1) {
            await db.from("job_queue").delete().eq("id", inserted.id).eq("status", "pending")
            result.steps.push(step("chain_next_source", "skipped", `${nextSource} chain job already live (post-insert race)`))
          } else {
            result.steps.push(step("chain_next_source", "ok", `${nextSource} source enqueued`))
            triggerWorker().catch(() => {})
          }
        } else {
          result.steps.push(step("chain_next_source", "skipped", `${nextSource} chain job already live`))
        }
      }
    } catch (e) {
      console.error("[translate-language] next-source insert failed:", e)
      result.steps.push(step("chain_next_source", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  if (followup === "halt_no_progress") {
    result.ok = false
    result.summary = `translate_language made no progress (${r.batchesSent} batches, ${r.batchesFailed} failed) — halted (${p.language_code}, ${source})${r.lastBatchError ? `: ${r.lastBatchError}` : ""}`
    return result
  }
  if (followup === "halt_cap") {
    result.ok = false
    result.summary = `translate_language hit the ${AI_CHAIN_CHUNK_CAP}-chunk cap with work remaining (${p.language_code}, ${source})`
    return result
  }

  result.summary = `translate_language done for ${p.language_code} (${source}): ${r.generated} generated, ${r.failed} failed`
  return result
}
