#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

const env = fs.readFileSync(path.resolve(__dirname, '../../.env.sandbox'), 'utf8')
const URL = env.match(/SUPABASE_DB_URL="([^"]+)"/)[1]

;(async () => {
  const client = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  const r = await client.query("SELECT policyname, cmd FROM pg_policies WHERE tablename = 'audit_flags' ORDER BY policyname")
  console.log('RLS policies:', JSON.stringify(r.rows, null, 2))
  await client.end()
})()
