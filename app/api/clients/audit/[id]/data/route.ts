import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findAuthUserByEmail } from '@/lib/auth-admin-helpers'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id

  const [sdsRes, taxRes, submissionsRes, paymentsRes, accountRes, membersRes, agreementsRes, contactsRes] = await Promise.all([
    supabaseAdmin
      .from('service_deliveries')
      .select('id, service_type, service_name, status, stage, start_date, end_date, notes, amount, amount_currency, assigned_to')
      .eq('account_id', id)
      .order('start_date', { ascending: false }),

    supabaseAdmin
      .from('tax_returns')
      .select('id, tax_year, return_type, status, data_received, data_received_date, extension_filed, extension_deadline, deadline, paid, sent_to_india, india_status, notes, link_sent')
      .eq('account_id', id)
      .order('tax_year', { ascending: false }),

    supabaseAdmin
      .from('tax_return_submissions')
      .select('id, tax_year, status, completed_at, submitted_data')
      .eq('account_id', id),

    supabaseAdmin
      .from('payments')
      .select('id, description, amount, amount_currency, due_date, paid_date, status, invoice_number, invoice_status, installment, period, is_test')
      .eq('account_id', id)
      .order('due_date', { ascending: false })
      .limit(20),

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from('accounts')
      .select('portal_account, portal_tier, entity_type, audit_sections')
      .eq('id', id)
      .single(),

    supabaseAdmin
      .from('members')
      .select('id, full_name, email, phone, ownership_pct, member_type, is_primary, is_signer, address_street, address_city, address_state, address_country, contact_id')
      .eq('account_id', id)
      .order('is_primary', { ascending: false }),

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from('annual_agreements')
      .select('id, agreement_year, status, skip_january, token, created_at')
      .eq('account_id', id)
      .order('agreement_year', { ascending: false }),

    // Two-step contact fetch (avoid PostgREST embed inference, which silently
    // returned empty rows in the deployed Vercel runtime even though the FK
    // resolves correctly in psql and the JS client locally — see audit-debug
    // diagnostic 2026-04-29). Step 1: get contact_ids linked to the account.
    supabaseAdmin
      .from('account_contacts')
      .select('contact_id, role')
      .eq('account_id', id),
  ])

  // Step 2: fetch the contacts themselves by id
  const linkedContactIds = (contactsRes.data ?? []).map(r => r.contact_id).filter(Boolean) as string[]
  const { data: contactRows } = linkedContactIds.length > 0
    ? await supabaseAdmin
        .from('contacts')
        .select('id, full_name, email, portal_tier')
        .in('id', linkedContactIds)
    : { data: [] as Array<{ id: string; full_name: string | null; email: string | null; portal_tier: string | null }> }

  // Use the explicitly-fetched contacts (Step 2 above) instead of the
  // unreliable PostgREST embed.
  const contacts = (contactRows ?? []).map(c => ({
    id: c.id as string,
    full_name: (c.full_name ?? '') as string,
    email: (c.email ?? '') as string,
    portal_tier: c.portal_tier as string | null,
  }))

  const authUserMap: Record<string, boolean> = {}
  const authBannedMap: Record<string, boolean> = {}
  for (const c of contacts) {
    if (!c?.email) continue
    const user = await findAuthUserByEmail(c.email)
    authUserMap[c.email] = !!user
    // banned_until is set when the user is banned; null/undefined = not banned
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const banned = !!(user as any)?.banned_until && new Date((user as any).banned_until) > new Date()
    authBannedMap[c.email] = banned
  }

  // Same for members
  const members = membersRes.data ?? []
  for (const m of members) {
    if (!m.email || authUserMap[m.email] !== undefined) continue
    const user = await findAuthUserByEmail(m.email)
    authUserMap[m.email] = !!user
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const banned = !!(user as any)?.banned_until && new Date((user as any).banned_until) > new Date()
    authBannedMap[m.email] = banned
  }

  return NextResponse.json({
    service_deliveries: sdsRes.data ?? [],
    tax_returns: taxRes.data ?? [],
    tax_return_submissions: submissionsRes.data ?? [],
    payments: (paymentsRes.data ?? []).filter((p: { is_test: boolean | null }) => !p.is_test),
    portal_account: accountRes.data?.portal_account ?? null,
    portal_tier: accountRes.data?.portal_tier ?? null,
    entity_type: accountRes.data?.entity_type ?? null,
    audit_sections: accountRes.data?.audit_sections ?? {},
    members: members,
    annual_agreements: agreementsRes.data ?? [],
    auth_user_map: authUserMap,
    auth_banned_map: authBannedMap,
    contacts_with_tier: contacts,
  })
}
