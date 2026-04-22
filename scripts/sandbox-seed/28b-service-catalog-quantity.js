/**
 * Script 28b — Area A.2: Add supports_quantity to service_catalog.
 *
 * Adds a boolean flag that controls whether the Create Offer dialog shows
 * a quantity input for that service. Only ITIN Application supports
 * quantity > 1 (one per member in a multi-member LLC).
 *
 * Safe to re-run (uses ADD COLUMN IF NOT EXISTS + idempotent UPDATE).
 * Apply to sandbox first, then to prod when the full MMLLC build ships.
 */

require('dotenv').config({ path: '.env.sandbox' })
const { Client } = require('pg')

const DB_URL = process.env.SUPABASE_DB_URL
if (!DB_URL) {
  console.error('SUPABASE_DB_URL not set in .env.sandbox')
  process.exit(1)
}

async function main() {
  const client = new Client({ connectionString: DB_URL })
  await client.connect()

  try {
    await client.query('BEGIN')

    // 1. Add column
    await client.query(`
      ALTER TABLE service_catalog
      ADD COLUMN IF NOT EXISTS supports_quantity boolean NOT NULL DEFAULT false
    `)
    console.log('✅ Column supports_quantity added (or already existed)')

    // 2. Enable for ITIN Application
    const { rowCount } = await client.query(`
      UPDATE service_catalog
      SET supports_quantity = true
      WHERE name = 'ITIN Application'
        AND supports_quantity = false
    `)
    console.log(`✅ ITIN Application: supports_quantity = true (${rowCount} row updated)`)

    // 3. Verify
    const { rows } = await client.query(`
      SELECT id, name, supports_quantity
      FROM service_catalog
      WHERE supports_quantity = true
    `)
    console.log('Services with supports_quantity = true:')
    rows.forEach(r => console.log(`  - ${r.name} (${r.id})`))

    await client.query('COMMIT')
    console.log('\n✅ Script 28b complete')
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('ROLLBACK —', err.message)
    process.exit(1)
  } finally {
    await client.end()
  }
}

main()
