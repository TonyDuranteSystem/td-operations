#!/usr/bin/env node
/**
 * Apply the real extension IDs from Antonio's batch-1 file
 * (Updated_Tax_Extension_2025.xlsx parsed into 06-real-extension-ids.json).
 *
 * For each row in the batch:
 *   - Match to sandbox account by company_name (case-insensitive)
 *   - If submission_id is present: upsert tax_returns row for 2025 with
 *     extension_filed=true + real submission_id
 *   - If remarks="Return has been filed" (no submission_id): mark
 *     tax_returns.status='TR Filed', leave extension_filed=false (no ext
 *     because return was filed directly)
 *   - If remarks="Please Provide Fiscal Year..." (no submission_id): leave
 *     extension_filed=false, add a note
 *
 * Produces a markdown report of matched / unmatched / special-cased rows.
 * Idempotent — safe to re-run.
 */

const fs = require('fs')
const path = require('path')

const sbEnv = fs.readFileSync(path.resolve(__dirname, '../../.env.sandbox'), 'utf8')
const SB_URL = sbEnv.match(/NEXT_PUBLIC_SUPABASE_URL="([^"]+)"/)[1]
const SB_KEY = sbEnv.match(/SUPABASE_SERVICE_ROLE_KEY="([^"]+)"/)[1]

const ROWS = JSON.parse(fs.readFileSync(path.resolve(__dirname, '06-real-extension-ids.json'), 'utf8'))

function headers(extra = {}) {
  return {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...extra,
  }
}

async function req(method, pathAndQuery, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    throw new Error(`${method} ${pathAndQuery} failed: ${res.status} ${await res.text()}`)
  }
  return res.json()
}

function originalDeadline(taxYear, returnType) {
  const filingYear = taxYear + 1
  const partnershipLike = returnType === 'MMLLC' || returnType === 'S-Corp'
  const month = partnershipLike ? '03' : '04'
  return `${filingYear}-${month}-15`
}

function normalize(s) {
  if (!s) return ''
  return s.toString().trim().toLowerCase().replace(/\s+/g, ' ')
}

