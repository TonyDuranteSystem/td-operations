#!/usr/bin/env npx tsx
/* eslint-disable no-console */
/**
 * Portal Verification Test Suite
 *
 * Runs automated checks against the portal codebase to catch issues
 * BEFORE deployment. Checks: schema, configs, tier gating, wizard
 * completeness, API routes, and flow integrity.
 *
 * Usage: npx tsx tests/portal/verify-portal.ts
 * Or:    npm run test:portal
 */

import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
let passed = 0
let failed = 0
const failures: string[] = []

function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    const msg = err instanceof Error ? err.message : String(err)
    failures.push(`${name}: ${msg}`)
    console.log(`  ❌ ${name} — ${msg}`)
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf-8')
}

function fileExists(relPath: string): boolean {
  return fs.existsSync(path.join(ROOT, relPath))
}

// ─── 1. SCHEMA VERIFICATION ─────────────────────────────────

console.log('\n📋 1. Schema Verification')

test('auto-save-document uses only existing columns', () => {
  const code = readFile('lib/portal/auto-save-document.ts')
  assert(!code.includes('storage_path'), 'storage_path column does not exist in documents table')
  assert(!code.includes('storage_bucket'), 'storage_bucket column does not exist in documents table')
})

test('wizard-configs exports MEMBER_FIELDS before FORMATION_FIELDS', () => {
  const code = readFile('components/portal/wizard/wizard-configs.ts')
  const memberPos = code.indexOf('export const MEMBER_FIELDS')
  const formationPos = code.indexOf('export const FORMATION_STEPS')
  assert(memberPos > 0, 'MEMBER_FIELDS not found')
  assert(formationPos > 0, 'FORMATION_STEPS not found')
  assert(memberPos < formationPos, 'MEMBER_FIELDS must be declared BEFORE FORMATION_STEPS')
})

test('formation_submissions and onboarding_submissions table names match wizard-submit', () => {
  const code = readFile('app/api/portal/wizard-submit/route.ts')
  assert(code.includes("'formation_submissions'"), 'Must reference formation_submissions table')
  assert(code.includes("'onboarding_submissions'"), 'Must reference onboarding_submissions table')
})

// ─── 2. WIZARD CONFIG COMPLETENESS ──────────────────────────

console.log('\n📋 2. Wizard Config Completeness')

test('getWizardConfig handles all wizard types', () => {
  const code = readFile('components/portal/wizard/wizard-configs.ts')
  assert(code.includes("case 'formation':"), 'Missing formation case')
  assert(code.includes("case 'onboarding':"), 'Missing onboarding case')
  assert(code.includes("case 'tax':") || code.includes("case 'tax_return':"), 'Missing tax case')
  assert(code.includes("case 'itin':"), 'Missing itin case')
})

test('FORMATION_FIELDS has members key', () => {
  const code = readFile('components/portal/wizard/wizard-configs.ts')
  // Find FORMATION_FIELDS object and check it has members key
  const formFieldsStart = code.indexOf('export const FORMATION_FIELDS')
  const formFieldsEnd = code.indexOf('}', code.indexOf('documents:', formFieldsStart) + 50)
  const formFieldsBlock = code.substring(formFieldsStart, formFieldsEnd)
  assert(formFieldsBlock.includes('members:'), 'FORMATION_FIELDS missing members key for MMLLC')
})

test('ONBOARDING_FIELDS has members key', () => {
  const code = readFile('components/portal/wizard/wizard-configs.ts')
  const onbFieldsStart = code.indexOf('export const ONBOARDING_FIELDS')
  const onbFieldsEnd = code.indexOf('}', code.indexOf('documents:', onbFieldsStart) + 50)
  const onbFieldsBlock = code.substring(onbFieldsStart, onbFieldsEnd)
  assert(onbFieldsBlock.includes('members:'), 'ONBOARDING_FIELDS missing members key for MMLLC')
})

test('all wizard step IDs have matching field keys', () => {
  const code = readFile('components/portal/wizard/wizard-configs.ts')

  // Formation steps
  const fSteps = ['owner', 'llc', 'documents']
  for (const s of fSteps) {
    assert(code.includes(`id: '${s}'`), `Formation missing step '${s}'`)
  }

  // Onboarding steps
  const oSteps = ['owner', 'company', 'documents']
  for (const s of oSteps) {
    assert(code.includes(`id: '${s}'`), `Onboarding missing step '${s}'`)
  }

  // Tax steps
  const tSteps = ['owner', 'company', 'financials', 'documents']
  for (const s of tSteps) {
    assert(code.includes(`id: '${s}'`), `Tax missing step '${s}'`)
  }

  // ITIN steps
  const iSteps = ['personal', 'address', 'review']
  for (const s of iSteps) {
    assert(code.includes(`id: '${s}'`), `ITIN missing step '${s}'`)
  }
})

