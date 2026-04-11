'use server'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'

// ─── Types ──────────────────────────────────────────────────

interface ParsedIntake {
  name: string
  email: string
  phone: string | null
  call_date: string | null
  reason: string | null
  referrer_name: string | null
  event_uri: string | null
  event_type_name: string | null
}

interface IntakePayload {
  raw?: unknown
  parsed?: ParsedIntake
  matches?: {
    existing_lead_id: string | null
    existing_lead_status: string | null
    existing_contact_id: string | null
    existing_contact_name: string | null
  }
  converted_lead_id?: string
  linked_lead_id?: string
}

// ─── Create Lead from Intake ────────────────────────────────

export async function createLeadFromIntake(
  webhookEventId: string,
  circleback_call_id?: string
): Promise<{ success: boolean; error?: string; lead_id?: string }> {
  try {
    // Fetch the webhook event
    const { data: evt, error: fetchErr } = await supabaseAdmin
      .from('webhook_events')
      .select('id, payload, review_status')
      .eq('id', webhookEventId)
      .single()

    if (fetchErr || !evt) {
      return { success: false, error: 'Webhook event not found' }
    }

    if (evt.review_status === 'converted') {
      return { success: false, error: 'Already converted to lead' }
    }

    const payload = evt.payload as IntakePayload
    const parsed = payload?.parsed
    if (!parsed?.email) {
      return { success: false, error: 'No email in parsed data' }
    }

    // Dedup check: does a lead with this email already exist?
    const { data: existingLeads } = await supabaseAdmin
      .from('leads')
      .select('id, full_name, status')
      .ilike('email', parsed.email)
      .limit(1)

    if (existingLeads && existingLeads.length > 0) {
      return {
        success: false,
        error: `Lead already exists: ${existingLeads[0].full_name} (${existingLeads[0].status}) — use "Link" instead`,
      }
    }

    // Create the lead
    const leadRecord: Record<string, unknown> = {
      full_name: parsed.name,
      email: parsed.email,
      source: parsed.referrer_name ? 'Referral' : 'Calendly',
      channel: 'Calendly',
      status: 'Call Scheduled',
      notes: parsed.reason || 'Booked via Calendly',
    }
    if (parsed.phone) leadRecord.phone = parsed.phone
    if (parsed.call_date) leadRecord.call_date = parsed.call_date
    if (parsed.reason) leadRecord.reason = parsed.reason
    if (parsed.referrer_name) leadRecord.referrer_name = parsed.referrer_name

    // Link Circleback if provided
    if (circleback_call_id) {
      leadRecord.circleback_call_id = circleback_call_id
    }

    const { data: newLead, error: insertErr } = await supabaseAdmin
      .from('leads')
      .insert(leadRecord)
      .select('id')
      .single()

    if (insertErr) {
      return { success: false, error: insertErr.message }
    }

    // Link Circleback call's lead_id if provided
    if (circleback_call_id) {
      await supabaseAdmin
        .from('call_summaries')
        .update({ lead_id: newLead.id })
        .eq('id', circleback_call_id)
    }

    // Update webhook event status
    await supabaseAdmin
      .from('webhook_events')
      .update({
        review_status: 'converted',
        payload: { ...payload, converted_lead_id: newLead.id },
      })
      .eq('id', webhookEventId)

    revalidatePath('/intake')
    revalidatePath('/leads')

    return { success: true, lead_id: newLead.id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ─── Link Intake to Existing Lead ───────────────────────────

export async function linkIntakeToExisting(
  webhookEventId: string,
  leadId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { data: evt } = await supabaseAdmin
      .from('webhook_events')
      .select('id, payload, review_status')
      .eq('id', webhookEventId)
      .single()

    if (!evt) return { success: false, error: 'Webhook event not found' }

    // Verify the lead exists
    const { data: lead } = await supabaseAdmin
      .from('leads')
      .select('id, full_name')
      .eq('id', leadId)
      .single()

    if (!lead) return { success: false, error: 'Lead not found' }

    const payload = evt.payload as IntakePayload

    // Update the lead's call_date if available and lead is in early stage
    const parsed = payload?.parsed
    if (parsed?.call_date) {
      await supabaseAdmin
        .from('leads')
        .update({ call_date: parsed.call_date, updated_at: new Date().toISOString() })
        .eq('id', leadId)
    }

    // Update webhook event
    await supabaseAdmin
      .from('webhook_events')
      .update({
        review_status: 'linked',
        payload: { ...payload, linked_lead_id: leadId },
      })
      .eq('id', webhookEventId)

    revalidatePath('/intake')
    revalidatePath(`/leads/${leadId}`)

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ─── Dismiss Intake Entry ───────────────────────────────────

export async function dismissIntake(
  webhookEventId: string,
  status: 'lost' | 'dismissed'
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabaseAdmin
      .from('webhook_events')
      .update({ review_status: status })
      .eq('id', webhookEventId)

    if (error) return { success: false, error: error.message }

    revalidatePath('/intake')
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}
