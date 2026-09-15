/**
 * Search ALREADY-PAID invoices by company name, contact name, or invoice
 * number — deliberately separate from the everyday open-invoice list
 * (`bankOpenInvoices` in app/(dashboard)/finance/page.tsx), which excludes
 * anything paid on purpose so a QA invoice or a settled one never absorbs
 * real client money.
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
import { isPaidInvoice } from '@/lib/finance/invoice-matchability'
import { escapeIlikeTerm } from '@/lib/inbox/recipient-search'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Fetched from the DB before the precise isPaidInvoice filter narrows it down
// (see below) — comfortably more than the 30 ever shown, so a handful of
// credit notes or other coarse-status-only false positives in the raw match
// still leave a full page of genuine results.
const DB_CANDIDATE_LIMIT = 100
const DISPLAY_LIMIT = 30

export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const rawQ = searchParams.get('q')?.trim() ?? ''
  if (rawQ.length < 2) return NextResponse.json({ invoices: [] })

  // Escaped BEFORE it ever reaches a `.or()` filter string — a raw comma or
  // parenthesis (routine in "Smith Holdings, LLC") breaks PostgREST's OR
  // grammar and previously came back as a silent 500 the client swallowed as
  // "no invoices match." Same helper already used for this exact reason in
  // lib/inbox/recipient-search.ts.
  const q = escapeIlikeTerm(rawQ)
  if (q.length < 2) return NextResponse.json({ invoices: [] })
  const pattern = `%${q}%`

  // Company/contact names live on separate tables — PostgREST can't filter a
  // parent query on an embedded child's column, so resolve matching ids
  // first. No limit on either lookup: a plain indexed search over however
  // many actually match, not a capped recent-N list.
  const [{ data: matchingAccounts }, { data: matchingContacts }] = await Promise.all([
    supabaseAdmin.from('accounts').select('id').ilike('company_name', pattern),
    supabaseAdmin.from('contacts').select('id').ilike('full_name', pattern),
  ])
  const accountIds = (matchingAccounts ?? []).map(a => a.id)
  const contactIds = (matchingContacts ?? []).map(c => c.id)

  const selectCols = 'id, invoice_number, description, total, amount, amount_due, amount_currency, invoice_status, status, account_id, accounts:account_id(company_name), contact_id, contacts:payments_contact_id_fkey(full_name)'

  // Broad on purpose: plain `status.eq.Paid` also catches a credit note (its
  // coarse status is "Paid" too, an artifact of the column's default for that
  // document type — see isPaidInvoice's own doc comment). That's fine here —
  // isPaidInvoice is applied as the precise, single-source-of-truth filter
  // below, in JS, rather than hand-translating its exact terminal-status
  // precedence into a second, separately-maintained SQL boolean (the two
  // ALREADY drifted once — a first version of this filter used only
  // `invoice_status.eq.Paid,and(invoice_status.is.null,status.eq.Paid)`,
  // which reproduced the exact dead-end this feature exists to fix for any
  // invoice whose invoice_status is stale — e.g. "Overdue" — while its coarse
  // status already reads Paid).
  let query = supabaseAdmin
    .from('payments')
    .select(selectCols)
    .or('invoice_status.eq.Paid,status.eq.Paid')
    .not('is_test', 'is', true)

  const orParts = [`invoice_number.ilike.${pattern}`, `description.ilike.${pattern}`]
  if (accountIds.length > 0) orParts.push(`account_id.in.(${accountIds.join(',')})`)
  if (contactIds.length > 0) orParts.push(`contact_id.in.(${contactIds.join(',')})`)
  query = query.or(orParts.join(','))

  const { data, error } = await query.order('paid_date', { ascending: false }).limit(DB_CANDIDATE_LIMIT)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const invoices = (data ?? []).filter(isPaidInvoice).slice(0, DISPLAY_LIMIT)
  return NextResponse.json({ invoices })
}
