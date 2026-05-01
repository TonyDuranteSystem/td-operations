#!/usr/bin/env node
/**
 * Apply a DDL migration file to the SANDBOX database.
 *
 * Usage:
 *   node scripts/apply-migration.js scripts/migrations/20260430-1200-add-audit-flags.sql
 *
 * The script:
 *   1. Reads SUPABASE_DB_URL from .env.local
 *   2. Blocks if the URL points to production (ydzipybqeebtpcvsbtvs)
 *   3. Executes the SQL file against sandbox
 *   4. Prints the execute_sql command to promote to production
 *
 * After sandbox QA passes, Antonio promotes to production via:
 *   execute_sql(query: "<sql>", mode: "write", reason: "migration:<filename>")
 */

require('dotenv').config({ path: '.env.local' })
const { Client } = require('pg')
const fs = require('fs')
const path = require('path')

const PROD_REF = 'ydzipybqeebtpcvsbtvs'
const SANDBOX_REF = 'xjcxlmlpeywtwkhstjlw'

const sqlFile = process.argv[2]
if (!sqlFile) {
  console.error('Usage: node scripts/apply-migration.js <path-to-sql-file>')
  console.error('Example: node scripts/apply-migration.js scripts/migrations/20260430-1200-description.sql')
  process.exit(1)
}

const sqlFilePath = path.resolve(sqlFile)
if (!fs.existsSync(sqlFilePath)) {
  console.error(`File not found: ${sqlFilePath}`)
  process.exit(1)
}

const dbUrl = process.env.SUPABASE_DB_URL
if (!dbUrl) {
  console.error('SUPABASE_DB_URL not found in .env.local')
  console.error('Fix: bash scripts/dev-setup.sh')
  process.exit(1)
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
if (supabaseUrl.includes(PROD_REF) || dbUrl.includes(PROD_REF)) {
  console.error('⛔ REFUSED: .env.local points to PRODUCTION database.')
  console.error('Fix: bash scripts/dev-setup.sh')
  process.exit(2)
}

if (!supabaseUrl.includes(SANDBOX_REF) && !dbUrl.includes(SANDBOX_REF)) {
  console.error('⛔ REFUSED: Cannot confirm sandbox ref. Expected ' + SANDBOX_REF)
  console.error('Fix: bash scripts/dev-setup.sh')
  process.exit(2)
}

const sql = fs.readFileSync(sqlFilePath, 'utf8').trim()
if (!sql) {
  console.error('SQL file is empty.')
  process.exit(1)
}

const filename = path.basename(sqlFilePath)

;(async () => {
  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await client.connect()

  console.log(`\nApplying migration to SANDBOX: ${filename}`)
  console.log('─'.repeat(60))
  console.log(sql)
  console.log('─'.repeat(60))

  try {
    await client.query(sql)
    console.log(`\n✅ Migration applied to sandbox successfully.\n`)
    console.log('To promote to production after QA, run execute_sql with:')
    console.log(`  query: ${JSON.stringify(sql)}`)
    console.log(`  mode: "write"`)
    console.log(`  reason: "migration:${filename}"`)
    console.log()
  } catch (err) {
    console.error(`\n❌ Migration failed: ${err.message}`)
    process.exit(1)
  } finally {
    await client.end()
  }
})()
