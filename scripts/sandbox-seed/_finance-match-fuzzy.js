// Fuzzy second pass for rows the Numbers export mangled with ligature substitution.
// Applies known replacements and re-matches the 10 unmatched.

require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');
const fs = require('fs');

const norm = (s) => (s || '').toLowerCase().replace(/l\.l\.c\.?/g, 'llc').replace(/[^a-z0-9]/g, '');

// ligature-loss substitutions Apple Numbers applied on export
function decode(s) {
  // Try all combinations of substitutions and return candidates
  const raw = s;
  const variants = new Set([raw]);
  // replace '8' with 'ti'
  variants.add(raw.replace(/8/g, 'ti'));
  // replace '3' with 'ft'
  variants.add(raw.replace(/3/g, 'ft'));
  // replace 'ee' with 'tt' in Italian names like Matteo
  variants.add(raw.replace(/ee/g, 'tt'));
  // combination — ee+8
  variants.add(raw.replace(/8/g, 'ti').replace(/ee/g, 'tt'));
  // 8+3
  variants.add(raw.replace(/8/g, 'ti').replace(/3/g, 'ft'));
  return [...variants];
}

(async () => {
  const full = JSON.parse(fs.readFileSync('/tmp/finance-match.json', 'utf8'));
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const acc = await c.query(`SELECT id, company_name, ein_number, status, account_type FROM accounts`);
  const byNorm = new Map();
  for (const a of acc.rows) byNorm.set(norm(a.company_name), a);
  const normNames = [...byNorm.keys()];

  const recovered = [];
  const stillMissing = [];

  for (const r of full.unmatched) {
    const candidates = decode(r.company);
    let hit = null;
    for (const cand of candidates) {
      const h = byNorm.get(norm(cand));
      if (h) { hit = h; break; }
    }
    if (!hit) {
      // try LIKE fallback on company_name
      const likeKey = norm(r.company).replace(/8/g, '').replace(/3/g, '').replace(/ee/g, '');
      const match = normNames.filter(n => n.includes(likeKey) && Math.abs(n.length - likeKey.length) < 5);
      if (match.length === 1) hit = byNorm.get(match[0]);
    }
    if (hit) {
      recovered.push({
        xlsx_company: r.company,
        sandbox_name: hit.company_name,
        sandbox_account_id: hit.id,
        sandbox_status: hit.status,
        sandbox_account_type: hit.account_type,
        amount: r.amount,
        paid_status: r.paid_status,
      });
    } else {
      stillMissing.push(r);
    }
  }

  console.log(`recovered: ${recovered.length}`);
  for (const x of recovered) {
    console.log(`  ${x.xlsx_company.padEnd(42)}  =>  ${x.sandbox_name.padEnd(42)}  ${x.sandbox_account_type}|${x.sandbox_status}`);
  }
  console.log(`\nstill missing: ${stillMissing.length}`);
  for (const x of stillMissing) console.log(`  ${x.company}   amount=${x.amount}   status=${x.paid_status}`);

  // also surface the Closed/Offboarding edge cases from the original matched set
  const edge = full.matched.filter(m => m.sandbox_status !== 'Active');
  console.log(`\nedge-case matched (non-Active): ${edge.length}`);
  for (const e of edge) console.log(`  ${e.sandbox_name.padEnd(42)}  status=${e.sandbox_status}   paid_status=${e.paid_status}   amount=${e.amount}`);

  // write merged result
  const finalMatched = [...full.matched, ...recovered];
  fs.writeFileSync('/tmp/finance-match-final.json', JSON.stringify({ matched: finalMatched, unmatched: stillMissing }, null, 2));
  console.log(`\nfinal matched: ${finalMatched.length}`);
  console.log(`final unmatched: ${stillMissing.length}`);

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
