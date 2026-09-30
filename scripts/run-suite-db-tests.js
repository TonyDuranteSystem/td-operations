#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Runs the suite-lock database tests (scripts/sql-tests/suite/*.sql) against the SANDBOX database.
 * Each file opens a transaction, records checks in a temp table and never commits (the connection closes = rollback).
 * Refuses to run against production. Exit code 1 if any check fails.
 *
 *   node scripts/run-suite-db-tests.js
 */
const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') })
const { Client } = require('pg')

const PROD_REF = 'ydzipybqeebtpcvsbtvs'
const SANDBOX_REF = 'xjcxlmlpeywtwkhstjlw'
const url = process.env.SUPABASE_DB_URL
if (!url) { console.error('SUPABASE_DB_URL is not set'); process.exit(2) }
if (url.includes(PROD_REF) || !url.includes(SANDBOX_REF)) { console.error('REFUSED: these tests run against the sandbox database only'); process.exit(2) }

const dir = path.join(__dirname, 'sql-tests', 'suite')
;(async () => {
  let failures = 0
  let total = 0
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
    await c.connect()
    try {
      const res = await c.query(fs.readFileSync(path.join(dir, file), 'utf8'))
      const last = Array.isArray(res) ? res[res.length - 1] : res
      const bad = last.rows.filter(r => !r.ok)
      total += last.rows.length
      failures += bad.length
      console.log(`${file}: ${last.rows.length} checks, ${bad.length} failing`)
      for (const b of bad) console.log(`   FAIL ${b.test} — ${b.info}`)
    } catch (e) {
      failures += 1
      console.log(`${file}: ERROR ${e.message}`)
    } finally {
      await c.end() // uncommitted transaction is rolled back
    }
  }
  console.log(`${total} checks, ${failures} failure(s)`)
  process.exit(failures ? 1 : 0)
})()
