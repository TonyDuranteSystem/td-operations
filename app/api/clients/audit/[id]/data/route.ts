import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findAuthUserByEmail } from '@/lib/auth-admin-helpers'
import { createClient } from '@supabase/supabase-js'
import {
  findFeedsForAccount,
  findPlaidMercuryDuplicates,
  type CascadeFeed,
} from '@/lib/audit/bank-feed-cascade'

// The supabaseAdmin singleton can return stale data for the accounts row in warm
// Lambda instances (the singleton is initialized once; a write from another instance
// is not reflected in subsequent reads through the cached client).  Creating a
// fresh client per request guarantees we always read from the live DB state.
//
// Additionally: Next.js 14 patches the global fetch and caches GET requests by
// default. Supabase JS uses fetch under the hood; even with `force-dynamic` set
// on this route, supabase queries can return cached data after a write from
// another path (e.g. Step 14 manualMatch flips td_bank_feeds.status='matched',
// then this route's read still sees 'unmatched'). Passing a custom fetch with
// `cache: 'no-store'` disables that layer.
function freshAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false },
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, cache: 'no-store' }),
      },
    }
  )
}

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

    // freshAdminClient() — supabaseAdmin singleton + Next.js fetch cache returns
    // stale tax_returns rows after writes (e.g. PATCH /api/tax-returns/[id]),
    // making the audit panel display old status even after a successful save.
    (freshAdminClient() as any)
      .from('tax_returns')
      .select('id, tax_year, return_type, status, data_received, data_received_date, extension_filed, extension_deadline, deadline, paid, sent_to_accountant, accountant_status, notes, link_sent')
      .eq('account_id', id)
      .order('tax_year', { ascending: false }),

    supabaseAdmin
      .from('tax_return_submissions')
      .select('id, tax_year, status, completed_at, submitted_data')
      .eq('account_id', id),

    supabaseAdmin
      .from('payments')
      .select('id, description, amount, amount_currency, due_date, paid_date, status, invoice_number, invoice_status, installment, payment_category, year, period, is_test')
      .eq('account_id', id)
      .order('due_date', { ascending: false })
      .limit(20),

    // Use a fresh client (not the singleton) so warm Lambda instances always
    // read the current audit_sections value rather than a cached-at-init snapshot.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (freshAdminClient() as any)
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

    // Phase 1: load active audit_flags for this account entity (reversed_at IS NULL = active).
    // freshAdminClient() avoids the typed Proxy wrapper: audit_flags is not in database.types.ts,
    // and the Proxy returns empty data with no error for unknown tables.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (freshAdminClient() as any)
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

    // Phase 1: load active audit_flags for all linked contacts.
    // freshAdminClient() for the same reason as account flags above (untyped table).
    linkedContactIds.length > 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (freshAdminClient() as any)
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

  // Step 13 — Bank-feed cascade. Pull a broad pool of feeds (unmatched orphans
  // for the cascade + all mercury / mercury_api rows for duplicate detection),
  // resolve each to an account via matched_payment_id → payments.account_id,
  // then run the pure cascade logic.
  const { data: companyRow } = await supabaseAdmin
    .from('accounts')
    .select('company_name')
    .eq('id', id)
    .single()

  // Use freshAdminClient for td_bank_feeds — same singleton stale-read class
  // of bug as accounts/audit_flags above. Without this, after manualMatch
  // flips a feed to status='matched' (e.g. via Step 14 create-service-from-feed)
  // the supabaseAdmin singleton can return the stale 'unmatched' row, leaving
  // the orphan visible in the audit panel until the next cold restart.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: feedRows } = await (freshAdminClient() as any)
    .from('td_bank_feeds')
    .select('id, source, transaction_date, amount, currency, sender_name, sender_reference, memo, status, matched_payment_id, raw_data')
    .or('status.eq.unmatched,source.eq.mercury,source.eq.mercury_api')
    .order('transaction_date', { ascending: false })
    .limit(500)

  const feedsTyped = (feedRows ?? []) as Array<{
    id: string; source: string; transaction_date: string
    amount: number | string; currency: string
    sender_name: string | null; sender_reference: string | null; memo: string | null
    status: string; matched_payment_id: string | null; raw_data: unknown
  }>

  // Resolve matched_account_id by looking up payments.account_id for every
  // matched_payment_id appearing in the candidate pool.
  const matchedPaymentIds = Array.from(
    new Set(feedsTyped.map(f => f.matched_payment_id).filter((x): x is string => !!x))
  )
  const paymentToAccount = new Map<string, string | null>()
  if (matchedPaymentIds.length > 0) {
    const { data: payRows } = await supabaseAdmin
      .from('payments')
      .select('id, account_id')
      .in('id', matchedPaymentIds)
    for (const r of (payRows ?? []) as Array<{ id: string; account_id: string | null }>) {
      paymentToAccount.set(r.id, r.account_id)
    }
  }

  const feedsForCascade: CascadeFeed[] = feedsTyped.map(f => ({
    id: f.id,
    source: f.source,
    transaction_date: f.transaction_date,
    amount: typeof f.amount === 'string' ? parseFloat(f.amount) : f.amount,
    currency: f.currency,
    sender_name: f.sender_name,
    sender_reference: f.sender_reference,
    memo: f.memo,
    status: f.status,
    matched_payment_id: f.matched_payment_id,
    matched_account_id: f.matched_payment_id ? (paymentToAccount.get(f.matched_payment_id) ?? null) : null,
    raw_data: f.raw_data,
  }))

  const accountInvoices = (paymentsRes.data ?? [])
    .map((p: { invoice_number: string | null }) => ({ invoice_number: p.invoice_number }))

  const allOrphans = findFeedsForAccount(
    { id, company_name: companyRow?.company_name ?? null },
    contacts.map(c => ({ id: c.id, full_name: c.full_name, email: c.email })),
    accountInvoices,
    feedsForCascade,
  )

  const mercuryDuplicates = findPlaidMercuryDuplicates(
    { id, company_name: companyRow?.company_name ?? null },
    contacts.map(c => ({ id: c.id, full_name: c.full_name, email: c.email })),
    accountInvoices,
    feedsForCascade,
  )

  // A Plaid mercury feed that's a duplicate of a mercury_api row belongs in the
  // duplicates table only — exclude it from orphans so the user sees exactly one
  // row per actionable item.
  const duplicatePlaidIds = new Set(mercuryDuplicates.map(d => d.plaid_feed.id))
  const orphanFeeds = allOrphans.filter(o => !duplicatePlaidIds.has(o.feed.id))

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
    // Phase 1: active audit_flags for this account + its linked contacts
    flags: allFlags,
    // Step 13 — bank-feed cascade results
    orphan_feeds: orphanFeeds,
    mercury_duplicates: mercuryDuplicates,
  })
}
