/**
 * Send a Company Formation flow's SS-4 to the client for signature: flips the
 * record from 'draft' → 'awaiting_signature' so it appears in the client's
 * portal Sign Documents page. Backs the ss4_panel "Send to Client for Signature"
 * button.
 *
 * Mirrors the ss4_update awaiting_signature guard: Line 6 (county_and_state) must
 * be populated first — it's sourced from the account's Registered Agent address.
 *
 * POST → { success, status } | { success:false, error }
 * [id] = service_delivery_id.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { logAction } from '@/lib/mcp/action-log'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { data: sd } = await supabaseAdmin
      .from('service_deliveries')
      .select('account_id, service_type')
      .eq('id', params.id)
      .maybeSingle()

    if (!sd) return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
    if (!sd.account_id) {
      return NextResponse.json({ success: false, error: 'No account linked to this flow yet.' }, { status: 400 })
    }

    const { data: ss4 } = await supabaseAdmin
      .from('ss4_applications')
      .select('id, status, company_name, county_and_state')
      .eq('account_id', sd.account_id)
      .maybeSingle()

    if (!ss4) {
      return NextResponse.json({ success: false, error: 'No SS-4 exists for this account yet. Generate it first.' }, { status: 404 })
    }
    if (ss4.status === 'signed' || ss4.status === 'submitted') {
      return NextResponse.json(
        { success: false, error: `SS-4 for ${ss4.company_name} is already ${ss4.status} — it can't be re-sent.` },
        { status: 409 },
      )
    }
    if (ss4.status === 'awaiting_signature') {
      return NextResponse.json({ success: true, status: 'awaiting_signature', message: 'Already sent — waiting for the client to sign.' })
    }
    if (!ss4.county_and_state) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Cannot send: Line 6 (county) is blank. It comes from the account\'s Registered Agent address — set the Registered Agent (and its county) on "Articles Received" first, then retry.',
        },
        { status: 409 },
      )
    }

    const { error: updErr } = await supabaseAdmin
      .from('ss4_applications')
      .update({ status: 'awaiting_signature', updated_at: new Date().toISOString() })
      .eq('id', ss4.id)
      .eq('status', 'draft') // TOCTOU guard: only flip from draft

    if (updErr) {
      return NextResponse.json({ success: false, error: `Could not update the SS-4: ${updErr.message}` }, { status: 500 })
    }

    logAction({
      action_type: 'update',
      table_name: 'ss4_applications',
      record_id: ss4.id,
      account_id: sd.account_id,
      summary: `SS-4 sent to client for signature: ${ss4.company_name}`,
      details: { source: 'flow-send-ss4', from: 'draft', to: 'awaiting_signature' },
    })

    // Tell the signer (chat + immediate email + bell/push). Before 2026-07-02
    // this button notified NOTHING — the SS-4 sat signable while the client had
    // no idea (Michele Cotti / AI Venture Labs). Best-effort: the status flip
    // above already committed; a notification failure is reported, not fatal.
    const { notifySs4ReadyToSign } = await import('@/lib/portal/action-required')
    const notify = await notifySs4ReadyToSign({ ss4Id: ss4.id, serviceDeliveryId: params.id })

    return NextResponse.json({ success: true, status: 'awaiting_signature', client_notified: notify })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
