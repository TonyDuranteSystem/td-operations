import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { checkImportRange, importLeadsFromMeta } from "@/lib/marketing/meta-leads/import-history"
import { liveImportDeps } from "@/lib/marketing/meta-leads/service"
import { romeStartOfDay, romeStartOfNextDay } from "@/lib/marketing/master-view"

export const dynamic = "force-dynamic"
export const maxDuration = 60
const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing-admin/meta/import-history { from: "YYYY-MM-DD", to: "YYYY-MM-DD", dryRun: boolean } — pulls OLDER leads from Meta (TD Marketing, dev job 9aec66fa).
 * Admin only (the strict check). `from` and `to` are whole days in Rome time, both included. dryRun counts and writes nothing; a real run stores each lead once
 * (a lead we already hold is skipped), so it is safe to repeat. Answers how many were seen / already held / added per day.
 */
export async function POST(req: NextRequest) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  const body = await req.json().catch(() => ({})) as { from?: unknown; to?: unknown; dryRun?: unknown }
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
  const f = day(body.from), t = day(body.to)
  if (!f || !t) return NextResponse.json({ error: "Pick a start and an end date." }, { status: 400, headers: NO_STORE })
  const since = romeStartOfDay(new Date(`${f}T12:00:00Z`))
  const until = romeStartOfNextDay(new Date(`${t}T12:00:00Z`))
  const range = checkImportRange(since.toISOString(), until.toISOString(), new Date())
  if (range.ok === false) return NextResponse.json({ error: range.error }, { status: 400, headers: NO_STORE })
  const dryRun = body.dryRun !== false // anything but an explicit false only counts
  try {
    const res = await importLeadsFromMeta(await liveImportDeps(), range, dryRun)
    console.warn(`[meta-leads] history import by ${user.email ?? user.id}: ${f}..${t} dryRun=${dryRun} seen=${res.seen} held=${res.alreadyHeld} added=${res.added} errors=${res.errors.length}`)
    return NextResponse.json(res, { headers: NO_STORE })
  } catch (e) {
    console.error("[meta-leads] history import failed:", e instanceof Error ? e.message : e)
    return NextResponse.json({ error: "The import could not run. Nothing was changed; try again." }, { status: 500, headers: NO_STORE })
  }
}
