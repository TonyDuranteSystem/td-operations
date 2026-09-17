// One-time seed: adds the "Shipping Address" registry row (dev job 254834cc,
// 2026-09-16). Values below are a point-in-time copy of `TD_OFFICE` in
// lib/td-address.ts (the single source of truth for this physical address) —
// this is a one-time data seed, not application code, so it is intentionally
// outside tests/unit/td-address-single-source.test.ts's scanned paths (same
// treatment that file already gives scripts/sandbox-seed/, for the same
// reason: a seed script runs once and becomes a stored row, it does not
// keep re-reading the constant). If TD's office address ever changes, this
// row is corrected the same way any other addresses row is — by editing it
// in the CRM, not by re-running this script.
//
// Deliberately a NEW, separate row — the existing row at this same physical
// address (id bae4b77d-7b8b-4f90-8a24-201def918acb, kind='business_mailing')
// is untouched, so the 28 accounts already linked to it, and the lease
// system's own address-matching, are unaffected.
//
// Usage: node scripts/seed-shipping-address.js
// Safe to re-run: skips silently if a kind='shipping' row already exists.

const { Client } = require("pg")

async function main() {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    const existing = await client.query(`SELECT id FROM addresses WHERE kind = 'shipping' LIMIT 1`)
    if (existing.rows.length > 0) {
      console.log(`Already seeded — kind='shipping' row exists: ${existing.rows[0].id}`)
      return
    }
    const result = await client.query(
      `INSERT INTO addresses (kind, name, is_td_provided, active, address_line1, address_line2, city, state, zip, country)
       VALUES ('shipping', 'TD Shipping Address', true, true, $1, $2, $3, $4, $5, $6)
       RETURNING id`,
      ["11125 Park Blvd", "Suite 104-153", "Seminole", "FL", "33772", "US"],
    )
    console.log(`Seeded shipping address row: ${result.rows[0].id}`)
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message)
  process.exit(1)
})
