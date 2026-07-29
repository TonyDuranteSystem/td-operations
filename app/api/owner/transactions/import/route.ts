import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { isOwnerCategory, TD_ENTITY_ID } from '@/lib/owner-finance'

export const dynamic = 'force-dynamic'

interface ImportRow {
  transaction_date: string
  description: string
  counterparty?: string
  amount: number
  currency?: string
  bank_name?: string
  account_type?: string
  transaction_ref?: string
  category?: string
  subcategory?: string
  notes?: string
  tax_year: number
}

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const rows: ImportRow[] = body.rows

  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'rows must be a non-empty array' }, { status: 400 })
  }

  // Currency must be a 3-letter ISO code, normalized UPPERCASE — a CSV "eur" would
  // otherwise create a separate 'eur' P&L block beside 'EUR', and a non-ISO string
  // crashes the currency formatter client-side.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.currency !== undefined && !/^[A-Za-z]{3}$/.test(r.currency)) {
      return NextResponse.json({ error: `Row ${i + 1}: currency "${r.currency}" is not a 3-letter code (e.g. USD, EUR)` }, { status: 400 })
    }
    if (r.category !== undefined && !isOwnerCategory(r.category)) {
      return NextResponse.json({ error: `Row ${i + 1}: unknown category "${r.category}"` }, { status: 400 })
    }
  }

  const records = rows.map(r => ({
    entity_id: TD_ENTITY_ID,
    tax_year: r.tax_year,
    transaction_date: r.transaction_date,
    description: r.description,
    counterparty: r.counterparty ?? null,
    amount: r.amount,
    currency: (r.currency ?? 'USD').toUpperCase(),
    bank_name: r.bank_name ?? null,
    account_type: r.account_type ?? null,
    transaction_ref: r.transaction_ref ?? null,
    category: r.category ?? 'uncategorized',
    subcategory: r.subcategory ?? null,
    notes: r.notes ?? null,
    is_related_party: false,
  }))

  const { data, error } = await supabaseAdmin
    .from('td_books_transactions')
    .upsert(records, {
      onConflict: 'entity_id,transaction_ref',
      ignoreDuplicates: true,
    })
    .select('id')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ imported: data?.length ?? 0 })
}
