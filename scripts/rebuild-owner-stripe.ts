/* eslint-disable no-console -- CLI tool: stdout IS the output. */
/**
 * Rebuild the Stripe account as a CLEARING ACCOUNT that ties to Stripe's own
 * year-end balance.
 *
 * WHAT WAS WRONG with the first import (all three found by reconciling against
 * Stripe's own 2025 balance summary, not by reading the code):
 *
 *  1. 29 FAILED charges were loaded as income. The export lists a declined card
 *     with an amount and a "Failed" status; the importer read the amount and
 *     ignored the status. That is $20,589 of money that never arrived.
 *  2. EUR charges were loaded at their EURO face value labelled as dollars. The
 *     "Amount" column is in the original currency; "Converted Amount" is the
 *     settlement figure. Summing the converted column gives 103,946.64 — Stripe's
 *     own gross to the cent; summing the raw column gives 103,057.60.
 *  3. FEES were never booked at all — the importer read no fee column. Stripe
 *     charged 3,594.39.
 *
 * WHY A CLEARING ACCOUNT. The 158 charges are the income. The 94 payouts are the
 * SAME money moving to Mercury — counting both is a $95,970 double-count, which is
 * exactly the error found in the prepared bookkeeping. So the payouts leave Stripe
 * as transfers and arrive at Mercury as transfers, and neither touches the P&L.
 *
 * THE PROOF. Stripe's own summary: 103,946.64 − 3,594.39 − 1,500.00 − 95,970.15
 * = 2,882.10 ending balance. After this rebuild the account's own rows must sum to
 * exactly that. If they do not, the load is wrong and the script says so.
 *
 * Run:
 *   npx tsx scripts/rebuild-owner-stripe.ts --dry-run
 *   npx tsx scripts/rebuild-owner-stripe.ts --apply
 */
import * as dotenv from 'dotenv'
import * as fs from 'fs'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: '.env.local' })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
if (url.includes('ydzipybqeebtpcvsbtvs')) {
  console.error('❌ PRODUCTION Supabase detected — this is sandbox-only.')
  process.exit(1)
}
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const ENTITY = '00000000-0000-0000-0000-000000000001'
const STRIPE = 'Stripe processor 0001'
const YEAR = 2025

/** Stripe's own 2025 balance summary — the figures this rebuild must reproduce. */
const STRIPE_SAYS = { gross: 103946.64, fees: 3594.39, refunds: 1500.00, payouts: 95970.15, ending: 2882.10 }

interface Row {
  transaction_date: string
  description: string
  counterparty?: string
  amount: number
  currency: string
  bank_name: string
  account_type: string
  transaction_ref: string
  balance_after: number | null
  tax_year: number
  category: string
  subcategory: string
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let cur: string[] = [], field = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') inQ = false
      else field += c
    } else if (c === '"') inQ = true
    else if (c === ',') { cur.push(field); field = '' }
    else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field || cur.length) { cur.push(field); rows.push(cur) }
  const head = rows.shift()!
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}

