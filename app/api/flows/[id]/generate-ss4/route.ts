/**
 * SS-4 for a Company Formation flow.
 *
 *   GET  → the SD's account's SS-4 record (or null) — backs the ss4_panel read.
 *   POST → generate the SS-4 via the shared createSS4 core (lib/operations/ss4.ts),
 *          the same logic the ss4_create MCP tool uses. Surfaces the real reason
 *          when a prerequisite blocks creation (e.g. no Registered Agent) — R099.
 *   POST {regenerate:true} → refresh the EXISTING unsigned SS-4 in place from
 *          current account/member data via the shared refreshSS4 core
 *          (lib/operations/ss4-refresh.ts) — same token, client link unchanged.
 *          Before 2026-07-02 this route had no regenerate at all and returned
 *          the stale record as a plain success, which is how "regenerate did
 *          nothing" burned staff time on the AI Venture Labs wrong-signer case.
 *
 * [id] = service_delivery_id.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { createSS4 } from '@/lib/operations/ss4'
import { refreshSS4 } from '@/lib/operations/ss4-refresh'
import { APP_BASE_URL } from '@/lib/config'

async function resolveAccountId(serviceDeliveryId: string): Promise<{ account_id: string | null; service_type: string | null } | null> {
  const { data: sd } = await supabaseAdmin
    .from('service_deliveries')
    .select('account_id, service_type')
    .eq('id', serviceDeliveryId)
    .maybeSingle()
  return sd ?? null
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sd = await resolveAccountId(params.id)
    if (!sd) return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
    if (!sd.account_id) return NextResponse.json({ success: true, ss4: null })

    const { data: ss4 } = await supabaseAdmin
      .from('ss4_applications')
      .select('id, token, access_code, status, company_name, signed_at, county_and_state, contact_id, responsible_party_name')
      .eq('account_id', sd.account_id)
      .maybeSingle()

    if (!ss4) return NextResponse.json({ success: true, ss4: null })

    // Signer candidates = EVERY contact linked to the account, whatever their
    // role. Roles are shown so staff can tell people apart, but they never
    // restrict the choice: the SS-4 responsible party is decoupled from
    // ownership by design (Antonio, 2026-08-10) — an SMLLC's signer may hold no
    // ownership at all.
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('contact_id, role, contacts(id, full_name, email)')
      .eq('account_id', sd.account_id)

    const candidates = (links ?? []).map((l) => {
      const c = l.contacts as unknown as { id: string; full_name: string | null; email: string | null } | null
      return {
        contact_id: l.contact_id as string,
        full_name: c?.full_name ?? 'Unknown',
        email: c?.email ?? null,
        role: (l as unknown as { role: string | null }).role ?? null,
      }
    })

    return NextResponse.json({
      success: true,
      ss4: {
        id: ss4.id,
        status: ss4.status,
        company_name: ss4.company_name,
        signed_at: ss4.signed_at ?? null,
        has_county: !!ss4.county_and_state,
        contact_id: ss4.contact_id ?? null,
        responsible_party_name: ss4.responsible_party_name ?? null,
        previewUrl: `${APP_BASE_URL}/ss4/${ss4.token}/${ss4.access_code}?preview=td`,
      },
      candidates,
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sd = await resolveAccountId(params.id)
    if (!sd) return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
    if (sd.service_type !== 'Company Formation') {
      return NextResponse.json({ success: false, error: 'SS-4 generation only applies to Company Formation flows.' }, { status: 400 })
    }
    if (!sd.account_id) {
      return NextResponse.json(
        { success: false, error: 'The CRM account is not created yet. Reach "Articles Received" first so the company is materialized.' },
        { status: 400 },
      )
    }

    const body = await req.json().catch(() => ({} as Record<string, unknown>))

    // ── Change the responsible party (workspace signer picker) ──
    // Staff may re-point the SS-4 at any linked contact right up until it is
    // signed — clients change their mind mid-job. The shared core resets an
    // already-sent record to draft, ROTATES the access code so the previous
    // signer's link stops working, repoints the internal documents row and
    // clears the previous signer's chat/bell.
    if (typeof body?.set_signer === 'string' && body.set_signer) {
      const { setSs4Signer } = await import('@/lib/operations/ss4-set-signer')
      const res = await setSs4Signer({
        account_id: sd.account_id,
        contact_id: body.set_signer,
        source: 'flow-ss4-picker',
      })
      if (!res.ok) {
        // 404 = nothing to switch; 500 = a genuine write/read failure (council
        // minor: an infrastructure error is not a 409 conflict); 409 = business
        // refusals (locked / not_linked / no_contact).
        const status = res.outcome === 'no_ss4' ? 404 : res.outcome === 'error' ? 500 : 409
        return NextResponse.json(
          { success: false, error: res.message || `Could not change the signer (${res.outcome}).`, outcome: res.outcome },
          { status },
        )
      }
      return NextResponse.json({
        success: true,
        signer_changed: res.outcome === 'switched',
        unchanged: res.outcome === 'unchanged',
        status_reset: res.statusReset === true,
        ss4: res.ss4
          ? {
              id: res.ss4.id,
              status: res.ss4.status,
              company_name: null,
              contact_id: res.ss4.contact_id,
              responsible_party_name: res.ss4.responsible_party_name,
              previewUrl: `${APP_BASE_URL}/ss4/${res.ss4.token}/${res.ss4.access_code}?preview=td`,
            }
          : null,
      })
    }

    // ── Regenerate: refresh the existing unsigned SS-4 in place ──
    if (body?.regenerate === true) {
      const refresh = await refreshSS4({ account_id: sd.account_id, source: 'flow-regenerate' })
      if (refresh.outcome === 'refreshed' || refresh.outcome === 'unchanged') {
        return NextResponse.json({
          success: true,
          regenerated: true,
          unchanged: refresh.outcome === 'unchanged',
          signer_changed: refresh.signerChanged === true,
          ss4: refresh.ss4
            ? {
                id: refresh.ss4.id,
                status: refresh.ss4.status,
                company_name: refresh.ss4.company_name,
                previewUrl: `${APP_BASE_URL}/ss4/${refresh.ss4.token}/${refresh.ss4.access_code}?preview=td`,
              }
            : null,
        })
      }
      if (refresh.outcome === 'no_ss4') {
        return NextResponse.json({ success: false, error: 'No SS-4 exists yet — use Generate SS-4 instead.' }, { status: 404 })
      }
      return NextResponse.json(
        { success: false, error: refresh.message || `Could not regenerate the SS-4 (${refresh.outcome}).`, outcome: refresh.outcome },
        { status: 409 },
      )
    }

    const result = await createSS4({ account_id: sd.account_id })

    // already_exists isn't a failure for the workspace, but be HONEST that
    // nothing was refreshed — the stale-success here is what hid the AI
    // Venture Labs wrong-signer bug from staff.
    if (result.outcome === 'already_exists' && result.ss4) {
      return NextResponse.json({
        success: true,
        already_existed: true,
        note: 'An SS-4 already exists for this account — it was NOT refreshed. Use "Regenerate from account data" to update it from current account/member data.',
        ss4: { id: result.ss4.id, status: result.ss4.status, company_name: result.ss4.company_name, previewUrl: result.previewUrl },
      })
    }

    if (!result.ok || !result.ss4) {
      return NextResponse.json(
        { success: false, error: result.message || `Could not generate the SS-4 (${result.outcome}).`, outcome: result.outcome },
        { status: 409 },
      )
    }

    return NextResponse.json({
      success: true,
      ss4: { id: result.ss4.id, status: result.ss4.status, company_name: result.ss4.company_name, previewUrl: result.previewUrl },
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
