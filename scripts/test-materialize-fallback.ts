/* eslint-disable no-console -- dev-only sandbox driver script, never shipped */
/**
 * Sandbox driver for fix/formation-upload-resolver:
 * Calls materializeFormationCompany directly against sandbox, exercising the
 * wizard_progress fallback path + admin-supplied state + self-heal + orphan
 * dedupe — all in one shot.
 *
 * Pre-seeded fixture (Shape C — Lorenzo replica):
 *   - contact: 2a17a3e9-83df-40c4-a434-5fc4ee70db0c
 *   - wizard_progress: 1 row (formation, submitted, chosen=CORAGEM LLC)
 *   - formation_submissions: 0 rows
 *   - service_deliveries: 1 active Company Formation
 *   - documents: 3 orphan "Articles of Organization" rows (account_id=null)
 *
 * Run: tsx scripts/test-materialize-fallback.ts
 */

import { config as dotenvConfig } from 'dotenv'
dotenvConfig({ path: '.env.local' })
import { materializeFormationCompany } from '@/lib/operations/formation-materialize'

const CONTACT_ID = '2a17a3e9-83df-40c4-a434-5fc4ee70db0c'

async function main() {
  // R104 guard — refuse to run against production by accident.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (url.includes('ydzipybqeebtpcvsbtvs')) {
    console.error('🛑 PRODUCTION DETECTED. Refusing to run. Use sandbox env.')
    process.exit(1)
  }
  if (!url.includes('xjcxlmlpeywtwkhstjlw')) {
    console.error(`🛑 Unexpected Supabase URL: ${url}. Aborting.`)
    process.exit(1)
  }
  console.log(`🟢 Sandbox env confirmed (${url.split('//')[1]?.split('.')[0]})`)

  console.log('\n=== Calling materializeFormationCompany ===')
  const result = await materializeFormationCompany({
    contact_id: CONTACT_ID,
    formation_state: 'NM',
    formation_date: '2026-05-18',
    filing_id: '3224710',
    actor: 'sandbox-test:driver',
  })

  console.log('\n=== Result ===')
  console.log('success:', result.success)
  console.log('outcome:', result.outcome)
  console.log('account_id:', result.account_id ?? 'n/a')
  if (result.error) console.log('error:', result.error)
  console.log('\n=== Steps ===')
  for (const s of result.steps) {
    const icon = s.status === 'ok' ? '✅' : s.status === 'skipped' ? '⏭️' : '❌'
    console.log(`${icon} ${s.step.padEnd(28)} ${s.detail ?? ''}`)
  }

  process.exit(result.success ? 0 : 1)
}

main().catch(err => {
  console.error('💥 Driver crashed:', err)
  process.exit(2)
})
