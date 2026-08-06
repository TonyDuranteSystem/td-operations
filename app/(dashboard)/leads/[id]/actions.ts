'use server'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'

// ─── Types ──────────────────────────────────────────────────

interface CallMatch {
  id: string
  meeting_name: string
  duration_seconds: number | null
  attendees: Array<{ name?: string; email?: string }>
  notes: string | null
  action_items: unknown[]
  recording_url: string | null
  created_at: string
}

// ─── Auto-match Circleback call by lead email ───────────────

export async function findAndLinkCall(
  leadId: string
): Promise<{ success: boolean; error?: string; call?: CallMatch; multiple?: boolean }> {
  try {
    // Get lead email
    const { data: lead, error: leadErr } = await supabaseAdmin
      .from('leads')
      .select('id, email, circleback_call_id')
      .eq('id', leadId)
      .single()

    if (leadErr || !lead) {
      return { success: false, error: 'Lead not found' }
    }

    // WS-D: linking is ADDITIVE — a lead can have many calls, so an existing
    // link is no longer a refusal. We look for calls matching the lead's email
    // that aren't linked to this lead yet.
    if (!lead.email) {
      return { success: false, error: 'Lead has no email — use manual link' }
    }

    const email = lead.email.toLowerCase().trim()

    // Fetch recent calls and match by attendee email in JS
    // (Supabase client can't filter inside JSONB arrays)
    const { data: recentCalls } = await supabaseAdmin
      .from('call_summaries')
      .select('id, meeting_name, duration_seconds, attendees, notes, action_items, recording_url, created_at, lead_id')
      .order('created_at', { ascending: false })
      .limit(200)

    const callMatches = (recentCalls || []).filter(call => {
      if ((call as { lead_id?: string | null }).lead_id === leadId) return false // already linked to this lead
      const attendees = call.attendees as Array<{ name?: string; email?: string }> | null
      if (!Array.isArray(attendees)) return false
      return attendees.some(a => a.email?.toLowerCase() === email)
    }) as unknown as CallMatch[]

    if (callMatches.length === 0) {
      return { success: false, error: 'No matching call found for this email' }
    }

    if (callMatches.length > 1) {
      // Return the most recent one but flag that there are multiple
      const best = callMatches[0]
      return { success: true, call: best, multiple: true }
    }

    // Single match — auto-link
    const call = callMatches[0]
    await linkCallToLead(leadId, call.id)

    return { success: true, call }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ─── Manual link: connect a specific call to a lead ─────────

export async function linkCallToLead(
  leadId: string,
  callSummaryId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // WS-D: leads.circleback_call_id is the PRIMARY-call pointer — set it only
    // when empty; a deliberate earlier choice is never overwritten by a later
    // link. The call row itself is always linked (additive model).
    const { data: leadRow, error: leadReadErr } = await supabaseAdmin
      .from('leads')
      .select('circleback_call_id')
      .eq('id', leadId)
      .single()

    if (leadReadErr) {
      return { success: false, error: `Failed to read lead: ${leadReadErr.message}` }
    }

    if (!leadRow.circleback_call_id) {
      const { error: leadErr } = await supabaseAdmin
        .from('leads')
        .update({
          circleback_call_id: callSummaryId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', leadId)

      if (leadErr) {
        return { success: false, error: `Failed to update lead: ${leadErr.message}` }
      }
    }

    // Link the call row + clear any ambiguity marker — a human just decided.
    const { error: callErr } = await supabaseAdmin
      .from('call_summaries')
      .update({ lead_id: leadId, link_review: null, updated_at: new Date().toISOString() })
      .eq('id', callSummaryId)

    if (callErr) {
      return { success: false, error: `Failed to update call: ${callErr.message}` }
    }

    revalidatePath(`/leads/${leadId}`)
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ─── Unlink call from lead ──────────────────────────────────

export async function unlinkCallFromLead(
  leadId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Get current link
    const { data: lead } = await supabaseAdmin
      .from('leads')
      .select('circleback_call_id')
      .eq('id', leadId)
      .single()

    if (!lead?.circleback_call_id) {
      return { success: false, error: 'No call linked' }
    }

    // Clear both sides
    await supabaseAdmin
      .from('leads')
      .update({ circleback_call_id: null, updated_at: new Date().toISOString() })
      .eq('id', leadId)

    await supabaseAdmin
      .from('call_summaries')
      .update({ lead_id: null, updated_at: new Date().toISOString() })
      .eq('id', lead.circleback_call_id)

    revalidatePath(`/leads/${leadId}`)
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ─── Search calls by name (for manual Find Call) ────────────

export async function searchCallsByName(
  query: string
): Promise<{ calls: CallMatch[] }> {
  try {
    const { data } = await supabaseAdmin
      .from('call_summaries')
      .select('id, meeting_name, duration_seconds, attendees, notes, action_items, recording_url, created_at')
      .ilike('meeting_name', `%${query}%`)
      .order('created_at', { ascending: false })
      .limit(10)

    return { calls: (data || []) as unknown as CallMatch[] }
  } catch {
    return { calls: [] }
  }
}

// ─── Toggle offer under_discussion status ───────────────────

export async function toggleOfferDiscussion(
  offerToken: string,
  leadId: string
): Promise<{ success: boolean; newStatus?: string; error?: string }> {
  try {
    const { data: offer } = await supabaseAdmin
      .from('offers')
      .select('status')
      .eq('token', offerToken)
      .single()

    if (!offer) return { success: false, error: 'Offer not found' }

    // Toggle: under_discussion ↔ published
    const allowed = ['published', 'viewed', 'under_discussion']
    if (!allowed.includes(offer.status)) {
      return { success: false, error: `Cannot change status from "${offer.status}"` }
    }

    const newStatus = offer.status === 'under_discussion' ? 'published' : 'under_discussion'

    const { error } = await supabaseAdmin
      .from('offers')
      .update({ status: newStatus })
      .eq('token', offerToken)

    if (error) return { success: false, error: error.message }

    // Sync lead offer_status
    await supabaseAdmin
      .from('leads')
      .update({
        offer_status: (newStatus === 'under_discussion' ? 'Under Discussion' : 'Published') as never,
        updated_at: new Date().toISOString(),
      })
      .eq('id', leadId)

    revalidatePath(`/leads/${leadId}`)
    return { success: true, newStatus }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}
