/**
 * CRON: Portal translation top-up (dev job 4fa1d8e5).
 *
 * Antonio: keep already-established portal languages current automatically,
 * instead of waiting for a client to happen to (re)pick that language after
 * new client-facing text is added. This runs daily and, for every language
 * that already has real translation investment (anything a client has ever
 * picked, or that was pre-generated), checks whether the live dictionary /
 * wizard / guide content has grown since that language was last topped up
 * and queues whatever's missing.
 *
 * Deliberately scoped to ESTABLISHED languages only (getEstablishedLanguageCodes
 * — every language_code with at least one portal_translations row), not all
 * ~180 ISO codes the picker offers: translating into a language nobody has
 * ever chosen would spend real paid AI-translation calls for nothing. A
 * brand-new language a client picks for the first time is still translated
 * on the spot by the existing language-picker route, unaffected by this cron.
 *
 * Reuses the exact same seed+enqueue step the language-picker route runs
 * inline (lib/portal/translation-generator.ts::kickoffMissingTranslationWork)
 * — this cron is only the periodic trigger, not a second implementation.
 *
 * Schedule: Daily via Vercel Cron.
 */

import { NextRequest, NextResponse } from "next/server"
import { logCron } from "@/lib/cron-log"
import { getEstablishedLanguageCodes, kickoffMissingTranslationWork } from "@/lib/portal/translation-generator"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const results: Array<{ language: string; queued: string | null; missing?: number }> = []
  let errorMessage: string | undefined

  try {
    const languages = await getEstablishedLanguageCodes()
    for (const lang of languages) {
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
    details: { checked: results.length, queued: results.filter(r => r.queued).length, results },
  })

  return NextResponse.json({ checked: results.length, queued: results.filter(r => r.queued).length, results, error: errorMessage })
}
