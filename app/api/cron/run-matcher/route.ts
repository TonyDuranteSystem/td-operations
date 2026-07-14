/**
 * One-time matcher run — processes ALL unmatched bank feeds.
 * Used for batch reconciliation after data cleanup or matcher enhancement.
 *
 * Goes through the ORCHESTRATOR, not matchAndReconcile directly: the matcher marks the
 * invoice Paid but has no knowledge of pending_activations, so running it alone leaves
 * the client's service un-activated with no way to notice.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { processOneFeed } from "@/lib/operations/process-bank-feed-matches"
import { logCron } from "@/lib/cron-log"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: feeds, error } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("id")
    .eq("status", "unmatched")
    .order("amount", { ascending: false })

  if (error || !feeds) {
    return NextResponse.json({ error: error?.message || "No feeds" }, { status: 500 })
  }

  const results = {
    total: feeds.length,
    matched: 0,
    unmatched: 0,
    errors: 0,
    matches: [] as Array<{ feedId: string; invoiceNumber?: string; confidence?: string }>,
  }

  for (const feed of feeds) {
    const result = await processOneFeed(feed.id)
    if (result.matched) {
      results.matched++
      results.matches.push({
        feedId: feed.id,
        invoiceNumber: result.invoiceNumber,
        confidence: result.confidence,
      })
    } else if (result.error) {
      results.errors++
    } else {
      results.unmatched++
    }
  }

  logCron({
    endpoint: "/api/cron/run-matcher",
    status: "success",
    duration_ms: Date.now() - startTime,
    details: results,
  })

  return NextResponse.json(results)
}