test('TAX_FIELDS has all step keys', () => {
  const code = readFile('components/portal/wizard/wizard-configs.ts')
  const taxFieldsStart = code.indexOf('export const TAX_FIELDS')
  const nextExport = code.indexOf('export const', taxFieldsStart + 1)
  const taxFieldsSection = code.substring(taxFieldsStart, nextExport > 0 ? nextExport : taxFieldsStart + 5000)
  assert(taxFieldsSection.includes('owner:'), 'TAX_FIELDS missing owner key')
  assert(taxFieldsSection.includes('company:'), 'TAX_FIELDS missing company key')
  assert(taxFieldsSection.includes('financials:'), 'TAX_FIELDS missing financials key')
  assert(taxFieldsSection.includes('documents:'), 'TAX_FIELDS missing documents key')
})

test('ITIN_FIELDS has all step keys', () => {
  const code = readFile('components/portal/wizard/wizard-configs.ts')
  const itinFieldsStart = code.indexOf('export const ITIN_FIELDS')
  const nextSection = code.indexOf('/**', itinFieldsStart + 1)
  const itinFieldsSection = code.substring(itinFieldsStart, nextSection > 0 ? nextSection : itinFieldsStart + 5000)
  assert(itinFieldsSection.includes('personal:'), 'ITIN_FIELDS missing personal key')
  assert(itinFieldsSection.includes('address:'), 'ITIN_FIELDS missing address key')
  assert(itinFieldsSection.includes('review:'), 'ITIN_FIELDS missing review key')
})

// ─── 3. TIER GATING VERIFICATION ────────────────────────────

console.log('\n📋 3. Tier Gating Verification')

test('tier-config defaults to lead (most restricted) for null tier', () => {
  const code = readFile('lib/portal/tier-config.ts')
  assert(code.includes("tier || 'lead'"), 'NULL tier must default to lead, not active')
  assert(!code.includes("tier || 'active'"), 'Must NOT default to active')
})

test('lead tier only allows: dashboard, offer, chat, profile, guide, documents', () => {
  const code = readFile('lib/portal/tier-config.ts')
  const leadStart = code.indexOf("lead: [")
  const leadEnd = code.indexOf("],", leadStart)
  const leadBlock = code.substring(leadStart, leadEnd)
  assert(leadBlock.includes("'dashboard'"), 'Lead tier missing dashboard')
  assert(leadBlock.includes("'chat'"), 'Lead tier missing chat')
  assert(leadBlock.includes("'documents'"), 'Lead tier missing documents')
  assert(!leadBlock.includes("'services'"), 'Lead tier should NOT have services')
  assert(!leadBlock.includes("'billing'"), 'Lead tier should NOT have billing')
  assert(!leadBlock.includes("'invoices'"), 'Lead tier should NOT have invoices')
})

test('onboarding tier includes wizard', () => {
  const code = readFile('lib/portal/tier-config.ts')
  const onbStart = code.indexOf("onboarding: [")
  const onbEnd = code.indexOf("],", onbStart)
  const onbBlock = code.substring(onbStart, onbEnd)
  assert(onbBlock.includes("'wizard'"), 'Onboarding tier missing wizard')
})

test('sidebar offer nav item only for lead tier', () => {
  const code = readFile('components/portal/portal-sidebar.tsx')
  assert(code.includes("tierOnly: ['lead']"), 'Offer nav must be lead-only')
})

test('sidebar wizard nav item only for onboarding tier', () => {
  const code = readFile('components/portal/portal-sidebar.tsx')
  assert(code.includes("tierOnly: ['onboarding']"), 'Wizard nav must be onboarding-only')
})

test('sidebar tier default is lead not active', () => {
  const code = readFile('components/portal/portal-sidebar.tsx')
  const tierFilter = code.substring(code.indexOf('tierOnly.includes'))
  assert(tierFilter.includes("|| 'lead'"), 'Sidebar tierOnly default must be lead')
  assert(!tierFilter.includes("|| 'active'"), 'Sidebar tierOnly must NOT default to active')
})

test('layout defaults portal_tier to lead when no account', () => {
  const code = readFile('app/portal/layout.tsx')
  assert(code.includes("'lead' as string"), 'Layout must default tier to lead for no-account users')
})

// ─── 4. SECURITY CHECKS ─────────────────────────────────────

console.log('\n📋 4. Security Checks')

