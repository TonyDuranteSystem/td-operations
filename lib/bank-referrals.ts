import { supabaseAdmin } from '@/lib/supabase-admin'

// Thin queries for the bank_referrals + bank_referral_clicks tables. We
// centralise the Supabase calls here because the generated DB types don't
// include these tables yet, and the untyped access is done via `as unknown`
// in one place instead of scattered casts. Once types are regenerated this
// file can drop the cast.
const untyped = supabaseAdmin as unknown as {
  from: (table: string) => {
    select: (sel: string) => {
      eq: (col: string, val: unknown) => {
        order: (col: string, opts: { ascending: boolean }) => Promise<{ data: unknown[] | null; error: unknown }>
      }
    }
    insert: (row: Record<string, unknown>) => { select: (sel?: string) => { single: () => Promise<{ data: unknown; error: unknown }> } }
  }
}

export interface EnabledBankReferral {
  slug: string
  label: string
}

export interface BankClickRow {
  bank_slug: string
  clicked_at: string
}

export async function getEnabledBankReferrals(): Promise<EnabledBankReferral[]> {
  const { data } = await untyped
    .from('bank_referrals')
    .select('slug, label')
    .eq('enabled', true)
    .order('label', { ascending: true })
  return (data ?? []) as EnabledBankReferral[]
}

export async function getBankClicksForAccount(accountId: string): Promise<BankClickRow[]> {
  const { data } = await untyped
    .from('bank_referral_clicks')
    .select('bank_slug, clicked_at')
    .eq('account_id', accountId)
    .order('clicked_at', { ascending: false })
  return (data ?? []) as BankClickRow[]
}

export interface BankReferralStatus {
  slug: string
  label: string
  clicked_at: string | null
}

/**
 * Enabled partner banks plus this account's latest click timestamp (if any).
 * Returns empty array if the tables don't exist yet (graceful when schema
 * hasn't been applied in a given environment).
 */
export async function getBankReferralsForAccount(accountId: string): Promise<BankReferralStatus[]> {
  try {
    const [referrals, clicks] = await Promise.all([
      getEnabledBankReferrals(),
      getBankClicksForAccount(accountId),
    ])
    const lastClick: Record<string, string> = {}
    for (const c of clicks) {
      if (!lastClick[c.bank_slug]) lastClick[c.bank_slug] = c.clicked_at
    }
    return referrals.map(r => ({
      slug: r.slug,
      label: r.label,
      clicked_at: lastClick[r.slug] ?? null,
    }))
  } catch {
    return []
  }
}
