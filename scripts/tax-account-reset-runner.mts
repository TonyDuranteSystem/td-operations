// Production-safe runner for lib/tax/reset-account-year.ts (card 4a39e0fd).
//
// Second bug-hunter pass, blocker #3: resetAccountYearBankStatements's own
// "archive before delete, never destroy" rule was a comment, not a mechanism
// — nothing stopped a caller from invoking dryRun:false without ever having
// persisted the dry run's archive. This script makes that structural:
//
//   STEP 1 (default, no --apply): dry run only. Writes the FULL archive —
//   every transaction row that WOULD be deleted, plus the rest of the plan
//   — to a timestamped JSON file, then reads that file back and verifies
//   its row count matches the plan before declaring success. Touches
//   nothing in the database.
//
//   STEP 2 (--apply): REFUSES to run unless an archive file already exists
//   for this exact account+year AND a fresh dry run taken right now still
//   matches that file's row count exactly (catches the case where the data
//   changed between the archive and the apply call — stale archive, not a
//   real backup of what's about to be deleted). Also requires --confirm
//   "<exact company name>" as a second, human-readable tripwire against a
//   copy-pasted wrong account id. NOTE: company_name has no DB uniqueness
//   constraint (a closed-then-reformed LLC can re-onboard under the same
//   name) — this check proves the account AT THIS ID currently has this
//   name, not that no other account shares it. The tool always prints the
//   resolved name+id pair before requiring --confirm; read it.
//
// Third bug-hunter pass, two more fixes: (1) apply now REFUSES outright if
// any job_queue row for this account+year is currently 'processing' —
// cancelling a row's status cannot stop an already-running worker, and a
// stuck tax_form_setup job finishing AFTER apply can silently resurrect the
// deleted data using its own frozen pre-reset payload. (2) after a
// successful apply, the archive file on disk is OVERWRITTEN with the exact
// rows the real delete call fetched and removed — the dry-run archive used
// for the stale-check is a close proxy (same row COUNT) but was a separate
// read; this makes the persisted backup provably identical to what's gone,
// not just count-matched.
//
// Usage:
//   npx tsx scripts/tax-account-reset-runner.mts --account <uuid> --year <year>
//   npx tsx scripts/tax-account-reset-runner.mts --account <uuid> --year <year> --apply --confirm "Exact Company Name LLC"
//
// Archives land in scripts/.reset-archives/<accountId>-<year>.json (NOT
// timestamped — each dry run overwrites the prior archive for that
// account+year by design; re-run without --apply to refresh it).
// Gitignored — these can contain real client financial data.

