#!/usr/bin/env node
/**
 * Sandbox seed step 5 — full production clone
 *
 * Clones every operational row (+ the reference tables needed for FK
 * integrity) from production to sandbox, in FK-safe order. Idempotent
 * upserts — re-running replaces existing rows. Paginated (PostgREST
 * returns max 1000 rows per request; we iterate offsets).
 *
 * PII: real names/emails (per Antonio 2026-04-19 confirmation).
 * Sandbox email gate + visual banner + Supabase ref assertion prevent
 * leakage to real clients.
 *
 * Skipped (log/noise): action_log, job_queue, email_queue, webhook_events,
 * oauth_*, portal_notifications (volatile), notification_queue.
 */

const fs = require('fs')
const path = require('path')

require('dotenv').config({ path: '.env.local' })
const PROD_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const PROD_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const sbEnv = fs.readFileSync(path.resolve(__dirname, '../../.env.sandbox'), 'utf8')
const SB_URL = sbEnv.match(/NEXT_PUBLIC_SUPABASE_URL="([^"]+)"/)[1]
const SB_KEY = sbEnv.match(/SUPABASE_SERVICE_ROLE_KEY="([^"]+)"/)[1]

const PAGE = 1000

function headers(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

async function readAll(url, key, table, select = '*') {
  const out = []
  let offset = 0
  for (;;) {
    const res = await fetch(`${url}/rest/v1/${table}?select=${encodeURIComponent(select)}&offset=${offset}&limit=${PAGE}`, {
      headers: headers(key),
    })
    if (!res.ok) throw new Error(`read ${table} offset ${offset} failed: ${res.status} ${await res.text()}`)
    const rows = await res.json()
    out.push(...rows)
    if (rows.length < PAGE) break
    offset += PAGE
  }
  return out
}

async function upsertBatch(url, key, table, rows, conflictColumn = 'id', stripFkCols = []) {
  if (!rows.length) return 0
  // If stripFkCols is set, null out those columns on insertion (for the
  // first pass of circular-FK tables). The second pass with full data
  // restores the FK values.
  const payload = stripFkCols.length
    ? rows.map(r => {
        const copy = { ...r }
        for (const c of stripFkCols) copy[c] = null
        return copy
      })
    : rows
  // Chunk upserts so PostgREST doesn't time out on huge payloads
  const chunkSize = 500
  let total = 0
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize)
    const res = await fetch(`${url}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
      method: 'POST',
      headers: headers(key, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(chunk),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`upsert ${table} chunk ${i}-${i + chunk.length} failed: ${res.status} ${body.slice(0, 300)}`)
    }
    total += chunk.length
  }
  return total
}

// Table clone specs. Circular FKs (accounts <-> contacts <-> client_partners)
// are handled with a two-pass approach: first pass strips the FK column on
// insert (NULLed), second pass (fk_restore_pass=true tables) re-upserts with
// full data now that referenced rows exist.
const TABLES = [
  // Reference tables (no FK parents of their own)
  { name: 'document_types', conflict: 'id' },
  { name: 'pipeline_stages', conflict: 'id' }, // already seeded but re-sync to be safe
  { name: 'service_catalog', conflict: 'id' },
  { name: 'app_settings', conflict: 'key' },

  // ─── Circular cluster: accounts ↔ contacts ↔ client_partners ───
  // Strategy: insert contacts + accounts first (FK fields stripped), then
  // client_partners (needs contacts — already exist), then re-upsert
  // contacts + accounts with full data.
  { name: 'accounts', conflict: 'id', stripFkCols: ['partner_id'] },
  { name: 'contacts', conflict: 'id', stripFkCols: ['primary_company_id'] },
  { name: 'client_partners', conflict: 'id', optional: true },

  // Second pass of the circular cluster — now all referenced rows exist
  { name: 'accounts', conflict: 'id', phase: 2 },
  { name: 'contacts', conflict: 'id', phase: 2 },

  // Leads (has converted_to_contact_id FK + converted_to_account_id FK)
  { name: 'leads', conflict: 'id' },

  // Account-contact junction (FK to both)
  { name: 'account_contacts', conflict: 'account_id,contact_id' },

  // Deals (referenced by offers/payments/service_deliveries/tasks FKs; most
  // current rows have NULL deal_id, so clone was previously succeeding by
  // accident — include it so sandbox mirrors prod and future non-NULL FKs
  // don't break).
  { name: 'deals', conflict: 'id', optional: true },

  // Client-side billing reference tables — required for client_invoices
  // (customer_id + bank_account_id FKs) and client_expenses (vendor_id FK).
  // Previously missing: client_invoices clone was failing loudly with
  // 23503 FK violation on customer_id.
  { name: 'client_customers', conflict: 'id', optional: true },
  { name: 'client_bank_accounts', conflict: 'id', optional: true },
  { name: 'client_vendors', conflict: 'id', optional: true },

  // Offers / contracts / activations (tied to leads + accounts + deals)
  { name: 'offers', conflict: 'id' },
  { name: 'contracts', conflict: 'id' },
  { name: 'pending_activations', conflict: 'id' },

  // Service deliveries + associated
  { name: 'service_deliveries', conflict: 'id' },
  { name: 'tax_returns', conflict: 'id' },
  { name: 'payments', conflict: 'id' },
  { name: 'payment_items', conflict: 'id', optional: true }, // FK → payments
  { name: 'client_invoices', conflict: 'id', optional: true },
  { name: 'client_expenses', conflict: 'id', optional: true },
  { name: 'client_expense_items', conflict: 'id', optional: true }, // FK → client_expenses
  { name: 'td_expenses', conflict: 'id', optional: true },

  // Deadlines (FK → accounts). 489+ rows: Annual Report, RA Renewal, Tax
  // Filing deadlines. Without these, sandbox portal shows empty deadline
  // calendar which hides bugs in deadline UI/reminders.
  { name: 'deadlines', conflict: 'id', optional: true },

  // Services catalog rows (tasks.service_id FK). Empty in prod today,
  // but include so any future row is cloned rather than breaking tasks.
  { name: 'services', conflict: 'id', optional: true },

  // Workflow artifacts
  { name: 'tasks', conflict: 'id' },
  { name: 'wizard_progress', conflict: 'id' },

  // Client submission flow tables — each wizard/form the client fills.
  // Must be cloned so sandbox portal shows correct "data received" state
  // for historical clients, and so the tax_returns anomaly view isn't
  // falsely flagged for rows whose evidence lives in tax_return_submissions.
  { name: 'company_info_submissions', conflict: 'id', optional: true },
  { name: 'tax_return_submissions', conflict: 'id', optional: true },
  { name: 'tax_quote_submissions', conflict: 'id', optional: true },
  { name: 'formation_submissions', conflict: 'id', optional: true },
  { name: 'onboarding_submissions', conflict: 'id', optional: true },
  { name: 'itin_submissions', conflict: 'id', optional: true },
  { name: 'closure_submissions', conflict: 'id', optional: true },
  { name: 'banking_submissions', conflict: 'id', optional: true },

  // Signature artifacts
  { name: 'oa_agreements', conflict: 'id', optional: true },
  { name: 'oa_signatures', conflict: 'id', optional: true }, // FK → oa_agreements + contacts
  { name: 'lease_agreements', conflict: 'id', optional: true },
  { name: 'ss4_applications', conflict: 'id', optional: true },
  { name: 'signature_requests', conflict: 'id', optional: true },

  // Documents (requires document_types)
  { name: 'documents', conflict: 'id', optional: true },
]

// Cache of rows we've already read from prod — so second-pass re-upsert
// doesn't re-hit PROD for the same data.
const rowCache = new Map()

async function main() {
  console.log('PROD:', PROD_URL)
  console.log('SANDBOX:', SB_URL)
  console.log('')

  const summary = []
  for (const spec of TABLES) {
    const label = spec.phase === 2 ? `${spec.name} (pass 2)` : spec.name
    process.stdout.write(`${label.padEnd(24)}… `)
    try {
      let rows
      if (rowCache.has(spec.name)) {
        rows = rowCache.get(spec.name)
      } else {
        rows = await readAll(PROD_URL, PROD_KEY, spec.name)
        rowCache.set(spec.name, rows)
      }
      // First pass: strip circular FK columns. Second pass: full data.
      const stripCols = spec.phase === 2 ? [] : (spec.stripFkCols || [])
      const n = await upsertBatch(SB_URL, SB_KEY, spec.name, rows, spec.conflict, stripCols)
      console.log(`${rows.length} read, ${n} upserted${stripCols.length ? ` (stripped: ${stripCols.join(', ')})` : ''}`)
      summary.push({ table: label, read: rows.length, upserted: n })
    } catch (e) {
      console.log(`ERR — ${e.message.slice(0, 200)}`)
      summary.push({ table: label, error: e.message.slice(0, 200) })
      if (!spec.optional) {
        console.log(`[${spec.name}] is required — stopping clone.`)
        break
      }
    }
  }

  console.log('\n=== Summary ===')
  for (const s of summary) {
    if (s.error) console.log(`  ${s.table.padEnd(24)}: ERROR`)
    else console.log(`  ${s.table.padEnd(24)}: ${s.upserted} rows`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
