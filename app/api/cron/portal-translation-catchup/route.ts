/**
 * CRON: any-language translation catch-up sweep (dev job 12cab351).
 *
 * Runs every 30 minutes. The only place that ever checks "does this
 * already-picked language have everything it should" is the language-picker
 * route itself (app/api/portal/language/route.ts) — it fires once, when a
 * client actively opens their language setting and picks/re-picks. Nothing
 * previously re-checked an already-active language after that moment, so
 * when new content was added to an existing source (the wizard-UI-text
 * migration, then separately the whole help-guide library) any language that
 * had already finished translating before that addition landed just silently
 * stayed behind forever — found live 2026-08-25: Spanish was missing an
 * entire later-added batch of intake-questionnaire wording, and French was
 * missing that same batch plus its whole help-guide section, because both
 * had already finished translating before those additions shipped and never
 * revisited their language setting afterward.
 *
 * Scope, deliberately narrow: sweeps every language CURRENTLY selected by a
 * real user (auth.users.user_metadata.portal_language), not every language
 * that ever got a portal_translations row. A language tried once via admin
 * "View As" or ad-hoc testing and never actually chosen by a live client
 * would otherwise get swept (and billed AI-translation work) forever.
 *
 * Cheap by construction: catchUpLanguage() does a read-only seed check per
 * content source (at most 3) and enqueues nothing when a language is already
 * caught up, so this is a no-op for every language most of the time — safe
 * to run this often. Reuses the exact same catch-up logic the language-picker
 * route already uses (lib/portal/language-catchup.ts) rather than a second
 * copy of it.
 */

import { NextRequest, NextResponse } from "next/server"
import { logCron } from "@/lib/cron-log"
import { listAllAuthUsers } from "@/lib/auth-admin-helpers"
import { SUPPORTED_LOCALES } from "@/lib/portal/i18n"
import { languageName } from "@/lib/portal/language-codes"
import { catchUpLanguage } from "@/lib/portal/language-catchup"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const users = await listAllAuthUsers()
    const activeLanguages = new Set<string>()
    for (const u of users) {
      const lang = (u.user_metadata as { portal_language?: string } | undefined)?.portal_language
      if (lang && !(SUPPORTED_LOCALES as readonly string[]).includes(lang)) {
        activeLanguages.add(lang)
      }
    }

    const results: Array<{ language: string; outcome: string }> = []
    for (const lang of Array.from(activeLanguages)) {
      try {
        const r = await catchUpLanguage(lang, languageName(lang) ?? lang)
        if (r.enqueued) results.push({ language: lang, outcome: `caught up (${r.source})` })
        else if (r.alreadyRunning) results.push({ language: lang, outcome: `already running (${r.source})` })
        else results.push({ language: lang, outcome: "fully translated" })
      } catch (rowErr) {
        // Fault isolation: one language's catch-up failing must not abort the
        // sweep for the rest (same posture as every other sweep cron here).
        results.push({ language: lang, outcome: `error: ${rowErr instanceof Error ? rowErr.message : String(rowErr)}` })
      }
    }

    const caughtUp = results.filter((r) => r.outcome.startsWith("caught up"))
    const errored = results.filter((r) => r.outcome.startsWith("error"))

    logCron({
      endpoint: "/api/cron/portal-translation-catchup",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: { checked: results.length, caughtUp: caughtUp.length, errored: errored.length, results },
    })

    return NextResponse.json({
      ok: true,
      checked: results.length,
      caughtUp: caughtUp.length,
      errored: errored.length,
      results,
    })
  } catch (err) {
    logCron({
      endpoint: "/api/cron/portal-translation-catchup",
      status: "error",
      duration_ms: Date.now() - startTime,
      error_message: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
