/**
 * GET /api/crm/leads/free-calls
 *
 * Recent recorded calls that nobody is attached to yet (no lead, no client contact, no company),
 * for the "New lead from a call" picker on the Leads page. Admin-only, same permission as creating a lead.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { toCallChoice, suggestLeadFromCall, type CallPickerRow } from "@/lib/leads/lead-from-call"

const WINDOW_DAYS = 30
const MAX_CALLS = 60

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!canPerform(user, "create_lead")) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 })
  }

  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString()
  const { data, error } = await supabaseAdmin
    .from("call_summaries")
    .select("id, meeting_name, duration_seconds, attendees, created_at, lead_id, contact_id, account_id")
    .is("lead_id", null)
    .is("contact_id", null)
    .is("account_id", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_CALLS)

  if (error) {
    console.error("[leads/free-calls] query failed:", error.message)
    return NextResponse.json({ error: "Could not load the calls — please try again." }, { status: 500 })
  }

  const calls = ((data ?? []) as CallPickerRow[]).map(row => {
    const choice = toCallChoice(row)
    return { ...choice, suggestion: suggestLeadFromCall(choice) }
  })
  return NextResponse.json({ calls })
}
