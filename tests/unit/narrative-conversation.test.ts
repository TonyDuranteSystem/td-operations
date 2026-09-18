/**
 * lib/offers/narrative-conversation.ts — persistence + scope-safety for the
 * offer-narrative conversation (offer-narrative chat redesign, 2026-09-16).
 *
 * Two properties matter most here, and both are exercised directly rather
 * than assumed from a green result (docs/systems/offers.md's own standing
 * warning: a check is only evidence once you know what would have to break
 * for it to go red):
 *   1. loadConversation REFUSES when the caller's claimed subject disagrees
 *      with the stored row — the thing that keeps two clients' narratives
 *      from ever blending.
 *   2. appendTurnPair assigns seqs via max(seq)+1/+2 and RETRIES on a real
 *      unique-violation (not any error) — the concurrency safeguard — and
 *      writes the user+assistant exchange as ONE atomic insert, so a failure
 *      can never leave a dangling turn with no reply.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const REJECT = Symbol('reject')
type QueuedResult = { data: unknown; error: unknown } | { [REJECT]: Error }

const h = vi.hoisted(() => ({
  queue: [] as unknown[],
  fromCalls: [] as string[],
  insertPayloads: [] as unknown[],
  updatePayloads: [] as unknown[],
}))

function queue(result: { data?: unknown; error?: unknown }) {
  h.queue.push({ data: result.data ?? null, error: result.error ?? null })
}

/** Queue a genuine network/JS-level failure (rejects) instead of the normal
 * supabase-js {data,error} resolution — for proving a try/catch actually works. */
function queueReject(err: Error) {
  h.queue.push({ [REJECT]: err })
}

function popResult(): Promise<{ data: unknown; error: unknown }> {
  const r = h.queue.shift() as QueuedResult | undefined
  if (!r) throw new Error('mock queue exhausted — the test did not queue enough responses for the calls the code actually makes')
  if (typeof r === 'object' && r !== null && REJECT in r) return Promise.reject((r as { [REJECT]: Error })[REJECT])
  return Promise.resolve(r as { data: unknown; error: unknown })
}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn((table: string) => {
      h.fromCalls.push(table)
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        insert: vi.fn((payload: unknown) => {
          h.insertPayloads.push(payload)
          return chain
        }),
        update: vi.fn((payload: unknown) => {
          h.updatePayloads.push(payload)
          return chain
        }),
        maybeSingle: vi.fn(() => popResult()),
        single: vi.fn(() => popResult()),
        // supabase-js query builders are themselves awaitable (thenable) when
        // no terminal (.single()/.maybeSingle()) is called — mirrored here so
        // `await supabaseAdmin.from(x).select(...).order(...)` resolves too.
        then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
          popResult().then(resolve, reject),
      }
      return chain
    }),
  },
}))

import {
  sameSubject,
  hasAnySubject,
  toMessageHistory,
  createConversation,
  loadConversation,
  appendTurnPair,
  touchConversation,
  type ConversationSubject,
} from '@/lib/offers/narrative-conversation'

beforeEach(() => {
  h.queue = []
  h.fromCalls = []
  h.insertPayloads = []
  h.updatePayloads = []
  vi.clearAllMocks()
})

describe('sameSubject (pure)', () => {
  it('treats identical lead/account/contact triples as the same subject', () => {
    const a: ConversationSubject = { leadId: 'l1', accountId: null, contactId: null }
    const b: ConversationSubject = { leadId: 'l1', accountId: null, contactId: null }
    expect(sameSubject(a, b)).toBe(true)
  })

  it('treats undefined and null the same as each other', () => {
    const a = { leadId: null, accountId: undefined, contactId: null } as unknown as ConversationSubject
    const b: ConversationSubject = { leadId: null, accountId: null, contactId: null }
    expect(sameSubject(a, b)).toBe(true)
  })

  it('is false when ANY single field disagrees — lead, account, or contact', () => {
    const base: ConversationSubject = { leadId: 'l1', accountId: 'a1', contactId: 'c1' }
    expect(sameSubject(base, { ...base, leadId: 'l2' })).toBe(false)
    expect(sameSubject(base, { ...base, accountId: 'a2' })).toBe(false)
    expect(sameSubject(base, { ...base, contactId: 'c2' })).toBe(false)
  })
})

describe('hasAnySubject (pure)', () => {
  it('true when at least one id is present', () => {
    expect(hasAnySubject({ leadId: 'l1', accountId: null, contactId: null })).toBe(true)
    expect(hasAnySubject({ leadId: null, accountId: 'a1', contactId: null })).toBe(true)
    expect(hasAnySubject({ leadId: null, accountId: null, contactId: 'c1' })).toBe(true)
  })
  it('false when all three are absent', () => {
    expect(hasAnySubject({ leadId: null, accountId: null, contactId: null })).toBe(false)
  })
})

