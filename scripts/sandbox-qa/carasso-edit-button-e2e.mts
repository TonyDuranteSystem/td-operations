/**
 * E2E QA for the Carasso edit-button fix — drives the REAL server functions
 * against seeded sandbox fixtures, all scenarios. Sandbox-only.
 *
 *   npx tsx scripts/sandbox-qa/carasso-edit-button-e2e.mts
 *
 * Verifies:
 *  - syncTaxRevisionRequest across every review_status + guard case
 *  - resolveTaxWizardEligibility opens the wizard (mode 'review') after the write
 *  - the review-mode resubmit UNIONs upload_paths (documents never lost)
 *  - the edit-mode pre-fill query the wizard page runs returns his answers
 */
import dotenv from 'dotenv'
dotenv.config({ path: process.env.SBX_ENV || '/private/tmp/claude-501/-Users-10225office-Developer-td-operations--claude-worktrees-tax-return-edit-restriction-1afc2c/d5d22ef9-c83f-471d-8b18-ac21b686b8ab/scratchpad/.env.sbx' })

const REF = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
if (!REF.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('ABORT: not the sandbox ref. Got:', REF)
  process.exit(1)
}

import { createClient } from '@supabase/supabase-js'
const sb = createClient(REF, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const TAG = 'QA-CARASSO-E2E'
let pass = 0, fail = 0
const results: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; results.push(`  ✅ ${name}`) }
  else { fail++; results.push(`  ❌ ${name} — ${detail}`) }
}

// ── cleanup any prior run ──
async function cleanup() {
  const { data: accts } = await sb.from('accounts').select('id').ilike('company_name', `${TAG}%`)
  const ids = (accts ?? []).map(a => a.id)
  if (ids.length) {
    await sb.from('tax_return_submissions').delete().in('account_id', ids)
    await sb.from('tax_returns').delete().in('account_id', ids)
    await sb.from('service_deliveries').delete().in('account_id', ids)
    await sb.from('wizard_progress').delete().in('account_id', ids)
    await sb.from('portal_messages').delete().in('account_id', ids)
    await sb.from('account_contacts').delete().in('account_id', ids)
    await sb.from('accounts').delete().in('id', ids)
  }
  await sb.from('contacts').delete().ilike('full_name', `${TAG}%`)
}

interface FixtureOpts {
  reviewStatus: string | null
  withSubmission?: boolean   // default true
  serviceType?: string       // default 'Tax Return'
  withAccount?: boolean      // default true (false → contact-scoped SD)
  uploadPaths?: string[]
  dataReceived?: boolean     // tax_returns.data_received (default true)
}

async function makeFixture(label: string, o: FixtureOpts) {
  const withSubmission = o.withSubmission !== false
  const withAccount = o.withAccount !== false
  const serviceType = o.serviceType ?? 'Tax Return'

  const { data: contact } = await sb.from('contacts').insert({
    full_name: `${TAG} ${label}`, first_name: 'QA', last_name: label,
    email: `qa-carasso-${label.toLowerCase()}@example.com`, language: 'Italian', is_test: true,
  }).select('id').single()
  const contactId = contact!.id

  let accountId: string | null = null
  if (withAccount) {
    const { data: acct } = await sb.from('accounts').insert({
      company_name: `${TAG} ${label} LLC`, entity_type: 'Single Member LLC',
      member_structure: 'single_member', formation_date: '2024-04-22',
      state_of_formation: 'Wyoming', portal_tier: 'active', status: 'Active',
    }).select('id').single()
    accountId = acct!.id
    await sb.from('account_contacts').insert({ account_id: accountId, contact_id: contactId, ownership_pct: 100 })
  }

  const { error: sdErr } = await sb.from('service_deliveries').insert({
    account_id: accountId, contact_id: contactId, service_type: serviceType,
    service_name: serviceType, stage: 'Revision Requested', status: 'active',
  })
  if (sdErr) throw new Error(`SD insert failed for ${label}: ${sdErr.message}`)

  if (withAccount) {
    await sb.from('tax_returns').insert({
      account_id: accountId, company_name: `${TAG} ${label} LLC`, client_name: `QA ${label}`,
      return_type: 'SMLLC', tax_year: 2025, deadline: '2026-04-15',
      status: 'Extension Filed', data_received: o.dataReceived ?? true,
    })
  }

  let submissionId: string | null = null
  if (withSubmission && accountId) {
    const { data: sub } = await sb.from('tax_return_submissions').insert({
      account_id: accountId, contact_id: contactId, tax_year: 2025, entity_type: 'SMLLC',
      token: `qa-carasso-${label.toLowerCase()}-2025`, status: 'reviewed',
      review_status: o.reviewStatus, review_history: [],
      submitted_data: { llc_name: `${TAG} ${label} LLC`, bank_contributions: 150000, personal_expenses: 40000 },
      upload_paths: o.uploadPaths ?? [],
    }).select('id').single()
    submissionId = sub!.id
  }

  return { contactId, accountId, submissionId, serviceType }
}