test('offer_send does not leak temp password in MCP response', () => {
  const code = readFile('lib/mcp/tools/offers.ts')
  // Check that the response line doesn't include ${tempPassword}
  const responseSection = code.substring(code.indexOf('Portal credentials sent'))
  const responseLine = responseSection.substring(0, responseSection.indexOf('\n'))
  // eslint-disable-next-line no-template-curly-in-string
  assert(!responseLine.includes('${tempPassword}'), 'MCP response must NOT show temp password')
})

test('wizard-upload requires auth', () => {
  const code = readFile('app/api/portal/wizard-upload/route.ts')
  assert(code.includes('auth.getUser()'), 'Upload route must check auth')
  assert(code.includes('isClient'), 'Upload route must verify client role')
})

test('wizard-submit requires auth', () => {
  const code = readFile('app/api/portal/wizard-submit/route.ts')
  assert(code.includes('auth.getUser()'), 'Submit route must check auth')
  assert(code.includes('isClient'), 'Submit route must verify client role')
})

test('wizard-progress requires auth', () => {
  const code = readFile('app/api/portal/wizard-progress/route.ts')
  assert(code.includes('auth.getUser()'), 'Progress route must check auth')
  assert(code.includes('isClient'), 'Progress route must verify client role')
})

test('wizard-submit has deduplication check', () => {
  const code = readFile('app/api/portal/wizard-submit/route.ts')
  assert(code.includes('already submitted') || code.includes('Already submitted'), 'Submit must check for duplicates')
})

test('no hardcoded portal domain in client-facing code', () => {
  const portalFiles = [
    'app/portal/offer/page.tsx',
    'app/portal/wizard/page.tsx',
    'app/portal/welcome-dashboard.tsx',
  ]
  for (const f of portalFiles) {
    if (fileExists(f)) {
      const code = readFile(f)
      assert(!code.includes('portal.tonydurante.us'), `${f} has hardcoded portal domain`)
      assert(!code.includes('td-operations.vercel.app'), `${f} has hardcoded vercel domain`)
    }
  }
})

// ─── 5. FILE EXISTENCE CHECKS ────────────────────────────────

console.log('\n📋 5. Portal File Existence')

const requiredFiles = [
  'lib/portal/tier-config.ts',
  'lib/portal/auto-create.ts',
  'lib/portal/auto-save-document.ts',
  'lib/whop-auto-plan.ts',
  'app/portal/layout.tsx',
  'app/portal/page.tsx',
  'app/portal/welcome-dashboard.tsx',
  'app/portal/offer/page.tsx',
  'app/portal/offer/portal-offer-client.tsx',
  'app/portal/wizard/page.tsx',
  'app/portal/wizard/wizard-client.tsx',
  'app/api/portal/wizard-progress/route.ts',
  'app/api/portal/wizard-submit/route.ts',
  'app/api/portal/wizard-upload/route.ts',
  'components/portal/wizard/wizard-shell.tsx',
  'components/portal/wizard/wizard-field.tsx',
  'components/portal/wizard/wizard-configs.ts',
]

for (const f of requiredFiles) {
  test(`${f} exists`, () => {
    assert(fileExists(f), `Missing file: ${f}`)
  })
}

// ─── 6. FLOW INTEGRITY ──────────────────────────────────────

console.log('\n📋 6. Flow Integrity')

test('offer_send imports autoCreatePortalUser', () => {
  const code = readFile('lib/mcp/tools/offers.ts')
  assert(code.includes('autoCreatePortalUser'), 'offer_send must use autoCreatePortalUser')
})

test('offer_send imports PORTAL_BASE_URL', () => {
  const code = readFile('lib/mcp/tools/offers.ts')
  assert(code.includes('PORTAL_BASE_URL'), 'offer_send must use PORTAL_BASE_URL for login URL')
})

test('whop webhook upgrades portal tier', () => {
  const code = readFile('app/api/webhooks/whop/route.ts')
  assert(code.includes('portal_tier'), 'Whop webhook must upgrade portal_tier')
  assert(code.includes('"onboarding"'), 'Whop webhook must set tier to onboarding')
})

test('activate-service upgrades portal tier', () => {
  const code = readFile('app/api/workflows/activate-service/route.ts')
  assert(code.includes('portal_tier'), 'activate-service must upgrade portal_tier')
})

test('formation_form_review upgrades tier to active', () => {
  const code = readFile('lib/mcp/tools/formation.ts')
  assert(code.includes("portal_tier"), 'formation review must upgrade portal_tier')
  assert(code.includes('"active"'), 'formation review must set tier to active')
})

