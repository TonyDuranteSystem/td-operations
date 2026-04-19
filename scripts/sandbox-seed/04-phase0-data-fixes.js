#!/usr/bin/env node
/**
 * Phase 0.2 data fixes — applies Antonio's 22-row decisions to the sandbox.
 *
 * Reads the current state of each audit account, applies the decision,
 * re-reads, and emits a before/after diff report.
 *
 * Extension IDs: placeholders (`EXT-SANDBOX-<slug>`). Antonio will replace
 * with real IDs tomorrow before we re-run against production.
 *
 * Decisions (per Antonio's corrected file + his clarifications):
 *   Group A — Extension filed (create tax_returns row if missing, set
 *             extension_filed=true + placeholder submission_id):
 *     Avorgate, Beril, Entregarse US, Flowiz Studio, Fulfil Partners,
 *     KG Wolf Consulting, Lida Consulting, Lucky Pama, Matsonic,
 *     Tube Marketing Ninja, Unique Commerce, Vairon Marketing, VSV210,
 *     Alma Accelerator, Invictus Equity Group, Kasabi Ocean Global
 *   Group B — Cancel Tax Return SD (service not sold / test account):
 *     DigitalBox, RelationBox, Italiza, Uxio Test
 *   Group C — Special cases:
 *     Financialot: create tax_returns (2025, SMLLC), set extension_filed=true,
 *       leave SD active for final TR filing. Account is already Closed.
 *     Marvin: migrate to Workstream B flow — SD stage → "Company Data
 *       Pending", account_id → null, delete placeholder account, set
 *       extension_filed=true on placeholder tax_returns row.
 *
 * Output: markdown diff report saved to scripts/sandbox-seed/04-diff-report.md
 */

const fs = require('fs')
const path = require('path')

const sbEnv = fs.readFileSync(path.resolve(__dirname, '../../.env.sandbox'), 'utf8')
const SB_URL = sbEnv.match(/NEXT_PUBLIC_SUPABASE_URL="([^"]+)"/)[1]
const SB_KEY = sbEnv.match(/SUPABASE_SERVICE_ROLE_KEY="([^"]+)"/)[1]

