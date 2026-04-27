#!/usr/bin/env node
/**
 * MMLLC members table backfill (sandbox only).
 *
 * Purpose: populate the `members` table for existing MMLLC accounts that were
 * formed before the new members-first code (April 2026). Reads from
 * account_contacts → contacts and inserts one members row per linked contact.
 *
 * Scope: only processes accounts where:
 *   1. entity_type is a Multi-Member LLC variant
 *   2. members table has 0 rows for that account (idempotent — skips already-migrated)
 *
 * All migrated rows get is_signer=false (default; Luca sets true after review).
 * Company members: not handled here — company members were manually entered; only
 * individual contacts from account_contacts are backfilled.
 *
 * Usage:
 *   node scripts/sandbox-seed/32-mmllc-members-backfill.js           # dry-run
 *   node scripts/sandbox-seed/32-mmllc-members-backfill.js --apply   # write to sandbox
 *
 * Safety: refuses to run unless NEXT_PUBLIC_SUPABASE_URL contains the sandbox
 * project ref `xjcxlmlpeywtwkhstjlw`. Production migration is a separate manual step.
 */

require('dotenv').config({ path: '.env.sandbox' })
const { Client } = require('pg')

const APPLY = process.argv.includes('--apply')

;(async () => {
  const c = new Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  })
  await c.connect()

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
  if (!url.includes('xjcxlmlpeywtwkhstjlw')) {
    console.error('REFUSED: not sandbox (' + url + '). This script only runs against sandbox.')
    await c.end()
    process.exit(2)
  }

  console.log(APPLY ? '🚀 APPLY MODE — writing to sandbox' : '🔍 DRY-RUN — no writes')
  console.log('=========================================================')

  // 1. Find all MMLLC accounts
  const { rows: mmllcAccounts } = await c.query(`
    SELECT id, company_name, entity_type::text
    FROM accounts
    WHERE entity_type = 'Multi Member LLC'
    ORDER BY company_name
  `)

  console.log(`\nFound ${mmllcAccounts.length} MMLLC account(s)`)

  let totalInserted = 0
  let totalSkipped = 0

  for (const account of mmllcAccounts) {
    // Check if members table already has rows for this account
    const { rows: existing } = await c.query(
      `SELECT COUNT(*) AS n FROM members WHERE account_id = $1`,
      [account.id]
    )
    const existingCount = parseInt(existing[0].n, 10)

    if (existingCount > 0) {
      console.log(`\n  ⏭  ${account.company_name} — already has ${existingCount} members row(s), skipping`)
      totalSkipped++
      continue
    }

    // Fetch account_contacts for this account
    const { rows: acRows } = await c.query(`
      SELECT
        ac.contact_id,
        ac.ownership_pct,
        ac.is_primary,
        c.full_name,
        c.first_name,
        c.last_name,
        c.email,
        c.phone,
        c.address_line1,
        c.address_city,
        c.address_state,
        c.address_zip,
        c.address_country
      FROM account_contacts ac
      JOIN contacts c ON c.id = ac.contact_id
      WHERE ac.account_id = $1
      ORDER BY COALESCE(ac.is_primary, false) DESC, c.full_name
    `, [account.id])

    if (acRows.length === 0) {
      console.log(`\n  ⚠️  ${account.company_name} — no account_contacts, skipping`)
      continue
    }

    console.log(`\n  📋 ${account.company_name} (${account.entity_type}) — ${acRows.length} contact(s) to migrate`)

    for (const row of acRows) {
      const fullName = row.full_name
        || [row.first_name, row.last_name].filter(Boolean).join(' ')
        || row.email
        || 'Unknown'

      console.log(`     → ${fullName} (${row.ownership_pct ?? '?'}%, is_primary=${row.is_primary})`)

      if (APPLY) {
        await c.query(`
          INSERT INTO members (
            account_id, member_type, full_name, email, phone,
            address_street, address_city, address_state, address_zip, address_country,
            ownership_pct, is_primary, is_signer, contact_id,
            created_at, updated_at
          ) VALUES (
            $1, 'individual', $2, $3, $4,
            $5, $6, $7, $8, $9,
            $10, $11, false, $12,
            now(), now()
          )
          ON CONFLICT (account_id, contact_id) WHERE contact_id IS NOT NULL DO NOTHING
        `, [
          account.id,
          fullName,
          row.email || null,
          row.phone || null,
          row.address_line1 || null,
          row.address_city || null,
          row.address_state || null,
          row.address_zip || null,
          row.address_country || null,
          row.ownership_pct || null,
          row.is_primary || false,
          row.contact_id,
        ])
        totalInserted++
      } else {
        totalInserted++ // count for dry-run
      }
    }
  }

  console.log('\n=========================================================')
  console.log(`Summary:`)
  console.log(`  Accounts skipped (already migrated): ${totalSkipped}`)
  console.log(`  Members ${APPLY ? 'inserted' : 'would be inserted'}: ${totalInserted}`)
  if (!APPLY) {
    console.log('\n▶ Run with --apply to execute the migration against sandbox.')
  }

  await c.end()
})()
