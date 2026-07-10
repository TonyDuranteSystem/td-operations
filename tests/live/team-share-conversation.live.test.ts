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

describe('resolution: Solved / Closed / reopen (S2)', () => {
  async function setResolution(id: string, resolution: 'solved' | 'closed' | null) {
    const patch =
      resolution === null
        ? { resolution: null, resolved_at: null, resolved_by: null, work_status: 'todo' }
        : { resolution, resolved_at: new Date().toISOString(), resolved_by: CREATED_BY, work_status: 'handled' }
    await supabaseAdmin.from('internal_threads').update(patch).eq('id', id)
  }
  async function read(id: string) {
    const { data } = await supabaseAdmin
      .from('internal_threads').select('resolution, resolved_at, resolved_by, work_status').eq('id', id).single()
    return data as unknown as Record<string, unknown>
  }

  it('a SOLVED conversation is reused AND reopened on new activity', async () => {
    const a = await make('Shipping')
    await setResolution(a.thread.id, 'solved')
    expect(await read(a.thread.id)).toMatchObject({ resolution: 'solved', work_status: 'handled' })

    // A new share for the same client+topic reuses the solved thread and reopens it.
    const b = await make('Shipping')
    expect(b.reused).toBe(true)
    expect(b.thread.id).toBe(a.thread.id)
    expect(await read(a.thread.id)).toMatchObject({ resolution: null, resolved_at: null, work_status: 'todo' })
  }, 60_000)

  it('a CLOSED conversation is NOT reused — a fresh thread starts', async () => {
    const a = await make('ITIN')
    await setResolution(a.thread.id, 'closed')
    expect(await read(a.thread.id)).toMatchObject({ resolution: 'closed' })

    const b = await make('ITIN')
    expect(b.thread.id).not.toBe(a.thread.id)
    // The closed one stays closed and untouched.
    expect(await read(a.thread.id)).toMatchObject({ resolution: 'closed' })
  }, 60_000)

  it('the resolution CHECK rejects a bad value', async () => {
    const a = await make('Documents')
    const { error } = await supabaseAdmin
      .from('internal_threads').update({ resolution: 'banana' }).eq('id', a.thread.id)
    expect(error).toBeTruthy()
  }, 60_000)

  it('get_team_threads returns the resolution field', async () => {
    const a = await make('Lease')
    await setResolution(a.thread.id, 'closed')
    const { data } = await supabaseAdmin.rpc('get_team_threads', { p_user_id: CREATED_BY })
    const row = (data as Array<Record<string, unknown>> | null)?.find(r => r.id === a.thread.id)
    expect(row?.resolution).toBe('closed')
  }, 60_000)
})

describe('participant flag + notification scope (S4)', () => {
  const OTHER = 'b0da5d9c-acf6-4761-9cae-2c3b14dbc631' // antonio (any other staff uuid)

  async function rpcRow(userId: string, threadId: string) {
    const { data } = await supabaseAdmin.rpc('get_team_threads', { p_user_id: userId })
    return (data as Array<Record<string, unknown>> | null)?.find(r => r.id === threadId)
  }

  it('the creator is a participant; a staffer who never touched it is NOT', async () => {
    const a = await make('Banking')
    // Creator seeded a read row via the opening message? No — creation does not
    // seed the creator's read row, so simulate an OPEN by upserting it.
    await supabaseAdmin.from('internal_thread_reads')
      .upsert({ thread_id: a.thread.id, user_id: CREATED_BY, last_read_at: '1970-01-01T00:00:00Z' }, { onConflict: 'thread_id,user_id' })

    const mine = await rpcRow(CREATED_BY, a.thread.id)
    const theirs = await rpcRow(OTHER, a.thread.id)
    expect(mine?.is_participant).toBe(true)
    expect(theirs?.is_participant).toBe(false)
  }, 60_000)

  it('seeding a recipient read row makes them a participant with the unread showing', async () => {
    const a = await make('Closure')
    // Simulate the share-route seed: recipient gets a read row, last_read_at null.
    await supabaseAdmin.from('internal_thread_reads')
      .upsert({ thread_id: a.thread.id, user_id: OTHER, last_read_at: '1970-01-01T00:00:00Z' }, { onConflict: 'thread_id,user_id', ignoreDuplicates: true })
    // A message from someone else so OTHER has something unread.
    await supabaseAdmin.from('internal_messages').insert({
      thread_id: a.thread.id, sender_id: CREATED_BY, sender_name: 'QA', message: 'shared item', read_at: new Date().toISOString(),
    })
    const row = await rpcRow(OTHER, a.thread.id)
    expect(row?.is_participant).toBe(true)
    expect(Number(row?.unread_count)).toBeGreaterThan(0)
  }, 60_000)
})

describe('grouping fields in get_team_threads (S3)', () => {
  it('an account conversation carries an account client_key + the account name + topic', async () => {
    const a = await make('Documents')
    const { data } = await supabaseAdmin.rpc('get_team_threads', { p_user_id: CREATED_BY })
    const row = (data as Array<Record<string, unknown>> | null)?.find(r => r.id === a.thread.id)
    expect(row?.client_key).toBe(`account:${QA_ACCOUNT}`)
    expect(typeof row?.client_label).toBe('string')
    expect((row?.client_label as string).length).toBeGreaterThan(0)
    expect(row?.topic).toBe('Documents')
    expect(row?.lead_id).toBeNull()
  }, 60_000)
})
