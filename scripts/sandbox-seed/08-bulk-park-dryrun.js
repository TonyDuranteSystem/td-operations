#!/usr/bin/env node
/**
 * Bulk-park dry-run — preview WITHOUT writing.
 *
 * Surveys every active Tax Return SD in the sandbox and buckets them:
 *   - WILL PARK: Client + active + ext_filed=true + account.status != Closed + tax_returns.status != 'TR Filed'
 *   - SKIP One-Time: account_type='One-Time' (exempt per Phase 0.1)
 *   - SKIP Closed: account.status='Closed' (Financialot-style — final TR)
 *   - SKIP TR Filed: tax_returns.status='TR Filed' (return already done)
 *   - SKIP Missing ext: no tax_returns row OR extension_filed=false (would
 *     show a false banner otherwise — needs Antonio's attention)
 *
 * Outputs a markdown report with each bucket's companies + rationale.
 * NO writes to the DB. Safe to run any time.
 */

const fs = require('fs')
const path = require('path')

const sbEnv = fs.readFileSync(path.resolve(__dirname, '../../.env.sandbox'), 'utf8')
const SB_URL = sbEnv.match(/NEXT_PUBLIC_SUPABASE_URL="([^"]+)"/)[1]
const SB_KEY = sbEnv.match(/SUPABASE_SERVICE_ROLE_KEY="([^"]+)"/)[1]

function headers() {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
}

async function readAll(fullUrl) {
  const out = []
  let offset = 0
  const PAGE = 1000
  const sep = fullUrl.includes('?') ? '&' : '?'
  for (;;) {
    const r = await fetch(`${fullUrl}${sep}offset=${offset}&limit=${PAGE}`, { headers: headers() })
    if (!r.ok) throw new Error(`read failed ${r.status} ${await r.text()}`)
    const rows = await r.json()
    out.push(...rows)
    if (rows.length < PAGE) break
    offset += PAGE
  }
  return out
}