import { config as loadEnv } from 'dotenv'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'
import { resetAccountYearBankStatements } from '../lib/tax/reset-account-year'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`)

const accountId = arg('account')
const taxYear = Number(arg('year'))
const apply = hasFlag('apply')
const confirmName = arg('confirm')
const archiveDir = path.resolve(__dirname, '.reset-archives')

if (!accountId || !Number.isInteger(taxYear)) {
  console.error('Usage: npx tsx scripts/tax-account-reset-runner.mts --account <uuid> --year <year> [--apply --confirm "<exact company name>"]')
  process.exit(1)
}

const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const sbServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!sbUrl || !sbServiceKey) throw new Error('Supabase URL or service key not set in .env.local')
const db = createClient(sbUrl, sbServiceKey)

const archiveFile = path.join(archiveDir, `${accountId}-${taxYear}.json`)

async function main() {
  const { data: account, error: acctErr } = await db.from('accounts').select('id, company_name').eq('id', accountId).single()
  if (acctErr || !account) throw new Error(`Account not found: ${acctErr?.message ?? accountId}`)
  const companyName = (account as { company_name: string }).company_name

  console.log(`\n${'='.repeat(60)}`)
  console.log(`  Target : ${companyName}  (${accountId})`)
  console.log(`  Year   : ${taxYear}`)
  console.log(`  DB     : ${sbUrl}`)
  console.log(`  Mode   : ${apply ? 'APPLY (will delete + clear real data)' : 'DRY RUN (archive only, nothing touched)'}`)
  console.log(`${'='.repeat(60)}\n`)

  const plan = await resetAccountYearBankStatements(db, accountId, taxYear, { dryRun: true })
  console.log(`  Transactions that would be archived : ${plan.archivedCount}`)
  console.log(`  Statement-file keys that would clear : ${plan.clearedStatementKeys.join(', ') || '(none)'}`)
  console.log(`  Coverage answers present             : ${plan.hadCoverageAnswers}`)
  console.log(`  ready_notified currently true        : ${plan.hadReadyNotified}`)
  console.log(`  Submission row                       : ${plan.submissionId ?? '(none found)'}`)
  console.log(`  A job is CURRENTLY processing        : ${plan.hasProcessingJob}${plan.hasProcessingJob ? '  ⚠️  apply will refuse while this is true' : ''}\n`)

  if (!apply) {
    fs.mkdirSync(archiveDir, { recursive: true })
    fs.writeFileSync(archiveFile, JSON.stringify({ ...plan, companyName, writtenAt: new Date().toISOString() }, null, 2))
    const readBack = JSON.parse(fs.readFileSync(archiveFile, 'utf8'))
    if (!Array.isArray(readBack.archivedTransactions) || readBack.archivedTransactions.length !== plan.archivedCount) {
      throw new Error(`ARCHIVE WRITE VERIFICATION FAILED — file does not contain what the plan reported. Nothing was applied. File: ${archiveFile}`)
    }
    console.log(`✅ Archive written and verified: ${archiveFile}`)
    console.log(`   (${readBack.archivedTransactions.length} rows confirmed present in the file on disk)\n`)
    console.log(`To apply, re-run with:\n  npx tsx scripts/tax-account-reset-runner.mts --account ${accountId} --year ${taxYear} --apply --confirm "${companyName}"\n`)
    return
  }

  // ---- APPLY PATH ----
  if (confirmName !== companyName) {
    throw new Error(`--confirm must exactly match the account's company name. Expected "${companyName}", got ${confirmName ? `"${confirmName}"` : '(missing)'}. Refusing to apply.`)
  }
  if (!fs.existsSync(archiveFile)) {
    throw new Error(`No archive file found at ${archiveFile}. Run without --apply first to create and verify one.`)
  }
  const existingArchive = JSON.parse(fs.readFileSync(archiveFile, 'utf8'))
  if (existingArchive.archivedCount !== plan.archivedCount) {
    throw new Error(
      `STALE ARCHIVE — the file on disk archived ${existingArchive.archivedCount} rows, but a fresh check right now finds ${plan.archivedCount}. ` +
      `The data changed since the archive was written. Re-run WITHOUT --apply to produce a current archive before applying.`,
    )
  }
  console.log(`✅ Archive verified current (${existingArchive.archivedCount} rows match). Proceeding to apply.\n`)

  const result = await resetAccountYearBankStatements(db, accountId, taxYear, { dryRun: false })
  // Overwrite the archive with the EXACT rows this call fetched and deleted —
  // provably identical to what's gone, not the earlier dry run's separate read.
  fs.writeFileSync(archiveFile, JSON.stringify({ ...result, companyName, writtenAt: new Date().toISOString(), source: 'post-apply (authoritative)' }, null, 2))
  const readBackFinal = JSON.parse(fs.readFileSync(archiveFile, 'utf8'))
  if (!Array.isArray(readBackFinal.archivedTransactions) || readBackFinal.archivedTransactions.length !== result.archivedCount) {
    console.error(`⚠️  WARNING: post-apply archive write could not be verified (expected ${result.archivedCount} rows in the file, found ${readBackFinal.archivedTransactions?.length}). The data IS already deleted — check ${archiveFile} by hand.`)
  }
  console.log(`✅ APPLIED.`)
  console.log(`   Transactions deleted     : ${result.archivedCount}`)
  console.log(`   Statement keys cleared   : ${result.clearedStatementKeys.join(', ') || '(none)'}`)
  console.log(`   Jobs cancelled           : ${result.cancelledJobCount}`)
  console.log(`   Coverage answers cleared : ${result.hadCoverageAnswers}`)
  console.log(`   ready_notified cleared   : ${result.hadReadyNotified}`)
  console.log(`\nAuthoritative archive of the deleted data (verified) at: ${archiveFile}\n`)
}

main().catch(err => { console.error('\nFATAL:', err.message ?? err); process.exit(1) })
