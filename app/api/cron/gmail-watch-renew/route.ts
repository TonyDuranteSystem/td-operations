import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { INTERNAL_BASE_URL } from "@/lib/config"
import { ensurePushSubscription, registerWatch } from "@/lib/gmail-push"

// gmail_push_events is not in the generated Database types yet (regenerated
// from production after the prod DDL). Same escape hatch as
// lib/system-errors.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export const dynamic = "force-dynamic"

/**
 * GET /api/cron/gmail-watch-renew — daily.
 *
 * Gmail watches expire after ~7 days; re-registering daily keeps real-time
 * push alive with margin. Also keeps the Pub/Sub push subscription pointed
 * at the PROD webhook and prunes old wake-up rows. Production-only: sandbox
 * must never (re)configure the shared push pipeline.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (process.env.SANDBOX_MODE === "1") {
    return NextResponse.json({ skipped: "sandbox — push pipeline is prod-only" })
  }

  const endpoint = `${INTERNAL_BASE_URL}/api/webhooks/gmail-push`
  const results: Record<string, string> = {}

  try {
    await ensurePushSubscription(endpoint)
    results.subscription = "ok"
  } catch (err) {
    results.subscription = `error: ${err instanceof Error ? err.message : String(err)}`
  }

  for (const mailbox of ["support", "antonio"] as const) {
    try {
      const watch = await registerWatch(mailbox)
      results[mailbox] = `ok (expires ${new Date(parseInt(watch.expiration)).toISOString()})`
    } catch (err) {
      results[mailbox] = `error: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // Prune wake-up rows older than 2 days (they are signals, not history).
  // Covers BOTH realtime buses: gmail push events and the dashboard
  // cross-tab ui_events (lib/ui-events.ts).
  const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
  await db.from("gmail_push_events").delete().lt("created_at", cutoff)
  await db.from("ui_events").delete().lt("created_at", cutoff)

  const failed = Object.values(results).some((v) => v.startsWith("error"))
  return NextResponse.json({ ok: !failed, results }, { status: failed ? 500 : 200 })
}
