#!/usr/bin/env node
/**
 * Apply bulk-park to sandbox — flip eligible Tax Return SDs from active → on_hold.
 *
 * Same eligibility logic as 08-bulk-park-dryrun.js:
 *   WILL PARK = Client account, SD active, extension_filed=true, account not Closed,
 *               tax_returns.status is pre-data-receipt, SD stage is 1st-Installment-Paid
 *               or Extension Filed.
 *
 * Sandbox only. Never run against production.
 *
 * Usage:
 *   node scripts/sandbox-seed/12-apply-bulk-park.js           # dry run (list WILL PARK rows, no writes)
 *   node scripts/sandbox-seed/12-apply-bulk-park.js --apply   # writes status=on_hold on each eligible SD
 */

require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');

const ALLOWED_TR_STATUS = new Set(['Activated - Need Link', 'Link Sent - Awaiting Data', 'Extension Filed']);
const ALLOWED_SD_STAGE = new Set(['1st Installment Paid', 'Extension Filed']);

(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // Safety net: confirm we're on sandbox
  const whoami = await c.query(`SELECT current_database() AS db, inet_server_addr() AS host`);
  console.log(`Connected to: ${whoami.rows[0].db} @ ${whoami.rows[0].host}`);
  const ref = (process.env.EXPECTED_SUPABASE_REF || '').trim();
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  if (!url.includes('xjcxlmlpeywtwkhstjlw') || ref !== 'xjcxlmlpeywtwkhstjlw') {
    console.error('REFUSED: this script must run against sandbox (xjcxlmlpeywtwkhstjlw). Got:', url, ref);
    process.exit(2);
  }

  const sds = await c.query(`
    SELECT
      sd.id                        AS sd_id,
      sd.stage,
      sd.status,
      sd.account_id,
      a.company_name,
      a.account_type,
      a.status                     AS acct_status,
      tr.status                    AS tr_status,
      tr.extension_filed,
      tr.extension_submission_id
    FROM service_deliveries sd
    LEFT JOIN accounts a      ON a.id = sd.account_id
    LEFT JOIN LATERAL (
      SELECT status, extension_filed, extension_submission_id
      FROM tax_returns
      WHERE account_id = sd.account_id
      ORDER BY tax_year DESC
      LIMIT 1
    ) tr ON TRUE
    WHERE sd.service_type = 'Tax Return' AND sd.status = 'active'
  `);

  const toPark = [];
  for (const r of sds.rows) {
    if (!r.account_id) continue; // orphan
    if (r.account_type !== 'Client') continue;
    if (r.acct_status === 'Closed') continue;
    if (r.tr_status === 'TR Filed') continue;
    if (!r.extension_filed) continue;
    if (!ALLOWED_TR_STATUS.has(r.tr_status)) continue;
    if (!ALLOWED_SD_STAGE.has(r.stage)) continue;
    toPark.push(r);
  }

  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} — ${toPark.length} SDs will flip to on_hold`);
  for (const r of toPark) {
    console.log(`  ${r.company_name.padEnd(42)}  stage=${r.stage.padEnd(22)}  ${r.tr_status.padEnd(22)}  ext=${r.extension_submission_id}`);
  }

  if (APPLY && toPark.length) {
    const ids = toPark.map(r => r.sd_id);
    const res = await c.query(
      `UPDATE service_deliveries SET status = 'on_hold', updated_at = now() WHERE id = ANY($1::uuid[]) RETURNING id`,
      [ids]
    );
    console.log(`\nParked ${res.rows.length} SDs.`);
  } else if (!APPLY) {
    console.log('\nDry run complete. Re-run with --apply to write.');
  }

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
