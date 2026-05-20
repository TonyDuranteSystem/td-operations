/* eslint-disable no-console, no-restricted-syntax -- QA script: console output is the deliverable; direct sandbox fixture inserts/teardown are intentional (this is not a production write path) */
/**
 * Sandbox QA — formation wizard contact-scope fix (dev_task 21fd1f4a).
 *
 * Seeds real wizard_progress rows in sandbox and runs the SAME query the portal
 * wizard page builds (lib/portal/wizard-scope.ts → resolveWizardProgressScope +
 * the .is('lead_id', null) restriction), asserting the correct row is found for
 * each scenario:
 *
 *   1. Materialized formation, normal login (Lorenzo) → finds the original
 *      contact-scoped formation; the OLD account-keyed query found nothing.
 *   2. New-company formation via lead → finds the lead-anchored draft (PR #75).
 *   3. Contact with BOTH formations, no lead → finds the ORIGINAL (lead_id NULL),
 *      not the newer second-company draft (the disambiguation).
 *   4. Account-owned wizard (banking) → stays account-scoped.
 *   5. In-progress formation before any account → still found by contact.
 *
 * Sandbox-only: aborts if NEXT_PUBLIC_SUPABASE_URL is not the sandbox ref.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}

async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { resolveWizardProgressScope } = await import('../../lib/portal/wizard-scope')

  let pass = 0
  let fail = 0
  function check(label: string, ok: boolean, detail?: string) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
    ok ? pass++ : fail++
  }

  const created = { contacts: [] as string[], accounts: [] as string[], leads: [] as string[], wizards: [] as string[] }
  const tag = `QA-CONTACTSCOPE-${Date.now()}`

  // Mirror the portal wizard page's progress lookup exactly.
  async function lookup(params: { wizardType: string; formationLeadId: string | null; accountId: string | null; contactId: string | null }) {
    const scope = resolveWizardProgressScope(params)
    if (!scope) return { scope, row: null as null | { id: string } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q = (supabaseAdmin as any).from('wizard_progress').select('id').eq(scope.col, scope.val).eq('wizard_type', params.wizardType).in('status', ['in_progress', 'submitted'])
    if (scope.restrictToNoLead) q = q.is('lead_id', null)
    const { data } = await q.order('updated_at', { ascending: false }).limit(1).maybeSingle()
    return { scope, row: data as null | { id: string } }
  }

  try {
    // ── Setup parents ──────────────────────────────────────────────────────
    const { data: contact, error: cErr } = await supabaseAdmin.from('contacts').insert({
      first_name: 'QA', last_name: tag, full_name: `QA ${tag}`, email: `qa+${tag}@example.com`, is_test: true,
    }).select('id').single()
    if (cErr || !contact) throw new Error(`contact insert failed: ${cErr?.message}`)
    created.contacts.push(contact.id)

    const { data: contact2, error: c2Err } = await supabaseAdmin.from('contacts').insert({
      first_name: 'QA2', last_name: tag, full_name: `QA2 ${tag}`, email: `qa2+${tag}@example.com`, is_test: true,
    }).select('id').single()
    if (c2Err || !contact2) throw new Error(`contact2 insert failed: ${c2Err?.message}`)
    created.contacts.push(contact2.id)

    const { data: account, error: aErr } = await supabaseAdmin.from('accounts').insert({
      company_name: `QA ${tag} LLC`, entity_type: 'Single Member LLC', status: 'Active', account_type: 'Client', is_test: true,
    }).select('id').single()
    if (aErr || !account) throw new Error(`account insert failed: ${aErr?.message}`)
    created.accounts.push(account.id)

    const { error: lkErr } = await supabaseAdmin.from('account_contacts').insert({
      account_id: account.id, contact_id: contact.id, role: 'Owner',
    })
    if (lkErr) throw new Error(`account_contacts insert failed: ${lkErr.message}`)

    const { data: lead, error: ldErr } = await supabaseAdmin.from('leads').insert({
      full_name: `QA ${tag}`, email: `qa+${tag}@example.com`, status: 'New',
    }).select('id').single()
    if (ldErr || !lead) throw new Error(`lead insert failed: ${ldErr?.message}`)
    created.leads.push(lead.id)

    // ── Seed wizard_progress rows ────────────────────────────────────────────
    async function wp(row: Record<string, unknown>) {
      const { data, error } = await supabaseAdmin.from('wizard_progress').insert(row).select('id').single()
      if (error || !data) throw new Error(`wizard_progress insert failed: ${error?.message}`)
      created.wizards.push(data.id)
      return data.id as string
    }
    // WP1: original/materialized formation — on contact, no account, no lead.
    const WP1 = await wp({ wizard_type: 'formation', status: 'submitted', current_step: 99, data: {}, contact_id: contact.id, account_id: null, lead_id: null })
    // WP2: second-company formation — anchored to a lead, newer than WP1.
    const WP2 = await wp({ wizard_type: 'formation', status: 'in_progress', current_step: 1, data: {}, contact_id: contact.id, account_id: null, lead_id: lead.id })
    // WPb: account-owned banking wizard.
    const WPb = await wp({ wizard_type: 'banking_payset', status: 'in_progress', current_step: 1, data: {}, contact_id: contact.id, account_id: account.id, lead_id: null })
    // WP5: in-progress formation for a contact with NO account.
    const WP5 = await wp({ wizard_type: 'formation', status: 'in_progress', current_step: 1, data: {}, contact_id: contact2.id, account_id: null, lead_id: null })

    // ── Scenario 1 + 3: normal login, contact has account + BOTH formations ──
    const s1 = await lookup({ wizardType: 'formation', formationLeadId: null, accountId: account.id, contactId: contact.id })
    check('S1/S3 scope is contact_id + restrictToNoLead', s1.scope?.col === 'contact_id' && s1.scope?.restrictToNoLead === true, JSON.stringify(s1.scope))
    check('S1/S3 finds the ORIGINAL formation (WP1), not the second-company draft (WP2)', s1.row?.id === WP1, `found ${s1.row?.id}`)

    // OLD (buggy) behavior: account-keyed lookup found nothing → caused the duplicate.
    const { data: oldRow } = await supabaseAdmin.from('wizard_progress').select('id').eq('account_id', account.id).eq('wizard_type', 'formation').in('status', ['in_progress', 'submitted']).order('updated_at', { ascending: false }).limit(1).maybeSingle()
    check('Regression proof: OLD account-keyed lookup found NO formation', !oldRow, `old found ${oldRow?.id ?? 'none'}`)

    // ── Scenario 2: new-company formation via lead ───────────────────────────
    const s2 = await lookup({ wizardType: 'formation', formationLeadId: lead.id, accountId: account.id, contactId: contact.id })
    check('S2 scope is lead_id (PR #75 path untouched)', s2.scope?.col === 'lead_id', JSON.stringify(s2.scope))
    check('S2 finds the second-company draft (WP2)', s2.row?.id === WP2, `found ${s2.row?.id}`)

    // ── Scenario 4: account-owned banking wizard ─────────────────────────────
    const s4 = await lookup({ wizardType: 'banking_payset', formationLeadId: null, accountId: account.id, contactId: contact.id })
    check('S4 scope is account_id (banking stays account-scoped)', s4.scope?.col === 'account_id', JSON.stringify(s4.scope))
    check('S4 finds the banking wizard (WPb)', s4.row?.id === WPb, `found ${s4.row?.id}`)

    // ── Scenario 5: in-progress formation, no account yet ────────────────────
    const s5 = await lookup({ wizardType: 'formation', formationLeadId: null, accountId: null, contactId: contact2.id })
    check('S5 scope is contact_id', s5.scope?.col === 'contact_id', JSON.stringify(s5.scope))
    check('S5 finds the pre-account formation (WP5)', s5.row?.id === WP5, `found ${s5.row?.id}`)

    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  } finally {
    // ── Teardown (children first) ────────────────────────────────────────────
    if (created.wizards.length) await supabaseAdmin.from('wizard_progress').delete().in('id', created.wizards)
    if (created.accounts.length) await supabaseAdmin.from('account_contacts').delete().in('account_id', created.accounts)
    if (created.accounts.length) await supabaseAdmin.from('accounts').delete().in('id', created.accounts)
    if (created.leads.length) await supabaseAdmin.from('leads').delete().in('id', created.leads)
    if (created.contacts.length) await supabaseAdmin.from('contacts').delete().in('id', created.contacts)
    console.log('🧹 cleanup done')
  }

  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