async function main() {
  console.log('SANDBOX:', SB_URL)

  // Load ALL active Tax Return SDs
  const sds = await readAll(`${SB_URL}/rest/v1/service_deliveries?service_type=eq.Tax%20Return&status=eq.active&select=id,account_id,contact_id,stage,status`)
  console.log('Active Tax Return SDs:', sds.length)

  // Join accounts + tax_returns
  const acctIds = Array.from(new Set(sds.map(s => s.account_id).filter(Boolean)))
  const acctsCsv = acctIds.map(id => `"${id}"`).join(',')
  const accounts = await readAll(`${SB_URL}/rest/v1/accounts?id=in.(${acctsCsv})&select=id,company_name,account_type,status`)
  const acctById = new Map(accounts.map(a => [a.id, a]))

  const trRows = await readAll(`${SB_URL}/rest/v1/tax_returns?account_id=in.(${acctsCsv})&select=id,account_id,tax_year,return_type,status,extension_filed,extension_submission_id&order=tax_year.desc`)
  // Keep the latest-year tax_returns row per account
  const trLatestByAcct = new Map()
  for (const t of trRows) {
    if (!trLatestByAcct.has(t.account_id)) trLatestByAcct.set(t.account_id, t)
  }

  const buckets = {
    will_park: [],
    skip_onetime: [],
    skip_closed: [],
    skip_tr_filed: [],
    skip_missing_ext: [],
    skip_past_data: [],
    skip_orphan_contact: [],
    skip_other: [],
  }

  for (const sd of sds) {
    const a = sd.account_id ? acctById.get(sd.account_id) : null
    const tr = sd.account_id ? trLatestByAcct.get(sd.account_id) : null

    if (!a) {
      // SD with no account yet (standalone business TR pre-wizard — Marvin-style)
      buckets.skip_orphan_contact.push({ sd_id: sd.id, reason: 'SD has no account_id (standalone business TR pre-intake)', stage: sd.stage })
      continue
    }

    if (a.account_type === 'One-Time') {
      buckets.skip_onetime.push({ name: a.company_name, reason: 'One-Time account — exempt from parking (no 2nd installment to reactivate on)' })
      continue
    }

    if (a.status === 'Closed') {
      buckets.skip_closed.push({ name: a.company_name, reason: 'Account Closed — final TR must complete; parking would block India filing' })
      continue
    }

    if (tr?.status === 'TR Filed') {
      buckets.skip_tr_filed.push({ name: a.company_name, reason: 'Tax return already filed — no pause needed' })
      continue
    }

    if (!tr || tr.extension_filed !== true) {
      buckets.skip_missing_ext.push({
        name: a.company_name,
        reason: tr ? `ext_filed=${tr.extension_filed}, submission_id=${tr.extension_submission_id ?? 'null'}` : 'no tax_returns row',
      })
      continue
    }

    // Only park accounts at pre-data-receipt stage. tr.status semantics:
    //   Activated - Need Link  — account activated, need to send link
    //   Link Sent - Awaiting Data — link sent, client hasn't submitted
    //   Extension Filed         — extension filed, data still pending
    //   Data Received           — client already submitted data (SKIP)
    //   Sent to India / ...     — further along (SKIP)
    // And SD stage must match — "1st Installment Paid" or "Extension Filed"
    // stages confirm the SD is in the data-collection phase.
    const ALLOWED_TR_STATUS = new Set(['Activated - Need Link', 'Link Sent - Awaiting Data', 'Extension Filed'])
    const ALLOWED_SD_STAGE = new Set(['1st Installment Paid', 'Extension Filed'])
    if (!ALLOWED_TR_STATUS.has(tr.status)) {
      buckets.skip_past_data.push({ name: a.company_name, reason: `tr.status=${tr.status} (past data collection)`, stage: sd.stage })
      continue
    }
    if (!ALLOWED_SD_STAGE.has(sd.stage)) {
      buckets.skip_past_data.push({ name: a.company_name, reason: `sd.stage=${sd.stage} (past 1st installment / extension filed)`, status: tr.status })
      continue
    }

    if (a.account_type !== 'Client') {
      buckets.skip_other.push({ name: a.company_name, reason: `account_type=${a.account_type}` })
      continue
    }

    buckets.will_park.push({
      name: a.company_name,
      sd_id: sd.id,
      stage: sd.stage,
      tr_year: tr.tax_year,
      tr_type: tr.return_type,
      ext_id: tr.extension_submission_id,
    })
  }

  const report = [
    '# Bulk-Park Dry Run — Sandbox Preview',
    '',
    `_Generated: ${new Date().toISOString()}_`,
    `_Sandbox: ${SB_URL}_`,
    '',
    '## Summary',
    '',
    `| Bucket | Count | Action |`,
    `|---|---|---|`,
    `| **WILL PARK** (status active → on_hold) | **${buckets.will_park.length}** | Flip to on_hold |`,
    `| Skip — One-Time account | ${buckets.skip_onetime.length} | Stay active (exempt) |`,
    `| Skip — Account Closed | ${buckets.skip_closed.length} | Stay active (final TR) |`,
    `| Skip — TR already filed | ${buckets.skip_tr_filed.length} | Stay active |`,
    `| Skip — Missing extension data | ${buckets.skip_missing_ext.length} | **NEEDS ANTONIO** — can't safely park without ext_id |`,
    `| Skip — Past data-receipt stage | ${buckets.skip_past_data.length} | Stay active (client already submitted data) |`,
    `| Skip — Orphan contact-only SD | ${buckets.skip_orphan_contact.length} | Stay active (pre-wizard) |`,
    `| Skip — Other account_type | ${buckets.skip_other.length} | Stay active |`,
    `| **TOTAL active TR SDs scanned** | **${sds.length}** | |`,
    '',
  ]

  const render = (title, bucket, showLimit = null) => {
    if (!bucket.length) return
    report.push(`## ${title} (${bucket.length})`)
    report.push('')
    const shown = showLimit ? bucket.slice(0, showLimit) : bucket
    for (const x of shown) {
      if ('sd_id' in x && 'ext_id' in x) {
        report.push(`- **${x.name}** — ${x.stage} | ${x.tr_year} ${x.tr_type} | ext_id: \`${x.ext_id}\``)
      } else {
        report.push(`- **${x.name ?? x.sd_id}** — ${x.reason}`)
      }
    }
    if (showLimit && bucket.length > showLimit) {
      report.push(`- ...and ${bucket.length - showLimit} more (truncated)`)
    }
    report.push('')
  }

  render('WILL PARK — Client accounts ready for on_hold', buckets.will_park)
  render('SKIP — One-Time accounts (exempt)', buckets.skip_onetime)
  render('SKIP — Account Closed (final TR)', buckets.skip_closed)
  render('SKIP — TR already filed', buckets.skip_tr_filed)
  render('SKIP — Missing extension data (NEEDS ANTONIO)', buckets.skip_missing_ext)
  render('SKIP — Past data-receipt stage (natural gating)', buckets.skip_past_data, 30)
  render('SKIP — Orphan contact-only SDs', buckets.skip_orphan_contact)
  render('SKIP — Other account types', buckets.skip_other)

  const outPath = path.resolve(__dirname, '08-bulk-park-preview.md')
  fs.writeFileSync(outPath, report.join('\n'))
  console.log('\n=== Preview written to', outPath, '===')
  console.log(`WILL PARK: ${buckets.will_park.length}`)
  console.log(`SKIP One-Time: ${buckets.skip_onetime.length}`)
  console.log(`SKIP Closed: ${buckets.skip_closed.length}`)
  console.log(`SKIP TR Filed: ${buckets.skip_tr_filed.length}`)
  console.log(`SKIP Missing ext: ${buckets.skip_missing_ext.length}`)
  console.log(`SKIP Past data-receipt: ${buckets.skip_past_data.length}`)
  console.log(`SKIP Orphan: ${buckets.skip_orphan_contact.length}`)
  console.log(`SKIP Other: ${buckets.skip_other.length}`)
  console.log(`Total active TR SDs: ${sds.length}`)
}

main().catch(e => { console.error(e); process.exit(1) })
