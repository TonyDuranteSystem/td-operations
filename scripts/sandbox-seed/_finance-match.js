// Match /tmp/finance-rows.json companies against sandbox accounts.
// Normalized name comparison. Reports matched/unmatched. No writes.

require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');
const fs = require('fs');

const norm = (s) => (s || '').toLowerCase().replace(/l\.l\.c\.?/g, 'llc').replace(/[^a-z0-9]/g, '');

(async () => {
  const rows = JSON.parse(fs.readFileSync('/tmp/finance-rows.json', 'utf8'));
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const acc = await c.query(`
    SELECT id, company_name, ein_number, status, account_type
    FROM accounts
    WHERE account_type IN ('Client','Managed','One-Time') OR account_type IS NULL
  `);

  const byNormName = new Map();
  for (const a of acc.rows) {
    byNormName.set(norm(a.company_name), a);
  }

  const matched = [];
  const unmatched = [];
  for (const r of rows) {
    const key = norm(r.company);
    const hit = byNormName.get(key);
    if (hit) {
      matched.push({
        company: r.company,
        amount: r.amount,
        paid_status: r.paid_status,
        sandbox_account_id: hit.id,
        sandbox_name: hit.company_name,
        sandbox_status: hit.status,
        sandbox_account_type: hit.account_type,
      });
    } else {
      unmatched.push({ company: r.company, amount: r.amount, paid_status: r.paid_status });
    }
  }

  fs.writeFileSync('/tmp/finance-match.json', JSON.stringify({ matched, unmatched }, null, 2));
  console.log(`matched:   ${matched.length}`);
  console.log(`unmatched: ${unmatched.length}`);
  if (unmatched.length) {
    console.log('\n=== UNMATCHED ===');
    for (const r of unmatched) console.log(`  ${r.company!=null?r.company:'(null)'}   amount=${r.amount}   status=${r.paid_status}`);
  }
  // matched distribution by sandbox_account_type + sandbox_status
  const dist = {};
  for (const m of matched) {
    const k = `${m.sandbox_account_type}|${m.sandbox_status}`;
    dist[k] = (dist[k] || 0) + 1;
  }
  console.log('\n=== matched distribution (sandbox account_type | status) ===');
  for (const [k,v] of Object.entries(dist).sort((a,b)=>b[1]-a[1])) console.log(`  ${v}  ${k}`);

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