describe('toMessageHistory (pure)', () => {
  it('maps role/content and re-sorts by seq defensively, even if the input is already ordered', () => {
    const out = toMessageHistory([
      { seq: 1, role: 'user', content: 'hi' },
      { seq: 2, role: 'assistant', content: 'reply' },
    ])
    expect(out).toEqual([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'reply' }])
  })

  it('re-sorts OUT-OF-ORDER rows by seq — never trusts array order alone', () => {
    const out = toMessageHistory([
      { seq: 3, role: 'assistant', content: 'third' },
      { seq: 1, role: 'user', content: 'first' },
      { seq: 2, role: 'assistant', content: 'second' },
    ])
    expect(out.map((m) => m.content)).toEqual(['first', 'second', 'third'])
  })

  it('empty turns → empty history', () => {
    expect(toMessageHistory([])).toEqual([])
  })
})

describe('createConversation', () => {
  it('rejects a subject with no lead/account/contact WITHOUT touching the database', async () => {
    await expect(createConversation({ leadId: null, accountId: null, contactId: null }, 'a@b.com'))
      .rejects.toThrow(/no lead_id, account_id, or contact_id/)
    expect(h.fromCalls).toEqual([])
  })

  it('inserts and returns the new conversation id', async () => {
    queue({ data: { id: 'convo-1' } })
    const id = await createConversation({ leadId: 'l1', accountId: null, contactId: null }, 'staff@tonydurante.us')
    expect(id).toBe('convo-1')
    expect(h.fromCalls).toEqual(['offer_narrative_conversations'])
    expect(h.insertPayloads[0]).toMatchObject({ lead_id: 'l1', account_id: null, contact_id: null, created_by: 'staff@tonydurante.us' })
  })

  it('throws with the DB error message on failure', async () => {
    queue({ data: null, error: { message: 'insert failed' } })
    await expect(createConversation({ leadId: 'l1', accountId: null, contactId: null }, null))
      .rejects.toThrow(/insert failed/)
  })
})

describe('loadConversation — scope re-validation', () => {
  it('loads the conversation and its turns in seq order when the subject matches', async () => {
    queue({ data: { id: 'convo-1', lead_id: 'l1', account_id: null, contact_id: null } })
    queue({ data: [{ seq: 1, role: 'user', content: 'a' }, { seq: 2, role: 'assistant', content: 'b' }] })
    const result = await loadConversation('convo-1', { leadId: 'l1', accountId: null, contactId: null })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.subject).toEqual({ leadId: 'l1', accountId: null, contactId: null })
      expect(result.turns).toHaveLength(2)
    }
    expect(h.fromCalls).toEqual(['offer_narrative_conversations', 'offer_narrative_turns'])
  })

  it('refuses when the conversation does not exist — never a throw', async () => {
    queue({ data: null })
    const result = await loadConversation('missing', { leadId: 'l1', accountId: null, contactId: null })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not found/)
    // Never queries turns for a conversation that doesn't exist.
    expect(h.fromCalls).toEqual(['offer_narrative_conversations'])
  })

  it('REFUSES when the stored subject disagrees with the caller\'s claim — the anti-blend guarantee', async () => {
    queue({ data: { id: 'convo-1', lead_id: 'l1', account_id: null, contact_id: null } })
    const result = await loadConversation('convo-1', { leadId: 'DIFFERENT-LEAD', accountId: null, contactId: null })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/different client\/offer draft/)
    // Must NOT read turns for a conversation it just refused — no partial leak.
    expect(h.fromCalls).toEqual(['offer_narrative_conversations'])
  })

  it('also refuses on an account-id or contact-id mismatch, not just lead', async () => {
    queue({ data: { id: 'c1', lead_id: null, account_id: 'a1', contact_id: null } })
    const r1 = await loadConversation('c1', { leadId: null, accountId: 'a-WRONG', contactId: null })
    expect(r1.ok).toBe(false)

    queue({ data: { id: 'c2', lead_id: null, account_id: null, contact_id: 'ct1' } })
    const r2 = await loadConversation('c2', { leadId: null, accountId: null, contactId: 'ct-WRONG' })
    expect(r2.ok).toBe(false)
  })

  it('surfaces a DB error on the conversation lookup as ok:false, not a throw', async () => {
    queue({ data: null, error: { message: 'db down' } })
    const result = await loadConversation('c1', { leadId: 'l1', accountId: null, contactId: null })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/db down/)
  })

  it('surfaces a DB error on the turns read as ok:false', async () => {
    queue({ data: { id: 'c1', lead_id: 'l1', account_id: null, contact_id: null } })
    queue({ data: null, error: { message: 'turns read failed' } })
    const result = await loadConversation('c1', { leadId: 'l1', accountId: null, contactId: null })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/turns read failed/)
  })
})

