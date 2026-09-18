/**
 * CRON: Portal translation top-up (dev job 4fa1d8e5).
 *
 * Antonio: keep already-established portal languages current automatically,
 * instead of waiting for a client to happen to (re)pick that language after
 * new client-facing text is added. This runs daily and, for every language
 * a real client account currently has selected, checks whether the live
 * dictionary / wizard / guide content has grown since that language was
 * last topped up and queues whatever's missing.
 *
 * Deliberately scoped to languages CURRENTLY selected by a real account
 * (getEstablishedLanguageCodes — reads user_metadata.portal_language, not
 * "ever had a portal_translations row"): a council review caught the
 * original wider scope live on sandbox — a handful of stray codes from
 * unrelated past testing (ab, gd, cy) had rows and would have been
 * "established" forever with zero real reader, permanently costing real
 * paid AI-translation calls on every future content addition. Sourcing from
 * CURRENT selections means a language nobody uses anymore naturally drops
 * out on its own. Also capped at MAX_LANGUAGES_PER_TOPUP_RUN per run so one
 * content push can't fan out into unbounded simultaneous paid chains — any
 * language past the cap just waits for the next day's run. A brand-new
 * language a client picks for the first time is still translated on the
 * spot by the existing language-picker route, unaffected by this cron.
 *
 * Reuses the exact same seed+enqueue step the language-picker route runs
 * inline (lib/portal/translation-generator.ts::kickoffMissingTranslationWork)
 * — this cron is only the periodic trigger, not a second implementation.
 * That shared step also respects the translation watchdog's own exhaustion
 * signal (hasUnresolvedExhaustion) so a permanently-broken language/source
 * doesn't get a fresh retry ladder — and a fresh staff alert — every day.
 *
 * Schedule: Daily via Vercel Cron.
 */

import { NextRequest, NextResponse } from "next/server"
import { logCron } from "@/lib/cron-log"
import { getEstablishedLanguageCodes, kickoffMissingTranslationWork } from "@/lib/portal/translation-generator"
import { MAX_LANGUAGES_PER_TOPUP_RUN } from "@/lib/portal/language-cap"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const results: Array<{ language: string; queued: string | null; missing?: number }> = []
  let errorMessage: string | undefined
  let totalEstablished = 0

  try {
    const languages = await getEstablishedLanguageCodes()
    totalEstablished = languages.length
    for (const lang of languages.slice(0, MAX_LANGUAGES_PER_TOPUP_RUN)) {
      try {
        const outcome = await kickoffMissingTranslationWork(lang, "portal-translation-topup-cron")
        results.push({ language: lang, queued: outcome?.source ?? null, missing: outcome?.missing })
      } catch (e) {
        // One language's failure (a transient DB hiccup, a bad row) must
        // never stop the rest of the run — each language is independent.
        results.push({ language: lang, queued: null })
        console.error(`[cron/portal-translation-topup] failed for "${lang}":`, e)
      }
    }
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e)
    console.error("[cron/portal-translation-topup] failed to list established languages:", e)
  }

  const duration_ms = Date.now() - startTime
  logCron({
    endpoint: "portal-translation-topup",
    status: errorMessage ? "error" : "success",
    duration_ms,
    error_message: errorMessage,
    details: { totalEstablished, checked: results.length, queued: results.filter(r => r.queued).length, results },
  })

  return NextResponse.json({ totalEstablished, checked: results.length, queued: results.filter(r => r.queued).length, results, error: errorMessage })
}
