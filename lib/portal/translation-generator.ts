import crypto from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { fetchAllPaged } from "@/lib/bank-transactions-fetch"

/**
 * Turns any {key: englishText} source dictionary into real translated rows
 * in portal_translations for a target language, via one AI call per batch —
 * NOT one call per phrase, which would be both slow and needlessly
 * expensive for hundreds of short strings (dev job 12cab351).
 *
 * Content-source agnostic on purpose: the central portal dictionary
 * (lib/portal/i18n.ts's getEnglishDictionary()) and the wizard field labels
 * (lib/portal/wizard-translatable-text.ts) both feed the SAME engine here —
 * one race-safe, batched, stuck-row-recovering generator, not a copy per
 * content source. Whatever calls this is responsible for excluding
 * legally-sensitive text BEFORE it reaches this function (see
 * lib/portal/translation-exclusions.ts) — this function has no way to know
 * which keys are safe, it only knows how to translate and store whatever
 * it's given.
 *
 * Wired into the client-facing picker (dev job 12cab351): `seedPendingTranslations`
 * is the fast, AI-free half this file exposes for the API route to call inline
 * (insert-only, milliseconds); the `translate_language` job (lib/jobs/handlers/
 * translate-language.ts) calls this full function to do the actual AI-calling
 * work in bounded, resumable chunks. Also still safe to run manually via
 * scripts/generate-portal-translations.ts.
 */

const STUCK_GENERATING_MS = 5 * 60 * 1000
const BATCH_SIZE = 150
// BUG #3 FOUND running this for real: a full 150-entry batch of real wizard
// copy (long paragraphs included, not just short labels) took ~117s and
// ~6,450 output tokens to translate — well past the old 55s timeout, which
// silently aborted (AbortError) and failed the ENTIRE batch every time,
// even though the model would have finished given more time. 4 minutes
// gives real headroom above the observed ~117s.
const AI_TIMEOUT_MS = 240_000
const CLAIM_CONCURRENCY = 20

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex")
}

export interface GenerateResult {
  languageCode: string
  requested: number
  alreadyDone: number
  generated: number
  failed: number
  failedKeys: string[]
  /** True when there was nothing to do at all (every key already 'done') —
   *  distinct from `generated === 0` after a real attempt, so a caller (the
   *  job handler) can tell "finished" from "started but got cut off". */
  noCandidates: boolean
  /** True when the batch loop stopped early because `deadlineAt` was reached
   *  (or would be, mid-batch) rather than because all work finished. */
  stoppedOnDeadline: boolean
  /** Batches actually attempted this call (each one real AI spend). */
  batchesSent: number
  batchesFailed: number
}

interface ExistingStatusRow {
  key: string
  status: string
}

/** Paged, 1000-row-cap-safe read of every row this language already has,
 * regardless of status — shared by the seed step and the full generator so
 * the two can never compute "missing" differently. */
async function loadExistingStatus(languageCode: string): Promise<ExistingStatusRow[]> {
  return fetchAllPaged<ExistingStatusRow>(
    async (from, to) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- portal_translations not yet in generated types (regenerated on production promotion)
      const { data, error } = await (supabaseAdmin as any)
        .from("portal_translations")
        .select("key, status")
        .eq("language_code", languageCode)
        .order("id", { ascending: true })
        .range(from, to)
      if (error) return []
      return data ?? []
    },
  )
}

export interface SeedResult {
  requested: number
  alreadyDone: number
  /** Keys that now have a 'pending' (or already-in-flight) row waiting to be
   *  translated — what a caller should check to decide whether it's worth
   *  enqueueing a translate_language job at all. */
  missing: number
}

/**
 * The fast half of generation: insert a 'pending' row for every key in
 * `sourceDictionary` that this language doesn't already have SOME row for.
 * No AI calls, no claiming — safe to call synchronously from an HTTP request
 * (the language-picker API route does exactly that). Idempotent via the same
 * upsert/ignoreDuplicates behavior the full generator already relied on.
 */
