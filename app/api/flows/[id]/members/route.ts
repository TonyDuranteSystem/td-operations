/**
 * Members of a Company Formation flow — backs the Workspace `members_panel`.
 *
 * GET  → { success, is_mmllc, members: [{ member_id, name, type,
 *          ownership_pct, is_signer, representative_name }] }
 *   - SD has account_id (materialized) → reads the `members` table.
 *   - SD has no account_id (in-flight, contact-scoped) → reads the formation
 *     `wizard_progress.data` and reconstructs owner + additional members from
 *     the flat keys (member_id null — no rows exist yet, so toggling is off).
 *
 * POST → { member_id, is_signer } → toggles the SS-4 Responsible Party on the
 *   `members` table (staff override). Setting is_signer=true clears every other
 *   member of the same account first, preserving the exactly-one-signer
 *   invariant the SS-4 guard (decideSs4Signer) depends on.
 *
 * [id] = service_delivery_id. Staff-only via requireStaffRoute() (lib/auth/
 * require-staff-route.ts) — the earlier "gated by middleware" comment here was FALSE
 * (security audit, 2026-08-21, dev job 9d80395e-cef4-4c76-998b-c23a5f99684b):
 * middleware never checks role on /api/* paths, only on dashboard page
 * navigations, so this route (like its sibling activate-ra / chat routes,
 * unaudited — see the dev job) was reachable by any authenticated session
 * including an ordinary portal client.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { extractMembersFromWizardData } from '@/lib/utils/wizard-members'
import { logAction } from '@/lib/mcp/action-log'
import { refreshSS4 } from '@/lib/operations/ss4-refresh'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'

type PanelMember = {
  member_id: string | null
  name: string
  type: 'individual' | 'company'
  ownership_pct: number | null
  is_signer: boolean
  representative_name: string | null
}

const noStore = { headers: { 'Cache-Control': 'no-store, max-age=0' } }

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const serviceDeliveryId = params.id

    const { data: sd, error: sdErr } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_type, account_id, contact_id')
      .eq('id', serviceDeliveryId)
      .single()

    if (sdErr || !sd) {
      return NextResponse.json({ success: false, error: 'Flow (service delivery) not found' }, { status: 404 })
    }

    // ── Materialized: read the members table ──
    if (sd.account_id) {
      const [{ data: acct }, { data: memberRows }] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- member_structure not in generated types
        (supabaseAdmin as any)
          .from('accounts')
          .select('member_structure, entity_type')
          .eq('id', sd.account_id)
          .maybeSingle(),
        supabaseAdmin
          .from('members')
          .select('id, member_type, full_name, company_name, ownership_pct, is_signer, representative_name')
          .eq('account_id', sd.account_id)
          .order('is_primary', { ascending: false }),
      ])

      const members: PanelMember[] = (memberRows ?? []).map((m) => ({
        member_id: m.id as string,
        name:
          (m.member_type === 'company'
            ? (m.company_name as string | null)
            : (m.full_name as string | null)) || '—',
        type: (m.member_type === 'company' ? 'company' : 'individual') as PanelMember['type'],
        ownership_pct: (m.ownership_pct as number | null) ?? null,
        is_signer: m.is_signer === true,
        representative_name: (m.representative_name as string | null) ?? null,
      }))

      const isMmllc =
        acct?.member_structure === 'multi_member' ||
        acct?.entity_type === 'Multi Member LLC' ||
        members.length > 1

      return NextResponse.json({ success: true, is_mmllc: isMmllc, members }, noStore)
    }

    // ── In-flight (contact-scoped): reconstruct from the formation wizard ──
    if (!sd.contact_id) {
      return NextResponse.json({ success: true, is_mmllc: false, members: [] }, noStore)
    }

    const { data: wp } = await supabaseAdmin
      .from('wizard_progress')
      .select('data')
      .eq('contact_id', sd.contact_id)
      .eq('wizard_type', 'formation')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const data = (wp?.data ?? {}) as Record<string, unknown>
    const additional = extractMembersFromWizardData(data)
    const isMmllc = data.entity_type === 'MMLLC' || additional.length > 0

    if (!isMmllc) {
      return NextResponse.json({ success: true, is_mmllc: false, members: [] }, noStore)
    }

    const additionalPctSum = additional.reduce((s, m) => s + (m.member_ownership_pct ?? 0), 0)
    const ownerName =
      [data.owner_first_name, data.owner_last_name].filter(Boolean).map(String).join(' ').trim() || '—'

    const members: PanelMember[] = [
      {
        member_id: null,
        name: ownerName,
        type: 'individual',
        ownership_pct: Math.max(0, Math.round((100 - additionalPctSum) * 100) / 100),
        is_signer: data.owner_is_signer === true,
        representative_name: null,
      },
      ...additional.map((m): PanelMember => ({
        member_id: null,
        name:
          m.member_type === 'company'
            ? m.member_company_name || '—'
            : [m.member_first_name, m.member_last_name].filter(Boolean).join(' ') || '—',
        type: m.member_type,
        ownership_pct: m.member_ownership_pct ?? null,
        is_signer: m.is_signer === true,
        representative_name: m.member_type === 'company' ? m.member_rep_name ?? null : null,
      })),
    ]

    return NextResponse.json({ success: true, is_mmllc: true, members }, noStore)
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const serviceDeliveryId = params.id
    const body = await req.json().catch(() => ({}))
    const memberId = typeof body.member_id === 'string' ? body.member_id : null
    const isSigner = body.is_signer === true

    if (!memberId) {
      return NextResponse.json({ success: false, error: 'member_id is required' }, { status: 400 })
    }

    // Resolve the member (and its account) — also verifies it exists.
    const { data: member, error: memErr } = await supabaseAdmin
      .from('members')
      .select('id, account_id')
      .eq('id', memberId)
      .single()

    if (memErr || !member) {
      return NextResponse.json({ success: false, error: 'Member not found' }, { status: 404 })
    }

    if (isSigner) {
      // Single-signer invariant: clear every member on this account first, then
      // flag the chosen one. The SS-4 guard requires exactly one is_signer=true.
      await supabaseAdmin
        .from('members')
        .update({ is_signer: false, updated_at: new Date().toISOString() })
        .eq('account_id', member.account_id)
      await supabaseAdmin
        .from('members')
        .update({ is_signer: true, updated_at: new Date().toISOString() })
        .eq('id', memberId)
    } else {
      await supabaseAdmin
        .from('members')
        .update({ is_signer: false, updated_at: new Date().toISOString() })
        .eq('id', memberId)
    }

    logAction({
      action_type: 'update',
      table_name: 'members',
      record_id: memberId,
      account_id: member.account_id,
      summary: `SS-4 signer ${isSigner ? 'set' : 'cleared'} on member ${memberId.slice(0, 8)}`,
      details: { source: 'flow-members-panel', service_delivery_id: serviceDeliveryId, is_signer: isSigner },
    })

    // Auto-refresh the account's unsigned SS-4 so the responsible party never
    // silently contradicts the signer staff just flagged (AI Venture Labs,
    // 2026-07-02). No-op when no unsigned SS-4 exists; best-effort.
    let ss4Refresh: { outcome: string; message?: string; signerChanged?: boolean } | null = null
    if (member.account_id) {
      try {
        const r = await refreshSS4({ account_id: member.account_id, source: 'flow-members-panel' })
        if (r.outcome !== 'no_ss4') ss4Refresh = { outcome: r.outcome, message: r.message, signerChanged: r.signerChanged }
      } catch (err) {
        console.error('[flow-members] SS-4 auto-refresh failed (non-fatal):', err)
      }
    }

    return NextResponse.json({ success: true, ss4_refresh: ss4Refresh }, noStore)
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
