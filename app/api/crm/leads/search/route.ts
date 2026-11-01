/**
 * GET /api/crm/leads/search?q=...
 *
 * Live suggestions for the Leads page search box. Same matching as the list
 * search (name, email, and phone in any format), but returns only the top few
 * rows. Uses the signed-in staff member's own session — no admin client — so
 * it can never show more than the Leads page itself shows.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { findLeadIdsByPhone, leadSearchOrFilter } from "@/lib/leads/phone-search"

const MAX_RESULTS = 8
const MIN_CHARS = 2

export async function GET(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 })
  }

  const q = new URL(request.url).searchParams.get("q")?.trim() ?? ""
  if (q.length < MIN_CHARS) {
    return NextResponse.json({ results: [] })
  }

  try {
    const phoneIds = await findLeadIdsByPhone(supabase, q)
    const { data, error } = await supabase
      .from("leads")
      .select("id, full_name, email, phone, status, existing_client_contact_id")
      .or(leadSearchOrFilter(q, phoneIds))
      .order("created_at", { ascending: false })
      .limit(MAX_RESULTS)

    if (error) {
      console.error("[leads/search] query failed:", error.message)
      return NextResponse.json({ error: "Search failed — please try again." }, { status: 500 })
    }
    return NextResponse.json({ results: data ?? [] })
  } catch (err) {
    console.error("[leads/search] unexpected error:", err)
    return NextResponse.json({ error: "Search failed — please try again." }, { status: 500 })
  }
}
