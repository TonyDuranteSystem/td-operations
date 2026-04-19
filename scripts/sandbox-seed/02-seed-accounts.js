#!/usr/bin/env node
/**
 * Sandbox seed step 2 — clone target accounts + all related data
 *
 * For each target account, reads from production and upserts into sandbox:
 *   accounts, account_contacts, contacts, leads (via contact), offers,
 *   contracts, pending_activations, service_deliveries, payments,
 *   tax_returns, tasks, wizard_progress, company_info_submissions.
 *
 * Insert order respects FK dependencies. All writes use upsert so the
 * script is idempotent (safe to re-run).
 *
 * PII: cloned verbatim (real names/emails) per Antonio 2026-04-19 —
 * sandbox DB is access-restricted and emails can't leak out because PR #15
 * installed the sandbox email gate.
 *
 * Target list: the 22 accounts Antonio triaged in his audit file, plus
 * a placeholder hook for edge-case additions.
 */

const fs = require('fs')
const path = require('path')

require('dotenv').config({ path: '.env.local' })
const PROD_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const PROD_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const sbEnv = fs.readFileSync(path.resolve(__dirname, '../../.env.sandbox'), 'utf8')
const SB_URL = sbEnv.match(/NEXT_PUBLIC_SUPABASE_URL="([^"]+)"/)[1]
const SB_KEY = sbEnv.match(/SUPABASE_SERVICE_ROLE_KEY="([^"]+)"/)[1]

// The 22 accounts from Antonio's audit file.
const TARGET_COMPANY_NAMES = [
  'Alma Accelerator LLC',
  'Avorgate LLC',
  'Beril LLC',
  'DigitalBox LLC',
  'Entregarse US LLC',
  'Financialot LLC',
  'Flowiz Studio LLC',
  'Fulfil Partners LLC',
  'Invictus Equity Group LLC',
  'Italiza LLC',
  'Kasabi Ocean Global LLC',
  'KG Wolf Consulting LLC',
  'Lida Consulting LLC',
  'Lucky Pama Llc',
  'Matsonic LLC',
  'Pending Company — Marvin Al Rivera',
  'RelationBox LLC',
  'Tube Marketing Ninja LLC',
  'Unique Commerce LLC',
  'Uxio Test LLC',
  'Vairon Marketing LLC',
  'VSV210 LLC',
]

function headers(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

async function read(url, key, table, query) {
  const res = await fetch(`${url}/rest/v1/${table}?${query}`, { headers: headers(key) })
  if (!res.ok) throw new Error(`read ${table} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function upsert(url, key, table, rows, conflictColumn = 'id') {
  if (!rows.length) return 0
  const res = await fetch(`${url}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
    method: 'POST',
    headers: headers(key, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  })
  if (!res.ok) {
    throw new Error(`upsert ${table} (${rows.length} rows) failed: ${res.status} ${await res.text()}`)
  }
  return rows.length
}

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)))
}

