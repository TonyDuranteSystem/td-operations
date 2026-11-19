export const dynamic = 'force-dynamic'
/**
 * Nightly safety net for a company whose closing is HELD for its final tax return (dev job 0a60f416, part C).
 *
 * The normal path is immediate: when the last open Tax Return reaches "TR Filed" (advanceServiceDelivery) or is cancelled (deactivateSD) the closing completes
 * on the spot. But a Tax Return can also be cancelled or removed from the Tax Returns tracker, the account status dialog or the contact actions without going
 * through either, and a first completion can fail — then nothing would ever close the company, and the nightly jobs would skip it for good. This sweep looks at
 * every waiting company once a day and completes the closing of any whose Tax Returns are all done or gone. It changes nothing for a company that still has
 * an open Tax Return (completePendingCompanyClosure answers "still waiting"), and nothing for a company nobody asked to wait.
 */
import { NextRequest, NextResponse } from "next/server"
import { findWaitingClosures } from "@/lib/closure/closing-wait"
import { completePendingCompanyClosure } from "@/lib/operations/close-company"
import { logCron } from "@/lib/cron-log"

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  try {
    const authHeader = req.headers.get("authorization")
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const waiting = await findWaitingClosures()
    const results: Array<{ accountId: string; action: string }> = []
    let completed = 0
    for (const w of waiting) {
      const r = await completePendingCompanyClosure({ accountId: w.accountId })
      if (r.problems.length > 0) results.push({ accountId: w.accountId, action: `problem: ${r.problems.join(" · ")}` })
      else if (r.waiting) results.push({ accountId: w.accountId, action: "still waiting" })
      else {
        completed++
        results.push({ accountId: w.accountId, action: "closing completed" })
      }
    }

    logCron({
      endpoint: "/api/cron/complete-held-closings",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: { waiting: waiting.length, completed, results },
    })
    return NextResponse.json({ ok: true, waiting: waiting.length, completed, results })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logCron({ endpoint: "/api/cron/complete-held-closings", status: "error", duration_ms: Date.now() - startTime, details: { error: message } })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
