/**
 * GET   /api/tax-quote/[token]/data?preview=td   — fetch the tax quote submission
 * PATCH /api/tax-quote/[token]/data               — track-open, or record the completed submission
 *   body: { preview?, action: "track_open" | "submit", ...submitted fields }
 *
 * Replaces app/tax-quote/[token]/page.tsx's direct anon-key browser queries
 * against tax_quote_submissions. See lib/public-forms/verify-token-access.ts
 * for why a client-supplied token filter was never actually enforced by the
 * database.
 *
 * UNLIKE every other public-form table converted so far, tax_quote_submissions
 * has NO access_code column at all (confirmed against lib/database.types.ts) —
 * the token itself is the only secret, by original design (it's also absent
 * from lib/access-code.ts's FORM_TABLE_MAP, the real list of token+code
 * forms). So this route does NOT use verifyTokenAccess (which requires an
 * access_code and fails closed on a blank one, which would incorrectly deny
 * every request here) — it looks up by token alone, same security promise
 * the page already made, just moved server-side so the anon grant can be
 * revoked.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffPreview } from "@/lib/auth/staff-preview"

type Params = { params: Promise<{ token: string }> }

interface TaxQuoteRow {
  id: string
  status: string | null
}

export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params
  const preview = req.nextUrl.searchParams.get("preview") === "td"
  const isAdmin = await isStaffPreview(preview)

  const { data, error } = await supabaseAdmin
    .from("tax_quote_submissions")
    .select("*")
    .eq("token", token)
    .maybeSingle()
  if (error || !data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  return NextResponse.json({ data, isAdmin })
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { token } = await params
  const body = await req.json().catch(() => ({}))

  const { data: row, error: lookupError } = await supabaseAdmin
    .from("tax_quote_submissions")
    .select("id, status")
    .eq("token", token)
    .maybeSingle()
  if (lookupError || !row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  const typedRow = row as TaxQuoteRow

  if (body.action === "track_open") {
    // Mirrors the page's prior client-side behavior exactly: only a
    // pending/sent submission promotes to "opened".
    if (typedRow.status !== "pending" && typedRow.status !== "sent") {
      return NextResponse.json({ ok: true, skipped: true })
    }
    const { error } = await supabaseAdmin
      .from("tax_quote_submissions")
      .update({ opened_at: new Date().toISOString(), status: "opened" })
      .eq("id", typedRow.id)
    if (error) return NextResponse.json({ error: "Failed to record view" }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (body.action === "submit") {
    // Same double-predicate write guard as every other converted form: the
    // read-time status check alone can't stop two near-simultaneous submits,
    // so the same condition is repeated on the UPDATE itself.
    if (typedRow.status === "completed" || typedRow.status === "processed") {
      return NextResponse.json({ error: "Already submitted" }, { status: 409 })
    }
    const { llc_name, llc_state, llc_type, tax_year, client_name, client_email, client_phone } = body
    if (!llc_name || !llc_state || !llc_type || !tax_year || !client_name || !client_email) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }
    const { data: updated, error } = await supabaseAdmin
      .from("tax_quote_submissions")
      .update({
        llc_name: String(llc_name).trim(),
        llc_state,
        llc_type,
        tax_year,
        client_name: String(client_name).trim(),
        client_email: String(client_email).trim().toLowerCase(),
        client_phone: client_phone ? String(client_phone).trim() : null,
        status: "completed",
        completed_at: new Date().toISOString(),
        client_user_agent: req.headers.get("user-agent") ?? "",
      })
      .eq("id", typedRow.id)
      .not("status", "in", "(completed,processed)")
      .select("id")
      .maybeSingle()
    if (error) return NextResponse.json({ error: "Failed to record submission" }, { status: 500 })
    if (!updated) {
      return NextResponse.json({ error: "Already submitted" }, { status: 409 })
    }
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