async function main() {
  console.log('PROD:', PROD_URL)
  console.log('SANDBOX:', SB_URL)
  console.log('Targets:', TARGET_COMPANY_NAMES.length, 'accounts')
  console.log('')

  // Step 1: resolve account IDs by company_name
  console.log('Resolving account IDs...')
  const orList = TARGET_COMPANY_NAMES
    .map(n => `company_name.eq.${encodeURIComponent(n)}`)
    .join(',')
  const accounts = await read(PROD_URL, PROD_KEY, 'accounts', `or=(${orList})&select=*`)
  console.log(`  ${accounts.length} accounts resolved`)
  const missing = TARGET_COMPANY_NAMES.filter(n => !accounts.find(a => a.company_name === n))
  if (missing.length) console.log('  MISSING (not found in prod):', missing)
  const accountIds = accounts.map(a => a.id)

  // Step 2: fetch related data. We use contact_id → leads, account_id → everything else.
  console.log('\nFetching related data...')
  const accountIdsCsv = accountIds.map(id => `"${id}"`).join(',')

  const [
    accountContactLinks,
    serviceDeliveries,
    payments,
    taxReturns,
    tasks,
    wizardProgress,
    documents,
    offersByAccount,
  ] = await Promise.all([
    read(PROD_URL, PROD_KEY, 'account_contacts', `account_id=in.(${accountIdsCsv})&select=*`),
    read(PROD_URL, PROD_KEY, 'service_deliveries', `account_id=in.(${accountIdsCsv})&select=*`),
    read(PROD_URL, PROD_KEY, 'payments', `account_id=in.(${accountIdsCsv})&select=*`),
    read(PROD_URL, PROD_KEY, 'tax_returns', `account_id=in.(${accountIdsCsv})&select=*`),
    read(PROD_URL, PROD_KEY, 'tasks', `account_id=in.(${accountIdsCsv})&select=*`),
    read(PROD_URL, PROD_KEY, 'wizard_progress', `account_id=in.(${accountIdsCsv})&select=*`),
    read(PROD_URL, PROD_KEY, 'documents', `account_id=in.(${accountIdsCsv})&select=*`),
    read(PROD_URL, PROD_KEY, 'offers', `account_id=in.(${accountIdsCsv})&select=*`),
  ])

  // Step 3: resolve contact IDs from account_contacts + SDs + payments + tasks (contact_id)
  const contactIdsSet = new Set()
  for (const l of accountContactLinks) if (l.contact_id) contactIdsSet.add(l.contact_id)
  for (const sd of serviceDeliveries) if (sd.contact_id) contactIdsSet.add(sd.contact_id)
  for (const p of payments) if (p.contact_id) contactIdsSet.add(p.contact_id)
  for (const t of tasks) if (t.contact_id) contactIdsSet.add(t.contact_id)
  for (const w of wizardProgress) if (w.contact_id) contactIdsSet.add(w.contact_id)
  const contactIds = Array.from(contactIdsSet)
  console.log(`  ${contactIds.length} unique contacts referenced`)

  // Fetch contacts
  let contacts = []
  let leads = []
  if (contactIds.length) {
    const contactIdsCsv = contactIds.map(id => `"${id}"`).join(',')
    contacts = await read(PROD_URL, PROD_KEY, 'contacts', `id=in.(${contactIdsCsv})&select=*`)
    // Fetch leads that converted to these contacts
    leads = await read(PROD_URL, PROD_KEY, 'leads', `converted_to_contact_id=in.(${contactIdsCsv})&select=*`)
  }
  console.log(`  ${contacts.length} contacts, ${leads.length} leads`)

  // Also fetch offers by lead_id (for offers that pre-date account linking)
  const leadIdsCsv = leads.map(l => `"${l.id}"`).join(',')
  let offersByLead = []
  if (leads.length) {
    offersByLead = await read(PROD_URL, PROD_KEY, 'offers', `lead_id=in.(${leadIdsCsv})&select=*`)
  }
  // Merge unique offers
  const offerMap = new Map()
  for (const o of [...offersByAccount, ...offersByLead]) offerMap.set(o.token, o)
  const offers = Array.from(offerMap.values())
  console.log(`  ${offers.length} unique offers (account+lead linked)`)

  // Step 4: fetch contracts, pending_activations by offer_token
  const offerTokens = offers.map(o => o.token)
  const offerTokensCsv = offerTokens.map(t => `"${t}"`).join(',')
  let contracts = []
  let pendingActivations = []
  if (offerTokens.length) {
    contracts = await read(PROD_URL, PROD_KEY, 'contracts', `offer_token=in.(${offerTokensCsv})&select=*`)
    pendingActivations = await read(PROD_URL, PROD_KEY, 'pending_activations', `offer_token=in.(${offerTokensCsv})&select=*`)
  }
  console.log(`  ${contracts.length} contracts, ${pendingActivations.length} pending_activations`)

  console.log(`  ${serviceDeliveries.length} SDs, ${payments.length} payments, ${taxReturns.length} tax_returns`)
  console.log(`  ${tasks.length} tasks, ${wizardProgress.length} wizard_progress, ${documents.length} documents`)

  // Step 5: insert into sandbox in FK-safe order.
  console.log('\nUpserting into sandbox (FK-safe order)...')

  const steps = [
    { table: 'contacts', rows: contacts, conflict: 'id' },
    { table: 'leads', rows: leads, conflict: 'id' },
    { table: 'accounts', rows: accounts, conflict: 'id' },
    { table: 'account_contacts', rows: accountContactLinks, conflict: 'account_id,contact_id' },
    { table: 'offers', rows: offers, conflict: 'id' },
    { table: 'contracts', rows: contracts, conflict: 'id' },
    { table: 'pending_activations', rows: pendingActivations, conflict: 'id' },
    { table: 'service_deliveries', rows: serviceDeliveries, conflict: 'id' },
    { table: 'payments', rows: payments, conflict: 'id' },
    { table: 'tax_returns', rows: taxReturns, conflict: 'id' },
    { table: 'tasks', rows: tasks, conflict: 'id' },
    { table: 'wizard_progress', rows: wizardProgress, conflict: 'id' },
    // documents: skip — requires document_types reference table which we haven't cloned.
    // Not needed for Phase 0 tax-pause testing. Revisit if workflows involving docs need testing.
    // { table: 'documents', rows: documents, conflict: 'id' },
  ]

  for (const s of steps) {
    try {
      const n = await upsert(SB_URL, SB_KEY, s.table, s.rows, s.conflict)
      console.log(`  ${s.table.padEnd(22)}: ${n} rows`)
    } catch (e) {
      console.log(`  ${s.table.padEnd(22)}: ERROR — ${e.message.slice(0, 200)}`)
    }
  }

  console.log('\nDone. Re-run safe — all upserts.')
}

main().catch(e => { console.error(e); process.exit(1) })
