#!/usr/bin/env node
/**
 * Boots `next dev` on port 3001 with the sandbox environment loaded from
 * .env.sandbox. Leaves prod .env.local untouched. Keeps the two worlds
 * visibly separate — sandbox = 3001.
 *
 * Temp companion to the Titan Real Estate tax-return investigation
 * (2026-04-21). Not part of the seed chain. Safe to delete once the
 * investigation is closed.
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const envPath = path.resolve(__dirname, '../../.env.sandbox')
const raw = fs.readFileSync(envPath, 'utf8')

const parsed = {}
for (const line of raw.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const m = trimmed.match(/^([A-Z0-9_]+)=("?)(.*)\2$/)
  if (!m) continue
  parsed[m[1]] = m[3]
}

const env = {
  ...process.env,
  ...parsed,
  PORT: '3001',
  NODE_ENV: 'development',
}

console.log('Booting next dev on :3001 with sandbox env...')
console.log('  Supabase ref:', env.EXPECTED_SUPABASE_REF)
console.log('  SANDBOX_MODE:', env.SANDBOX_MODE)

const next = spawn(
  path.resolve(__dirname, '../../node_modules/.bin/next'),
  ['dev', '-p', '3001'],
  { cwd: path.resolve(__dirname, '../..'), env, stdio: 'inherit' }
)
next.on('exit', (code) => process.exit(code ?? 0))
