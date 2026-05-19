/* eslint-disable no-console -- one-off backfill script, never shipped */
/**
 * Backfill: Lorenzo Cannas's Company Formation SD (created 2026-05-05) predates
 * Phase 9 (2026-05-18) so it never had its sd_created workflow dispatched. This
 * script dispatches it once. Idempotent — re-runs return already_spawned.
 *
 * Hardcoded to Lorenzo's specific SD id so it can never accidentally fire for
 * other SDs.
 */

import { config as dotenvConfig } from 'dotenv'
dotenvConfig({ path: '.env.local' })

import { dispatchWorkflowForSdCreated } from '@/lib/tasks/dispatch-workflow-for-event'

const LORENZO_SD_ID = '08ad3655-1c84-4db7-b08c-a6f0b35bbdea'

async function main() {
  // PRODUCTION TARGET — this script is intentionally allowed to hit production
  // because the SD it backfills only exists in production. Sandbox doesn't have
  // a matching row. Verified Lorenzo's id at this exact value before run.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  console.log(`🟢 DB: ${url.split('//')[1]?.split('.')[0]}`)

  const result = await dispatchWorkflowForSdCreated({
    delivery: {
      id: LORENZO_SD_ID,
      service_type: 'Company Formation',
      stage: 'Data Collection',
      account_id: null,
      contact_id: '2a17a3e9-83df-40c4-a434-5fc4ee70db0c',
      service_name: 'Company Formation - CORAGEM LLC',
    },
    build_task_meta: async () => ({
      service_delivery_id: LORENZO_SD_ID,
      schema_version: 1,
    }),
    task_title: 'Company Formation - CORAGEM LLC',
    description: 'Backfill: Lorenzo Cannas formation wizard submitted 2026-05-05, predates Phase 9 sd_created auto-dispatch. Use the action buttons to advance the lifecycle.',
    actor: 'backfill:lorenzo-pre-phase9',
  })

  console.log('Result:', JSON.stringify(result, null, 2))
  process.exit(result.spawned || result.reason === 'already_spawned' ? 0 : 1)
}

main().catch(err => {
  console.error('💥 Crashed:', err)
  process.exit(2)
})