test('onboarding_form_review upgrades tier to active', () => {
  const code = readFile('lib/mcp/tools/onboarding.ts')
  assert(code.includes("portal_tier"), 'onboarding review must upgrade portal_tier')
  assert(code.includes('"active"'), 'onboarding review must set tier to active')
})

test('sd_advance_stage upgrades portal_tier on milestone', () => {
  const code = readFile('lib/service-delivery.ts')
  assert(code.includes("portal_tier"), 'sd_advance must reference portal_tier upgrades')
})

test('offer-signed webhook auto-saves document', () => {
  const code = readFile('app/api/webhooks/offer-signed/route.ts')
  assert(code.includes('autoSaveDocument'), 'offer-signed must auto-save to documents table')
})

test('lease-signed webhook auto-saves document', () => {
  const code = readFile('app/api/lease-signed/route.ts')
  assert(code.includes('autoSaveDocument'), 'lease-signed must auto-save to documents table')
})

test('oa-signed webhook auto-saves document', () => {
  const code = readFile('app/api/oa-signed/route.ts')
  assert(code.includes('autoSaveDocument'), 'oa-signed must auto-save to documents table')
})

test('welcome-package auto-saves EIN + Articles', () => {
  const code = readFile('lib/mcp/tools/welcome-package.ts')
  assert(code.includes('autoSaveDocument'), 'welcome-package must auto-save documents')
})

test('cookie banner script in portal layout', () => {
  const code = readFile('app/portal/layout.tsx')
  assert(code.includes('iubenda'), 'Portal layout must include Iubenda cookie banner')
})

test('privacy policy link on login page', () => {
  const code = readFile('app/portal/login/page.tsx')
  assert(code.includes('privacy-policy/51522422'), 'Login page must link to privacy policy')
  assert(code.includes('cookie-policy'), 'Login page must link to cookie policy')
  assert(code.includes('terms-and-conditions'), 'Login page must link to terms')
})

// ─── 7. WIZARD TYPE DETECTION ────────────────────────────────

console.log('\n📋 7. Wizard Type Detection')

test('wizard page searches by user.email for leads', () => {
  const code = readFile('app/portal/wizard/page.tsx')
  assert(code.includes('user.email'), 'Wizard must search by user.email for leads without contacts')
})

test('wizard page detects formation from offer.contract_type', () => {
  const code = readFile('app/portal/wizard/page.tsx')
  assert(code.includes("contract_type === 'formation'"), 'Wizard must detect formation type from offer')
})

test('wizard page detects tax from offer.contract_type', () => {
  const code = readFile('app/portal/wizard/page.tsx')
  assert(code.includes("contract_type === 'tax_return'") || code.includes("'tax_return'"), 'Wizard must detect tax type')
})

test('wizard page detects itin from offer.contract_type', () => {
  const code = readFile('app/portal/wizard/page.tsx')
  assert(code.includes("contract_type === 'itin'") || code.includes("'itin'"), 'Wizard must detect ITIN type')
})

// ─── 8. PORTAL DASHBOARD ────────────────────────────────────

console.log('\n📋 8. Portal Dashboard')

test('dashboard handles no-account users (leads)', () => {
  const code = readFile('app/portal/page.tsx')
  assert(code.includes('WelcomeDashboard'), 'Dashboard must render WelcomeDashboard for leads')
  assert(code.includes("tier: \"lead\"") || code.includes("tier=\"lead\"") || code.includes("'lead'"), 'Dashboard must pass lead tier')
})

test('dashboard fetches offer by multiple emails', () => {
  const code = readFile('app/portal/page.tsx')
  assert(code.includes('Set<string>') || code.includes('emailArr'), 'Dashboard must search by multiple emails')
})

test('welcome dashboard has payment section', () => {
  const code = readFile('app/portal/welcome-dashboard.tsx')
  assert(code.includes('paymentRequired') || code.includes('PAYMENT REQUIRED') || code.includes('Payment Required'), 'Welcome dashboard must have payment section')
})

test('welcome dashboard only shows payment when methods exist', () => {
  const code = readFile('app/portal/welcome-dashboard.tsx')
  assert(code.includes('payment_links?.length') || code.includes('bank_details'), 'Payment section must check if methods exist')
})

// ─── RESULTS ─────────────────────────────────────────────────

console.log('\n' + '═'.repeat(50))
console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`)

if (failures.length > 0) {
  console.log('❌ FAILURES:')
  for (const f of failures) {
    console.log(`   • ${f}`)
  }
  console.log('')
  process.exit(1)
} else {
  console.log('✅ ALL TESTS PASSED — Portal is verified\n')
  process.exit(0)
}
