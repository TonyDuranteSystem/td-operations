require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  await c.connect();

  // 1) auth users snapshot — count + admin-ish emails
  const total = await c.query('SELECT COUNT(*)::int AS n FROM auth.users');
  console.log('auth.users total:', total.rows[0].n);

  // 2) look for admin-flavored emails (typical patterns)
  const admins = await c.query(`
    SELECT email, created_at, last_sign_in_at
    FROM auth.users
    WHERE email ILIKE ANY (ARRAY[
      '%tonydurante%','%@tonydurante.us%','%admin%','%support@%','%antonio%','%luca%'
    ])
    ORDER BY created_at DESC
    LIMIT 25
  `);
  console.log('--- admin-flavored auth users ---');
  for (const r of admins.rows) console.log(' ', r.email, '| last login:', r.last_sign_in_at);

  // 3) contacts with portal_tier=admin or role indicating staff
  const tiers = await c.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='contacts' AND column_name IN ('portal_tier','role','user_id','is_staff','is_admin')
  `);
  console.log('--- contacts role-ish cols present ---');
  for (const r of tiers.rows) console.log(' ', r.column_name);

  // 4) unique portal_tier values
  try {
    const t = await c.query(`SELECT portal_tier, COUNT(*)::int AS n FROM contacts GROUP BY portal_tier ORDER BY 2 DESC LIMIT 20`);
    console.log('--- contacts.portal_tier distribution ---');
    for (const r of t.rows) console.log(' ', JSON.stringify(r.portal_tier), r.n);
  } catch (e) {
    console.log('(portal_tier query skipped:', e.message, ')');
  }

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
