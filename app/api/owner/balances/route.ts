import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { TD_ENTITY_ID } from '@/lib/owner-finance'
import { computeBooksTieOut } from '@/lib/owner-tie-out'
import type { Database } from '@/lib/database.types'

export const dynamic = 'force-dynamic'

/** Per-bank statement balances + the tie-out (Phase 2): does opening + captured movement
 * equal the statement's closing? The movement counts BOTH the owner's books rows AND
 * client-payment deposits from the bank feed — client money is real bank movement even
 * though its income lives in the payments ledger. */
export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const year = parseInt(searchParams.get('year') ?? String(new Date().getFullYear()), 10)
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: 'year must be a 4-digit year' }, { status: 400 })
  }

  try {
    const tieOut = await computeBooksTieOut(year)
    return NextResponse.json({ year, rows: tieOut })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Tie-out failed' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { tax_year, bank_key, currency, opening_balance, closing_balance, notes } = body
  if (!Number.isInteger(tax_year) || typeof bank_key !== 'string' || !bank_key.trim() || typeof currency !== 'string') {
    return NextResponse.json({ error: 'tax_year, bank_key and currency are required' }, { status: 400 })
  }
  if (bank_key.includes('|')) {
    return NextResponse.json({ error: 'bank_key must not contain "|"' }, { status: 400 })
  }
  if (!/^[A-Za-z]{3}$/.test(currency)) {
    return NextResponse.json({ error: 'currency must be a 3-letter code (e.g. USD, EUR)' }, { status: 400 })
  }
  // Coerce ONCE, write the coerced value: "" and true are Number-finite-ish trapdoors
  // that would otherwise reach Postgres raw and 500. null = clear; undefined = invalid.
  const coerceBalance = (v: unknown): number | null | undefined => {
    if (v === null || v === undefined || v === '') return null
    if (typeof v !== 'number' && typeof v !== 'string') return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const opening = coerceBalance(opening_balance)
  if (opening === undefined) return NextResponse.json({ error: 'opening_balance must be a number' }, { status: 400 })
  const closing = coerceBalance(closing_balance)
  if (closing === undefined) return NextResponse.json({ error: 'closing_balance must be a number' }, { status: 400 })

  // notes: only write when explicitly provided — a balance save from a client that
  // doesn't know about notes must never wipe one.
  const record: Database['public']['Tables']['td_books_bank_balances']['Insert'] = {
    entity_id: TD_ENTITY_ID,
    tax_year,
    bank_key: bank_key.trim(),
    currency: currency.toUpperCase(),
    opening_balance: opening,
    closing_balance: closing,
    updated_at: new Date().toISOString(),
  }
  if (notes !== undefined) record.notes = notes === null ? null : String(notes)

  const { data, error } = await supabaseAdmin
    .from('td_books_bank_balances')
    .upsert(record, { onConflict: 'entity_id,tax_year,bank_key,currency' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ balance: data })
}
