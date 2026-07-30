import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { TD_ENTITY_ID } from '@/lib/owner-finance'
import { isSimilarVendor, normalizeVendorKey, vendorIdentity } from '@/lib/owner-vendor-match'

export const dynamic = 'force-dynamic'

/**
 * "Transactions like this" (the QuickBooks pattern): given one books row, find every
 * OTHER still-uncategorized row of the same tax year with a similar counterparty —
 * loose-matched, because banks word the same vendor differently. Server-side so the
 * count covers the whole year, not just the page the UI happens to have loaded.
 */
export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { data: target, error: targetError } = await supabaseAdmin
    .from('td_books_transactions')
    .select('id, tax_year, counterparty, description')
    .eq('id', id)
    .eq('entity_id', TD_ENTITY_ID)
    .single()

  if (targetError || !target) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  // Vendor IDENTITY, not raw counterparty: Mercury puts the SENDER (our own company)
  // in the counterparty of outgoing payments — raw matching grouped a $2,500 vendor
  // payment with the own-account transfers (Antonio's live catch).
  const targetKey = vendorIdentity(target.counterparty, target.description)

  const CANDIDATE_LIMIT = 2000
  const { data: candidates, error } = await supabaseAdmin
    .from('td_books_transactions')
    .select('id, counterparty, description, transaction_ref, amount')
    .eq('entity_id', TD_ENTITY_ID)
    .eq('tax_year', target.tax_year)
    .eq('category', 'uncategorized')
    .neq('id', target.id)
    .order('id', { ascending: true })
    .limit(CANDIDATE_LIMIT)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const similar = (candidates ?? []).filter(c =>
    isSimilarVendor(targetKey, vendorIdentity(c.counterparty, c.description))
  )

  // The "Always do this" rule pattern must cover the WHOLE matched set, not just the
  // wording of whichever row the modal happened to open on. Similarity is (whole-token)
  // containment, so the SHORTEST normalized key in the set is the most general member —
  // a contains-rule saved with it matches every current member and future arrivals alike.
  const keys = [targetKey, ...similar.map(s => vendorIdentity(s.counterparty, s.description))]
    .map(k => normalizeVendorKey(k))
    .filter(Boolean)
  const suggestedPattern = keys.sort((a, b) => a.length - b.length)[0] ?? ''

  return NextResponse.json({
    count: similar.length,
    ids: similar.map(s => s.id),
    suggested_pattern: suggestedPattern,
    // The human must SEE what they're about to label, not trust a count — the modal
    // renders ALL of these in a scrollable list (Antonio: "I want to see all
    // transactions"). Cap only as an anti-blowup backstop.
    preview: similar.slice(0, 500).map(s => ({
      text: s.counterparty ?? s.description,
      amount: Number(s.amount),
    })),
    // Money-in AND money-out in one set is a strong wrong-one-label signal.
    mixed_signs: similar.some(s => Number(s.amount) > 0) && similar.some(s => Number(s.amount) < 0),
    // A full candidate page means the scan may have missed rows — say so, never imply
    // completeness that wasn't checked.
    truncated: (candidates ?? []).length === CANDIDATE_LIMIT,
    // The income double-count guard needs to know if ANY matched row is a bank deposit —
    // live-feed OR statement-imported (after a backfill, most deposits are stmt: rows).
    has_positive_feed_rows: similar.some(s => Number(s.amount) > 0 && (s.transaction_ref?.startsWith('feed:') || s.transaction_ref?.startsWith('stmt:'))),
  })
}
