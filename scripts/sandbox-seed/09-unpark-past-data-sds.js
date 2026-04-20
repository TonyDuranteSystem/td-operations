#!/usr/bin/env node
/**
 * Unpark Tax Return SDs that slipped past the narrowed eligibility window.
 *
 * Phase 0.2 parked every active Client TR SD with extension_filed=true.
 * After spot-checking (Flowiz Studio, Avorgate), we narrowed the pause
 * banner to fire only when BOTH:
 *   tr.status IN ('Activated - Need Link', 'Link Sent - Awaiting Data', 'Extension Filed')
 *   sd.stage  IN ('1st Installment Paid', 'Extension Filed')
 *
 * This script flips back to active any SD that is currently on_hold but
 * fails one of those gates (i.e. the client has already moved past
 * data-receipt, or the SD has advanced past the data-collection stage).
 *
 * Idempotent. Prints a summary. NO PROD writes — sandbox only.
 */

const fs = require('fs')
const path = require('path')

const sbEnv = fs.readFileSync(path.resolve(__dirname, '../../.env.sandbox'), 'utf8')
const SB_URL = sbEnv.match(/NEXT_PUBLIC_SUPABASE_URL="([^"]+)"/)[1]
const SB_KEY = sbEnv.match(/SUPABASE_SERVICE_ROLE_KEY="([^"]+)"/)[1]

if (!/xjcxlmlpeywtwkhstjlw/.test(SB_URL)) {
  console.error('Refusing to run: expected sandbox Supabase ref xjcxlmlpeywtwkhstjlw, got', SB_URL)
  process.exit(1)
}

function headers() {
  return {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }
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

async function patch(pathAndQuery, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`patch failed ${res.status} ${await res.text()}`)
  return res.json()
}

async function main() {
  console.log('SANDBOX:', SB_URL)

  const ALLOWED_TR_STATUS = new Set(['Activated - Need Link', 'Link Sent - Awaiting Data', 'Extension Filed'])
  const ALLOWED_SD_STAGE = new Set(['1st Installment Paid', 'Extension Filed'])

  // All on_hold Tax Return SDs
  const sds = await readAll(
    `${SB_URL}/rest/v1/service_deliveries?service_type=eq.Tax%20Return&status=eq.on_hold&select=id,account_id,stage,status`,
  )
  console.log('on_hold Tax Return SDs:', sds.length)

  if (sds.length === 0) {
    console.log('Nothing to unpark.')
    return
  }

  const acctIds = Array.from(new Set(sds.map(s => s.account_id).filter(Boolean)))
  const acctsCsv = acctIds.map(id => `"${id}"`).join(',')
  const trRows = await readAll(
    `${SB_URL}/rest/v1/tax_returns?account_id=in.(${acctsCsv})&select=id,account_id,tax_year,status&order=tax_year.desc`,
  )
  const trLatestByAcct = new Map()
  for (const t of trRows) if (!trLatestByAcct.has(t.account_id)) trLatestByAcct.set(t.account_id, t)

  const unpark = []
  const keep = []
  for (const sd of sds) {
    const tr = sd.account_id ? trLatestByAcct.get(sd.account_id) : null
    const trOk = tr && ALLOWED_TR_STATUS.has(tr.status)
    const stageOk = ALLOWED_SD_STAGE.has(sd.stage)
    if (!trOk || !stageOk) {
      unpark.push({ sd_id: sd.id, stage: sd.stage, tr_status: tr?.status ?? 'no tax_returns row' })
    } else {
      keep.push({ sd_id: sd.id, stage: sd.stage, tr_status: tr.status })
    }
  }

  console.log('WILL UNPARK:', unpark.length)
  console.log('KEEP PARKED:', keep.length)

  const preview = unpark.slice(0, 20)
  for (const u of preview) console.log(`  - ${u.sd_id} | stage=${u.stage} | tr=${u.tr_status}`)
  if (unpark.length > 20) console.log(`  ...and ${unpark.length - 20} more`)

  if (process.argv.includes('--dry')) {
    console.log('\n[DRY RUN] No writes. Re-run without --dry to apply.')
    return
  }

  // Apply. Batch by id IN (...) to minimize round-trips.
  const ids = unpark.map(u => u.sd_id)
  const BATCH = 50
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH)
    const inList = chunk.map(id => `"${id}"`).join(',')
    const res = await patch(
      `service_deliveries?id=in.(${inList})&status=eq.on_hold`,
      { status: 'active', updated_at: new Date().toISOString() },
    )
    console.log(`Unparked batch ${i / BATCH + 1}: ${Array.isArray(res) ? res.length : 0} rows`)
  }

  console.log('\nDone.')
}

main().catch(e => { console.error(e); process.exit(1) })
