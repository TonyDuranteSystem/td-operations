/* eslint-disable no-console -- CLI tool: stdout IS the output. */
/**
 * Apply the owner-books categorization rules to rows that are still uncategorized.
 *
 * TWO SAFETY PROPERTIES, both learned the hard way on this data:
 *
 *  1. It only ever touches rows whose category is still `uncategorized`. An earlier
 *     pass re-ran over a stale snapshot and let a general rule overwrite a specific
 *     classification that had already been made correctly.
 *  2. It reads PAGED. PostgREST caps an un-ranged select at 1000 rows and returns no
 *     error at all, so a naive read of a 1,350-row year silently drops the tail —
 *     and the rows it drops are exactly the ones that then look "already done".
 *
 * Run:
 *   npx tsx scripts/apply-owner-books-rules.ts --year 2025 --dry-run
 *   npx tsx scripts/apply-owner-books-rules.ts --year 2025 --account "Chase credit card 9279"
 *
 * --dry-run prints what WOULD change, grouped, plus everything left unmatched.
 * Nothing is written without an explicit run.
 */
import * as dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { classifyOwnerTransaction } from '../lib/owner-books-rules'

dotenv.config({ path: '.env.local' })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
if (url.includes('ydzipybqeebtpcvsbtvs')) {
  console.error('❌ PRODUCTION Supabase detected — this is sandbox-only.')
  process.exit(1)
}
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const ENTITY = '00000000-0000-0000-0000-000000000001'

interface Row {
  id: string
  description: string
  amount: number
  bank_name: string
  account_type: string | null
  transaction_date: string
}

async function fetchUncategorized(year: number, account: string | null): Promise<Row[]> {
  const out: Row[] = []
  for (let from = 0; ; from += 1000) {
    let q = db.from('td_books_transactions')
      .select('id,description,amount,bank_name,account_type,transaction_date')
      .eq('entity_id', ENTITY).eq('tax_year', year).eq('category', 'uncategorized')
    if (account) q = q.eq('bank_name', account)
    const { data, error } = await q.order('id').range(from, from + 999)
    if (error) throw error
    out.push(...(data as Row[]))
    if (data.length < 1000) break
  }
  return out
}

async function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const yearIdx = argv.indexOf('--year')
  const accIdx = argv.indexOf('--account')
  const year = yearIdx >= 0 ? Number(argv[yearIdx + 1]) : NaN
  const account = accIdx >= 0 ? argv[accIdx + 1] : null

  if (!Number.isInteger(year)) {
    console.error('--year is required, e.g. --year 2025')
    process.exit(1)
  }
  if (year === 2026) {
    // 2026 holds real live bank-feed data and is explicitly off limits to this rebuild.
    console.error('❌ 2026 is off limits — this rebuild is 2025 only.')
    process.exit(1)
  }

  const rows = await fetchUncategorized(year, account)
  console.log(`uncategorized rows in ${year}${account ? ` for ${account}` : ''}: ${rows.length}`)

  const planned: Array<{ row: Row; category: string; subcategory: string }> = []
  const unmatched: Row[] = []
  for (const r of rows) {
    const m = classifyOwnerTransaction(r.description, r.amount, r.account_type)
    if (m) planned.push({ row: r, category: m.category, subcategory: m.subcategory })
    else unmatched.push(r)
  }

  const byBucket = new Map<string, { n: number; total: number }>()
  for (const p of planned) {
    const k = `${p.category} / ${p.subcategory}`
    const v = byBucket.get(k) || { n: 0, total: 0 }
    v.n++; v.total += p.row.amount
    byBucket.set(k, v)
  }
  console.log(`\nwould categorize ${planned.length}, leaving ${unmatched.length} unmatched\n`)
  for (const [k, v] of [...byBucket].sort((a, b) => a[1].total - b[1].total)) {
    console.log(`  ${String(v.n).padStart(4)}  ${v.total.toFixed(2).padStart(12)}  ${k}`)
  }

  if (unmatched.length) {
    const agg = new Map<string, { n: number; total: number }>()
    for (const r of unmatched) {
      const k = (r.description || '').replace(/\d{2,}/g, '#').toUpperCase().slice(0, 42)
      const v = agg.get(k) || { n: 0, total: 0 }
      v.n++; v.total += r.amount
      agg.set(k, v)
    }
    console.log(`\n--- UNMATCHED (stay uncategorized, by |total|) ---`)
    for (const [k, v] of [...agg].sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total)).slice(0, 60)) {
      console.log(`  ${String(v.n).padStart(4)}  ${v.total.toFixed(2).padStart(12)}  ${k}`)
    }
  }

  if (dryRun) {
    console.log('\n[DRY RUN — nothing written]')
    return
  }

  let written = 0
  for (const p of planned) {
    // Row-scoped, and re-asserting `uncategorized` in the WHERE so a row categorized
    // between the read and the write is left alone rather than overwritten.
    const { error, count } = await db.from('td_books_transactions')
      .update({ category: p.category, subcategory: p.subcategory }, { count: 'exact' })
      .eq('id', p.row.id).eq('category', 'uncategorized')
    if (error) throw error
    written += count ?? 0
  }
  console.log(`\n✓ wrote ${written} of ${planned.length} planned`)
  if (written !== planned.length) {
    console.log('  (the difference was categorized by something else between read and write)')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
