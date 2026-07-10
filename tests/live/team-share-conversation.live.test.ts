/**
 * LIVE sandbox test for S1 — sharing an email/message into a CLIENT CONVERSATION.
 *
 * Exercises the real `findOrCreateConversation` helper (the single create/dedup
 * path the share route now uses) against the sandbox DB: create-then-reuse,
 * topic slug, forceNew, and no-duplicate-on-reshare. The HTTP route wraps this
 * plus card insertion + push; the identity logic under test is the helper.
 *
 * Run: npx vitest run --config vitest.esign-live.config.ts tests/live/team-share-conversation.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findOrCreateConversation } from '@/lib/team/find-conversation'
import type { ClientRef } from '@/lib/team/conversations'

const QA_ACCOUNT = '22222222-2222-4222-8222-222222222201' // QA One LLC
const CREATED_BY = 'deb9becc-01d5-4d76-a29a-195a6d5b2857' // support/Luca (any staff uuid)
const createdThreadIds: string[] = []

async function cleanupThread(id: string) {
  await supabaseAdmin.from('internal_messages').delete().eq('thread_id', id)
  await supabaseAdmin.from('internal_thread_reads').delete().eq('thread_id', id)
  await supabaseAdmin.from('internal_threads').delete().eq('id', id)
}

beforeAll(() => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  if (!url.includes('xjcxlmlpeywtwkhstjlw')) {
    throw new Error(`REFUSING TO RUN: not the sandbox database (${url})`)
  }
})

afterAll(async () => {
  for (const id of createdThreadIds) await cleanupThread(id)
}, 60_000)

const ref: ClientRef = { kind: 'account', id: QA_ACCOUNT }

async function make(topic: string | null, forceNew = false) {
  const r = await findOrCreateConversation({
    ref, topic, createdBy: CREATED_BY, createdByName: 'QA', forceNew,
  })
  if ('error' in r) throw new Error(r.error)
  if (!r.reused) createdThreadIds.push(r.thread.id)
  return r
}

describe('findOrCreateConversation (S1)', () => {
  it('creates a discussion titled "Client · Topic" with the topic slug set', async () => {
    const r = await make('Billing')
    expect(r.reused).toBe(false)
    expect(r.thread.thread_type).toBe('discussion')
    expect(r.thread.account_id).toBe(QA_ACCOUNT)
    expect(r.thread.topic).toBe('Billing')
    expect(r.thread.topic_slug).toBe('billing')
    expect(r.thread.title).toContain('· Billing')

    // It seeded exactly one opening marker message.
    const { count } = await supabaseAdmin
      .from('internal_messages').select('id', { count: 'exact', head: true }).eq('thread_id', r.thread.id)
    expect(count).toBe(1)
  }, 60_000)

  it('REUSES the same thread for the same client+topic — no duplicate', async () => {
    const first = await make('Formation')
    const second = await make('Formation')
    expect(second.reused).toBe(true)
    expect(second.thread.id).toBe(first.thread.id)
  }, 60_000)

  it('a different topic on the same client is a DIFFERENT thread', async () => {
    const billing = await make('Billing')       // reuses the one from test 1
    const tax = await make('Tax')
    expect(tax.thread.id).not.toBe(billing.thread.id)
  }, 60_000)

  it('forceNew creates a fresh thread even when an open one exists (the "start a new one" hatch)', async () => {
    const a = await make('Banking')
    const b = await make('Banking', true)
    expect(b.reused).toBe(false)
    expect(b.thread.id).not.toBe(a.thread.id)
  }, 60_000)

  it('a topic-less share reuses only other topic-less threads, not a topic thread', async () => {
    const none1 = await make(null)
    const none2 = await make(null)
    expect(none2.reused).toBe(true)
    expect(none2.thread.id).toBe(none1.thread.id)
    expect(none1.thread.topic_slug).toBeNull()
  }, 60_000)

  it('rejects a client that does not exist', async () => {
    const r = await findOrCreateConversation({
      ref: { kind: 'account', id: '00000000-0000-4000-8000-000000000000' },
      topic: 'Billing', createdBy: CREATED_BY, createdByName: 'QA',
    })
    expect('error' in r && r.status).toBe(404)
  }, 60_000)
})
