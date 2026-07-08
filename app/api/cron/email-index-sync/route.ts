import { NextRequest, NextResponse } from "next/server"
import { backfillStep, syncIncremental, MAILBOX_ADDRESSES } from "@/lib/email-index/sync"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"
export const maxDuration = 300

// gmail_watch_state extra columns not in generated types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/**
 * GET /api/cron/email-index-sync — every 10 min.
 *
 * Two jobs per mailbox:
 *  1. BACKFILL: while not done, index the next page of mailbox history
 *     (resumable cursor in gmail_watch_state) — the one-time full build.
 *  2. RECONCILE: incremental history sync as a safety net behind the
 *     gmail-push-driven sync (heals missed pushes / expired cursors).
 *
 * Runs in BOTH environments: sandbox and production each maintain their own
 * index of the same mailboxes (reads only — no webhook registration here).
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const results: Record<string, unknown> = {}
  const startedAt = Date.now()

  for (const mailbox of ["support", "antonio"] as const) {
    try {
      // Up to 3 backfill pages per mailbox per run, within the time budget
      // (~180 threads/run/mailbox → full history in hours, not days)
      let bf = await backfillStep(mailbox)
      let pages = 1
      while (!bf.done && pages < 3 && Date.now() - startedAt < 180_000) {
        const next = await backfillStep(mailbox)
        bf = {
          indexedThreads: bf.indexedThreads + next.indexedThreads,
          indexedMessages: bf.indexedMessages + next.indexedMessages,
          done: next.done,
        }
        pages += 1
      }
      let sync: { threads: number } | null = null
      if (bf.done) {
        // Reconcile from the current profile historyId
        const profile = (await import("@/lib/gmail").then(({ gmailGet }) =>
          gmailGet("/profile", undefined, MAILBOX_ADDRESSES[mailbox])
        )) as { historyId?: string }
        if (profile.historyId) {
          sync = await syncIncremental(mailbox, String(profile.historyId))
        }
      }
      results[mailbox] = { backfill: bf, reconcile: sync }
    } catch (err) {
      results[mailbox] = { error: err instanceof Error ? err.message : String(err) }
    }
  }

  const { count } = await db
    .from("email_index")
    .select("id", { count: "exact", head: true })
  results.total_indexed = count ?? null

  return NextResponse.json({ ok: true, results })
}
