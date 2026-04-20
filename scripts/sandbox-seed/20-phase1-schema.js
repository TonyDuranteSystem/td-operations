#!/usr/bin/env node
/**
 * Phase 1 — Additive schema migration (sandbox only).
 *
 * Purpose: give existing records the labels and links the rest of the plan
 * relies on. Every change is additive and non-breaking — old code keeps running.
 *
 * Ordered so that types exist before columns reference them, columns exist
 * before indexes/constraints depend on them, and data backfills run last.
 *
 * Usage:
 *   node scripts/sandbox-seed/20-phase1-schema.js           # dry-run (prints plan, no writes)
 *   node scripts/sandbox-seed/20-phase1-schema.js --apply   # executes against sandbox
 */

require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');

const sections = [
  {
    name: '1. Create two new enums: subject_type (contact/account) and payment_type (6 values)',
    stmts: [
      `DO $$ BEGIN
         CREATE TYPE subject_type_enum AS ENUM ('contact','account');
       EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
      `DO $$ BEGIN
         CREATE TYPE payment_type_enum AS ENUM (
           'Setup Fee','Installment 1 (Jan)','Installment 2 (Jun)',
           'Annual Payment','One-Time Service','Custom'
         );
       EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    ],
  },
  {
    name: '2. Expand billing_type enum 2 -> 6 values (keep existing, add new)',
    stmts: [
      `ALTER TYPE billing_type ADD VALUE IF NOT EXISTS 'Setup Fee';`,
      `ALTER TYPE billing_type ADD VALUE IF NOT EXISTS 'Installments';`,
      `ALTER TYPE billing_type ADD VALUE IF NOT EXISTS 'Annual Payment';`,
      `ALTER TYPE billing_type ADD VALUE IF NOT EXISTS 'One-Time Service';`,
      `ALTER TYPE billing_type ADD VALUE IF NOT EXISTS 'Custom';`,
    ],
    enumExpansion: true, // Postgres requires these outside a txn
  },
  {
    name: '3. Add new columns to offers (subject_type, contact_id)',
    stmts: [
      `ALTER TABLE offers ADD COLUMN IF NOT EXISTS subject_type subject_type_enum;`,
      `ALTER TABLE offers ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id);`,
    ],
  },
  {
    name: '4. Add FK columns to contracts (contact_id, account_id, invoice_id, payment_type)',
    stmts: [
      `ALTER TABLE contracts ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id);`,
      `ALTER TABLE contracts ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id);`,
      `ALTER TABLE contracts ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES payments(id);`,
      `ALTER TABLE contracts ADD COLUMN IF NOT EXISTS payment_type payment_type_enum;`,
    ],
  },
  {
    name: '5. Add is_primary flag to account_contacts + services_bundle_detail JSONB to accounts',
    stmts: [
      `ALTER TABLE account_contacts ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;`,
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS services_bundle_detail jsonb;`,
    ],
  },
  {
    name: '6. Add unique partial indexes (block contract double-submit, enforce one primary per account)',
    stmts: [
      // Postgres requires index expressions to be immutable; use a GENERATED
      // STORED column for the date part of signed_at so the unique index has
      // something deterministic to key on.
      `ALTER TABLE contracts ADD COLUMN IF NOT EXISTS signed_on date
         GENERATED ALWAYS AS ((signed_at AT TIME ZONE 'UTC')::date) STORED;`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_contracts_offer_contact_signed
         ON contracts (offer_token, contact_id, signed_on)
         WHERE offer_token IS NOT NULL AND contact_id IS NOT NULL AND signed_on IS NOT NULL;`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_account_contacts_primary
         ON account_contacts (account_id)
         WHERE is_primary = true;`,
    ],
  },
  {
    name: '7. Add transitional CHECK on payments.installment (accepts new 6 values + legacy)',
    stmts: [
      `ALTER TABLE payments DROP CONSTRAINT IF EXISTS ck_payments_installment_transitional;`,
      `ALTER TABLE payments ADD CONSTRAINT ck_payments_installment_transitional
         CHECK (
           installment IS NULL OR installment IN (
             'Setup Fee','Installment 1 (Jan)','Installment 2 (Jun)',
             'Annual Payment','One-Time Service','Custom',
             'One-Time','One-time','ITIN'
           )
         );`,
    ],
  },
  {
    name: '8. Data: normalize role casing (owner->Owner, member->Member) + backfill contract_type on 12 service_catalog rows + backfill subject_type on existing offers',
    stmts: [
      `UPDATE account_contacts SET role = 'Owner'  WHERE role = 'owner';`,
      `UPDATE account_contacts SET role = 'Member' WHERE role = 'member';`,
      // service_catalog: contract_type = slug for the 12 null rows
      `UPDATE service_catalog SET contract_type = slug WHERE contract_type IS NULL AND slug IN (
         'additional_service','annual_renewal','banking','certificate_of_incumbency',
         'closure','cmra','consulting','ein','first_installment','public_notary',
         'second_installment','service_fee','shipping'
       );`,
      // offers: if has account_id -> 'account'; elif has lead_id -> 'contact'; else leave NULL for manual review
      `UPDATE offers SET subject_type = 'account'::subject_type_enum WHERE subject_type IS NULL AND account_id IS NOT NULL;`,
      `UPDATE offers SET subject_type = 'contact'::subject_type_enum WHERE subject_type IS NULL AND account_id IS NULL AND lead_id IS NOT NULL;`,
    ],
  },
];

(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  if (!url.includes('xjcxlmlpeywtwkhstjlw')) {
    console.error('REFUSED: not sandbox (' + url + ')'); process.exit(2);
  }

  console.log(APPLY ? 'APPLY MODE — writing to sandbox' : 'DRY-RUN — no writes');
  console.log('===========================================');
  for (const section of sections) {
    console.log('\n-- ' + section.name);
    for (const s of section.stmts) {
      const oneLine = s.replace(/\s+/g, ' ').trim();
      console.log('   ' + oneLine.substring(0, 180) + (oneLine.length > 180 ? '...' : ''));
    }
  }

  if (!APPLY) { await c.end(); console.log('\n(dry-run complete)'); return; }

  // apply mode
  for (const section of sections) {
    console.log('\n▶ ' + section.name);
    try {
      if (section.enumExpansion) {
        // ALTER TYPE ... ADD VALUE cannot run inside a multi-statement txn
        for (const s of section.stmts) {
          await c.query(s);
          console.log('  ✓ ' + s.replace(/\s+/g, ' ').trim().substring(0, 80));
        }
      } else {
        await c.query('BEGIN');
        for (const s of section.stmts) {
          await c.query(s);
        }
        await c.query('COMMIT');
        console.log('  ✓ section committed (' + section.stmts.length + ' stmt)');
      }
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch {}
      console.error('  ✗ FAIL: ' + e.message);
      process.exit(1);
    }
  }

  // verification
  console.log('\n=== VERIFICATION ===');
  const checks = [
    { label: 'subject_type_enum exists', q: "SELECT 1 FROM pg_type WHERE typname='subject_type_enum'" },
    { label: 'payment_type_enum exists', q: "SELECT 1 FROM pg_type WHERE typname='payment_type_enum'" },
    { label: 'billing_type has 6 values', q: "SELECT COUNT(*) n FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='billing_type'" },
    { label: 'offers.subject_type column',  q: "SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='subject_type'" },
    { label: 'offers.contact_id column',    q: "SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='contact_id'" },
    { label: 'contracts.contact_id',        q: "SELECT 1 FROM information_schema.columns WHERE table_name='contracts' AND column_name='contact_id'" },
    { label: 'contracts.account_id',        q: "SELECT 1 FROM information_schema.columns WHERE table_name='contracts' AND column_name='account_id'" },
    { label: 'contracts.invoice_id',        q: "SELECT 1 FROM information_schema.columns WHERE table_name='contracts' AND column_name='invoice_id'" },
    { label: 'contracts.payment_type',      q: "SELECT 1 FROM information_schema.columns WHERE table_name='contracts' AND column_name='payment_type'" },
    { label: 'account_contacts.is_primary', q: "SELECT 1 FROM information_schema.columns WHERE table_name='account_contacts' AND column_name='is_primary'" },
    { label: 'accounts.services_bundle_detail', q: "SELECT 1 FROM information_schema.columns WHERE table_name='accounts' AND column_name='services_bundle_detail'" },
    { label: 'contracts double-submit index', q: "SELECT 1 FROM pg_indexes WHERE indexname='uq_contracts_offer_contact_signed'" },
    { label: 'account_contacts primary index', q: "SELECT 1 FROM pg_indexes WHERE indexname='uq_account_contacts_primary'" },
    { label: 'payments installment CHECK',   q: "SELECT 1 FROM pg_constraint WHERE conname='ck_payments_installment_transitional'" },
  ];
  for (const ch of checks) {
    const r = await c.query(ch.q);
    if (ch.label.includes('6 values')) {
      console.log('  ' + (r.rows[0].n === '6' ? '✓' : '✗') + ' ' + ch.label + ' (got ' + r.rows[0].n + ')');
    } else {
      console.log('  ' + (r.rows.length ? '✓' : '✗') + ' ' + ch.label);
    }
  }

  const scRemaining = await c.query(`SELECT COUNT(*)::int n FROM service_catalog WHERE active=true AND contract_type IS NULL`);
  console.log('  service_catalog rows still missing contract_type: ' + scRemaining.rows[0].n);

  const ofSubject = await c.query(`SELECT subject_type::text, COUNT(*)::int n FROM offers GROUP BY subject_type ORDER BY 2 DESC`);
  console.log('  offers.subject_type distribution:');
  for (const r of ofSubject.rows) console.log('    ' + (r.subject_type || '(null)') + ': ' + r.n);

  const roleDist = await c.query(`SELECT role, COUNT(*)::int n FROM account_contacts WHERE role IN ('owner','Owner','member','Member') GROUP BY role ORDER BY 2 DESC`);
  console.log('  account_contacts role casing after normalize:');
  for (const r of roleDist.rows) console.log('    ' + r.role + ': ' + r.n);

  await c.end();
  console.log('\nPhase 1 migration complete.');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
