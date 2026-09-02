/* eslint-disable no-console -- CLI tool: stdout IS the output. */
/**
 * Flip the sign on accounts whose statement uses the OPPOSITE convention to the
 * rest of the books.
 *
 * WHY THIS EXISTS. Amex writes a purchase as POSITIVE and a card payment as
 * NEGATIVE — the reverse of Chase and of every other account here. The importer
 * has no reader for Amex, so the file falls to the generic column mapper, which
 * copies the number exactly as written and forms no belief about what the account
 * is. Left alone the books report roughly $80,457 EARNED from Corporate Filings,
 * Home Depot, Geico and Zoho, and $83,883 SPENT paying the card off. The First
 * Citizens loan has the same defect: its drawdown reads as money out and its
 * repayments as money in.
 *
 * THE BALANCE IS NOT NEGATED — and this was checked with arithmetic, not assumed.
 * A first version of this script negated `balance_after` too, on the reasoning that
 * both columns share a convention. They do not. A loan statement prints the balance
 * as the AMOUNT OWED, and the amounts are the CHANGE in what is owed. Proven on the
 * real June 2025 rows: with the amounts flipped (interest +783.91, payment -1,068.30)
 * and the balance left positive, 144,500 + (-284.39) = 144,215.61 — exactly what the
 * statement states. Negating the balance would have broken the very chain this fix
 * exists to make true. Amex carries no balance at all, so the question is moot there.
 *
 * SAFETY:
 *  - Sandbox only, production ref hard-refused.
 *  - --dry-run by default in practice: nothing is written without an explicit run.
 *  - Refuses to touch a CATEGORIZED row. A sign flip under a human's decision
 *    silently changes what that decision meant.
 *  - Prints a BEFORE/AFTER control total. A mutation over ~29% of the dataset
 *    with an $80k swing is not something to run and hope.
 *  - Idempotent by intent, NOT by construction: running it twice flips back. The
 *    control total is how you tell. Read it.
 *
 * Run:
 *   npx tsx scripts/fix-owner-inverted-signs.ts --year 2025 --dry-run
 *   npx tsx scripts/fix-owner-inverted-signs.ts --year 2025 --apply
 */
import * as dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: '.env.local' })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
if (url.includes('ydzipybqeebtpcvsbtvs')) {
  console.error('❌ PRODUCTION Supabase detected — this is sandbox-only.')
  process.exit(1)
}
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const ENTITY = '00000000-0000-0000-0000-000000000001'

/** The accounts whose export inverts the sign, and the evidence for each. */
const INVERTED = [
  {
    bank_name: 'Amex credit card 51007',
    why: 'Amex writes a charge positive and a card payment negative. Tell: of 48 negative rows, 24 are "MOBILE PAYMENT - THANK YOU" totalling -81,124.41 — payments cannot be the spending.',
  },
  {
    bank_name: 'Firstcitizenbank loan 7363',
    why: 'Drawdown recorded as money out ("LOAN FUNDING" negative) and repayments as money in. A drawdown increases what is owed.',
  },
]

interface Row {
  id: string
  amount: number
  balance_after: number | null
  category: string
  description: string
}

async function fetchAll(bank: string, year: number): Promise<Row[]> {
  const out: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('td_books_transactions')
      .select('id, amount, balance_after, category, description')
      .eq('entity_id', ENTITY).eq('tax_year', year).eq('bank_name', bank)
      .order('id').range(from, from + 999)
    if (error) throw error
    out.push(...(data as Row[]))
    if (data.length < 1000) break
  }
  return out
}

const money = (n: number) => n.toFixed(2).padStart(14)

async function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const yearIdx = argv.indexOf('--year')
  const year = yearIdx >= 0 ? Number(argv[yearIdx + 1]) : NaN
  if (!Number.isInteger(year)) {
    console.error('--year is required, e.g. --year 2025')
    process.exit(1)
  }
  if (year === 2026) {
    console.error('❌ 2026 is off limits.')
    process.exit(1)
  }

  for (const acct of INVERTED) {
    const rows = await fetchAll(acct.bank_name, year)
    if (rows.length === 0) { console.log(`\n· ${acct.bank_name}: no ${year} rows\n`); continue }

    const categorized = rows.filter(r => r.category !== 'uncategorized')
    const target = rows.filter(r => r.category === 'uncategorized')

    const before = { in: 0, out: 0 }
    for (const r of target) { if (r.amount > 0) before.in += r.amount; else before.out += r.amount }

    console.log(`\n═══ ${acct.bank_name} ═══`)
    console.log(`  ${acct.why}`)
    console.log(`  rows ${rows.length}   flippable ${target.length}   REFUSED (already categorized) ${categorized.length}`)
    console.log(`  BEFORE   in ${money(before.in)}   out ${money(before.out)}   net ${money(before.in + before.out)}`)
    console.log(`  AFTER    in ${money(-before.out)}   out ${money(-before.in)}   net ${money(-(before.in + before.out))}`)
    const withBal = target.filter(r => r.balance_after !== null).length
    console.log(`  stated balances LEFT AS-IS on ${withBal} row(s) — they are the amount owed, not a signed amount`)

    if (categorized.length > 0) {
      console.log(`  ⚠ ${categorized.length} row(s) already carry a human decision and are LEFT ALONE — a flip under a decision changes what it meant.`)
    }

    if (!apply) { console.log('  [DRY RUN — nothing written]'); continue }

    let written = 0
    for (const r of target) {
      const { error, count } = await db.from('td_books_transactions')
        // amount ONLY — see the header. The stated balance is already correct.
        .update({ amount: -r.amount }, { count: 'exact' })
        // Re-assert uncategorized in the WHERE: a row categorized between the read
        // and the write must not be flipped underneath that decision.
        .eq('id', r.id).eq('category', 'uncategorized')
      if (error) throw error
      written += count ?? 0
    }
    console.log(`  ✓ flipped ${written} of ${target.length}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