async function sdIdFor(accountId: string | null, contactId: string) {
  const q = accountId
    ? sb.from('service_deliveries').select('id').eq('account_id', accountId)
    : sb.from('service_deliveries').select('id').eq('contact_id', contactId).is('account_id', null)
  const { data } = await q.limit(1).maybeSingle()
  return data?.id as string
}

async function reviewStatusOf(submissionId: string) {
  const { data } = await sb.from('tax_return_submissions').select('review_status, review_history').eq('id', submissionId).single()
  return data
}

async function main() {
  await cleanup()
  const { syncTaxRevisionRequest } = await import('@/lib/tax/sync-flow-revision')
  const { resolveTaxWizardEligibility } = await import('@/lib/tax/wizard-eligibility')

  // ── Scenario 1: LEGACY null (Matteo's exact shape) ──
  {
    const f = await makeFixture('Legacy', { reviewStatus: null, uploadPaths: ['carasso-consulting-llc-2025/ein_letter.pdf'] })
    const sdId = await sdIdFor(f.accountId, f.contactId)
    const r = await syncTaxRevisionRequest({ serviceDeliveryId: sdId, by: 'flow-action' })
    check('S1 legacy-null: write succeeded', r.status === 'written', JSON.stringify(r))
    check('S1 legacy-null: from=null recorded', r.from === null, String(r.from))
    const after = await reviewStatusOf(f.submissionId!)
    check('S1 legacy-null: review_status now revision_requested', after?.review_status === 'revision_requested', String(after?.review_status))
    const hist = (after?.review_history as any[]) ?? []
    check('S1 legacy-null: history round appended (from null → revision_requested)', hist.length === 1 && hist[0].from === null && hist[0].to === 'revision_requested', JSON.stringify(hist))
    // gate opens?
    const elig = await resolveTaxWizardEligibility({ accountId: f.accountId })
    check('S1 legacy-null: wizard gate now mode=review (client can edit)', elig.mode === 'review', JSON.stringify(elig))
    // idempotency: second press
    const r2 = await syncTaxRevisionRequest({ serviceDeliveryId: sdId, by: 'flow-action' })
    check('S1 idempotent: second press is a no-op', r2.status === 'already_revision_requested', JSON.stringify(r2))
    // client notified (chat message written even though email is blocked in sandbox)
    const { data: msgs } = await sb.from('portal_messages').select('id').eq('account_id', f.accountId!)
    check('S1 legacy-null: client notification written to portal chat', (msgs?.length ?? 0) >= 1, `msgs=${msgs?.length}`)
  }

  // ── Scenario 2: submitted (normal portal-wizard client) ──
  {
    const f = await makeFixture('Submitted', { reviewStatus: 'submitted' })
    const sdId = await sdIdFor(f.accountId, f.contactId)
    const r = await syncTaxRevisionRequest({ serviceDeliveryId: sdId, by: 'flow-action' })
    check('S2 submitted: write succeeded from=submitted', r.status === 'written' && r.from === 'submitted', JSON.stringify(r))
    const after = await reviewStatusOf(f.submissionId!)
    check('S2 submitted: review_status now revision_requested', after?.review_status === 'revision_requested', String(after?.review_status))
  }

  // ── Scenario 3: under_review ──
  {
    const f = await makeFixture('UnderReview', { reviewStatus: 'under_review' })
    const sdId = await sdIdFor(f.accountId, f.contactId)
    const r = await syncTaxRevisionRequest({ serviceDeliveryId: sdId, by: 'flow-action' })
    check('S3 under_review: write succeeded', r.status === 'written' && r.from === 'under_review', JSON.stringify(r))
  }

  // ── Scenario 4: confirmed (finalized) → locked ──
  {
    const f = await makeFixture('Confirmed', { reviewStatus: 'confirmed' })
    const sdId = await sdIdFor(f.accountId, f.contactId)
    const r = await syncTaxRevisionRequest({ serviceDeliveryId: sdId, by: 'flow-action' })
    check('S4 confirmed: refused (confirmed_locked)', r.status === 'confirmed_locked', JSON.stringify(r))
    const after = await reviewStatusOf(f.submissionId!)
    check('S4 confirmed: review_status UNCHANGED', after?.review_status === 'confirmed', String(after?.review_status))
  }

  // ── Scenario 5: SD but no submission row ──
  {
    const f = await makeFixture('NoSub', { reviewStatus: null, withSubmission: false })
    const sdId = await sdIdFor(f.accountId, f.contactId)
    const r = await syncTaxRevisionRequest({ serviceDeliveryId: sdId, by: 'flow-action' })
    check('S5 no-submission: refused (no_submission)', r.status === 'no_submission', JSON.stringify(r))
  }

  // ── Scenario 6: non-tax flow ──
  {
    const f = await makeFixture('NonTax', { reviewStatus: null, serviceType: 'CMRA Mailing Address' })
    const sdId = await sdIdFor(f.accountId, f.contactId)
    const r = await syncTaxRevisionRequest({ serviceDeliveryId: sdId, by: 'flow-action' })
    check('S6 non-tax flow: ignored (not_tax_flow)', r.status === 'not_tax_flow', JSON.stringify(r))
  }

  // ── Scenario 7: contact-scoped SD, no account ──
  {
    const f = await makeFixture('NoAcct', { reviewStatus: null, withAccount: false })
    const sdId = await sdIdFor(null, f.contactId)
    const r = await syncTaxRevisionRequest({ serviceDeliveryId: sdId, by: 'flow-action' })
    check('S7 contact-scoped SD: refused (no_account)', r.status === 'no_account', JSON.stringify(r))
  }

  // ── Scenario 8: DOCUMENT PRESERVATION on resubmit ──
  // Replays the EXACT review-mode merge the wizard-submit route now performs:
  // carry forward only prior NON-wizard (external) paths + the newly collected
  // wizard set. Uses the real isWizardUploadPath discriminator.
  const { isWizardUploadPath } = await import('@/lib/portal/wizard-uploads')
  const mergeReview = (prior: string[], nowCollected: string[]) =>
    Array.from(new Set([...prior.filter(p => !isWizardUploadPath(p)), ...nowCollected]))

  {
    const f = await makeFixture('DocKeep', { reviewStatus: 'revision_requested', uploadPaths: ['carasso-consulting-llc-2025/ein_letter.pdf'] })
    const { data: cur } = await sb.from('tax_return_submissions').select('upload_paths').eq('id', f.submissionId!).single()
    const merged = mergeReview((cur!.upload_paths as string[]) ?? [], []) // SMLLC edit, no wizard file field
    await sb.from('tax_return_submissions').update({ upload_paths: merged, submitted_data: { llc_name: `${TAG} DocKeep LLC`, bank_contributions: 0 } }).eq('id', f.submissionId!)
    const { data: post } = await sb.from('tax_return_submissions').select('upload_paths, submitted_data').eq('id', f.submissionId!).single()
    const paths = (post!.upload_paths as string[]) ?? []
    check('S8 doc-preservation: external EIN letter SURVIVES resubmit', paths.includes('carasso-consulting-llc-2025/ein_letter.pdf'), JSON.stringify(paths))
    check('S8 doc-preservation: edited answer saved (contributions 150000→0)', (post!.submitted_data as any).bank_contributions === 0, JSON.stringify(post!.submitted_data))
  }

  // ── Scenario 8b: REPLACED wizard document is NOT resurrected (bug-hunter #1) ──
  {
    const f = await makeFixture('DocReplace', { reviewStatus: 'revision_requested', uploadPaths: ['ext/ein.pdf', 'tax/acct/bank_A.pdf'] })
    const { data: cur } = await sb.from('tax_return_submissions').select('upload_paths').eq('id', f.submissionId!).single()
    // client replaces bank_A with bank_B (new unique path); external ein untouched
    const merged = mergeReview((cur!.upload_paths as string[]) ?? [], ['tax/acct/bank_B.pdf'])
    await sb.from('tax_return_submissions').update({ upload_paths: merged }).eq('id', f.submissionId!)
    const { data: post } = await sb.from('tax_return_submissions').select('upload_paths').eq('id', f.submissionId!).single()
    const paths = (post!.upload_paths as string[]) ?? []
    check('S8b replace: NEW bank statement kept', paths.includes('tax/acct/bank_B.pdf'), JSON.stringify(paths))
    check('S8b replace: OLD (wrong) bank statement NOT resurrected', !paths.includes('tax/acct/bank_A.pdf'), JSON.stringify(paths))
    check('S8b replace: external EIN letter still preserved', paths.includes('ext/ein.pdf'), JSON.stringify(paths))
  }

  // ── Scenario 8c: REMOVED wizard document stays removed (bug-hunter #1) ──
  {
    const f = await makeFixture('DocRemove', { reviewStatus: 'revision_requested', uploadPaths: ['ext/ein.pdf', 'tax/acct/bank_A.pdf'] })
    const { data: cur } = await sb.from('tax_return_submissions').select('upload_paths').eq('id', f.submissionId!).single()
    const merged = mergeReview((cur!.upload_paths as string[]) ?? [], []) // client removed the wizard doc
    await sb.from('tax_return_submissions').update({ upload_paths: merged }).eq('id', f.submissionId!)
    const { data: post } = await sb.from('tax_return_submissions').select('upload_paths').eq('id', f.submissionId!).single()
    const paths = (post!.upload_paths as string[]) ?? []
    check('S8c remove: deliberately removed wizard doc stays gone', !paths.includes('tax/acct/bank_A.pdf'), JSON.stringify(paths))
    check('S8c remove: external EIN letter still preserved', paths.length === 1 && paths[0] === 'ext/ein.pdf', JSON.stringify(paths))
  }

  // ── Scenario 10: BOARD TRACKING after resubmit (bug-hunter #2) ──
  // Real overlay against the live sandbox catalog stage_orders.
  {
    const { overlayEffectiveStageName } = await import('@/lib/tax/tax-stage-overlay')
    const { data: stageRows } = await sb.from('pipeline_stages').select('stage_name, stage_order').eq('service_type', 'Tax Return')
    const stages = (stageRows ?? []) as { stage_name: string; stage_order: number }[]
    // After the fix the resubmit parks the SD at "Data Submitted"; the board must
    // then show the review sub-state, not stay stuck on "Revision Requested".
    const shownRevision = overlayEffectiveStageName(stages, 'Data Submitted', 'revision_requested')
    const shownResubmitted = overlayEffectiveStageName(stages, 'Data Submitted', 'resubmitted')
    check('S10 board: staff request-changes shows "Revision Requested"', shownRevision === 'Revision Requested', String(shownRevision))
    check('S10 board: after resubmit shows "Data Submitted" (NOT stuck)', shownResubmitted === 'Data Submitted', String(shownResubmitted))
  }

  // ── Scenario 11: MULTI-YEAR targeting now CONVERGES (bug-hunter #3 FIXED) ──
  // Two submissions + an OPEN older-year return: the button must write the SAME
  // row the gate opens (oldest-open year), not the newest.
  {
    const { data: contact } = await sb.from('contacts').insert({ full_name: `${TAG} MultiYear`, first_name: 'QA', last_name: 'MultiYear', email: 'qa-carasso-multiyear@example.com', language: 'Italian', is_test: true }).select('id').single()
    const { data: acct } = await sb.from('accounts').insert({ company_name: `${TAG} MultiYear LLC`, entity_type: 'Single Member LLC', member_structure: 'single_member', formation_date: '2023-01-01', state_of_formation: 'Wyoming', portal_tier: 'active', status: 'Active' }).select('id').single()
    await sb.from('account_contacts').insert({ account_id: acct!.id, contact_id: contact!.id, ownership_pct: 100 })
    await sb.from('service_deliveries').insert({ account_id: acct!.id, contact_id: contact!.id, service_type: 'Tax Return', service_name: 'Tax Return', stage: 'Revision Requested', status: 'active' })
    await sb.from('tax_returns').insert({ account_id: acct!.id, company_name: `${TAG} MultiYear LLC`, client_name: 'QA MultiYear', return_type: 'SMLLC', tax_year: 2024, deadline: '2025-04-15', status: 'Extension Filed', data_received: false }) // OPEN older year
    const { data: sub2024 } = await sb.from('tax_return_submissions').insert({ account_id: acct!.id, contact_id: contact!.id, tax_year: 2024, entity_type: 'SMLLC', token: 'qa-carasso-my-2024', status: 'reviewed', review_status: 'submitted', review_history: [], submitted_data: { llc_name: 'x' }, upload_paths: [], created_at: '2026-01-01T00:00:00Z' }).select('id').single()
    await sb.from('tax_return_submissions').insert({ account_id: acct!.id, contact_id: contact!.id, tax_year: 2025, entity_type: 'SMLLC', token: 'qa-carasso-my-2025', status: 'reviewed', review_status: 'submitted', review_history: [], submitted_data: { llc_name: 'x' }, upload_paths: [], created_at: '2026-07-01T00:00:00Z' }).select('id').single()
    const { data: sdRow } = await sb.from('service_deliveries').select('id').eq('account_id', acct!.id).limit(1).maybeSingle()
    const r = await syncTaxRevisionRequest({ serviceDeliveryId: sdRow!.id, by: 'flow-action' })
    const elig = await resolveTaxWizardEligibility({ accountId: acct!.id })
    check('S11 multi-year: button wrote the OLDEST-OPEN year (2024) submission', r.submissionId === sub2024!.id, JSON.stringify({ wrote: r.submissionId, sub2024: sub2024!.id }))
    check('S11 multi-year: gate opens the SAME row the button wrote (convergence)', elig.submissionId === sub2024!.id && elig.taxYear === 2024, JSON.stringify(elig))
  }

  // ── Scenario 12: notification uses a DISTINCT deep link (bug-hunter #6) ──
  {
    const f = await makeFixture('NotifyLink', { reviewStatus: null })
    const sdId = await sdIdFor(f.accountId, f.contactId)
    await syncTaxRevisionRequest({ serviceDeliveryId: sdId, by: 'flow-action' })
    const { data: notifs } = await sb.from('portal_notifications').select('link').eq('contact_id', f.contactId)
    const links = (notifs ?? []).map(n => n.link)
    check('S12 notify: bell link is the distinct editable-form deep link', links.includes('/portal/wizard?type=tax'), JSON.stringify(links))
  }

  // ── Scenario 9: EDIT-MODE PRE-FILL query (the page's own lookup) ──
  // The wizard page loads submitted_data when there's NO wizard_progress draft
  // and the review state is editable. Verify that exact query returns his data.
  {
    const f = await makeFixture('Prefill', { reviewStatus: 'revision_requested' })
    const { data: draft } = await sb.from('wizard_progress').select('id').eq('account_id', f.accountId!).eq('wizard_type', 'tax').in('status', ['in_progress', 'submitted']).limit(1).maybeSingle()
    check('S9 prefill: no wizard_progress draft exists (legacy shape)', !draft, JSON.stringify(draft))
    const { data: editSub } = await sb.from('tax_return_submissions').select('submitted_data, review_status').eq('account_id', f.accountId!).order('created_at', { ascending: false }).limit(1).maybeSingle()
    const editable = editSub?.review_status && ['submitted', 'revision_requested', 'approved', 'reopened'].includes(editSub.review_status)
    check('S9 prefill: page would load his answers (editable + submitted_data present)', !!(editable && editSub?.submitted_data && (editSub.submitted_data as any).llc_name), JSON.stringify(editSub?.review_status))
  }

  console.log('\n' + results.join('\n'))
  console.log(`\n${fail === 0 ? '🟢 ALL PASS' : '🔴 FAILURES'} — ${pass} passed, ${fail} failed`)
  await cleanup()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(1) })
