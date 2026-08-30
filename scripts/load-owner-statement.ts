/* eslint-disable no-console -- CLI tool: stdout IS the output. */
/**
 * Load one (or several) real bank/card statement files into the owner's books
 * from the command line, using the EXACT same import code as the browser upload
 * (lib/owner-statement-import.ts) — same filename rule, same account stamping,
 * same year guard, same duplicate handling.
 *
 * Why this exists: the 2025 rebuild is ~20 statement files, and Antonio's rule is
 * one file at a time, read what it actually contains, then categorize it. Doing
 * that through the browser means re-authenticating for each pass; doing it with a
 * separate ad-hoc script would mean a second copy of the money decisions. This is
 * the third option — the same function, driven from a terminal.
 *
 * Run:
 *   npx tsx scripts/load-owner-statement.ts --year 2025 "path/to/Chase_checking_3920.csv"
 *   npx tsx scripts/load-owner-statement.ts --year 2025 --dry-run "path/to/file.csv"
 *
 * --dry-run parses and reports WITHOUT writing, so a file's contents can be read
 * before deciding anything. Nothing is categorized either way: every row lands
 * uncategorized, exactly as the upload route does.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const PRODUCTION_REF = 'ydzipybqeebtpcvsbtvs'
if ((process.env.NEXT_PUBLIC_SUPABASE_URL || '').includes(PRODUCTION_REF)) {
  console.error('❌ PRODUCTION Supabase detected — this loader is sandbox-only. Run scripts/dev-setup.sh.')
  process.exit(1)
}

async function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const yearIdx = argv.indexOf('--year')
  const year = yearIdx >= 0 ? Number(argv[yearIdx + 1]) : null
  const files = argv.filter((a, i) =>
    !a.startsWith('--') && i !== yearIdx + 1)

  if (files.length === 0) {
    console.error('Usage: npx tsx scripts/load-owner-statement.ts --year 2025 [--dry-run] <file...>')
    process.exit(1)
  }
  if (year !== null && !Number.isInteger(year)) {
    console.error('--year needs a 4-digit year, e.g. --year 2025')
    process.exit(1)
  }
  if (year === null) {
    // Not a default worth having: an un-scoped load is how 17 rows once leaked
    // into 2026, a year that is explicitly off limits.
    console.error('--year is REQUIRED. Rows outside it are skipped rather than written.')
    process.exit(1)
  }

  // Imported lazily so the production check above runs before any DB client is built.
  const { importOwnerStatement } = await import('../lib/owner-statement-import')

  for (const file of files) {
    const buffer = fs.readFileSync(file)
    const fileName = path.basename(file)

    if (dryRun) {
      // Mirror the real path as far as it goes without writing: the filename rule
      // and the parser, but no insert.
      const { parseStatementFilename } = await import('../lib/owner-statement-filename')
      const { parseBankStatement } = await import('../lib/bank-statement-parser')
      const account = parseStatementFilename(fileName)
      if (!account.ok) {
        console.log(`\n✗ ${fileName}\n  ${account.error?.problem} ${account.error?.suggestion}`)
        continue
      }
      const parsed = await parseBankStatement(
        buffer, fileName,
        fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/csv',
      )
      const inYear = parsed.transactions.filter(t => Number(t.transaction_date.slice(0, 4)) === year)
      const inflow = inYear.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0)
      const outflow = inYear.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0)
      console.log(`\n· ${fileName}  [DRY RUN — nothing written]`)
      console.log(`  account : ${account.value!.label} (${account.value!.accountType})`)
      console.log(`  parsed  : ${parsed.transactions.length}, in ${year}: ${inYear.length}`)
      console.log(`  in  +${inflow.toFixed(2)}   out ${outflow.toFixed(2)}   net ${(inflow + outflow).toFixed(2)}`)
      if (parsed.errors.length) console.log(`  warnings: ${parsed.errors.join(' | ')}`)
      continue
    }

    const r = await importOwnerStatement({ fileName, buffer, targetYear: year })
    if (r.status !== 'imported') {
      console.log(`\n✗ ${fileName}  [${r.status}]\n  ${r.error}`)
      continue
    }
    console.log(`\n✓ ${fileName}`)
    console.log(`  account : ${r.account} (${r.account_type})`)
    console.log(`  imported: ${r.imported} of ${r.parsed_count} parsed`)
    if (r.skipped_out_of_year) console.log(`  skipped : ${r.skipped_out_of_year} outside ${year}`)
    if (r.skipped_same_source) console.log(`  skipped : ${r.skipped_same_source} already imported from this file`)
    if (r.skipped_already_booked) console.log(`  skipped : ${r.skipped_already_booked} already in the books from another source`)
    if (r.duplicate_samples?.length) console.log(`  samples : ${r.duplicate_samples.slice(0, 3).join(' | ')}`)
    if (r.warnings?.length) console.log(`  warnings: ${r.warnings.join(' | ')}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