export async function seedPendingTranslations(
  languageCode: string,
  sourceDictionary: Record<string, string>,
): Promise<SeedResult> {
  const allKeys = Object.keys(sourceDictionary)
  const existing = await loadExistingStatus(languageCode)
  const doneKeys = new Set<string>(existing.filter(r => r.status === "done").map(r => r.key))
  const existingKeys = new Set<string>(existing.map(r => r.key))
  const missingKeys = allKeys.filter(k => !doneKeys.has(k))

  const brandNewKeys = missingKeys.filter(k => !existingKeys.has(k))
  if (brandNewKeys.length > 0) {
    const claimRows = brandNewKeys.map(key => ({
      language_code: languageCode,
      key,
      source_text: sourceDictionary[key],
      source_text_hash: hashText(sourceDictionary[key]),
      status: "pending",
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- portal_translations not yet in generated types (regenerated on production promotion)
    await (supabaseAdmin as any)
      .from("portal_translations")
      .upsert(claimRows, { onConflict: "language_code,key", ignoreDuplicates: true })
  }

  return { requested: allKeys.length, alreadyDone: allKeys.length - missingKeys.length, missing: missingKeys.length }
}

/** A row stuck in 'generating' with no update in STUCK_GENERATING_MS means
 * the job that claimed it died (crash, timeout) — reset it to 'pending' so
 * the next run retries it. Same shape as the Hermes bridge's own
 * stuck-'processing'-row recovery (R108, CLAUDE.md). */
async function recoverStuckRows(languageCode: string): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_GENERATING_MS).toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- portal_translations not yet in generated types (regenerated on production promotion)
  await (supabaseAdmin as any)
    .from("portal_translations")
    .update({ status: "pending", generating_started_at: null })
    .eq("language_code", languageCode)
    .eq("status", "generating")
    .lt("generating_started_at", cutoff)
}

/**
 * Ask Claude to translate one batch of {key: englishText} pairs, forced
 * through tool-use so the response is real, parseable JSON rather than
 * free text this function would have to guess how to parse. Same raw
 * Anthropic Messages API call shape lib/ai-agent/providers.ts already uses
 * elsewhere in this codebase — no new provider integration.
 */
async function translateBatch(
  entries: Array<{ key: string; text: string }>,
  languageCode: string,
  languageName: string,
): Promise<Record<string, string>> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured")

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system:
          "You translate short user-interface phrases (buttons, menu labels, headings, short instructions) for a legal/financial services web app, from English into the target language. " +
          "Keep the same tone (plain, professional, concise) and the same length feel — these are UI labels, not prose. " +
          "Preserve any proper nouns, brand names, and placeholders exactly as written. " +
          "Translate every single entry given; do not skip or merge any. Call the submit_translations tool exactly once with every key filled in.",
        tools: [
          {
            name: "submit_translations",
            description: "Submit the translated text for every key given, one-to-one.",
            input_schema: {
              type: "object",
              properties: {
                translations: {
                  type: "object",
                  description: "Map of the exact same keys given in the request to their translated text.",
                  additionalProperties: { type: "string" },
                },
              },
              required: ["translations"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "submit_translations" },
        messages: [
          {
            role: "user",
            content:
              `Translate these ${entries.length} UI phrases into ${languageName} (ISO code: ${languageCode}). ` +
              `Return them via submit_translations, keyed by the same identifier:\n\n` +
              JSON.stringify(Object.fromEntries(entries.map(e => [e.key, e.text])), null, 2),
          },
        ],
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`Claude API error ${res.status}: ${JSON.stringify(err)}`)
    }

    const data = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolUse = data.content?.find((b: any) => b.type === "tool_use" && b.name === "submit_translations")
    // On larger batches the model sometimes hands back `translations` as a
    // JSON-encoded STRING instead of a native object, even though the tool
    // schema declares it as an object — a real, reproducible quirk, not a
    // hypothetical. The old code trusted the shape and returned the string
    // as-is; every per-key lookup then silently missed (string indexing by a
    // non-numeric key is always undefined), so the whole batch failed with no
    // error surfaced. (Found live: 150/150 Hungarian entries failed this way
    // in one batch, 2026-08-23.)
    let translations: unknown = toolUse?.input?.translations
    if (typeof translations === "string") {
      try {
        translations = JSON.parse(translations)
      } catch {
        translations = null
      }
    }
    if (!translations || typeof translations !== "object") {
      throw new Error("Model did not return submit_translations with a translations object")
    }
    return translations as Record<string, string>
  } finally {
    clearTimeout(timeout)
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

/**
 * Generate every missing translation for one language. Idempotent — safe to
 * call repeatedly; already-'done' keys are skipped, and a batch failure only
 * leaves ITS OWN keys un-generated (retried on the next call) rather than
 * losing progress already made by earlier batches in the same run.
 *
 * BUG #1 FIXED HERE (found running this for real at full scale, not caught
 * by mocked tests): a row that got claimed as 'pending' but never made it to
 * 'done' — a batch that failed outright, or the process dying mid-run — was
 * NEVER retried by a later call. The old claim step was insert-only
 * (upsert ... ignoreDuplicates), so on retry it saw the row already existed
 * (in ANY status) and silently skipped it, forever. The fix is to claim
 * work via a CONDITIONAL UPDATE (WHERE status='pending'), which correctly
 * picks up both brand-new rows AND any row stuck at 'pending' from an
 * earlier incomplete run.
 *
 * BUG #2 FIXED HERE (found running the WIZARD content source specifically —
 * its keys are the English sentences themselves, not short dot-paths like
 * the central dictionary's): PostgREST's `.in()` list filter corrupts
 * matching for the ENTIRE list when even one value contains a literal
 * double-quote character — real UI copy does (e.g. a phrase containing
 * `"back-filing"`). This wasn't a per-key failure; one poisoned key in the
 * list silently zeroed out matches for the whole batch, so claiming with
 * `.in('key', missingKeys)` left genuinely-pending rows unclaimed run after
 * run with no error. Fixed by claiming ONE KEY AT A TIME via `.eq('key', …)`
 * (verified safe with embedded quotes/apostrophes), chunked with bounded
 * concurrency so this stays fast without re-introducing a list filter.
 * Still race-safe: each per-key UPDATE only flips that one row if it is
 * still 'pending' at the moment it runs.
 */
export async function generateTranslationsForLanguage(
  languageCode: string,
  languageName: string,
  sourceDictionary: Record<string, string>,
  opts?: {
    /** Hard wall-clock deadline (epoch ms), same contract as the rest of the
     *  job system's JobRunContext.deadlineAt. When set, this call will not
     *  START a new batch once the remaining time couldn't fit one — it stops
     *  and reports `stoppedOnDeadline: true` instead of racing the platform's
     *  own kill, which would waste the AI spend for whatever was in flight. */
    deadlineAt?: number
  },
): Promise<GenerateResult> {
  await recoverStuckRows(languageCode)

  const englishDict = sourceDictionary
  const allKeys = Object.keys(englishDict)

  // Unbounded .select() truncates at PostgREST's default 1000-row page —
  // the exact same bug already found and fixed in translations-store.ts.
  // A language with more done rows than that (any language once both the
  // central dictionary AND the wizard content are translated — 979 + 433 =
  // 1412 for the two sources shipped so far) silently lost visibility into
  // its own already-'done' rows, so this function kept re-computing the
  // same "missing" keys forever, kept skipping them via the upsert's
  // onConflict/ignoreDuplicates (they already exist), and kept reporting
  // generated:0 — a real, reproduced defect, not a timing artifact.
  const existing = await loadExistingStatus(languageCode)
  const doneKeys = new Set<string>(existing.filter(r => r.status === "done").map(r => r.key))
  const existingKeys = new Set<string>(existing.map(r => r.key))

  const missingKeys = allKeys.filter(k => !doneKeys.has(k))
  const result: GenerateResult = {
    languageCode,
    requested: allKeys.length,
    alreadyDone: allKeys.length - missingKeys.length,
    generated: 0,
    failed: 0,
    failedKeys: [],
    noCandidates: missingKeys.length === 0,
    stoppedOnDeadline: false,
    batchesSent: 0,
    batchesFailed: 0,
  }
  if (missingKeys.length === 0) return result

  // Ensure a row exists for every missing key that has NO row at all yet.
  // A key that already has a row (in any status — including a stuck one
  // from a previous run) is left alone here; ignoreDuplicates makes this a
  // harmless no-op for it, and the conditional claim below is what
  // actually picks it up for a retry.
  const brandNewKeys = missingKeys.filter(k => !existingKeys.has(k))
  if (brandNewKeys.length > 0) {
    const claimRows = brandNewKeys.map(key => ({
      language_code: languageCode,
      key,
      source_text: englishDict[key],
      source_text_hash: hashText(englishDict[key]),
      status: "pending",
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- portal_translations not yet in generated types (regenerated on production promotion)
    await (supabaseAdmin as any)
      .from("portal_translations")
      .upsert(claimRows, { onConflict: "language_code,key", ignoreDuplicates: true })
  }

  // Claim and translate ONE BATCH_SIZE group at a time (found running this
  // for real, BUG #4: claiming every missing key up front — before checking
  // whether there was even time left to attempt a single batch — left
  // hundreds of rows sitting at 'generating' with NOTHING claimed-but-idle
  // whenever the deadline was already tight when this call started, e.g. a
  // drain loop that spent most of its window on an earlier language. Those
  // rows then blocked the very next chunk's claim (nothing else could win
  // them) until the 5-minute stuck-row recovery, even though this call never
  // laid a finger on them. Claiming per-batch, right before attempting it,
  // means we only ever hold 'generating' on keys we're actually about to try.
  let attemptedAnyClaim = false
  for (const batchKeys of chunk(missingKeys, BATCH_SIZE)) {
    // Don't START a batch that couldn't finish before the deadline — a batch
    // already takes up to AI_TIMEOUT_MS, so leave that much headroom. Keys in
    // this and any later un-attempted chunk are never claimed here, so they
    // stay 'pending' — immediately claimable by the very next invocation,
    // not stuck waiting on recoverStuckRows().
    if (opts?.deadlineAt && Date.now() >= opts.deadlineAt - AI_TIMEOUT_MS) {
      result.stoppedOnDeadline = true
      break
    }

    // Race-safe claim for just this batch: flips exactly the rows STILL
    // 'pending' right now to 'generating' — covers freshly-inserted rows
    // above AND any leftover 'pending' row from an earlier incomplete run. A
    // row a concurrent caller already flipped (or one still legitimately
    // 'generating' from an in-flight, non-stale job) simply won't match and
    // is left untouched. One UPDATE per key (not `.in()` — see BUG #2
    // above), chunked with bounded concurrency.
    const startedAt = new Date().toISOString()
    const wonKeys: string[] = []
    for (const claimChunk of chunk(batchKeys, CLAIM_CONCURRENCY)) {
      const claims = await Promise.all(
        claimChunk.map(async key => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- portal_translations not yet in generated types (regenerated on production promotion)
          const { data } = await (supabaseAdmin as any)
            .from("portal_translations")
            .update({ status: "generating", generating_started_at: startedAt })
            .eq("language_code", languageCode)
            .eq("status", "pending")
            .eq("key", key)
            .select("key")
          return data && data.length > 0 ? key : null
        }),
      )
      wonKeys.push(...claims.filter((k): k is string => k !== null))
    }
    attemptedAnyClaim = true
    if (wonKeys.length === 0) {
      // Lost the race for this whole batch — another caller has these keys
      // in flight. Try the next batch rather than giving up immediately;
      // other keys may still be free.
      continue
    }

    result.batchesSent++
    try {
      const entries = wonKeys.map(key => ({ key, text: englishDict[key] }))
      const translated = await translateBatch(entries, languageCode, languageName)

      for (const key of wonKeys) {
        const text = translated[key]
        if (typeof text !== "string" || !text.trim()) {
          result.failed++
          result.failedKeys.push(key)
          continue
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabaseAdmin as any)
          .from("portal_translations")
          .update({ status: "done", translated_text: text, updated_at: new Date().toISOString() })
          .eq("language_code", languageCode)
          .eq("key", key)
        if (error) {
          result.failed++
          result.failedKeys.push(key)
        } else {
          result.generated++
        }
      }
    } catch {
      // Whole batch failed (API error, timeout, malformed response) — leave
      // these rows at 'generating'; recoverStuckRows() resets them to
      // 'pending' for the next call once STUCK_GENERATING_MS has passed.
      result.batchesFailed++
      result.failed += wonKeys.length
      result.failedKeys.push(...wonKeys)
    }
  }

  if (!attemptedAnyClaim || result.batchesSent === 0) {
    // Never actually got a batch running — either the deadline was already
    // too tight to start, or every batch we examined lost its whole claim
    // race to another caller. Same "come back later, not broken" signal as a
    // genuine deadline stop, so the caller's continue/halt decision treats
    // it the same way: chain a continuation, don't burn the no-progress halt
    // on it. (batchesFailed can only be nonzero alongside a batchesSent
    // increment, so batchesSent===0 already implies no batch even failed.)
    result.stoppedOnDeadline = true
  }

  return result
}
