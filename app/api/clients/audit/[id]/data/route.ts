import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findAuthUserByEmail } from '@/lib/auth-admin-helpers'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [sdsRes, taxRes, submissionsRes, paymentsRes, accountRes, membersRes, agreementsRes, contactsRes, accountFlagsRes] = await Promise.all([
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
      .select('id, full_name, company_name, ein, email, phone, ownership_pct, member_type, is_primary, is_signer, address_street, address_city, address_state, address_zip, address_country, contact_id, representative_name, representative_email, representative_phone, representative_address_street, representative_address_city, representative_address_state, representative_address_zip, representative_address_country')
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

    // Phase 1: load active audit_flags for this account entity (reversed_at IS NULL = active)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from('audit_flags')
      .select('id, entity_type, entity_id, field_name, flag_type, note, marked_by, marked_at')
      .eq('entity_type', 'account')
      .eq('entity_id', id)
      .is('reversed_at', null),
  ])

  // Step 2: fetch contacts + contact flags in parallel
  const linkedContactIds = (contactsRes.data ?? []).map((r: { contact_id: string }) => r.contact_id).filter(Boolean) as string[]

  const [contactRowsRes, contactFlagsRes] = await Promise.all([
    linkedContactIds.length > 0
      ? supabaseAdmin
          .from('contacts')
          .select('id, full_name, email, phone, language, citizenship, itin_number, portal_tier, date_of_birth, passport_number, passport_expiry_date, passport_on_file, kyc_status, address_line1, address_city, address_state, address_zip, address_country')
          .in('id', linkedContactIds)
      : Promise.resolve({ data: [] as Array<{
          id: string; full_name: string | null; email: string | null; phone: string | null
          language: string | null; citizenship: string | null; itin_number: string | null; portal_tier: string | null
          date_of_birth: string | null; passport_number: string | null; passport_expiry_date: string | null
          passport_on_file: boolean | null; kyc_status: string | null
          address_line1: string | null; address_city: string | null; address_state: string | null
          address_zip: string | null; address_country: string | null
        }> }),

    // Phase 1: load active audit_flags for all linked contacts
    linkedContactIds.length > 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (supabaseAdmin as any)
          .from('audit_flags')
          .select('id, entity_type, entity_id, field_name, flag_type, note, marked_by, marked_at')
          .eq('entity_type', 'contact')
          .in('entity_id', linkedContactIds)
          .is('reversed_at', null)
      : Promise.resolve({ data: [] }),
  ])

  // Use the explicitly-fetched contacts (Step 2 above) instead of the
  // unreliable PostgREST embed.
  const contacts = (contactRowsRes.data ?? []).map((c: {
    id: string; full_name: string | null; email: string | null; phone: string | null
    language: string | null; citizenship: string | null; itin_number: string | null; portal_tier: string | null
    date_of_birth: string | null; passport_number: string | null; passport_expiry_date: string | null
    passport_on_file: boolean | null; kyc_status: string | null
    address_line1: string | null; address_city: string | null; address_state: string | null
    address_zip: string | null; address_country: string | null
  }) => ({
    id: c.id as string,
    full_name: (c.full_name ?? '') as string,
    email: (c.email ?? '') as string,
    phone: (c.phone ?? null) as string | null,
    language: (c.language ?? null) as string | null,
    citizenship: (c.citizenship ?? null) as string | null,
    itin_number: (c.itin_number ?? null) as string | null,
    portal_tier: c.portal_tier as string | null,
    date_of_birth: (c.date_of_birth ?? null) as string | null,
    passport_number: (c.passport_number ?? null) as string | null,
    passport_expiry_date: (c.passport_expiry_date ?? null) as string | null,
    passport_on_file: (c.passport_on_file ?? null) as boolean | null,
    kyc_status: (c.kyc_status ?? null) as string | null,
    address_line1: (c.address_line1 ?? null) as string | null,
    address_city: (c.address_city ?? null) as string | null,
    address_state: (c.address_state ?? null) as string | null,
    address_zip: (c.address_zip ?? null) as string | null,
    address_country: (c.address_country ?? null) as string | null,
  }))

  // Combine account + contact flags into a single array for the panel
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allFlags: Array<{
    id: string
    entity_type: string
    entity_id: string
    field_name: string
    flag_type: string
    note: string | null
    marked_by: string
    marked_at: string
  }> = [
    ...(accountFlagsRes.data ?? []),
    ...(contactFlagsRes.data ?? []),
  ]

  // Read banned_until via a Postgres RPC that selects directly from
  // auth.users — the Supabase auth admin API (listUsers AND getUserById)
  // is inconsistent in the deployed runtime: it returns banned_until for
  // some users and strips it for others, even though the DB row is correct.
  // The RPC is SECURITY DEFINER so it can read auth.users via service role.
  async function readBannedUntil(userId: string): Promise<string | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any).rpc('get_auth_user_banned_until', { p_user_id: userId })
    if (error) {
      // Fallback: try getUserById in case the RPC isn't deployed yet
      const { data: byId } = await supabaseAdmin.auth.admin.getUserById(userId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((byId?.user as any)?.banned_until as string | null) ?? null
    }
    return (data as string | null) ?? null
  }

  const authUserMap: Record<string, boolean> = {}
  const authBannedMap: Record<string, boolean> = {}
  for (const c of contacts) {
    if (!c?.email) continue
    const user = await findAuthUserByEmail(c.email)
    authUserMap[c.email] = !!user
    if (user) {
      const bannedUntil = await readBannedUntil(user.id)
      authBannedMap[c.email] = !!bannedUntil && new Date(bannedUntil) > new Date()
    } else {
      authBannedMap[c.email] = false
    }
  }

  // Same for members
  const members = membersRes.data ?? []
  for (const m of members) {
    if (!m.email || authUserMap[m.email] !== undefined) continue
    const user = await findAuthUserByEmail(m.email)
    authUserMap[m.email] = !!user
    if (user) {
      const bannedUntil = await readBannedUntil(user.id)
      authBannedMap[m.email] = !!bannedUntil && new Date(bannedUntil) > new Date()
    } else {
      authBannedMap[m.email] = false
    }
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
    _debug_acct_err: accountRes.error?.message ?? null,
    _debug_supabase_url: process.env.NEXT_PUBLIC_SUPABASE_URL?.slice(8, 40) ?? 'unset',
    _debug_acct_raw: accountRes.data ? JSON.stringify(accountRes.data) : 'null',
    _debug_svc_key_prefix: process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(0, 25) ?? 'unset',
    _debug_fresh_read: await (async () => {
      const fresh = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await (fresh as any).from('accounts').select('id, audit_sections').eq('id', id).single()
      return r.error ? `ERR:${r.error.message}` : JSON.stringify(r.data?.audit_sections)
    })(),
    members: members,
    annual_agreements: agreementsRes.data ?? [],
    auth_user_map: authUserMap,
    auth_banned_map: authBannedMap,
    contacts_with_tier: contacts,
    // Phase 1: active audit_flags for this account + its linked contacts
    flags: allFlags,
  })
}
