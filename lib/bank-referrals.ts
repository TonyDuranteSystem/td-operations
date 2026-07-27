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
      order: (col: string, opts: { ascending: boolean }) => Promise<{ data: unknown[] | null; error: unknown }>
    }
    insert: (row: Record<string, unknown>) => { select: (sel?: string) => { single: () => Promise<{ data: unknown; error: unknown }> } }
  }
}

/** Every editable column of a bank row, as the CRM screen reads/writes it. */
export const BANK_COLUMNS =
  'slug, label, apply_url, rep_email, tag, description_en, description_it, managed, sort_order, enabled, created_at, updated_at'

/**
 * Validates the apply link for the kind of bank it is. A managed bank
 * ("we submit for you") points at our OWN intake form, e.g.
 * `/portal/wizard?type=banking_relay` — an internal path, not an external site,
 * so the http(s) rule would wrongly reject it. A self-service bank must be a
 * real http(s) link because the tracked redirect forwards the browser to it.
 *
 * Returns an error message, or null when the link is acceptable.
 */
export function validateApplyUrl(applyUrl: string, managed: boolean): string | null {
  const value = applyUrl.trim()
  if (!value) return 'apply_url is required'
  if (managed) {
    return value.startsWith('/')
      ? null
      : 'For "we submit for you" banks the link must be an internal path starting with /'
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return 'apply_url must be a valid http(s) URL'
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'apply_url must be a valid http(s) URL'
  }
  return null
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
/**
 * A bank tile as rendered on the client-facing /portal/banks page. This is the
 * full shape Antonio edits from the CRM (Trackers -> Banking Fintech), which is
 * the single source of truth since 2026-07-27 — the page used to carry its own
 * hardcoded array and drifted from the CRM list (the hardcoded Sokin tile even
 * lost the ?pid referral tag).
 */
export interface BankPageOption {
  slug: string
  label: string
  apply_url: string
  tag: string | null
  description_en: string | null
  description_it: string | null
  /**
   * TRUE = TD collects the details and files the application. The tile opens
   * the internal intake form in the SAME tab and is not click-tracked.
   * FALSE = self-service; the tile routes through the tracked redirect so the
   * click is recorded against the account and the rep is notified.
   */
  managed: boolean
}

/**
 * Last-resort list used ONLY when the catalog is unreachable or empty, so a
 * client never lands on an empty Bank Applications page. Deliberately excludes
 * Wise (removed by Antonio 2026-07-27) — a fallback must never resurrect a
 * provider that was taken down on purpose. Everything else is managed from the
 * CRM; do not extend this list, add banks there.
 */
const FALLBACK_BANKS: BankPageOption[] = [
  {
    slug: 'relay',
    label: 'Relay',
    apply_url: '/portal/wizard?type=banking_relay',
    tag: 'USD',
    managed: true,
    description_en: 'US business account (USD) — fill in your details and we prepare and submit the application for you.',
    description_it: 'Conto business USA (USD) — inserisci i tuoi dati e prepariamo e inviamo la richiesta per te.',
  },
  {
    slug: 'payset',
    label: 'Payset',
    apply_url: '/portal/wizard?type=banking_payset',
    tag: 'EUR / Multi-currency',
    managed: true,
    description_en: 'EUR/IBAN multi-currency account — fill in your details and we submit the application for you.',
    description_it: 'Conto multivaluta EUR/IBAN — inserisci i tuoi dati e inviamo la richiesta per te.',
  },
]

/**
 * Enabled banks for the client-facing Bank Applications page, in the display
 * order set in the CRM. Falls back to FALLBACK_BANKS if the catalog is missing
 * or empty so the page is never blank for a client.
 */
export async function getBankPageOptions(): Promise<BankPageOption[]> {
  try {
    const { data, error } = await untyped
      .from('bank_referrals')
      .select('slug, label, apply_url, tag, description_en, description_it, managed, sort_order')
      .eq('enabled', true)
      .order('sort_order', { ascending: true })
    if (error) return FALLBACK_BANKS
    const rows = (data ?? []) as BankPageOption[]
    return rows.length > 0 ? rows : FALLBACK_BANKS
  } catch {
    return FALLBACK_BANKS
  }
}

/**
 * Where a bank tile should point. Managed banks go straight to the internal
 * intake form (same tab, no tracking — there's no external click to attribute).
 * Self-service banks go through the tracked redirect, which records the click
 * and then forwards to the provider's real (referral-tagged) URL.
 */
export function bankTileHref(bank: Pick<BankPageOption, 'slug' | 'apply_url' | 'managed'>): string {
  return bank.managed ? bank.apply_url : `/portal/apply/bank/${bank.slug}`
}

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
