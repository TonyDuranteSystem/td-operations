#!/usr/bin/env node
/**
 * Phase 2 area 2 APPLY — account_contacts.is_primary backfill.
 *
 * Scope: account_type='Client' AND status NOT IN ('Cancelled','Closed') ONLY.
 *   (Partner and One-Time accounts are excluded; they need a different pass.)
 *
 * Rules:
 *   - 210 accounts with exactly 1 contact → that contact gets is_primary=true (auto)
 *   - 19 accounts with 2+ contacts → use the explicit EXPLICIT_PRIMARY map below,
 *     which comes from Antonio's review of the corrected Excel on 2026-04-20
 *   - 2 accounts with 0 contacts → skipped (nothing to mark)
 *
 * Match strategy for multi-contact accounts:
 *   EXPLICIT_PRIMARY lists company_name → primary_hint. The hint may be a full
 *   name ("Andrea Bosco"), a first name ("Bence"), or a variant ("Boris" for
 *   "Borisz Diera"). We match case-insensitively by prefix against the contacts
 *   on that account. If exactly one contact matches, use it; else raise.
 *
 * All writes in ONE transaction.
 * Usage:
 *   node scripts/sandbox-seed/24-phase2b-primary-contact-apply.js           # dry-run
 *   node scripts/sandbox-seed/24-phase2b-primary-contact-apply.js --apply
 */

require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');

const EXPLICIT_PRIMARY = {
  'B&P International LLC':         'Andrea Bosco',
  'Conversion Monsters LLC':       'Marcello Faglia',
  'Datavora LLC':                  'Massimo Grilletta',
  'Imperium Commerce LLC':         'Bence',
  'KS Media Consulting LLC':       'Botond',
  'Magic Scale LLC':               'Yanin',
  'MushBrew LLC':                  'Peter Czegle',
  'Nebroo LLC':                    'Giovanni',
  'Nova Ratio Investment LLC':     'Auralba',
  'PTBT Holding LLC':              'Mark Eke',
  'Rise Communications LLC':       'Aly Sayed',
  'SD Studio LLC':                 'Selene',
  'Stepwell Dynamics LLC':         'Mohamed Hassan Mahmoud Kosba',
  'THW Global LLC':                'Peter Zelenyanszki',
  'TITAN REAL ESTATE GROUP LLC':   'Gabriele',
  'Terra Prime Development LLC':   'Arturo',
  'Virtus Commerce LLC':           'Balint',
  'WSCP LLC':                      'Carmine',
  'Zhang Holding LLC':             'Boris',
};

function matchHint(hint, contactNames) {
  const hl = hint.toLowerCase();
  // 1. Prefix match
  let hits = contactNames.filter(n => (n || '').toLowerCase().startsWith(hl));
  if (hits.length === 1) return hits[0];
  // 2. Substring match (catches "Hassan Mahmoud Kosba" inside "Mohamed Mohamed Hassan Mahmoud Kosba")
  hits = contactNames.filter(n => (n || '').toLowerCase().includes(hl));
  if (hits.length === 1) return hits[0];
  // 3. Match first 5 chars of hint as substring (catches "Boris" in "Borisz")
  hits = contactNames.filter(n => (n || '').toLowerCase().includes(hl.slice(0, Math.min(hl.length, 5))));
  if (hits.length === 1) return hits[0];
  return null;
}

(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  if (!url.includes('xjcxlmlpeywtwkhstjlw')) { console.error('REFUSED: not sandbox.'); process.exit(2); }

  const r = await c.query(`
    SELECT a.id AS account_id, a.company_name,
           json_agg(json_build_object('contact_id', c.id, 'name', c.full_name) ORDER BY c.full_name) AS contacts
    FROM accounts a
    JOIN account_contacts ac ON ac.account_id = a.id
    JOIN contacts c ON c.id = ac.contact_id
    WHERE a.account_type = 'Client' AND a.status NOT IN ('Cancelled','Closed')
    GROUP BY a.id, a.company_name
  `);

  const planned = [];
  const errors = [];
  for (const row of r.rows) {
    const contacts = row.contacts;
    if (contacts.length === 1) {
      planned.push({ account_id: row.account_id, company: row.company_name, primary: contacts[0] });
    } else {
      const hint = EXPLICIT_PRIMARY[row.company_name];
      if (!hint) {
        errors.push({ company: row.company_name, reason: 'multi-contact with no explicit pick', contacts: contacts.map(c=>c.name).join(' / ') });
        continue;
      }
      const names = contacts.map(c => c.name);
      const matched = matchHint(hint, names);
      if (!matched) {
        errors.push({ company: row.company_name, reason: `hint '${hint}' did not match any of: ${names.join(' / ')}`, contacts: names.join(' / ') });
        continue;
      }
      const picked = contacts.find(c => c.name === matched);
      planned.push({ account_id: row.account_id, company: row.company_name, primary: picked, hint });
    }
  }

  console.log(APPLY ? 'APPLY' : 'DRY-RUN');
  console.log('=====================================');
  console.log(`planned writes: ${planned.length}`);
  console.log(`match errors:   ${errors.length}`);
  if (errors.length) {
    console.log('\nERRORS — will NOT write these:');
    for (const e of errors) console.log('  ' + e.company.padEnd(40) + ' — ' + e.reason);
  }
  const multi = planned.filter(p => p.hint);
  console.log(`\nmulti-contact resolved (${multi.length}):`);
  for (const p of multi) console.log('  ' + p.company.padEnd(40) + ' → ' + p.primary.name + ' (hint: ' + p.hint + ')');
  const singleCount = planned.length - multi.length;
  console.log(`\nsingle-contact auto: ${singleCount}`);

  if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); await c.end(); return; }

  await c.query('BEGIN');
  try {
    for (const p of planned) {
      await c.query(
        `UPDATE account_contacts SET is_primary = true WHERE account_id = $1 AND contact_id = $2`,
        [p.account_id, p.primary.contact_id]
      );
    }
    await c.query('COMMIT');
    console.log(`\nCOMMIT — wrote is_primary=true on ${planned.length} rows.`);
  } catch (e) {
    await c.query('ROLLBACK'); console.error('ROLLBACK — FAIL:', e.message); process.exit(1);
  }
  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
