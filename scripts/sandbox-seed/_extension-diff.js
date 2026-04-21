// Compare master xlsx extension list against current sandbox state.
// Read-only. Writes no DB changes. Produces:
//   - list of sandbox rows that would gain a real ID (placeholder → real)
//   - list of sandbox rows that would flip extension_filed false→true
//   - list of xlsx companies not found in sandbox at all
//   - list of sandbox 2025 TR rows not in xlsx (possible mismatches)
//
// Input: /tmp/extension-list.json (produced by the Python xlsx reader)

require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');
const fs = require('fs');

const XLSX_JSON = process.argv[2] || '/tmp/extension-list.json';

function normEIN(v) {
  if (v == null) return null;
  return String(v).replace(/\D/g, '') || null;
}

function normName(v) {
  if (v == null) return '';
  return String(v).toLowerCase().replace(/[^a-z0-9]/g, '');
}

(async () => {
  const xlsx = JSON.parse(fs.readFileSync(XLSX_JSON, 'utf8'));
  console.log('xlsx rows:', xlsx.length);

  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // pull sandbox 2025 tax_returns + account + ein + company_name
  const sb = await c.query(`
    SELECT
      tr.id          AS tr_id,
      tr.account_id,
      tr.tax_year,
      tr.return_type,
      tr.status      AS tr_status,
      tr.extension_filed,
      tr.extension_submission_id,
      a.company_name,
      a.ein_number  AS ein,
      a.account_type
    FROM tax_returns tr
    JOIN accounts a ON a.id = tr.account_id
    WHERE tr.tax_year = 2025
  `);
  console.log('sandbox 2025 tax_returns:', sb.rows.length);

  const byEin = new Map();
  const byName = new Map();
  for (const r of sb.rows) {
    const e = normEIN(r.ein);
    if (e) byEin.set(e, r);
    byName.set(normName(r.company_name), r);
  }

  const wouldUpdate = [];   // real ID will be written
  const wouldFlip = [];     // extension_filed false→true
  const xlsxNotFound = [];  // xlsx company not in sandbox
  const sbUnmatched = new Set(sb.rows.map(r => r.tr_id));

  for (const row of xlsx) {
    const e = normEIN(row.EIN);
    const n = normName(row['Company Name']);
    const sbRow = (e && byEin.get(e)) || byName.get(n);
    if (!sbRow) {
      xlsxNotFound.push({ company: row['Company Name'], ein: row.EIN, ref: row['Ref Submission ID'], notes: row.Notes });
      continue;
    }
    sbUnmatched.delete(sbRow.tr_id);

    const currentId = sbRow.extension_submission_id;
    const realId = row['Ref Submission ID'];
    const isPlaceholder = currentId && /^EXT-SANDBOX-/.test(currentId);
    const isMissing = currentId == null || currentId === '';
    const notes = (row.Notes || '').toString().toLowerCase();
    const isPendingFiscalYear = notes.includes('pending fiscal') || notes.includes('pending fy');
    const isAlreadyFiled = notes.includes('tr filed') || notes.includes('return filed') || notes.includes('already filed');

    if (realId && realId !== currentId && !isPendingFiscalYear && !isAlreadyFiled) {
      wouldUpdate.push({
        tr_id: sbRow.tr_id,
        company: sbRow.company_name,
        ein: sbRow.ein,
        from: currentId,
        to: realId,
        placeholder: isPlaceholder,
        missing: isMissing,
        notes: row.Notes,
      });
    }
    if (!sbRow.extension_filed && !isPendingFiscalYear && !isAlreadyFiled && realId) {
      wouldFlip.push({
        tr_id: sbRow.tr_id,
        company: sbRow.company_name,
        current_filed: sbRow.extension_filed,
        notes: row.Notes,
      });
    }
  }

  const sbUnmatchedRows = sb.rows.filter(r => sbUnmatched.has(r.tr_id));

  const summary = {
    xlsx_total: xlsx.length,
    sandbox_2025_total: sb.rows.length,
    would_update_extension_id: wouldUpdate.length,
    would_flip_extension_filed: wouldFlip.length,
    xlsx_not_found_in_sandbox: xlsxNotFound.length,
    sandbox_not_in_xlsx: sbUnmatchedRows.length,
  };

  console.log('\n--- SUMMARY ---');
  console.log(JSON.stringify(summary, null, 2));

  // sample the first ~10 of each bucket
  const sample = arr => arr.slice(0, 10);
  const detail = {
    would_update_extension_id_sample: sample(wouldUpdate),
    would_flip_extension_filed_sample: sample(wouldFlip),
    xlsx_not_found_sample: sample(xlsxNotFound),
    sandbox_not_in_xlsx_sample: sample(sbUnmatchedRows.map(r => ({
      tr_id: r.tr_id, company: r.company_name, ein: r.ein, current_id: r.extension_submission_id, tr_status: r.tr_status, account_type: r.account_type
    }))),
  };
  fs.writeFileSync('/tmp/extension-diff.json', JSON.stringify({ summary, detail, wouldUpdate, wouldFlip, xlsxNotFound, sbUnmatched: sbUnmatchedRows }, null, 2));
  console.log('\nFull report → /tmp/extension-diff.json');
  console.log('\n--- DETAIL SAMPLES ---');
  console.log(JSON.stringify(detail, null, 2));

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
