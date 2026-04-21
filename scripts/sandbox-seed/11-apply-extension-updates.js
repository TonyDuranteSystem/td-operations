#!/usr/bin/env node
/**
 * Apply 16 safe extension-ID updates to sandbox tax_returns.
 *
 * Source of truth: the master India xlsx at
 *   /Users/10225office/Library/CloudStorage/GoogleDrive-support@tonydurante.us/Shared drives/Tony Durante LLC/TD Clients/India Team/Extension 2025/Extension_List_2025_ALL_updated (1).xlsx
 * dumped to /tmp/extension-list.json by a Python one-liner.
 *
 * Updates are filtered by _extension-diff.js to exclude:
 *   - Flowiz Studio (xlsx Ref is a UUID, bad data — skipped)
 *   - Any "Pending fiscal year" / "TR filed" / "Rejection code" rows
 *
 * Each write also flips extension_filed=true where it's currently false.
 *
 * Usage:
 *   node scripts/sandbox-seed/11-apply-extension-updates.js           # dry run (prints the 16 row diffs, no writes)
 *   node scripts/sandbox-seed/11-apply-extension-updates.js --apply   # actually writes to sandbox
 */

require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');
const fs = require('fs');

const APPLY = process.argv.includes('--apply');
const DIFF_PATH = '/tmp/extension-diff.json';

const SKIP_COMPANIES = new Set(['Flowiz Studio LLC']);

(async () => {
  if (!fs.existsSync(DIFF_PATH)) {
    console.error(`Missing ${DIFF_PATH}. Run _extension-diff.js first.`);
    process.exit(1);
  }
  const diff = JSON.parse(fs.readFileSync(DIFF_PATH, 'utf8'));
  const updates = diff.wouldUpdate.filter(r => !SKIP_COMPANIES.has(r.company));
  const flips = new Set(diff.wouldFlip.map(r => r.tr_id));

  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} — ${updates.length} extension-ID updates to sandbox`);
  console.log(`(also flipping extension_filed=true on ${updates.filter(u => flips.has(u.tr_id)).length} of them)`);
  console.log('');

  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  let applied = 0;
  for (const u of updates) {
    const willFlip = flips.has(u.tr_id);
    const from = u.from == null ? '[null]' : u.from;
    const kind = u.placeholder ? 'placeholder' : u.missing ? 'missing' : 'real-change';
    console.log(`  ${u.company.padEnd(42)}  ${from.padEnd(48)}  ->  ${u.to.padEnd(22)}  ${kind}${willFlip ? '  (+extension_filed=true)' : ''}`);

    if (APPLY) {
      const sql = willFlip
        ? `UPDATE tax_returns SET extension_submission_id = $1, extension_filed = true, updated_at = now() WHERE id = $2`
        : `UPDATE tax_returns SET extension_submission_id = $1, updated_at = now() WHERE id = $2`;
      await c.query(sql, [u.to, u.tr_id]);
      applied++;
    }
  }

  await c.end();
  console.log('');
  console.log(APPLY ? `Applied ${applied} updates.` : 'Dry run complete. Re-run with --apply to write.');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
