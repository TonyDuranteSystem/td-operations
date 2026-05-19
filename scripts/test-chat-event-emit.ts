/* eslint-disable no-console -- dev-only sandbox driver, never shipped */
/**
 * Sandbox e2e: Wave 1 of the system-event portal-chat work.
 *
 *  1. Seed Lorenzo-shape contact in sandbox if missing.
 *  2. Call createSD({contact_id, service_type='Company Formation', ...}).
 *  3. Phase 9 auto-dispatch fires formation_progress workflow.
 *  4. Wave 1 dispatcher edit emits a sender_type='system' portal_messages row
 *     under topic='Formation'.
 *  5. Assert: task exists + portal_message exists + idempotency holds on re-run.
 */

import { config as dotenvConfig } from 'dotenv'
dotenvConfig({ path: '.env.local' })

import { supabaseAdmin } from '@/lib/supabase-admin'
import { createSD } from '@/lib/operations/service-delivery'

const LORENZO = '2a17a3e9-83df-40c4-a434-5fc4ee70db0c'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes('xjcxlmlpeywtwkhstjlw')) {
    console.error(`🛑 Expected sandbox; got ${url}`)
    process.exit(1)
  }
  console.log('🟢 sandbox confirmed')

  // ── Teardown anything from prior runs ───────────────────────────────────
  await supabaseAdmin.from('portal_messages').delete()
    .eq('contact_id', LORENZO).eq('sender_type', 'system')
  await supabaseAdmin.from('service_deliveries').delete()
    .eq('contact_id', LORENZO).eq('service_type', 'Company Formation')

  // ── Step 1: createSD (this triggers Phase 9 auto-dispatch) ──────────────
  const sd = await createSD({
    contact_id: LORENZO,
    service_type: 'Company Formation',
    service_name: 'Company Formation - Sandbox E2E Test',
  })
  console.log(`SD created: ${sd.id}`)

  // ── Step 2: verify task exists ──────────────────────────────────────────
  const { data: tasks } = await supabaseAdmin
    .from('tasks').select('id, task_title, workflow_slug')
    .eq('workflow_slug', 'formation_progress')
    .eq('task_meta->>service_delivery_id', sd.id)
  console.log(`Tasks spawned: ${tasks?.length ?? 0}`, tasks)

  // ── Step 3: verify portal_message emitted ───────────────────────────────
  const { data: msgs } = await supabaseAdmin
    .from('portal_messages').select('id, topic, sender_type, message, read_at')
    .eq('contact_id', LORENZO).eq('sender_type', 'system')
    .like('message', `%tasks:${tasks?.[0]?.id ?? '__none__'}%`)
  console.log(`System messages emitted: ${msgs?.length ?? 0}`, msgs)

  // ── Step 4: re-run the dispatcher emit (idempotency) ────────────────────
  // Directly call emitClientChatEvent with the same (source, kind) — must dedup
  const { emitClientChatEvent } = await import('@/lib/portal/chat-events')
  const second = await emitClientChatEvent({
    contact_id: LORENZO,
    topic: 'Formation',
    message: 'duplicate attempt',
    source: { table: 'tasks', id: tasks?.[0]?.id ?? 'x' },
    event_kind: 'workflow_spawned',
  })
  console.log(`Idempotency check (should be already_emitted): ${second.reason}`)

  // ── Cleanup ─────────────────────────────────────────────────────────────
  await supabaseAdmin.from('portal_messages').delete()
    .eq('contact_id', LORENZO).eq('sender_type', 'system')
  await supabaseAdmin.from('service_deliveries').delete().eq('id', sd.id)
  await supabaseAdmin.from('tasks').delete()
    .eq('task_meta->>service_delivery_id', sd.id)

  const pass =
    (tasks?.length ?? 0) === 1 &&
    (msgs?.length ?? 0) === 1 &&
    second.reason === 'already_emitted'
  console.log(pass ? '\n✅ E2E PASSED' : '\n❌ E2E FAILED')
  process.exit(pass ? 0 : 1)
}

main().catch(err => {
  console.error('💥 Crashed:', err)
  process.exit(2)
})
