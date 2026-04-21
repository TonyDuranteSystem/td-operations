#!/usr/bin/env node
/**
 * Daily sandbox refresh orchestrator.
 *
 * Runs every night via GitHub Actions (.github/workflows/sandbox-refresh.yml)
 * so sandbox stays within 24h of production. After refresh sandbox is a
 * near-clone of prod PLUS the sandbox-only extras (uniform test auth users,
 * observability trigger).
 *
 * Sequence (fail-fast — any step failure aborts the rest):
 *   1. 05-full-clone.js            — row-level prod → sandbox (upsert)
 *   2. 03-create-auth-users.js     — re-seed test auth users (idempotent)
 *   3. _apply-tax-returns-observability.js — re-apply sandbox DDL
 *
 * Safety checks up-front:
 *   - Both .env.local and .env.sandbox must exist
 *   - Sandbox env ref MUST be xjcxlmlpeywtwkhstjlw (never run against prod)
 *   - Prod env URL MUST be ydzipybqeebtpcvsbtvs (never clone FROM sandbox)
 *
 * No summary email — failure is signalled by non-zero exit, which shows as
 * red in GitHub Actions and triggers GitHub's own failure notification.
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '../..')
const SANDBOX_ENV = path.join(ROOT, '.env.sandbox')
const PROD_ENV = path.join(ROOT, '.env.local')

const EXPECTED_SANDBOX_REF = 'xjcxlmlpeywtwkhstjlw'
const EXPECTED_PROD_REF = 'ydzipybqeebtpcvsbtvs'

function assertEnv() {
  if (!fs.existsSync(SANDBOX_ENV)) {
    throw new Error('.env.sandbox is missing — aborting to avoid running against prod')
  }
  if (!fs.existsSync(PROD_ENV)) {
    throw new Error('.env.local is missing — orchestrator needs prod URL + service-role key for the clone source')
  }

  const sb = fs.readFileSync(SANDBOX_ENV, 'utf8')
  const sbRef = sb.match(/EXPECTED_SUPABASE_REF="([^"]+)"/)?.[1]
  const sbUrl = sb.match(/NEXT_PUBLIC_SUPABASE_URL="([^"]+)"/)?.[1] || ''
  if (sbRef !== EXPECTED_SANDBOX_REF || !sbUrl.includes(EXPECTED_SANDBOX_REF)) {
    throw new Error(
      `Sandbox env does not target ${EXPECTED_SANDBOX_REF} (got ref="${sbRef}", url="${sbUrl}") — refusing to run`
    )
  }

  const prod = fs.readFileSync(PROD_ENV, 'utf8')
  const prodUrl =
    prod.match(/SUPABASE_URL="([^"]+)"/)?.[1] ||
    prod.match(/NEXT_PUBLIC_SUPABASE_URL="([^"]+)"/)?.[1] ||
    ''
  if (!prodUrl.includes(EXPECTED_PROD_REF)) {
    throw new Error(
      `Prod env does not target ${EXPECTED_PROD_REF} (got "${prodUrl}") — refusing to run`
    )
  }

  return { sandboxRef: sbRef, prodUrl }
}

function runStep(label, file, extraEnv = {}) {
  const line = '─'.repeat(40)
  console.log(`\n${line}\n[step] ${label}\n${line}`)
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
  if (r.status !== 0) {
    throw new Error(`${label} failed with exit code ${r.status}`)
  }
}

async function main() {
  const start = Date.now()
  console.log('\n=== sandbox daily refresh ===')
  console.log('started:', new Date().toISOString())

  const { sandboxRef, prodUrl } = assertEnv()
  console.log(`  prod URL:    ${prodUrl}`)
  console.log(`  sandbox ref: ${sandboxRef}`)

  runStep('1/3 clone prod → sandbox', '05-full-clone.js')
  runStep('2/3 re-seed sandbox auth users', '03-create-auth-users.js')
  runStep('3/3 re-apply sandbox DDL (tax_returns observability)', '_apply-tax-returns-observability.js')

  const elapsedSec = Math.round((Date.now() - start) / 1000)
  console.log(`\n=== refresh complete in ${elapsedSec}s ===`)
}

main().catch((e) => {
  console.error('\n[refresh] FAILED:', e.message)
  process.exit(1)
})