async function main() {
  const apply = process.argv.includes('--apply')
  const csvPath = process.argv.find(a => a.endsWith('.csv'))
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error('Pass the Stripe CSV path as an argument.')
    process.exit(1)
  }

  const raw = parseCsv(fs.readFileSync(csvPath, 'utf-8'))
  // CAPTURED ONLY. A declined card is not income; this is defect (1).
  const captured = raw.filter(r => r.Captured === 'TRUE')

  const out: Row[] = []
  let gross = 0, fees = 0, refunds = 0

  for (const r of captured) {
    const date = (r['Created date (UTC)'] || '').slice(0, 10)
    const id = r.id
    // CONVERTED amount — defect (2). The raw column is in the charge's own currency.
    const amt = Number(r['Converted Amount'] || 0)
    const fee = Number(r.Fee || 0)
    const ref = Number(r['Amount Refunded'] || 0)
    const desc = r.Description || r['Statement Descriptor'] || 'Stripe charge'

    gross += amt
    out.push({
      transaction_date: date, description: desc, counterparty: r['customer_name (metadata)'] || undefined,
      amount: amt, currency: 'USD', bank_name: STRIPE, account_type: 'processor',
      transaction_ref: `stripe:${id}`, balance_after: null, tax_year: YEAR,
      category: 'income', subcategory: 'client_payment',
    })

    if (fee > 0) {
      fees += fee
      out.push({
        transaction_date: date, description: `Stripe processing fee — ${desc}`,
        amount: -fee, currency: 'USD', bank_name: STRIPE, account_type: 'processor',
        transaction_ref: `stripe:${id}:fee`, balance_after: null, tax_year: YEAR,
        category: 'fee', subcategory: 'processing_fee',
      })
    }

    if (ref > 0) {
      refunds += ref
      out.push({
        transaction_date: date, description: `Refund — ${desc}`,
        amount: -ref, currency: 'USD', bank_name: STRIPE, account_type: 'processor',
        transaction_ref: `stripe:${id}:refund`, balance_after: null, tax_year: YEAR,
        category: 'refund', subcategory: 'client_refund',
      })
    }
  }

  // The payout leg. Mirrored from the MERCURY rows that actually received the money,
  // so the two sides carry identical dates and amounts by construction rather than by
  // a matching heuristic that could pair the wrong ones.
  const { data: mercury, error: mErr } = await db.from('td_books_transactions')
    .select('id, transaction_date, amount, description')
    .eq('entity_id', ENTITY).eq('tax_year', YEAR)
    .eq('bank_name', 'Mercury checking 4517').ilike('description', '%stripe%')
  if (mErr) throw mErr

  let payouts = 0
  for (const m of mercury ?? []) {
    payouts += Number(m.amount)
    out.push({
      transaction_date: m.transaction_date, description: `Payout to Mercury — ${m.description.slice(0, 60)}`,
      amount: -Number(m.amount), currency: 'USD', bank_name: STRIPE, account_type: 'processor',
      transaction_ref: `stripe:payout:${m.id}`, balance_after: null, tax_year: YEAR,
      category: 'transfer', subcategory: 'stripe_payout',
    })
  }

  const ending = gross - fees - refunds - payouts
  const ok = (a: number, b: number) => Math.abs(a - b) < 0.01
  const check = (label: string, got: number, want: number) =>
    console.log(`  ${label.padEnd(22)} ${got.toFixed(2).padStart(12)}   Stripe says ${want.toFixed(2).padStart(12)}   ${ok(got, want) ? '✓' : '✗ MISMATCH'}`)

  console.log(`\nRebuilt Stripe from ${captured.length} captured charges (${raw.length - captured.length} failed, excluded) + ${mercury?.length ?? 0} payouts\n`)
  check('gross charges', gross, STRIPE_SAYS.gross)
  check('fees', fees, STRIPE_SAYS.fees)
  check('refunds', refunds, STRIPE_SAYS.refunds)
  check('payouts to Mercury', payouts, STRIPE_SAYS.payouts)
  check('ENDING BALANCE', ending, STRIPE_SAYS.ending)

  const allOk = ok(gross, STRIPE_SAYS.gross) && ok(fees, STRIPE_SAYS.fees)
    && ok(refunds, STRIPE_SAYS.refunds) && ok(payouts, STRIPE_SAYS.payouts) && ok(ending, STRIPE_SAYS.ending)
  if (!allOk) {
    console.error('\n❌ The rebuild does NOT reproduce Stripe\'s own figures. Refusing to write.')
    process.exit(1)
  }
  console.log(`\n  → ${out.length} rows to write`)

  if (!apply) { console.log('\n[DRY RUN — nothing written]'); return }

  // Back up before deleting. A mutation that removes 187 rows is not something to
  // run without a copy on disk.
  const { data: existing } = await db.from('td_books_transactions').select('*')
    .eq('entity_id', ENTITY).eq('tax_year', YEAR).eq('bank_name', STRIPE)
  fs.writeFileSync('.books-scratch/backup-stripe-before-rebuild.json', JSON.stringify(existing, null, 2))
  console.log(`  backed up ${existing?.length ?? 0} existing rows`)

  const { error: dErr } = await db.from('td_books_transactions').delete()
    .eq('entity_id', ENTITY).eq('tax_year', YEAR).eq('bank_name', STRIPE)
  if (dErr) throw dErr

  for (let i = 0; i < out.length; i += 200) {
    const { error } = await db.from('td_books_transactions').insert(
      out.slice(i, i + 200).map(r => ({ ...r, entity_id: ENTITY })),
    )
    if (error) throw error
  }
  console.log(`  ✓ wrote ${out.length} rows`)

  // The Mercury side. Those deposits are the OTHER leg of the same movement and must
  // not also read as income.
  let marked = 0
  for (const m of mercury ?? []) {
    const { error, count } = await db.from('td_books_transactions')
      .update({ category: 'transfer', subcategory: 'stripe_payout' }, { count: 'exact' })
      .eq('id', m.id).eq('category', 'uncategorized')
    if (error) throw error
    marked += count ?? 0
  }
  console.log(`  ✓ marked ${marked} of ${mercury?.length ?? 0} Mercury deposits as transfers`)
}

main().catch(e => { console.error(e); process.exit(1) })
