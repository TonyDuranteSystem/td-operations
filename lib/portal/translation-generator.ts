import crypto from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { fetchAllPaged } from "@/lib/bank-transactions-fetch"
import { enqueueJob } from "@/lib/jobs/queue"
import { getEnglishDictionary, SUPPORTED_LOCALES } from "@/lib/portal/i18n"
import { getWizardTranslatableText } from "@/lib/portal/wizard-translatable-text"
import { getGuideTranslatableText } from "@/lib/portal/guide-translatable-text"
import { languageName } from "@/lib/portal/language-codes"

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
  /** The raw error from the LAST failed batch this call, if any — kept so a
   *  stuck language (repeated halt_no_progress) is diagnosable from the job's
   *  own result/error text instead of requiring a manual server-log dig, as
   *  this session had to do to root-cause the German incident (2026-08-24). */
  lastBatchError?: string
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
 * Give claimed rows back ('generating' → 'pending') once we know the model's
 * answer for them was unusable. One UPDATE per key with `.eq` — never `.in()`,
 * which corrupts matching for the whole list when a value contains a quote
 * (BUG #2 in generateTranslationsForLanguage). Only flips rows still
 * 'generating', so it can't undo a concurrent success. Never throws: releasing
 * is best-effort, and recoverStuckRows() still backstops it after 5 minutes.
 */
async function releaseClaims(languageCode: string, keys: string[]): Promise<void> {
  try {
    for (const group of chunk(keys, CLAIM_CONCURRENCY)) {
      await Promise.all(
        group.map(key =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- portal_translations not yet in generated types (regenerated on production promotion)
          (supabaseAdmin as any)
            .from("portal_translations")
            .update({ status: "pending", generating_started_at: null })
            .eq("language_code", languageCode)
            .eq("key", key)
            .eq("status", "generating"),
        ),
      )
    }
  } catch (e) {
    console.error("[translation-generator] releaseClaims failed (recoverStuckRows will backstop):", e)
  }
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
        // BUG #6 FOUND running this for real (German, 2026-08-24): a full
        // BATCH_SIZE (150) batch of guide/wizard prose content (full
        // sentences, not short dictionary labels) translated into a
        // verbose target language needs more than 8192 output tokens —
        // German needed 8513, Finnish (tested as a worse-case language)
        // needed 8962. The response gets cut off mid-generation
        // (stop_reason: "max_tokens") before the tool_use block completes,
        // so the whole batch fails cleanly (no partial/corrupted "done"
        // rows — see the !translations check below). 16000 gives real
        // headroom above both measured worst cases while staying well
        // under the AI_TIMEOUT_MS wall-clock budget (the Finnish test
        // took ~167s of the 240s allowed).
        max_tokens: 16000,
        system:
          "You translate short user-interface phrases (buttons, menu labels, headings, short instructions) for a legal/financial services web app, from English into the target language. " +
          "Keep the same tone (plain, professional, concise) and the same length feel — these are UI labels, not prose. " +
          "Preserve any proper nouns, brand names, and placeholders exactly as written. " +
          "Translate every single entry given; do not skip or merge any. " +
          // BUG #5 FOUND running this for real (German, 2026-08-24): a source
          // phrase containing an embedded quoted phrase (e.g. `... as "Pay
          // Now" buttons ...`) sometimes comes back with a mismatched opening/
          // closing quote style (a typographic opening quote paired with a
          // bare, unescaped ASCII closing quote) when the model hands the
          // whole `translations` object back as a re-stringified JSON blob —
          // an already-known quirk, see the string-vs-object handling below.
          // That one bad character corrupts JSON.parse for the ENTIRE batch,
          // not just the one key, and reproduces 100% of the time for the
          // same batch (verified: 4/4 failures on the real stuck content,
          // 0/3 failures once this instruction was added). Cheaper and safer
          // than a source-text edit — the affected keys already have
          // completed Spanish/French translations with no live mechanism
          // that would ever re-check them against a changed source string.
          "Never use literal quotation mark characters (\" or any curly/typographic quote variant) anywhere in a translated value, even if the English source text contains a quoted phrase — rephrase around it instead (e.g. drop the quotes, or reword) so the output never contains a quote character that could break JSON encoding. " +
          // Entries are identified by short opaque ids (k0, k1, ...), NOT by the
          // English sentence itself. For the wizard/guide sources the row key IS
          // the sentence, and the model does not echo a long sentence back
          // byte-for-byte: for a sentence with curly apostrophes it returned the
          // key with straight ones (reproduced 6/6, 2026-09-23), so the lookup
          // missed, the row was never saved, and the chain looped for weeks.
          "Each entry has an id. Return each translation under that exact id (k0, k1, ...). The optional `context` field only tells you where the phrase appears — use it as a hint, never translate or return it. " +
          "Call the submit_translations tool exactly once with every id filled in.",
        tools: [
          {
            name: "submit_translations",
            description: "Submit the translated text for every id given, one-to-one.",
            input_schema: {
              type: "object",
              properties: {
                translations: {
                  type: "object",
                  description: "Map of the exact same ids given in the request (k0, k1, ...) to their translated text.",
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
              `Return them via submit_translations, keyed by each entry's id:\n\n` +
              JSON.stringify(
                entries.map((e, i) => (e.key === e.text ? { id: `k${i}`, text: e.text } : { id: `k${i}`, context: e.key, text: e.text })),
                null,
                2,
              ),
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
    // Map back by id. Ids the request never asked for are ignored (a stray
    // "k151" must never write to another row). A model that ignored the ids and
    // echoed the exact original key is still accepted, but ONLY as an exact
    // match — no fuzzy/normalized matching, which could merge two different
    // source strings that differ only by an apostrophe style.
    const byId = translations as Record<string, unknown>
    const out: Record<string, string> = {}
    entries.forEach((e, i) => {
      const v = Object.prototype.hasOwnProperty.call(byId, `k${i}`) ? byId[`k${i}`] : byId[e.key]
      if (typeof v === "string") out[e.key] = v
    })
    return out
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Cheap sanity check before a model answer is stored as 'done'. Matching by
 * id removes the loud "key not found" failure, so this guards the quiet one:
 * a translation attached to the wrong sentence, or a placeholder the model
 * dropped/renamed (which would break interpolation in the live UI). Kept
 * deliberately conservative — a false rejection would recreate the very
 * no-progress loop this exists to prevent, so only clear-cut damage fails:
 * a `{placeholder}` set that doesn't match, or a wildly different length.
 */
export function translationLooksValid(source: string, translated: string): boolean {
  if (typeof translated !== "string" || !translated.trim()) return false
  const tokens = (s: string) => (s.match(/\{[^{}\s]+\}/g) ?? []).sort().join("|")
  if (tokens(source) !== tokens(translated)) return false
  if (source.length >= 30) {
    const ratio = translated.length / source.length
    if (ratio < 0.1 || ratio > 8) return false
  }
  return true
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

      const notSaved: string[] = []
      for (const key of wonKeys) {
        const text = translated[key]
        if (typeof text !== "string" || !translationLooksValid(englishDict[key], text)) {
          result.failed++
          result.failedKeys.push(key)
          notSaved.push(key)
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
          notSaved.push(key)
        } else {
          result.generated++
        }
      }
      // The model answered but these keys weren't saved. Hand them straight
      // back to 'pending' instead of leaving them 'generating' for 5 minutes:
      // a stuck lock made the very next attempt lose its claim, look like a
      // harmless "come back later", and turn one bad key into a self-requeuing
      // loop that never failed terminally (weeks of silent spend, 2026-09-23).
      await releaseClaims(languageCode, notSaved)
    } catch (e) {
      // Whole batch failed (API error, timeout, malformed response) — leave
      // these rows at 'generating'; recoverStuckRows() resets them to
      // 'pending' for the next call once STUCK_GENERATING_MS has passed.
      result.batchesFailed++
      result.failed += wonKeys.length
      result.failedKeys.push(...wonKeys)
      result.lastBatchError = e instanceof Error ? e.message : String(e)
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

// Same order the job handler's own chain hops through (translate-language.ts's
// NEXT_SOURCE) — dictionary, then wizard, then the guide/help-article library.
// Exported (moved from app/api/portal/language/route.ts, dev job 4fa1d8e5) so
// both the language-picker route and the daily top-up cron share one list
// instead of two copies that could drift.
export type TranslationSource = "dictionary" | "wizard" | "guide"
export const TRANSLATION_SOURCES_IN_ORDER: Array<{ source: TranslationSource; dictionary: () => Record<string, string> }> = [
  { source: "dictionary", dictionary: getEnglishDictionary },
  { source: "wizard", dictionary: getWizardTranslatableText },
  { source: "guide", dictionary: getGuideTranslatableText },
]

/**
 * The job handler's own chain-continuation dedup only guards chunk-to-chunk
 * within an already-running chain — it never protected this initial enqueue.
 * Two callers picking the same language/source at once could each start
 * their own chunk-0 job for it. Per-key claiming inside the job still
 * prevents double-translating any single entry, but this avoids the wasted
 * duplicate job outright. Moved here (from the language route) so the daily
 * top-up cron shares the same guard, dev job 4fa1d8e5.
 */
export async function hasLiveTranslateJob(languageCode: string, source: TranslationSource): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("job_queue")
    .select("id")
    .eq("job_type", "translate_language")
    .eq("payload->>language_code", languageCode)
    .eq("payload->>source", source)
    .in("status", ["pending", "processing"])
    .limit(1)
  return !!data && data.length > 0
}

/**
 * Seed+enqueue whichever source (dictionary, then wizard, then guide) still
 * has missing work for one language — the same "find what's missing, queue
 * it" step the language-picker route runs inline right after a client picks
 * a language. Shared here (dev job 4fa1d8e5) so the daily top-up cron
 * (scripts/cron: portal-translation-topup) can run the identical step for
 * every already-established language, instead of only ever running it when
 * a client happens to reselect that language after new text is added.
 *
 * Returns which source (if any) had missing work and got a job queued —
 * `null` means everything for this language is already done or already has
 * a live job in flight.
 */
/**
 * True when the translation watchdog (lib/jobs/translation-watchdog.ts) has
 * already logged this exact (language, source) scope as exhausted — its
 * backoff ladder spent, one staff alert already sent, deliberately left for
 * a human to look at rather than auto-retried forever. Checked here (dev job
 * 4fa1d8e5, council review) so this function's own fresh chunk-0 enqueue
 * can't silently reset that ladder: without this check, a daily caller (the
 * top-up cron) would create a brand-new chunk_index:0/auto_retry:0 job every
 * day for a permanently-broken source — replaying the full retry ladder and
 * sending a fresh staff alert every single day forever, exactly the
 * "one-time incident becomes a daily recurring one" failure this guards.
 * A human fixing the underlying issue and wanting a fresh attempt still has
 * the normal path: the language-picker route's own kickoff runs unconditionally
 * from a client's next pick, OR staff can delete the exhaustion action_log row.
 */
async function hasUnresolvedExhaustion(languageCode: string, source: TranslationSource): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("action_log")
    .select("id")
    .eq("action_type", "translation_chain_exhausted")
    .eq("details->>scope", `translate:${languageCode}:${source}`)
    .limit(1)
  return !!data && data.length > 0
}

export async function kickoffMissingTranslationWork(languageCode: string, createdBy: string): Promise<{ source: TranslationSource; missing: number } | null> {
  for (const { source, dictionary } of TRANSLATION_SOURCES_IN_ORDER) {
    const seeded = await seedPendingTranslations(languageCode, dictionary())
    if (seeded.missing > 0) {
      if (!(await hasLiveTranslateJob(languageCode, source)) && !(await hasUnresolvedExhaustion(languageCode, source))) {
        const inserted = await enqueueJob({
          job_type: "translate_language",
          payload: { language_code: languageCode, language_name: languageName(languageCode) ?? languageCode, source, chunk_index: 0, auto_retry: 0 },
          created_by: createdBy,
        })
        // Post-insert verify (same non-atomic SELECT-then-INSERT guard used
        // throughout this feature, e.g. translate-language.ts's own
        // chain-continuation enqueue): a concurrent caller (the cron and a
        // client's own pick can both pass the hasLiveTranslateJob check
        // before either has inserted) could otherwise leave two live jobs
        // for the same (language, source) scope.
        const { data: live } = await supabaseAdmin
          .from("job_queue")
          .select("id")
          .in("status", ["pending", "processing"])
          .eq("job_type", "translate_language")
          .eq("payload->>language_code", languageCode)
          .eq("payload->>source", source)
        if ((live ?? []).length > 1) {
          await supabaseAdmin.from("job_queue").delete().eq("id", inserted.id).eq("status", "pending")
        }
      }
      return { source, missing: seeded.missing }
    }
  }
  return null
}

/**
 * Every language code at least one real client account currently has set as
 * their portal_language (dev job 4fa1d8e5, revised after council review).
 * Deliberately NOT "every code that ever had a portal_translations row" —
 * council found that scope live on sandbox: a handful of stray codes (ab,
 * gd, cy) from unrelated past testing had rows and would be "established"
 * forever with zero real reader, permanently costing real paid AI-translation
 * calls on every future content addition with no way to ever un-enroll them.
 * Sourcing from CURRENT user_metadata instead means a language a client no
 * longer uses naturally stops being topped up on its own — no manual
 * cleanup, no permanent zombie enrollment. `en`/`it` are excluded even if a
 * user has them set: they're the two hand-written static dictionaries, not
 * AI-generated, and seedPendingTranslations() short-circuits for them anyway.
 *
 * Paginates via listUsers() rather than a portal_translations table scan —
 * bounded by the portal's real user count (hundreds, not millions), same
 * order of magnitude already proven safe manually against this exact table.
 */
export async function getEstablishedLanguageCodes(): Promise<string[]> {
  const codes = new Set<string>()
  const perPage = 200
  for (let page = 1; page <= 100; page++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- auth.admin typing doesn't expose user_metadata's app-specific shape
    const { data, error } = await (supabaseAdmin as any).auth.admin.listUsers({ page, perPage })
    if (error) break
    const users = data?.users ?? []
    for (const u of users) {
      const lang = u.user_metadata?.portal_language
      if (typeof lang === "string" && lang && !(SUPPORTED_LOCALES as readonly string[]).includes(lang)) {
        codes.add(lang)
      }
    }
    if (users.length < perPage) break
  }
  return Array.from(codes)
}
