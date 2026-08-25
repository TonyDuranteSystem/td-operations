import { supabaseAdmin } from "@/lib/supabase-admin"
import { enqueueJob } from "@/lib/jobs/queue"
import { seedPendingTranslations } from "@/lib/portal/translation-generator"
import { SOURCES_IN_ORDER, sourceDictionaryFor, type TranslationSource } from "@/lib/portal/translation-sources"

/**
 * Shared "does this language still need work, and is anything already
 * running" check — the one seed/enqueue loop for a language against the
 * three content sources, in chain order. Extracted from the language-picker
 * route (dev job 12cab351) so a second real caller (the catch-up sweep,
 * lib/jobs/handlers/portal-translation-catchup — added because Spanish and
 * French silently fell behind after new content was added to an already-
 * translated source with nothing to notice and re-seed them) doesn't have to
 * hand-roll a second copy of this loop.
 *
 * Only ever enqueues the FIRST source (in chain order) that still has
 * missing work — a returning/already-active language whose earlier sources
 * are done only needs whichever one source is genuinely behind. That job's
 * own chain (lib/jobs/handlers/translate-language.ts's NEXT_SOURCE hop)
 * carries it through any remaining sources after that.
 */

/**
 * The job handler's own chain-continuation dedup only guards chunk-to-chunk
 * within an already-running chain — it never protected this initial enqueue.
 * Two callers (two clients/devices picking the same language at once, or a
 * client's pick racing this same sweep) could each start their own chunk-0
 * job for it. Per-key claiming inside the job still prevents double-
 * translating any single entry, but this avoids the wasted duplicate job
 * outright (found in review, 2026-08-23).
 */
export async function hasLiveTranslateJob(languageCode: string, source: TranslationSource): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- job_queue payload JSON path filter, not yet in generated types
  const { data } = await (supabaseAdmin as any)
    .from("job_queue")
    .select("id")
    .eq("job_type", "translate_language")
    .eq("payload->>language_code", languageCode)
    .eq("payload->>source", source)
    .in("status", ["pending", "processing"])
    .limit(1)
  return !!data && data.length > 0
}

export interface CatchUpResult {
  /** True if a translate_language job was newly enqueued this call. */
  enqueued: boolean
  /** The source that still has missing work (enqueued now, or already has a
   *  live job in flight) — undefined if every source is fully translated. */
  source?: TranslationSource
  /** True when `source` has missing work but a job for it was already
   *  running, so nothing new was enqueued. */
  alreadyRunning?: boolean
}

/**
 * Seed+enqueue the first source (in chain order) that still has missing
 * work for `languageCode`. No-ops cheaply (one read-only seed check per
 * source, at most 3) when everything is already caught up — safe to call
 * on every language pick, and safe to call repeatedly from a periodic sweep.
 */
export async function catchUpLanguage(languageCode: string, languageName: string): Promise<CatchUpResult> {
  for (const source of SOURCES_IN_ORDER) {
    const seeded = await seedPendingTranslations(languageCode, sourceDictionaryFor(source))
    if (seeded.missing > 0) {
      if (await hasLiveTranslateJob(languageCode, source)) {
        return { enqueued: false, source, alreadyRunning: true }
      }
      await enqueueJob({
        job_type: "translate_language",
        payload: { language_code: languageCode, language_name: languageName, source, chunk_index: 0, auto_retry: 0 },
        created_by: "portal-language-picker",
      })
      return { enqueued: true, source }
    }
  }
  return { enqueued: false }
}