async function main() {
  console.log('SANDBOX:', SB_URL)
  console.log('Rows in batch:', ROWS.length)

  // Pre-fetch all sandbox accounts for name matching
  const accounts = await req('GET', 'accounts?select=id,company_name,account_type,status')
  const byNorm = new Map(accounts.map(a => [normalize(a.company_name), a]))
  console.log('Sandbox accounts loaded:', accounts.length)

  const report = [
    '# Real Extension IDs — Sandbox Application',
    '',
    `_Generated: ${new Date().toISOString()}_`,
    `_Source: Updated_Tax_Extension_2025.xlsx (batch 1) — ${ROWS.length} rows_`,
    '',
  ]

  const stats = { applied_with_id: 0, marked_filed: 0, marked_pending: 0, unmatched: 0, no_data: 0 }
  const unmatched = []
  const markedFiled = []
  const markedPending = []

  for (const row of ROWS) {
    const match = byNorm.get(normalize(row.company_name))
    if (!match) {
      stats.unmatched++
      unmatched.push(row.company_name)
      continue
    }
    const accountId = match.id
    const taxYear = 2025
    const returnType = row.return_type || 'SMLLC'

    const hasId = !!(row.submission_id && String(row.submission_id).trim())
    const remarks = (row.remarks || '').toString()
    const isReturnFiled = /return has been filed/i.test(remarks)
    const isPendingFiscal = /fiscal\s+year/i.test(remarks)

    try {
      if (hasId) {
        // Normal case: real extension ID, mark ext filed
        const existing = await req('GET', `tax_returns?account_id=eq.${accountId}&tax_year=eq.${taxYear}&select=id`)
        if (existing.length) {
          await req('PATCH', `tax_returns?id=eq.${existing[0].id}`, {
            extension_filed: true,
            extension_submission_id: String(row.submission_id).trim(),
            return_type: returnType,
            updated_at: new Date().toISOString(),
          })
        } else {
          await req('POST', 'tax_returns', {
            account_id: accountId,
            company_name: match.company_name,
            tax_year: taxYear,
            return_type: returnType,
            deadline: originalDeadline(taxYear, returnType),
            extension_filed: true,
            extension_submission_id: String(row.submission_id).trim(),
            paid: true,
            status: 'Activated - Need Link',
          })
        }
        stats.applied_with_id++
      } else if (isReturnFiled) {
        // Return filed directly, no extension. Mark TR row status + leave
        // extension_filed=false. Don't park the SD (pause is nonsensical
        // for a return that's done).
        const existing = await req('GET', `tax_returns?account_id=eq.${accountId}&tax_year=eq.${taxYear}&select=id,status`)
        if (existing.length) {
          await req('PATCH', `tax_returns?id=eq.${existing[0].id}`, {
            status: 'TR Filed',
            extension_filed: false,
            updated_at: new Date().toISOString(),
          })
        } else {
          await req('POST', 'tax_returns', {
            account_id: accountId,
            company_name: match.company_name,
            tax_year: taxYear,
            return_type: returnType,
            deadline: originalDeadline(taxYear, returnType),
            extension_filed: false,
            paid: true,
            status: 'TR Filed',
          })
        }
        // Ensure SD is not on_hold
        await req('PATCH', `service_deliveries?account_id=eq.${accountId}&service_type=eq.Tax%20Return&status=eq.on_hold`, {
          status: 'active',
          updated_at: new Date().toISOString(),
        })
        stats.marked_filed++
        markedFiled.push(match.company_name)
      } else if (isPendingFiscal) {
        // Extension blocked — pending fiscal year from client. Add a note,
        // do NOT park (can't claim "extension filed" when it hasn't been).
        const existing = await req('GET', `tax_returns?account_id=eq.${accountId}&tax_year=eq.${taxYear}&select=id,notes`)
        const note = `[${new Date().toISOString().split('T')[0]}] Extension blocked — client has not provided fiscal year start/end dates.`
        if (existing.length) {
          await req('PATCH', `tax_returns?id=eq.${existing[0].id}`, {
            notes: [existing[0].notes, note].filter(Boolean).join('\n'),
            extension_filed: false,
            updated_at: new Date().toISOString(),
          })
        } else {
          await req('POST', 'tax_returns', {
            account_id: accountId,
            company_name: match.company_name,
            tax_year: taxYear,
            return_type: returnType,
            deadline: originalDeadline(taxYear, returnType),
            extension_filed: false,
            paid: true,
            status: 'Activated - Need Link',
            notes: note,
          })
        }
        // Unpark — pause banner would be wrong here (no extension filed).
        await req('PATCH', `service_deliveries?account_id=eq.${accountId}&service_type=eq.Tax%20Return&status=eq.on_hold`, {
          status: 'active',
          updated_at: new Date().toISOString(),
        })
        stats.marked_pending++
        markedPending.push(match.company_name)
      } else {
        stats.no_data++
      }
    } catch (e) {
      console.log(`  ERR ${row.company_name}: ${e.message.slice(0, 100)}`)
    }
  }

  report.push('## Summary')
  report.push('')
  report.push(`- Real IDs applied: **${stats.applied_with_id}**`)
  report.push(`- Marked "TR Filed" (no extension needed): **${stats.marked_filed}**`)
  report.push(`- Marked "Pending fiscal year" (unpause): **${stats.marked_pending}**`)
  report.push(`- Unmatched (not in sandbox accounts): **${stats.unmatched}**`)
  report.push(`- No data (no ID + no remark): **${stats.no_data}**`)
  report.push('')

  if (markedFiled.length) {
    report.push('## Marked "TR Filed"')
    report.push('')
    for (const n of markedFiled) report.push(`- ${n}`)
    report.push('')
  }
  if (markedPending.length) {
    report.push('## Marked "Pending fiscal year"')
    report.push('')
    for (const n of markedPending) report.push(`- ${n}`)
    report.push('')
  }
  if (unmatched.length) {
    report.push('## Unmatched')
    report.push('')
    for (const n of unmatched) report.push(`- ${n}`)
    report.push('')
  }

  const outPath = path.resolve(__dirname, '07-apply-report.md')
  fs.writeFileSync(outPath, report.join('\n'))
  console.log('\nStats:', stats)
  console.log('Report saved to:', outPath)
}

main().catch(e => { console.error(e); process.exit(1) })
