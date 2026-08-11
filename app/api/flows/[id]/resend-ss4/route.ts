/**
 * Re-send a Company Formation flow's SS-4 for signature when the captured
 * signature is bad/missing. Resets a 'signed' (or 'submitted') SS-4 back to
 * 'awaiting_signature' and CLEARS the invalid signature so the client can sign
 * again on the existing link (token + access_code are preserved). Backs the
 * ss4_panel "Re-send for Signature" button.
 *
 * Why this exists: Numero Uno Social LLC signed with a single dot (no real
 * signature). Once 'signed', the panel offered no way to re-send — staff were
 * stuck. This re-opens it. The signature-required guard on the signing page
 * prevents the bad signature recurring.
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
      .select('id, status, company_name, contact_id, entity_type, responsible_party_name')
      .eq('account_id', sd.account_id)
      .maybeSingle()

    if (!ss4) {
      return NextResponse.json({ success: false, error: 'No SS-4 exists for this account yet.' }, { status: 404 })
    }

    // ── ROUND-5 PROMOTION GATE ── a re-open must not re-arm a link for a
    // responsible party who is no longer a member and was never picked (the
    // member roster may have changed since the signature being re-done).
    {
      const { assertSs4PartyPromotable } = await import('@/lib/operations/ss4-refresh')
      const gate = await assertSs4PartyPromotable({ account_id: sd.account_id, ss4 })
      if (gate.ok === false) {
        return NextResponse.json({ success: false, error: gate.message }, { status: 409 })
      }
    }
    if (ss4.status === 'draft') {
      return NextResponse.json(
        { success: false, error: 'This SS-4 is still a draft — use "Send to Client for Signature" instead.' },
        { status: 409 },
      )
    }
    if (ss4.status === 'awaiting_signature') {
      return NextResponse.json({ success: true, status: 'awaiting_signature', message: 'Already awaiting the client’s signature.' })
    }

    // Re-open: clear the signature and drop back to awaiting_signature. Token +
    // access_code are preserved so the client's existing signing link still
    // works. pdf_signed_drive_id is cleared (the next signature regenerates it).
    // eslint-disable-next-line no-restricted-syntax -- targeted re-open, not a bulk write
    const { error: updErr } = await supabaseAdmin
      .from('ss4_applications')
      .update({
        status: 'awaiting_signature',
        signature_data: null,
        signed_at: null,
        signed_ip: null,
        pdf_signed_drive_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', ss4.id)
      .in('status', ['signed', 'submitted']) // TOCTOU guard: only re-open a signed/submitted SS-4

    if (updErr) {
      return NextResponse.json({ success: false, error: `Could not re-open the SS-4: ${updErr.message}` }, { status: 500 })
    }

    logAction({
      action_type: 'update',
      table_name: 'ss4_applications',
      record_id: ss4.id,
      account_id: sd.account_id,
      summary: `SS-4 re-opened for re-signature: ${ss4.company_name}`,
      details: { source: 'flow-resend-ss4', from: ss4.status, to: 'awaiting_signature' },
    })

    // Tell the signer they need to sign AGAIN (chat + immediate email +
    // bell/push) — a re-opened SS-4 without a message is exactly the silent
    // wait this feature removes. Best-effort, never fails the re-open.
    const { notifySs4ReadyToSign } = await import('@/lib/portal/action-required')
    const notify = await notifySs4ReadyToSign({ ss4Id: ss4.id, serviceDeliveryId: params.id })

    return NextResponse.json({ success: true, status: 'awaiting_signature', client_notified: notify })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
