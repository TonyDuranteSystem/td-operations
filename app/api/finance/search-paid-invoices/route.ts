/**
 * Search ALREADY-PAID invoices by company name or invoice number — deliberately
 * separate from the everyday open-invoice list (`bankOpenInvoices` in
 * app/(dashboard)/finance/page.tsx), which excludes anything paid on purpose so
 * a QA invoice or a settled one never absorbs real client money.
 *
 * Exists for exactly one case: connecting a real bank transaction to an
 * invoice that was already marked paid some other way — an audit-trail link,
 * never money (see lib/finance/owner-transaction-link.ts's isPaidInvoice
 * branch). On-demand and query-only, not loaded on every page visit: Antonio
 * asked for no time limit on how far back this can reach, and the business
 * has years of paid invoices — sending all of them on every Finance page load
 * would be exactly the kind of unbounded payload this avoids by only ever
 * running when someone actually types a search.
 */
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ invoices: [] })

  // Company name lives on `accounts`, a separate table — PostgREST can't
  // filter a parent query on an embedded child's column, so resolve matching
  // account ids first. No limit here either: this is a plain indexed search
  // over however many accounts actually match, not a capped recent-N list.
  const { data: matchingAccounts } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .ilike('company_name', `%${q}%`)
  const accountIds = (matchingAccounts ?? []).map(a => a.id)

  const selectCols = 'id, invoice_number, description, total, amount, amount_due, amount_currency, invoice_status, status, account_id, accounts:account_id(company_name), contact_id, contacts:payments_contact_id_fkey(full_name)'

  // Genuinely fully paid — same narrowing as wasFullyPaid (not isPaidInvoice)
  // in lib/finance/invoice-matchability.ts: invoice_status='Paid' directly,
  // OR (invoice_status absent AND status='Paid') for the 48 production
  // invoices that only ever recorded it on the coarse column. Deliberately
  // NOT a plain status.eq.Paid OR — a credit note's `status` is ALSO always
  // "Paid" from the moment it's created regardless of its real
  // invoice_status="Credit", so that alone would surface credit notes here
  // labeled "Paid" and audit-linkable, which they are not (a credit note is
  // money owed back to the client, not money TD received).
  let query = supabaseAdmin
    .from('payments')
    .select(selectCols)
    .or('invoice_status.eq.Paid,and(invoice_status.is.null,status.eq.Paid)')
    .not('is_test', 'is', true)

  const orParts = [`invoice_number.ilike.%${q}%`, `description.ilike.%${q}%`]
  if (accountIds.length > 0) orParts.push(`account_id.in.(${accountIds.join(',')})`)
  query = query.or(orParts.join(','))

  const { data, error } = await query.order('paid_date', { ascending: false }).limit(30)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ invoices: data ?? [] })
}
