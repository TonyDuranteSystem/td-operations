/* eslint-disable no-console -- QA script: console output is the deliverable */
/**
 * Sandbox QA — PR 3 materialization helper.
 *
 * Exercises lib/operations/formation-materialize.ts end-to-end against a
 * fresh test contact in sandbox. Verifies:
 *   1. SMLLC happy path: helper creates account + Owner link + SD link + tier sync.
 *   2. Idempotency: re-running returns already_materialized.
 *   3. Legacy placeholder: with a "Pending Formation" account already linked,
 *      helper returns already_materialized (does NOT create a second account).
 *   4. Missing chosen_name: returns missing_chosen_name when wizard_progress
 *      lacks chosen_name_final.
 *   5. Invalid state: returns invalid_state when formation_submissions.state
 *      is outside NM/WY/FL/DE.
 *
 * Drive: each test creates a real Drive folder under Companies/New Mexico/.
 * Script logs the folder names so you can clean up Drive manually after.
 *
 * Sandbox-only: aborts if NEXT_PUBLIC_SUPABASE_URL is not the sandbox ref.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}

type CleanupRefs = {
  contact_ids: string[]
  account_ids: string[]
  submission_ids: string[]
  wizard_ids: string[]
  sd_ids: string[]
  drive_company_folder_names: string[]
}
const cleanupRefs: CleanupRefs = {
  contact_ids: [],
  account_ids: [],
  submission_ids: [],
  wizard_ids: [],
  sd_ids: [],
  drive_company_folder_names: [],
}

async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { materializeFormationCompany } = await import('../../lib/operations/formation-materialize')

  let pass = 0
  let fail = 0
  function check(label: string, ok: boolean, detail?: string) {
    if (ok) {
      console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
      pass++
    } else {
      console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
      fail++
    }
  }

  async function setupContact(opts: {
    suffix: string
    entityType: 'SMLLC' | 'MMLLC'
    state?: string
    chosenName?: string
    skipWizardProgress?: boolean
    extraSubmittedData?: Record<string, unknown>
  }) {
    const ts = Date.now()
    const testEmail = `qa-pr3-${opts.suffix}-${ts}@example.test`
    const testFirstName = 'QA'
    const testLastName = `PR3 ${opts.suffix} ${ts}`
    const testFullName = `${testFirstName} ${testLastName}`
    const llcName = opts.chosenName ?? `QA Test PR3 ${opts.suffix} ${ts} LLC`

    const { data: contact, error: cErr } = await supabaseAdmin
      .from('contacts')
      .insert({
        email: testEmail,
        full_name: testFullName,
        first_name: testFirstName,
        last_name: testLastName,
        portal_tier: 'formation',
      })
      .select('id')
      .single()
    if (cErr || !contact) throw new Error(`contact insert failed: ${cErr?.message}`)
    cleanupRefs.contact_ids.push(contact.id)

    const submittedData: Record<string, unknown> = {
      owner_first_name: testFirstName,
      owner_last_name: testLastName,
      owner_email: testEmail,
      owner_phone: '+1-555-0100',
      owner_dob: '1990-01-01',
      owner_nationality: 'US',
      owner_street: '123 Test Street',
      owner_city: 'Albuquerque',
      owner_state_province: 'NM',
      owner_zip: '87102',
      owner_country: 'United States',
      llc_name_1: llcName,
      ...(opts.extraSubmittedData ?? {}),
    }

    const { data: sub, error: sErr } = await supabaseAdmin
      .from('formation_submissions')
      .insert({
        token: `qa-pr3-${opts.suffix}-${ts}`,
        contact_id: contact.id,
        lead_id: null,
        entity_type: opts.entityType,
        state: opts.state ?? 'NM',
        language: 'en',
        status: 'completed',
        prefilled_data: {},
        submitted_data: submittedData,
        upload_paths: [],
      })
      .select('id')
      .single()
    if (sErr || !sub) throw new Error(`submission insert failed: ${sErr?.message}`)
    cleanupRefs.submission_ids.push(sub.id)

    let wpId: string | null = null
    if (!opts.skipWizardProgress) {
      const { data: wp, error: wErr } = await supabaseAdmin
        .from('wizard_progress')
        .insert({
          wizard_type: 'formation',
          data: {
            owner_first_name: testFirstName,
            owner_last_name: testLastName,
            llc_name_1: llcName,
            chosen_name: llcName,
            chosen_name_final: llcName,
          },
          contact_id: contact.id,
          account_id: null,
          status: 'submitted',
          current_step: 99,
        })
        .select('id')
        .single()
      if (wErr || !wp) throw new Error(`wizard_progress insert failed: ${wErr?.message}`)
      wpId = wp.id
      cleanupRefs.wizard_ids.push(wp.id)
    }

    const { data: sd, error: sdErr } = await supabaseAdmin
      .from('service_deliveries')
      .insert({
        service_name: `Company Formation - ${llcName}`,
        service_type: 'Company Formation',
        pipeline: 'Company Formation',
        stage: 'Data Collection',
        stage_order: 1,
        contact_id: contact.id,
        account_id: null,
        status: 'active',
        start_date: '2026-05-04',
        assigned_to: 'Luca',
      })
      .select('id')
      .single()
    if (sdErr || !sd) throw new Error(`SD insert failed: ${sdErr?.message}`)
    cleanupRefs.sd_ids.push(sd.id)

    return { contactId: contact.id, submissionId: sub.id, wizardId: wpId, sdId: sd.id, llcName, fullName: testFullName }
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n=== Test 1: SMLLC happy path ===')
  const t1 = await setupContact({ suffix: 'smllc', entityType: 'SMLLC' })
  cleanupRefs.drive_company_folder_names.push(`${t1.llcName} - ${t1.fullName}`)

  const r1 = await materializeFormationCompany({
    contact_id: t1.contactId,
    formation_date: '2026-05-04',
    actor: 'qa-pr3-test',
  })
  console.log(`  result.success=${r1.success} outcome=${r1.outcome}`)
  if (r1.account_id) cleanupRefs.account_ids.push(r1.account_id)

  check('helper succeeded', r1.success, r1.error)
  check('outcome=materialized', r1.outcome === 'materialized')
  check('account_id returned', !!r1.account_id)

  if (r1.account_id) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: acct } = await (supabaseAdmin as any).from('accounts').select('*').eq('id', r1.account_id).single()
    check('account.company_name', acct?.company_name === t1.llcName, acct?.company_name)
    check('account.status=Active', acct?.status === 'Active', acct?.status)
    check('account.account_type=Client', acct?.account_type === 'Client', acct?.account_type)
    check('account.state_of_formation=New Mexico', acct?.state_of_formation === 'New Mexico', acct?.state_of_formation)
    check('account.formation_date=2026-05-04', acct?.formation_date === '2026-05-04', acct?.formation_date)
    check('account.entity_type=Single Member LLC', acct?.entity_type === 'Single Member LLC', acct?.entity_type)
    check('account.portal_tier=formation', acct?.portal_tier === 'formation', acct?.portal_tier)

    const { data: link } = await supabaseAdmin
      .from('account_contacts').select('role').eq('account_id', r1.account_id).eq('contact_id', t1.contactId).maybeSingle()
    check('account_contacts row exists', !!link)
    check('account_contacts.role=Owner', link?.role === 'Owner', link?.role)

    const { data: sdAfter } = await supabaseAdmin
      .from('service_deliveries').select('account_id, service_name').eq('id', t1.sdId).single()
    check('SD account_id linked', sdAfter?.account_id === r1.account_id, sdAfter?.account_id ?? 'null')
    check('SD service_name updated', sdAfter?.service_name?.includes(t1.llcName) ?? false, sdAfter?.service_name ?? '')

    // SMLLC: no members rows expected (helper only writes for MMLLC).
    const { count: memberCount } = await supabaseAdmin
      .from('members').select('*', { count: 'exact', head: true }).eq('account_id', r1.account_id)
    check('SMLLC has 0 members rows', memberCount === 0, `count=${memberCount}`)

    // Step result inspection
    const ss4Pending = r1.steps.find(s => s.step === 'ss4_pending')
    check('ss4_pending step present', !!ss4Pending, ss4Pending?.detail)
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n=== Test 2: Idempotency (re-run on same contact) ===')
  const r1b = await materializeFormationCompany({
    contact_id: t1.contactId,
    formation_date: '2026-05-04',
    actor: 'qa-pr3-test',
  })
  check('outcome=already_materialized', r1b.outcome === 'already_materialized', r1b.outcome)
  check('returns same account_id', r1b.account_id === r1.account_id, r1b.account_id ?? 'undefined')

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n=== Test 3: Legacy placeholder — helper skips ===')
  const t3 = await setupContact({ suffix: 'placeholder', entityType: 'SMLLC' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: placeholder } = await (supabaseAdmin as any).from('accounts').insert({
    company_name: `Pending Formation - ${t3.fullName}`,
    entity_type: 'Single Member LLC',
    status: 'Pending Formation',
    account_type: 'Formation',
  }).select('id').single()
  cleanupRefs.account_ids.push(placeholder!.id)
  await supabaseAdmin.from('account_contacts').insert({
    account_id: placeholder!.id,
    contact_id: t3.contactId,
    role: 'Owner',
  })

  const r3 = await materializeFormationCompany({
    contact_id: t3.contactId,
    formation_date: '2026-05-04',
    actor: 'qa-pr3-test',
  })
  check('outcome=already_materialized (placeholder skip)', r3.outcome === 'already_materialized', r3.outcome)
  check('returns placeholder account_id', r3.account_id === placeholder!.id, r3.account_id ?? 'undefined')

  // No new account should have been created
  const { data: acctsForT3 } = await supabaseAdmin
    .from('account_contacts').select('account_id').eq('contact_id', t3.contactId)
  check('only one account linked to t3 contact', (acctsForT3?.length ?? 0) === 1, `linked=${acctsForT3?.length ?? 0}`)

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n=== Test 4: Missing chosen_name ===')
  const t4 = await setupContact({ suffix: 'nochosen', entityType: 'SMLLC', skipWizardProgress: true })

  const r4 = await materializeFormationCompany({
    contact_id: t4.contactId,
    formation_date: '2026-05-04',
    actor: 'qa-pr3-test',
  })
  check('outcome=missing_chosen_name', r4.outcome === 'missing_chosen_name', r4.outcome)
  check('no account_id returned', !r4.account_id, r4.account_id ?? 'undefined')

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n=== Test 4b: MMLLC happy path with 2 individual members ===')
  const t4b = await setupContact({
    suffix: 'mmllc',
    entityType: 'MMLLC',
    extraSubmittedData: {
      primary_member_index: 0,
      additional_members: [
        {
          member_type: 'individual',
          member_first_name: 'Alice',
          member_last_name: 'TestMember',
          member_email: `qa-pr3-mmllc-alice-${Date.now()}@example.test`,
          member_ownership_pct: 30,
          member_dob: '1992-03-15',
          member_nationality: 'US',
          member_street: '456 Member Lane',
          member_city: 'Albuquerque',
          member_state_province: 'NM',
          member_zip: '87102',
          member_country: 'United States',
        },
        {
          member_type: 'individual',
          member_first_name: 'Bob',
          member_last_name: 'TestMember',
          member_email: `qa-pr3-mmllc-bob-${Date.now()}@example.test`,
          member_ownership_pct: 20,
          member_dob: '1985-07-22',
          member_nationality: 'US',
          member_street: '789 Another St',
          member_city: 'Albuquerque',
          member_state_province: 'NM',
          member_zip: '87102',
          member_country: 'United States',
        },
      ],
    },
  })
  cleanupRefs.drive_company_folder_names.push(`${t4b.llcName} - ${t4b.fullName}`)

  const r4b = await materializeFormationCompany({
    contact_id: t4b.contactId,
    formation_date: '2026-05-04',
    actor: 'qa-pr3-test',
  })
  console.log(`  result.success=${r4b.success} outcome=${r4b.outcome}`)
  if (r4b.account_id) cleanupRefs.account_ids.push(r4b.account_id)

  check('MMLLC helper succeeded', r4b.success, r4b.error)
  check('MMLLC outcome=materialized', r4b.outcome === 'materialized')

  if (r4b.account_id) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: acctMM } = await (supabaseAdmin as any).from('accounts').select('entity_type').eq('id', r4b.account_id).single()
    check('MMLLC account.entity_type=Multi Member LLC', acctMM?.entity_type === 'Multi Member LLC', acctMM?.entity_type)

    const { data: links } = await supabaseAdmin
      .from('account_contacts').select('contact_id, role').eq('account_id', r4b.account_id)
    check('MMLLC has 3 account_contacts (owner + 2 members)', (links?.length ?? 0) === 3, `count=${links?.length ?? 0}`)
    const owners = (links || []).filter(l => l.role === 'Owner')
    const members = (links || []).filter(l => l.role === 'Member')
    check('MMLLC has 1 Owner role', owners.length === 1, `count=${owners.length}`)
    check('MMLLC has 2 Member roles', members.length === 2, `count=${members.length}`)

    const { data: membersRows } = await supabaseAdmin
      .from('members').select('full_name, ownership_pct, is_primary, contact_id, member_type').eq('account_id', r4b.account_id)
    check('members table has 3 rows (owner + 2 additional)', (membersRows?.length ?? 0) === 3, `count=${membersRows?.length ?? 0}`)
    const ownerRow = (membersRows || []).find(m => m.contact_id === t4b.contactId)
    check('owner members row exists', !!ownerRow)
    check('owner is_primary=true', ownerRow?.is_primary === true)
    check('owner ownership_pct=50 (100 - 30 - 20)', Number(ownerRow?.ownership_pct) === 50, String(ownerRow?.ownership_pct))

    const aliceRow = (membersRows || []).find(m => m.full_name === 'Alice TestMember')
    check('Alice members row exists', !!aliceRow)
    check('Alice ownership_pct=30', Number(aliceRow?.ownership_pct) === 30, String(aliceRow?.ownership_pct))

    // Track member contacts for cleanup
    for (const link of (links || [])) {
      if (link.role === 'Member' && !cleanupRefs.contact_ids.includes(link.contact_id)) {
        cleanupRefs.contact_ids.push(link.contact_id)
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n=== Test 5: Invalid state ===')
  const t5 = await setupContact({ suffix: 'badstate', entityType: 'SMLLC', state: 'CA' })

  const r5 = await materializeFormationCompany({
    contact_id: t5.contactId,
    formation_date: '2026-05-04',
    actor: 'qa-pr3-test',
  })
  check('outcome=invalid_state', r5.outcome === 'invalid_state', r5.outcome)
  check('no account_id returned', !r5.account_id, r5.account_id ?? 'undefined')

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n=== Cleanup ===')
  for (const id of cleanupRefs.sd_ids) {
    await supabaseAdmin.from('service_deliveries').delete().eq('id', id)
  }
  for (const id of cleanupRefs.wizard_ids) {
    await supabaseAdmin.from('wizard_progress').delete().eq('id', id)
  }
  for (const id of cleanupRefs.submission_ids) {
    await supabaseAdmin.from('formation_submissions').delete().eq('id', id)
  }
  for (const id of cleanupRefs.account_ids) {
    await supabaseAdmin.from('account_contacts').delete().eq('account_id', id)
    await supabaseAdmin.from('members').delete().eq('account_id', id)
    await supabaseAdmin.from('accounts').delete().eq('id', id)
  }
  for (const id of cleanupRefs.contact_ids) {
    await supabaseAdmin.from('contacts').delete().eq('id', id)
  }
  console.log(`  Cleaned ${cleanupRefs.contact_ids.length} contact(s), ${cleanupRefs.account_ids.length} account(s).`)

  if (cleanupRefs.drive_company_folder_names.length > 0) {
    console.log(`\n  ⚠️  Drive folders NOT auto-cleaned. Check Companies/New Mexico/ for:`)
    for (const n of cleanupRefs.drive_company_folder_names) console.log(`     - "${n}"`)
  }

  console.log(`\n=== RESULT: ${pass} pass, ${fail} fail ===`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
