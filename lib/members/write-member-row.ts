/**
 * upsertMemberRow — the single, reliable way to write one row to the `members`
 * table, shared by the onboarding setup job and the formation materialization.
 *
 * Why this exists: `members` has ONLY partial unique indexes
 *   - uq_members_account_contact (account_id, contact_id) WHERE contact_id IS NOT NULL AND member_type='individual'
 *   - uq_members_account_company (account_id, company_name) WHERE company_name IS NOT NULL
 * Postgres cannot use a partial index as an ON CONFLICT arbiter without repeating
 * its predicate, and supabase-js emits a bare `ON CONFLICT (cols)`. So
 * `.upsert({ onConflict: 'account_id,contact_id' })` raises 42P10 and (because the
 * error was never captured) silently wrote NOTHING in the onboarding job. This
 * helper does the idempotent write by hand: find the row on its natural key, then
 * UPDATE it or INSERT — so re-running a job updates in place instead of failing or
 * duplicating.
 *
 * Natural key: individual rows key on (account_id, contact_id); company rows key
 * on (account_id, company_name) — matching the two partial indexes.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

export interface MemberRowInput {
  account_id: string
  member_type: 'individual' | 'company'
  contact_id?: string | null
  company_name?: string | null
  full_name?: string | null
  email?: string | null
  ein?: string | null
  ownership_pct?: number | null
  is_primary?: boolean
  is_signer?: boolean
  address_street?: string | null
  address_city?: string | null
  address_state?: string | null
  address_zip?: string | null
  address_country?: string | null
  representative_name?: string | null
  representative_email?: string | null
  representative_address_street?: string | null
  representative_address_city?: string | null
  representative_address_state?: string | null
  representative_address_zip?: string | null
  representative_address_country?: string | null
  updated_at?: string
}

/**
 * Idempotently write one members row. Returns { error } on failure (never throws)
 * so callers can record a step and continue.
 */
export async function upsertMemberRow(row: MemberRowInput): Promise<{ error?: string }> {
  const now = row.updated_at || new Date().toISOString()
  const payload = { ...row, updated_at: now }

  // Locate an existing row on the natural key so a re-run updates in place.
  let existingId: string | null = null
  try {
    if (row.member_type === 'individual' && row.contact_id) {
      const { data } = await supabaseAdmin
        .from('members')
        .select('id')
        .eq('account_id', row.account_id)
        .eq('contact_id', row.contact_id)
        .eq('member_type', 'individual')
        .limit(1)
        .maybeSingle()
      existingId = data?.id ?? null
    } else if (row.member_type === 'company' && row.company_name) {
      const { data } = await supabaseAdmin
        .from('members')
        .select('id')
        .eq('account_id', row.account_id)
        .eq('company_name', row.company_name)
        .limit(1)
        .maybeSingle()
      existingId = data?.id ?? null
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }

  if (existingId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- some columns not yet in generated types
    const { error } = await supabaseAdmin.from('members').update(payload as any).eq('id', existingId)
    return error ? { error: error.message } : {}
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- some columns not yet in generated types
  const { error } = await supabaseAdmin.from('members').insert({ ...payload, created_at: now } as any)
  return error ? { error: error.message } : {}
}
