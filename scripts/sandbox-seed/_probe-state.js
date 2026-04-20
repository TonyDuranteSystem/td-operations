require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  await c.connect();

  const tables = {
    offers: ['subject_type','subject_id','contact_id','account_id','lead_id'],
    contracts: ['contact_id','account_id','invoice_id','payment_type','selected_services','offer_token','signed_at'],
    service_deliveries: ['billing_type','status','is_test'],
    account_contacts: ['is_primary','role'],
    payments: ['installment']
  };
  for (const [t, cols] of Object.entries(tables)) {
    const r = await c.query(
      `SELECT column_name, udt_name FROM information_schema.columns
       WHERE table_name=$1 AND column_name = ANY($2::text[])`, [t, cols]);
    console.log(`--- ${t} ---`);
    for (const row of r.rows) console.log(' ', row.column_name, '(' + row.udt_name + ')');
    const missing = cols.filter(x => !r.rows.find(y => y.column_name === x));
    if (missing.length) console.log('  MISSING:', missing);
  }

  const sdStatus = await c.query(
    `SELECT status, COUNT(*)::int AS n FROM service_deliveries
     WHERE service_type IN ('Tax Return','tax_return') GROUP BY status ORDER BY 2 DESC`);
  console.log('--- TR SD status ---');
  for (const r of sdStatus.rows) console.log(' ', r.status, r.n);

  const btVals = await c.query(
    `SELECT billing_type, COUNT(*)::int AS n FROM service_deliveries GROUP BY billing_type ORDER BY 2 DESC`);
  console.log('--- billing_type data ---');
  for (const r of btVals.rows) console.log(' ', JSON.stringify(r.billing_type), r.n);

  const instVals = await c.query(
    `SELECT installment, COUNT(*)::int AS n FROM payments GROUP BY installment ORDER BY 2 DESC LIMIT 15`);
  console.log('--- installment data ---');
  for (const r of instVals.rows) console.log(' ', JSON.stringify(r.installment), r.n);

  const flag = await c.query(`SELECT value FROM app_settings WHERE key='tax_season_paused'`);
  console.log('--- tax_season_paused:', flag.rows[0]?.value);

  const bt = await c.query(
    `SELECT to_regclass('public.bank_referrals')::text AS t1, to_regclass('public.bank_referral_clicks')::text AS t2`);
  console.log('--- bank_referral tables:', bt.rows[0]);

  // check constraints on payments.installment
  const chk = await c.query(
    `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
     FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid JOIN pg_attribute a ON a.attrelid=rel.oid
     WHERE rel.relname='payments' AND con.contype='c' AND pg_get_constraintdef(con.oid) ILIKE '%installment%'`);
  console.log('--- payments.installment check constraints ---');
  for (const r of chk.rows) console.log(' ', r.conname, r.def);

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
