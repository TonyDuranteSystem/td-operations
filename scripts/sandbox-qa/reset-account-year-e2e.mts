// Sandbox E2E for lib/tax/reset-account-year.ts (card 4a39e0fd, second bug-hunter
// pass requested by Antonio) — REAL writes against sandbox, not mocks, because the
// first bug-hunter pass explicitly flagged that a mock DB can hide the exact class
// of bug (pagination, filter precision) this tool most needs to get right.
//
// Usage: npx tsx scripts/sandbox-qa/reset-account-year-e2e.mts

import { config as loadEnv } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../../.env.local') })
import { createClient } from '@supabase/supabase-js'
import { resetAccountYearBankStatements } from '../../lib/tax/reset-account-year'

const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const sbServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!sbUrl || !sbServiceKey) throw new Error('Supabase URL or service key not set')
if (sbUrl.includes('ydzipybqeebtpcvsbtvs')) {
  throw new Error('REFUSING to run against production. .env.local must point at sandbox.')
}

const db = createClient(sbUrl, sbServiceKey)

const TAX_YEAR = 2025
const OTHER_YEAR = 2024 // used to prove the reset never touches a different year
let pass = 0
let fail = 0
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`) }
}

async function main() {
  console.log(`\n🧪 reset-account-year E2E — sandbox: ${sbUrl}\n`)

  // ---- Fixture: a clearly-fake, dedicated test account (never a real client name) ----
  const { data: account, error: acctErr } = await db
    .from('accounts')
    .insert({ company_name: 'QA E2E Reset Test LLC', entity_type: 'Multi Member LLC' })
    .select('id')
    .single()
  if (acctErr || !account) throw new Error(`fixture account insert failed: ${acctErr?.message}`)
  const accountId = account.id as string
  console.log(`Fixture account: ${accountId}`)

  try {
    // Submission row: realistic multi-bank shape + the LEGACY singular field +
    // populated coverage_answers, so the reset has real work to do on every axis.
    const submittedData = {
      company_name: 'QA E2E Reset Test LLC',
      member_0_member_first_name: 'Test',
      mmllc_foreign_partners: 'No',
      bank_accounts_count: '2',
      bank_accounts_0_bank_name: 'Chase',
      bank_accounts_0_statements: ['chase_jan.csv', 'chase_feb.csv'],
      bank_accounts_1_bank_name: 'Relay',
      bank_accounts_1_statements: ['relay_jan.csv'],
      bank_statements: ['legacy_upload.pdf'], // pre-repeater shape, still present on old drafts
    }
    const financialsMeta = {
      ready_notified: true,
      coverage_answers: { 'Relay|leading|2025-06': { answer: 'no_activity', at: '2026-01-01' } },
    }
    const { data: submission, error: subErr } = await db
      .from('tax_return_submissions')
      .insert({
        account_id: accountId,
        tax_year: TAX_YEAR,
        entity_type: 'Multi Member LLC',
        status: 'completed',
        submitted_data: submittedData,
        financials_meta: { ...financialsMeta, failed_files_override: { reason: 'QA fixture override', by: 'qa-script' } },
        confirmation_accepted: true, // client already "confirmed" the wrong numbers — round-2 finding
        token: `qa-e2e-reset-${Date.now()}`,
      })
      .select('id')
      .single()
    if (subErr || !submission) throw new Error(`fixture submission insert failed: ${subErr?.message}`)
    console.log(`Fixture submission: ${submission.id}`)

    // 1,500 bank_transactions rows — deliberately past the 1000-row PostgREST
    // cap, the exact shape of the bug the first bug-hunter pass found.
    const runId = Date.now()
    const rows = Array.from({ length: 1500 }, (_, i) => ({
      account_id: accountId,
      tax_year: TAX_YEAR,
      transaction_date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
      amount: i % 2 === 0 ? 10 : -10,
      description: `QA fixture row ${i}`,
      bank_name: i % 2 === 0 ? 'Chase' : 'Relay',
      account_type: 'USD',
      transaction_ref: `qa-e2e-reset-${runId}-${i}`,
    }))
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from('bank_transactions').insert(rows.slice(i, i + 500))
      if (error) throw new Error(`fixture transaction insert failed at batch ${i}: ${error.message}`)
    }
    console.log(`Fixture transactions: 1500 rows (2025), spanning the 1000-row page boundary`)

    // A transaction on a DIFFERENT tax year, same account — must survive untouched.
    await db.from('bank_transactions').insert({
      account_id: accountId, tax_year: OTHER_YEAR, transaction_date: '2024-06-01',
      amount: 5, description: 'other-year row', bank_name: 'Chase', account_type: 'USD',
      transaction_ref: `qa-e2e-reset-${runId}-other-year`,
    })

    // job_queue: pending/completed/failed (should all be cancelled), one
    // already cancelled (must stay untouched, not double-processed), one on
    // the OTHER tax year for the SAME account (must survive — proves the
    // payload tax_year filter is precise, not just account-scoped), and —
    // round-2 finding — a DIFFERENT job_type (tax_form_setup, the exact type
    // whose stuck/retried re-enqueue undoes the reset) to prove cancellation
    // is no longer scoped to ingest_bank_statement alone. NOTE: 'processing'
    // is deliberately NOT included here — round 3 changed its meaning from
    // "gets cancelled" to "blocks apply entirely"; that behavior is tested
    // separately, below, as its own scenario with its own fixture job.
    const jobBase = { job_type: 'ingest_bank_statement', account_id: accountId }
    const { error: jobErr } = await db.from('job_queue').insert([
      { ...jobBase, status: 'completed', payload: { tax_year: TAX_YEAR, path: 'a.csv' } },
      { ...jobBase, status: 'pending', payload: { tax_year: TAX_YEAR, path: 'b.csv' } },
      { ...jobBase, status: 'failed', payload: { tax_year: TAX_YEAR, path: 'd.csv' }, error: 'boom' },
      { ...jobBase, status: 'cancelled', payload: { tax_year: TAX_YEAR, path: 'already-cancelled.csv' }, error: 'pre-existing' },
      { ...jobBase, status: 'completed', payload: { tax_year: OTHER_YEAR, path: 'other-year.csv' } },
      { job_type: 'tax_form_setup', account_id: accountId, status: 'pending', payload: { tax_year: TAX_YEAR, source: 'portal_wizard', upload_paths: ['stale/a.csv'] } },
    ])
    if (jobErr) throw new Error(`fixture job insert failed: ${jobErr.message}`)
    console.log(`Fixture jobs: 6 rows (4 to cancel across 2 job_types, 1 already-cancelled, 1 on a different year)\n`)

    // ================= DRY RUN =================
    console.log('--- DRY RUN ---')
    const dryPlan = await resetAccountYearBankStatements(db, accountId, TAX_YEAR)
    check('dry run: applied is false', dryPlan.applied === false)
    check('dry run: archived ALL 1500 rows, not capped at 1000', dryPlan.archivedCount === 1500, `got ${dryPlan.archivedCount}`)
    check('dry run: sees both statement-key shapes', new Set(dryPlan.clearedStatementKeys).size === 3 &&
      dryPlan.clearedStatementKeys.includes('bank_accounts_0_statements') &&
      dryPlan.clearedStatementKeys.includes('bank_accounts_1_statements') &&
      dryPlan.clearedStatementKeys.includes('bank_statements'))
    check('dry run: sees the populated coverage_answers', dryPlan.hadCoverageAnswers === true)
    check('dry run: reports 0 cancelled jobs (nothing cancelled yet)', dryPlan.cancelledJobCount === 0)

    const { count: txCountAfterDry } = await db.from('bank_transactions')
      .select('id', { count: 'exact', head: true }).eq('account_id', accountId).eq('tax_year', TAX_YEAR)
    check('dry run: NOTHING deleted from the database yet', txCountAfterDry === 1500, `got ${txCountAfterDry}`)

    const { data: subAfterDry } = await db.from('tax_return_submissions').select('submitted_data').eq('id', submission.id).single()
    const sdAfterDry = (subAfterDry as { submitted_data: Record<string, unknown> })?.submitted_data
    // Deep-equal by KEY/VALUE, not a string comparison — JSONB round-tripping through
    // Postgres does not preserve object key insertion order, so JSON.stringify() can
    // legitimately differ between two byte-identical-in-content objects.
    const sameContent = sdAfterDry && Object.keys(submittedData).every(
      k => JSON.stringify((sdAfterDry as Record<string, unknown>)[k]) === JSON.stringify((submittedData as Record<string, unknown>)[k]),
    ) && Object.keys(sdAfterDry).length === Object.keys(submittedData).length
    check('dry run: submission NOT mutated yet (still has the ORIGINAL un-cleared statement arrays)',
      Boolean(sameContent) && Array.isArray(sdAfterDry.bank_accounts_0_statements) && (sdAfterDry.bank_accounts_0_statements as unknown[]).length === 2,
      `got: ${JSON.stringify(sdAfterDry)}`)

    // ================= ROUND 3: IN-FLIGHT JOB REFUSAL =================
    // A genuinely 'processing' job cannot be stopped by cancelling its row —
    // apply must refuse outright rather than proceed and risk the reset
    // being silently undone once that job finishes.
    console.log('\n--- IN-FLIGHT JOB REFUSAL (round 3) ---')
    const { data: inFlightJob } = await db.from('job_queue').insert({
      job_type: 'tax_form_setup', account_id: accountId, status: 'processing',
      payload: { tax_year: TAX_YEAR, source: 'portal_wizard', upload_paths: ['stale/in-flight.csv'] },
    }).select('id').single()
    const dryPlanWithInFlight = await resetAccountYearBankStatements(db, accountId, TAX_YEAR)
    check('dry run WITH an in-flight job: hasProcessingJob is true', dryPlanWithInFlight.hasProcessingJob === true)
    let refused = false
    try {
      await resetAccountYearBankStatements(db, accountId, TAX_YEAR, { dryRun: false })
    } catch (e) {
      refused = /processing/i.test((e as Error).message)
    }
    check('apply REFUSES while a job is processing (real throw, real DB)', refused)
    const { count: txCountStillThere } = await db.from('bank_transactions')
      .select('id', { count: 'exact', head: true }).eq('account_id', accountId).eq('tax_year', TAX_YEAR)
    check('apply refusal means NOTHING was deleted — all 1500 rows still present', txCountStillThere === 1500, `got ${txCountStillThere}`)
    await db.from('job_queue').delete().eq('id', (inFlightJob as { id: string }).id) // clear the in-flight job, proceed normally below

    // ================= APPLY =================
    console.log('\n--- APPLY (dryRun:false) ---')
    const applyPlan = await resetAccountYearBankStatements(db, accountId, TAX_YEAR, { dryRun: false })
    check('apply: hasProcessingJob is false now that the in-flight job is gone', applyPlan.hasProcessingJob === false)
    check('apply: applied is true', applyPlan.applied === true)
    check('apply: cancelled exactly the 4 blocking-status jobs for THIS year, across BOTH job_types', applyPlan.cancelledJobCount === 4, `got ${applyPlan.cancelledJobCount}`)

    const { count: txCountAfterApply } = await db.from('bank_transactions')
      .select('id', { count: 'exact', head: true }).eq('account_id', accountId).eq('tax_year', TAX_YEAR)
    check('apply: all 1500 rows for THIS year actually gone', txCountAfterApply === 0, `got ${txCountAfterApply}`)

    const { count: otherYearCount } = await db.from('bank_transactions')
      .select('id', { count: 'exact', head: true }).eq('account_id', accountId).eq('tax_year', OTHER_YEAR)
    check('apply: the OTHER tax year row survives untouched', otherYearCount === 1, `got ${otherYearCount}`)

    const { data: subAfterApply } = await db.from('tax_return_submissions')
      .select('submitted_data, financials_meta, confirmation_accepted, review_history').eq('id', submission.id).single()
    const sd = (subAfterApply as { submitted_data: Record<string, unknown> }).submitted_data
    const fm = (subAfterApply as { financials_meta: Record<string, unknown> }).financials_meta
    const confirmationAfter = (subAfterApply as { confirmation_accepted: boolean }).confirmation_accepted
    const historyAfter = (subAfterApply as { review_history: unknown[] }).review_history ?? []
    check('apply: bank_accounts_0_statements cleared', Array.isArray(sd.bank_accounts_0_statements) && (sd.bank_accounts_0_statements as unknown[]).length === 0)
    check('apply: bank_accounts_1_statements cleared', Array.isArray(sd.bank_accounts_1_statements) && (sd.bank_accounts_1_statements as unknown[]).length === 0)
    check('apply: legacy bank_statements cleared', Array.isArray(sd.bank_statements) && (sd.bank_statements as unknown[]).length === 0)
    check('apply: company_name untouched', sd.company_name === 'QA E2E Reset Test LLC')
    check('apply: member name untouched', sd.member_0_member_first_name === 'Test')
    check('apply: mmllc_foreign_partners (compliance answer) untouched', sd.mmllc_foreign_partners === 'No')
    check('apply: which-banks declarations untouched', sd.bank_accounts_0_bank_name === 'Chase' && sd.bank_accounts_1_bank_name === 'Relay' && sd.bank_accounts_count === '2')
    check('apply: coverage_answers cleared to {}', JSON.stringify(fm.coverage_answers) === '{}')
    check('apply: ready_notified cleared to false (round-2 finding — was silently left true before)', fm.ready_notified === false, `got ${fm.ready_notified}`)
    check('apply: client attestation invalidated — confirmation_accepted now false (round-2 blocker)', confirmationAfter === false, `got ${confirmationAfter}`)
    check('apply: staff failed_files_override cleared (round-2 blocker)', !('failed_files_override' in fm), `fm still has: ${JSON.stringify(fm)}`)
    check('apply: the attestation reset left an audit trail in review_history', historyAfter.length >= 2,
      `got ${JSON.stringify(historyAfter)}`)

    const { data: jobsAfter } = await db.from('job_queue').select('job_type, status, payload').eq('account_id', accountId)
    const byYear = (jobsAfter ?? []) as Array<{ job_type: string; status: string; payload: { tax_year: number; path?: string } }>
    const thisYearJobs = byYear.filter(j => j.payload.tax_year === TAX_YEAR)
    const otherYearJobs = byYear.filter(j => j.payload.tax_year === OTHER_YEAR)
    check('apply: the 4 blocking-status jobs for THIS year are now cancelled', thisYearJobs.filter(j => j.status === 'cancelled').length === 5, // 4 newly + 1 pre-existing
      `statuses: ${JSON.stringify(thisYearJobs.map(j => ({ type: j.job_type, status: j.status })))}`)
    check('apply: the tax_form_setup job (a DIFFERENT job_type) was also cancelled',
      thisYearJobs.find(j => j.job_type === 'tax_form_setup')?.status === 'cancelled',
      `got ${JSON.stringify(thisYearJobs.find(j => j.job_type === 'tax_form_setup'))}`)
    check('apply: the already-cancelled job kept its original error text (not double-processed)',
      (jobsAfter ?? []).some((j) => (j as { payload: { path?: string } }).payload.path === 'already-cancelled.csv'))
    check('apply: the OTHER-year job on the SAME account was NOT touched', otherYearJobs.length === 1 && otherYearJobs[0].status === 'completed',
      `got ${JSON.stringify(otherYearJobs)}`)

    // ================= EDGE CASE: nothing to reset =================
    console.log('\n--- EDGE CASE: account+year with no submission and no transactions ---')
    const emptyPlan = await resetAccountYearBankStatements(db, accountId, 2099, { dryRun: false })
    check('empty case: applies cleanly as a no-op', emptyPlan.applied === true && emptyPlan.archivedCount === 0 && emptyPlan.cancelledJobCount === 0)

    // ================= EDGE CASE: idempotent double-apply =================
    console.log('\n--- EDGE CASE: applying again on an already-reset account+year ---')
    const secondPlan = await resetAccountYearBankStatements(db, accountId, TAX_YEAR, { dryRun: false })
    check('double-apply: safe no-op, no error, archives 0', secondPlan.applied === true && secondPlan.archivedCount === 0)
  } finally {
    // ---- Cleanup: leave sandbox exactly as it was found ----
    await db.from('job_queue').delete().eq('account_id', accountId)
    await db.from('bank_transactions').delete().eq('account_id', accountId)
    await db.from('tax_return_submissions').delete().eq('account_id', accountId)
    await db.from('accounts').delete().eq('id', accountId)
    console.log(`\nFixture account ${accountId} and all related rows deleted.`)
  }

  console.log(`\n${'='.repeat(50)}\n${pass} passed, ${fail} failed\n${'='.repeat(50)}\n`)
  if (fail > 0) process.exit(1)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
