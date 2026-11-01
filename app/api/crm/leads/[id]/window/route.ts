/**
 * GET /api/crm/leads/[id]/window
 *
 * Everything the floating lead window shows, in one read-only call (dev job
 * 6fc63c52, phase A). Staff only. Nothing is written.
 *
 * The lead, offers, emails, contracts and activation are read with the staff
 * member's own session (so they can never see more than the lead page itself).
 * Call recordings are read with the service client — same as the lead page —
 * but only AFTER the staff check, and the big transcript column is never
 * fetched here: only which calls have one. The transcript has its own route.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { buildLeadWindowData, type WindowCallRow } from "@/lib/leads/window-data"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CALL_COLUMNS = "id, meeting_name, duration_seconds, notes, recording_url, created_at"

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const id = params.id
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "That is not a valid lead id." }, { status: 400 })
  }

  try {
    const supabase = createClient()
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("id, full_name, email, phone, language, source, referrer_name, status, call_date, notes, created_at, updated_at, existing_client_contact_id, converted_to_contact_id, circleback_call_id")
      .eq("id", id)
      .maybeSingle()
    if (leadError) {
      console.error("[leads/window] lead query failed:", leadError.message)
      return NextResponse.json({ error: "Could not load this lead — please try again." }, { status: 500 })
    }
    if (!lead) return NextResponse.json({ error: "Lead not found." }, { status: 404 })

    const { data: offers } = await supabase
      .from("offers")
      .select("token, status, version, created_at, viewed_at, view_count, superseded_by")
      .eq("lead_id", id)
    const offerTokens = (offers ?? []).map(o => o.token)

    const [emailsRes, contractsRes, activationRes, callsRes, textRes] = await Promise.all([
      supabase.from("email_tracking").select("id, subject, created_at, first_opened_at").eq("lead_id", id).order("created_at", { ascending: true }),
      offerTokens.length > 0
        ? supabase.from("contracts").select("offer_token, signed_at").in("offer_token", offerTokens)
        : Promise.resolve({ data: [] as { offer_token: string; signed_at: string | null }[] }),
      supabase
        .from("pending_activations")
        .select("id, status, amount, currency, payment_confirmed_at, created_at")
        .eq("lead_id", id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin.from("call_summaries").select(CALL_COLUMNS).eq("lead_id", id).order("created_at", { ascending: true }),
      supabaseAdmin.from("call_summaries").select("id").eq("lead_id", id).not("transcript", "is", null),
    ])

    let calls = (callsRes.data ?? []) as WindowCallRow[]
    // Older edge the lead page also handles: the pointer is set but the call was never back-linked by lead_id.
    if (lead.circleback_call_id && !calls.some(c => c.id === lead.circleback_call_id)) {
      const { data: pointer } = await supabaseAdmin
        .from("call_summaries")
        .select(CALL_COLUMNS)
        .eq("id", lead.circleback_call_id)
        .maybeSingle()
      if (pointer) calls = [...calls, pointer as WindowCallRow]
    }
    const transcriptIds = new Set((textRes.data ?? []).map(r => r.id as string))
    if (lead.circleback_call_id && calls.some(c => c.id === lead.circleback_call_id) && !transcriptIds.has(lead.circleback_call_id)) {
      const { data: t } = await supabaseAdmin.from("call_summaries").select("id").eq("id", lead.circleback_call_id).not("transcript", "is", null).maybeSingle()
      if (t) transcriptIds.add(t.id as string)
    }

    // "Already a client": exact email match (case-insensitive) to a contact that belongs to a company.
    let isLiveClient = false
    if (lead.email && lead.email.trim()) {
      const escaped = lead.email.trim().replace(/[\\%_]/g, "\\$&")
      const { data: match } = await supabase
        .from("contacts")
        .select("id, account_contacts!inner(account_id)")
        .ilike("email", escaped)
        .limit(1)
      isLiveClient = (match ?? []).length > 0
    }

    const data = buildLeadWindowData({
      lead,
      offers: offers ?? [],
      calls,
      transcriptCallIds: Array.from(transcriptIds),
      emails: emailsRes.data ?? [],
      contracts: contractsRes.data ?? [],
      activation: activationRes.data ?? null,
      isLiveClient,
    })
    return NextResponse.json({ data })
  } catch (err) {
    console.error("[leads/window] unexpected error:", err)
    return NextResponse.json({ error: "Could not load this lead — please try again." }, { status: 500 })
  }
}