function headers(extra = {}) {
  return {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

async function req(method, pathAndQuery, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: headers({ Prefer: 'return=representation' }),
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    throw new Error(`${method} ${pathAndQuery} failed: ${res.status} ${await res.text()}`)
  }
  return res.json()
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
}

// ─── Decision catalog ──────────────────────────────────────
const DECISIONS = [
  // Group A — Extension filed
  { company: 'Avorgate LLC', action: 'extension_filed_and_park', tax_year: 2025, return_type: 'Corp' },
  { company: 'Beril LLC', action: 'extension_filed_and_park', tax_year: 2025, return_type: 'Corp' },
  { company: 'Entregarse US LLC', action: 'extension_filed_and_park', tax_year: 2025, return_type: 'Corp' },
  { company: 'Flowiz Studio LLC', action: 'extension_filed_and_park', tax_year: 2025, return_type: 'SMLLC' },
  { company: 'Fulfil Partners LLC', action: 'extension_filed_and_park', tax_year: 2025, return_type: 'SMLLC' },
  { company: 'KG Wolf Consulting LLC', action: 'extension_filed_and_park', tax_year: 2025, return_type: 'SMLLC' },
  { company: 'Lida Consulting LLC', action: 'extension_filed_and_park', tax_year: 2025, return_type: 'SMLLC' },
  { company: 'Lucky Pama Llc', action: 'extension_filed_and_park', tax_year: 2025, return_type: 'Corp' },
  { company: 'Matsonic LLC', action: 'extension_filed_and_park', tax_year: 2025, return_type: 'SMLLC' },
  { company: 'Tube Marketing Ninja LLC', action: 'extension_filed_and_park', tax_year: 2025, return_type: 'SMLLC' },
  { company: 'Unique Commerce LLC', action: 'extension_filed_and_park', tax_year: 2025, return_type: 'SMLLC' },
  { company: 'Vairon Marketing LLC', action: 'extension_filed_and_park', tax_year: 2025, return_type: 'SMLLC' },
  { company: 'VSV210 LLC', action: 'extension_filed_and_park', tax_year: 2025, return_type: 'Corp' },
  { company: 'Alma Accelerator LLC', action: 'extension_filed_only', tax_year: 2025, return_type: 'SMLLC' }, // One-Time — don't park
  { company: 'Invictus Equity Group LLC', action: 'extension_filed_and_park', tax_year: 2025, return_type: 'SMLLC' },
  { company: 'Kasabi Ocean Global LLC', action: 'extension_filed_and_park', tax_year: 2025, return_type: 'SMLLC' },

  // Group B — Cancel Tax Return SD
  { company: 'DigitalBox LLC', action: 'cancel_tr_sd', reason: 'only RA + State Renewal sold' },
  { company: 'RelationBox LLC', action: 'cancel_tr_sd', reason: 'only RA + State Renewal sold' },
  { company: 'Italiza LLC', action: 'cancel_tr_sd', reason: 'No tax return sold' },
  { company: 'Uxio Test LLC', action: 'cancel_tr_sd_and_mark_test', reason: 'test account' },

  // Group C — Special
  { company: 'Financialot LLC', action: 'extension_filed_final_return', tax_year: 2025, return_type: 'SMLLC', reason: 'final TR then company is already Closed' },
  { company: 'Pending Company — Marvin Al Rivera', action: 'migrate_marvin_to_workstream_b', tax_year: 2025, return_type: 'SMLLC', reason: 'pre-Workstream B; standalone business TR' },
]

// ─── Per-decision handlers ────────────────────────────────

async function applyDecision(d, report) {
  const accts = await req('GET', `accounts?company_name=eq.${encodeURIComponent(d.company)}&select=id,company_name,account_type,status,is_test`)
  if (!accts.length) { report.push(`- **${d.company}**: NOT FOUND in sandbox`); return }
  const a = accts[0]

  const before = await snapshot(a.id, d.company, a)

  if (d.action === 'extension_filed_and_park') {
    await ensureTaxReturn(a, d)
    await parkSd(a.id)
  } else if (d.action === 'extension_filed_only') {
    // One-Time TR customer — create tax_returns but DON'T park (pause code should exempt them)
    await ensureTaxReturn(a, d)
    // Do NOT park — this tests the One-Time exemption
  } else if (d.action === 'cancel_tr_sd') {
    await cancelTrSd(a.id)
  } else if (d.action === 'cancel_tr_sd_and_mark_test') {
    await cancelTrSd(a.id)
    await markAccountTest(a.id)
    await markSdsTest(a.id)
  } else if (d.action === 'extension_filed_final_return') {
    // Financialot — account already Closed, leave SD active for final TR
    await ensureTaxReturn(a, d)
    // Do NOT park — final return needs to be processed
  } else if (d.action === 'migrate_marvin_to_workstream_b') {
    await migrateMarvin(a, d)
  } else {
    report.push(`- **${d.company}**: UNKNOWN action "${d.action}"`)
    return
  }

  const after = await snapshot(a.id, d.company, a)
  report.push(formatDiff(d, before, after))
}

async function snapshot(accountId, companyName, account) {
  const [sds, trs] = await Promise.all([
    req('GET', `service_deliveries?account_id=eq.${accountId}&service_type=eq.Tax%20Return&select=id,stage,status,is_test`),
    req('GET', `tax_returns?account_id=eq.${accountId}&select=id,tax_year,return_type,status,extension_filed,extension_submission_id`),
  ])
  const acctRow = await req('GET', `accounts?id=eq.${accountId}&select=status,is_test,account_type`)
  return { companyName, account: acctRow[0], sds, trs }
}

function originalDeadline(taxYear, returnType) {
  // Original IRS filing deadlines (before extension):
  //   MMLLC / S-Corp → March 15 of tax_year+1
  //   SMLLC / Corp → April 15 of tax_year+1
  const filingYear = taxYear + 1
  const partnershipLike = returnType === 'MMLLC' || returnType === 'S-Corp'
  const month = partnershipLike ? '03' : '04'
  return `${filingYear}-${month}-15`
}

async function ensureTaxReturn(account, d) {
  // Find tax_returns row for this account + tax_year. If missing, insert.
  // If present, update extension_filed + extension_submission_id.
  const existing = await req('GET', `tax_returns?account_id=eq.${account.id}&tax_year=eq.${d.tax_year}&select=id`)
  const submissionId = `EXT-SANDBOX-${slug(account.company_name)}-${d.tax_year}`
  if (existing.length) {
    await req('PATCH', `tax_returns?id=eq.${existing[0].id}`, {
      extension_filed: true,
      extension_submission_id: submissionId,
      return_type: d.return_type,
      updated_at: new Date().toISOString(),
    })
  } else {
    await req('POST', 'tax_returns', {
      account_id: account.id,
      company_name: account.company_name,
      tax_year: d.tax_year,
      return_type: d.return_type,
      deadline: originalDeadline(d.tax_year, d.return_type),
      extension_filed: true,
      extension_submission_id: submissionId,
      paid: true,
      status: 'Activated - Need Link',
    })
  }
}

async function parkSd(accountId) {
  // Flip Tax Return SD to on_hold for testing the pause banner.
  await req('PATCH', `service_deliveries?account_id=eq.${accountId}&service_type=eq.Tax%20Return&status=eq.active`, {
    status: 'on_hold',
    updated_at: new Date().toISOString(),
  })
}

async function cancelTrSd(accountId) {
  await req('PATCH', `service_deliveries?account_id=eq.${accountId}&service_type=eq.Tax%20Return&status=neq.completed&status=neq.cancelled`, {
    status: 'cancelled',
    end_date: new Date().toISOString().split('T')[0],
    updated_at: new Date().toISOString(),
  })
}

async function markAccountTest(accountId) {
  await req('PATCH', `accounts?id=eq.${accountId}`, {
    is_test: true,
    updated_at: new Date().toISOString(),
  })
}

async function markSdsTest(accountId) {
  await req('PATCH', `service_deliveries?account_id=eq.${accountId}`, {
    is_test: true,
    updated_at: new Date().toISOString(),
  })
}

async function migrateMarvin(account, d) {
  // Get Marvin's Tax Return SD
  const sds = await req('GET', `service_deliveries?account_id=eq.${account.id}&service_type=eq.Tax%20Return&select=id,stage,status`)
  if (!sds.length) return
  const sd = sds[0]
  // Migrate SD back to "Company Data Pending" (stage_order=-1), null out account_id
  await req('PATCH', `service_deliveries?id=eq.${sd.id}`, {
    stage: 'Company Data Pending',
    stage_order: -1,
    account_id: null,
    status: 'active',
    updated_at: new Date().toISOString(),
  })
  // Create tax_returns row (orphan for now, no account_id yet). Uses contact_id instead.
  const link = await req('GET', `account_contacts?account_id=eq.${account.id}&select=contact_id&limit=1`)
  const contactId = link[0]?.contact_id || null
  const submissionId = `EXT-SANDBOX-${slug(account.company_name)}-${d.tax_year}`
  // Don't create tax_returns row yet — it'll be created by tax_return_intake
  // handler when Marvin submits company_info wizard. Instead, record his
  // extension on a pending placeholder that the handler can pick up later.
  // For now, do nothing with tax_returns — the extension_submission_id
  // will need to be attached manually when Marvin finishes his flow.
  void contactId
  void submissionId

  // Placeholder account: don't delete (would require nulling payments/invoices/etc.
  // that reference it). Rename it to make its orphan state obvious and flag for
  // manual cleanup after Marvin completes his company_info wizard and gets a
  // real account. The SD has already been detached (account_id=null above).
  if (account.company_name.startsWith('Pending Company')) {
    await req('PATCH', `accounts?id=eq.${account.id}`, {
      notes: `[MIGRATED 2026-04-19] Marvin's SD moved back to "Company Data Pending" for Workstream B flow. This placeholder account is now an orphan — delete after he completes company_info wizard and gets a real account.`,
      status: 'Suspended',
      updated_at: new Date().toISOString(),
    })
  }
}

function formatDiff(d, before, after) {
  const lines = [`\n### ${d.company}`]
  lines.push(`**Decision**: ${d.action}${d.reason ? ` (${d.reason})` : ''}`)
  lines.push('')
  lines.push('| | Before | After |')
  lines.push('|---|---|---|')
  lines.push(`| Account status | ${before.account?.status ?? '—'} | ${after.account?.status ?? '(deleted)'} |`)
  lines.push(`| Account is_test | ${before.account?.is_test ?? '—'} | ${after.account?.is_test ?? '(deleted)'} |`)
  lines.push(`| Tax Return SDs | ${before.sds.map(s => `${s.stage}/${s.status}`).join(', ') || '—'} | ${after.sds.map(s => `${s.stage}/${s.status}`).join(', ') || '—'} |`)
  lines.push(`| tax_returns rows | ${before.trs.length} (${before.trs.map(t => `${t.tax_year}/${t.return_type}/ext=${t.extension_filed}`).join(', ')}) | ${after.trs.length} (${after.trs.map(t => `${t.tax_year}/${t.return_type}/ext=${t.extension_filed}/id=${t.extension_submission_id ?? 'none'}`).join(', ')}) |`)
  return lines.join('\n')
}

// ─── Main ──────────────────────────────────────

async function main() {
  console.log('SANDBOX:', SB_URL)
  console.log('Applying', DECISIONS.length, 'decisions...\n')

  const report = [
    '# Phase 0.2 Data Fix — Sandbox Dry Run',
    '',
    `_Generated: ${new Date().toISOString()}_`,
    '',
    `- **Sandbox Supabase**: ${SB_URL}`,
    `- **Extension IDs**: placeholders (format \`EXT-SANDBOX-<company-slug>-<year>\`). Replace before prod.`,
    '',
    '## Decisions applied',
    '',
  ]

  let ok = 0
  let errors = 0

  for (const d of DECISIONS) {
    try {
      await applyDecision(d, report)
      ok++
    } catch (e) {
      errors++
      report.push(`\n### ${d.company}\n**ERROR**: ${e.message}`)
      console.log(`ERR ${d.company}: ${e.message}`)
    }
  }

  report.push('')
  report.push('---')
  report.push(`**Summary**: ${ok} applied, ${errors} errors`)

  const outPath = path.resolve(__dirname, '04-diff-report.md')
  fs.writeFileSync(outPath, report.join('\n'))
  console.log(`\nReport saved to: ${outPath}`)
  console.log(`Summary: ${ok} applied, ${errors} errors`)
}

main().catch(e => { console.error(e); process.exit(1) })