describe('appendTurnPair — race-safe sequencing, atomic exchange', () => {
  it('assigns seq 1 (user) and seq 2 (assistant) on the first exchange of an empty conversation', async () => {
    queue({ data: null }) // max(seq) → none yet
    queue({ error: null }) // paired insert succeeds
    const { userSeq, assistantSeq } = await appendTurnPair('c1', 'hello', 'hi there')
    expect(userSeq).toBe(1)
    expect(assistantSeq).toBe(2)
  })

  it('assigns max(seq)+1 / +2 on a non-empty conversation', async () => {
    queue({ data: { seq: 5 } })
    queue({ error: null })
    const { userSeq, assistantSeq } = await appendTurnPair('c1', 'q', 'a')
    expect(userSeq).toBe(6)
    expect(assistantSeq).toBe(7)
  })

  it('writes BOTH rows in ONE insert call — never two separate inserts', async () => {
    queue({ data: { seq: 5 } })
    queue({ error: null })
    await appendTurnPair('c1', 'the question', 'the answer')
    expect(h.insertPayloads).toHaveLength(1)
    const payload = h.insertPayloads[0] as Array<{ seq: number; role: string; content: string }>
    expect(payload).toEqual([
      { conversation_id: 'c1', seq: 6, role: 'user', content: 'the question' },
      { conversation_id: 'c1', seq: 7, role: 'assistant', content: 'the answer' },
    ])
  })

  it('ATOMICITY: a failed insert leaves NO dangling turn — the exchange is all-or-nothing', async () => {
    // This is the property that keeps a conversation's roles strictly
    // alternating: if the user turn could land without its assistant reply,
    // the NEXT turn's history would end in 'user', and callAI would append
    // ANOTHER 'user' message — two in a row, which Anthropic's API rejects.
    queue({ data: { seq: 3 } })
    queue({ error: { code: '55000', message: 'connection reset' } })
    await expect(appendTurnPair('c1', 'q', 'a')).rejects.toThrow(/Could not save conversation exchange/)
    // Exactly ONE insert call was attempted (containing both rows) — there is
    // no code path where the user row is inserted separately from the
    // assistant row, so there is nothing that could have partially landed.
    expect(h.insertPayloads).toHaveLength(1)
  })

  it('RETRIES on a real unique-violation (23505) on the claimed seq pair, and succeeds with the next pair', async () => {
    // Attempt 1: reads max=5, tries to claim seqs 6+7, loses the race (23505).
    queue({ data: { seq: 5 } })
    queue({ error: { code: '23505', message: 'duplicate key value violates unique constraint "offer_narrative_turns_conversation_seq_uniq"' } })
    // Attempt 2: re-reads max, now 7 (the winner's pair), claims 8+9, succeeds.
    queue({ data: { seq: 7 } })
    queue({ error: null })
    const { userSeq, assistantSeq } = await appendTurnPair('c1', 'retried q', 'retried a')
    expect(userSeq).toBe(8)
    expect(assistantSeq).toBe(9)
    // Exactly 2 full attempts (max-read + insert) happened — 4 from() calls.
    expect(h.fromCalls).toHaveLength(4)
  })

  it('does NOT retry a non-unique-violation error — throws immediately', async () => {
    queue({ data: { seq: 1 } })
    queue({ error: { code: '55000', message: 'some other postgres error' } })
    await expect(appendTurnPair('c1', 'q', 'a')).rejects.toThrow(/Could not save conversation exchange/)
    // Only ONE attempt was made (2 from() calls: max-read + the failed insert).
    expect(h.fromCalls).toHaveLength(2)
  })

  it('gives up after repeated collisions rather than retrying forever', async () => {
    for (let i = 0; i < 10; i++) {
      queue({ data: { seq: i + 1 } })
      queue({ error: { code: '23505', message: 'duplicate key value violates unique constraint "offer_narrative_turns_conversation_seq_uniq"' } })
    }
    await expect(appendTurnPair('c1', 'q', 'a')).rejects.toThrow(/too many concurrent writers/)
    expect(h.fromCalls).toHaveLength(20) // 10 attempts × (max-read + insert)
  })

  it('a unique-violation on a DIFFERENT constraint is treated as a real error, not a seq race', async () => {
    queue({ data: { seq: 1 } })
    queue({ error: { code: '23505', message: 'duplicate key value violates unique constraint "some_other_constraint"' } })
    await expect(appendTurnPair('c1', 'q', 'a')).rejects.toThrow(/Could not save conversation exchange/)
  })
})

describe('touchConversation', () => {
  it('updates updated_at on the conversation row', async () => {
    queue({ error: null })
    await touchConversation('c1')
    expect(h.fromCalls).toEqual(['offer_narrative_conversations'])
    expect(h.updatePayloads).toHaveLength(1)
  })

  it('swallows a resolved {error} — bookkeeping only, never inspected', async () => {
    queue({ error: { message: 'update failed' } })
    await expect(touchConversation('c1')).resolves.toBeUndefined()
  })

  it('never throws even on a genuine network/JS-level failure — the try/catch actually catches', async () => {
    queueReject(new Error('network down'))
    await expect(touchConversation('c1')).resolves.toBeUndefined()
  })
})
