/**
 * GET /api/feed/target-services?account_id=X | ?contact_id=X
 *
 * Returns the active service deliveries on the chosen target, scoped exactly
 * the way PR 2 scoped portal contact reads (lib/portal/queries.ts:305,336):
 *   - account target → service_deliveries WHERE account_id = X
 *   - contact target → service_deliveries WHERE contact_id = X AND account_id IS NULL
 *
 * The contact-side `account_id IS NULL` filter mirrors the formation
 * architecture rule "ownership = whoever paid, never migrates" — services
 * that have been linked to a company belong to the company, not the contact.
 *
 * Used by the bank-feed-tab modal's "Attach payment to existing service"
 * branch (Bank-feed Tier B redesign 2026-05-05).
 *
 * Auth: dashboard session (admin staff use the bank-feed UI).
 */
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const accountId = req.nextUrl.searchParams.get("account_id")?.trim() || null
  const contactId = req.nextUrl.searchParams.get("contact_id")?.trim() || null

  if (!accountId && !contactId) {
    return NextResponse.json(
      { error: "account_id or contact_id required" },
      { status: 400 },
    )
  }
  if (accountId && contactId) {
    return NextResponse.json(
      { error: "pass account_id OR contact_id, not both" },
      { status: 400 },
    )
  }

  let query = supabaseAdmin
    .from("service_deliveries")
    .select("id, service_type, service_name, stage, status, start_date")
    .eq("status", "active") // only non-terminal SDs are eligible for attach
    .order("start_date", { ascending: false })
    .limit(50)

  if (accountId) {
    query = query.eq("account_id", accountId)
  } else {
    // PR 2 convention: contact-scoped reads exclude account-linked rows
    query = query.eq("contact_id", contactId!).is("account_id", null)
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json(
      { error: `Lookup failed: ${error.message}` },
      { status: 500 },
    )
  }

  return NextResponse.json({ services: data ?? [] })
}
