import { supabaseAdmin } from '@/lib/supabase-admin'
import { isOwnerCategory, TD_ENTITY_ID } from '@/lib/owner-finance'

export interface OwnerImportRow {
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

/**
 * Validate + upsert a batch of rows into td_books_transactions. Shared by the
 * JSON import route and the statement-upload route so the currency/category
 * validation and the insert-once upsert semantics live in exactly one place.
 * Throws on the first validation problem (row index in the message) — callers
 * catch and turn it into their own response shape.
 */
export async function insertOwnerTransactionRows(rows: OwnerImportRow[]): Promise<{ imported: number }> {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('rows must be a non-empty array')
  }

  // Currency must be a 3-letter ISO code, normalized UPPERCASE — a CSV "eur" would
  // otherwise create a separate 'eur' P&L block beside 'EUR', and a non-ISO string
  // crashes the currency formatter client-side.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.currency !== undefined && !/^[A-Za-z]{3}$/.test(r.currency)) {
      throw new Error(`Row ${i + 1}: currency "${r.currency}" is not a 3-letter code (e.g. USD, EUR)`)
    }
    if (r.category !== undefined && !isOwnerCategory(r.category)) {
      throw new Error(`Row ${i + 1}: unknown category "${r.category}"`)
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

  if (error) throw new Error(error.message)
  return { imported: data?.length ?? 0 }
}
