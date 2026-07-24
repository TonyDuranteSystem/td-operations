/**
 * GET /api/cron/oa-finalize-sweep — Bearer CRON_SECRET.
 *
 * Safety net for the server-side OA signing. Normally the last signer's request
 * renders the executed agreement + certificate and files it. If that step hiccups
 * (render error, storage/Drive blip, function timeout), the agreement is left
 * "partially_signed" with every signature collected. This sweep finds those and
 * finishes them — idempotently, and NEVER for a paper ("by_hand") agreement.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { logCron } from "@/lib/cron-log"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { finalizeOaAgreement } from "@/lib/oa/finalize-signing"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const start = Date.now()
  try {
    // Candidates: fully-signed by the counter, not yet "signed", not voided. The
    // by_hand exclusion is done in JS, NOT in SQL: a stuck row has
    // signature_method = NULL (it is set to 'electronic' only at the flip), and a
    // SQL `not.eq 'by_hand'` drops NULL rows under three-valued logic — which would
    // make this sweep never find the very rows it exists to catch.
    const { data: rows } = await db
      .from("oa_agreements")
      .select("id, token, company_name, status, signed_count, total_signers, signature_method")
      .neq("status", "signed")
      .neq("status", "voided")
      .limit(50)

    const stuck = (rows ?? []).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r: any) => r.signature_method !== "by_hand" && (r.signed_count || 0) >= (r.total_signers || 1),
    )

    const results: Array<{ id: string; outcome: string }> = []
    for (const r of stuck) {
      const res = await finalizeOaAgreement(r.id)
      results.push({
        id: r.id,
        outcome: res.ok ? ("pdfPath" in res && res.pdfPath ? "finalized" : `skipped:${res.skipped}`) : `error:${res.error}`,
      })
    }

    logCron({
      endpoint: "/api/cron/oa-finalize-sweep",
      status: "success",
      duration_ms: Date.now() - start,
      details: { candidates: stuck.length, results },
    })
    return NextResponse.json({ ok: true, finalized: results.filter(r => r.outcome === "finalized").length, results })
  } catch (err) {
    logCron({
      endpoint: "/api/cron/oa-finalize-sweep",
      status: "error",
      duration_ms: Date.now() - start,
      error_message: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
