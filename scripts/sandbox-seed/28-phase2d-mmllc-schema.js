#!/usr/bin/env node
/**
 * Phase 2d — MMLLC schema migration (sandbox only).
 *
 * Purpose: add `offers.entity_type` column so the offer carries the
 * single-member vs multi-member decision into the activation chain.
 *
 * Context: see `sysdoc mmllc-full-build-plan`. First schema change in the
 * MMLLC build. Additive, non-breaking. Uses the existing `company_type`
 * enum ("Single Member LLC" | "Multi Member LLC" | "C-Corp Elected") for
 * DB consistency with accounts.entity_type. Backfills existing offers
 * from their linked account's entity_type where account_id is set.
 *
 * Usage:
 *   node scripts/sandbox-seed/28-phase2d-mmllc-schema.js           # dry-run (prints plan, no writes)
 *   node scripts/sandbox-seed/28-phase2d-mmllc-schema.js --apply   # executes against sandbox
 *
 * Safety: refuses to run unless NEXT_PUBLIC_SUPABASE_URL points at the
 * sandbox Supabase project (ref `xjcxlmlpeywtwkhstjlw`). Production cutover
 * is a separate script (32-phase3-prod-cutover.js).
 */

require('dotenv').config({ path: '.env.sandbox' })
const { Client } = require('pg')

const APPLY = process.argv.includes('--apply')

const sections = [
  {
    name: '1. Add offers.entity_type column (uses existing company_type enum)',
    stmts: [
      `ALTER TABLE offers ADD COLUMN IF NOT EXISTS entity_type company_type;`,
    ],
  },
  {
    name: '2. Backfill offers.entity_type from linked accounts where account_id is set',
    stmts: [
      // Only backfill where not yet set AND linked account has entity_type
      `UPDATE offers o
       SET entity_type = a.entity_type
       FROM accounts a
       WHERE o.account_id = a.id
         AND o.entity_type IS NULL
         AND a.entity_type IS NOT NULL;`,
    ],
  },
  {
    name: '3. (No backfill for contact-linked offers) — leave NULL where no linked account; Antonio sets at offer creation going forward',
    stmts: [
      // No-op section — placeholder for clarity in the log
      `SELECT 1;`,
    ],
  },
]

;(async () => {
  const c = new Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  })
  await c.connect()

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
  if (!url.includes('xjcxlmlpeywtwkhstjlw')) {
    console.error('REFUSED: not sandbox (' + url + ')')
    await c.end()
    process.exit(2)
  }

  console.log(APPLY ? 'APPLY MODE — writing to sandbox' : 'DRY-RUN — no writes')
  console.log('===========================================')
  for (const section of sections) {
    console.log('\n-- ' + section.name)
    for (const s of section.stmts) {
      const oneLine = s.replace(/\s+/g, ' ').trim()
      console.log('   ' + oneLine.substring(0, 200) + (oneLine.length > 200 ? '...' : ''))
    }
  }

  if (!APPLY) {
    await c.end()
    console.log('\n(dry-run complete — re-run with --apply to execute)')
    return
  }

  for (const section of sections) {
    console.log('\n▶ ' + section.name)
    try {
      await c.query('BEGIN')
      for (const s of section.stmts) {
        const res = await c.query(s)
        const rc = typeof res.rowCount === 'number' ? ` (${res.rowCount} row(s))` : ''
        console.log('  ✓ statement ok' + rc)
      }
      await c.query('COMMIT')
      console.log('  ✓ section committed (' + section.stmts.length + ' stmt)')
    } catch (e) {
      try { await c.query('ROLLBACK') } catch {}
      console.error('  ✗ FAIL: ' + e.message)
      await c.end()
      process.exit(1)
    }
  }

  // ─── Verification ───
  console.log('\n=== VERIFICATION ===')
  const checks = [
    {
      label: 'offers.entity_type column exists',
      q: `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'offers' AND column_name = 'entity_type'`,
    },
    {
      label: 'offers.entity_type uses company_type enum',
      q: `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'offers' AND column_name = 'entity_type'
            AND udt_name = 'company_type'`,
    },
  ]
  for (const ch of checks) {
    const r = await c.query(ch.q)
    console.log('  ' + (r.rows.length ? '✓' : '✗') + ' ' + ch.label)
  }

  const dist = await c.query(
    `SELECT entity_type::text, COUNT(*)::int AS n
     FROM offers
     GROUP BY entity_type
     ORDER BY n DESC`
  )
  console.log('\n  offers.entity_type distribution:')
  for (const r of dist.rows) {
    console.log('    ' + (r.entity_type || '(null)') + ': ' + r.n)
  }

  await c.end()
  console.log('\nPhase 2d migration complete.')
})().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
