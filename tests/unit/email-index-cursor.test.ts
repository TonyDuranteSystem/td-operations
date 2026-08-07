/**
 * Cursor discipline for the email-index incremental sync (council rework,
 * 2026-08-07, dev job 21844d01).
 *
 * The old syncIncremental advanced the cursor UNCONDITIONALLY — a failed or
 * capped history read was skipped forever, and nothing else repairs
 * label_ids, so an archived email became a phantom-INBOX row that popped
 * back after every archive. These tests pin the new contract:
 *   - transient failure (429/5xx/network) → cursor HELD (or advanced only to
 *     the last fully-processed page), retried next sync;
 *   - permanent thread failure (404/410 — the thread is gone) → counts as
 *     processed, never wedges the cursor;
 *   - history.list 404 (expired cursor) → RESET to latest, flagged for heal;
 *   - clean drain → advance to the push's latest id;
 *   - every advance is compare-and-swap on the starting cursor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock state, mutated per test ───────────────────────
type HistoryPage = {
  history?: Array<{
    id?: string
    labelsRemoved?: Array<{ message?: { threadId?: string } }>
  }>
  nextPageToken?: string
}
const mock = {
  cursor: null as string | null,
  historyPages: [] as HistoryPage[],
  historyError: null as Error | null,
  threadErrors: new Map<string, Error>(),
  cursorWrites: [] as Array<{ kind: 'cas' | 'upsert'; expected?: string; target: string }>,
  indexedThreads: [] as string[],
}

function resetMock() {
  mock.cursor = null
  mock.historyPages = []
  mock.historyError = null
  mock.threadErrors = new Map()
  mock.cursorWrites = []
  mock.indexedThreads = []
}

function gmailThread(threadId: string) {
  return {
    messages: [
      {
        id: `${threadId}-m1`,
        threadId,
        snippet: 'hi',
        labelIds: ['INBOX'],
        internalDate: '1783515731000',
        payload: {
          headers: [
            { name: 'From', value: 'x@y.com' },
            { name: 'To', value: 'support@tonydurante.us' },
            { name: 'Subject', value: 's' },
          ],
          mimeType: 'text/plain',
        },
      },
    ],
  }
}

vi.mock('@/lib/gmail', () => ({
  gmailGet: vi.fn(async (path: string, params?: Record<string, string>) => {
    if (path === '/history') {
      if (mock.historyError) throw mock.historyError
      const idx = params?.pageToken ? Number(params.pageToken) : 0
      return mock.historyPages[idx] ?? {}
    }
    const m = /^\/threads\/(.+)$/.exec(path)
    if (m) {
      const tid = m[1]
      const err = mock.threadErrors.get(tid)
      if (err) throw err
      mock.indexedThreads.push(tid)
      return gmailThread(tid)
    }
    throw new Error(`unexpected gmailGet ${path}`)
  }),
  getHeader: (headers: Array<{ name: string; value: string }> | undefined, name: string) =>
    headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '',
}))

vi.mock('@/lib/supabase-admin', () => {
  const from = (table: string) => {
    if (table === 'gmail_watch_state') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: mock.cursor === null ? null : { index_history_id: mock.cursor } }),
          }),
        }),
        update: (payload: { index_history_id: string }) => ({
          eq: (_c1: string, _v1: string) => ({
            eq: async (_c2: string, expected: string) => {
              mock.cursorWrites.push({ kind: 'cas', expected, target: payload.index_history_id })
              return { data: null, error: null }
            },
          }),
        }),
        upsert: async (payload: { index_history_id: string }) => {
          mock.cursorWrites.push({ kind: 'upsert', target: payload.index_history_id })
          return { error: null }
        },
      }
    }
    if (table === 'email_index') {
      return { upsert: async () => ({ error: null }) }
    }
    // loadCrmDirectory tables — empty directory is fine.
    return { select: async () => ({ data: [] }) }
  }
  return { supabaseAdmin: { from } }
})

import {
  syncIncremental,
  reindexThreadsAfterAction,
  gmailErrorStatus,
  isPermanentGmailThreadError,
} from '@/lib/email-index/sync'

beforeEach(resetMock)

const page = (recId: string, threadIds: string[], nextPageToken?: string): HistoryPage => ({
  history: threadIds.map((t) => ({ id: recId, labelsRemoved: [{ message: { threadId: t } }] })),
  nextPageToken,
})

describe('gmailErrorStatus / isPermanentGmailThreadError', () => {
  it('parses the status from every lib/gmail error shape', () => {
    expect(gmailErrorStatus(new Error('Gmail API 404: notFound'))).toBe(404)
    expect(gmailErrorStatus(new Error('Gmail API 429: rateLimitExceeded'))).toBe(429)
    expect(gmailErrorStatus(new Error('Gmail DELETE 403: forbidden'))).toBe(403)
    expect(gmailErrorStatus(new Error('Gmail OAuth error 500: boom'))).toBe(500)
  })
  it('returns null for non-Gmail errors (network, parse)', () => {
    expect(gmailErrorStatus(new Error('fetch failed'))).toBeNull()
    expect(gmailErrorStatus('weird')).toBeNull()
  })
  it('classifies only 404/410 as permanent', () => {
    expect(isPermanentGmailThreadError(new Error('Gmail API 404: gone'))).toBe(true)
    expect(isPermanentGmailThreadError(new Error('Gmail API 410: gone'))).toBe(true)
    expect(isPermanentGmailThreadError(new Error('Gmail API 429: rate'))).toBe(false)
    expect(isPermanentGmailThreadError(new Error('Gmail API 500: ise'))).toBe(false)
    expect(isPermanentGmailThreadError(new Error('fetch failed'))).toBe(false)
  })
})

describe('syncIncremental cursor discipline', () => {
  it('clean drain advances the cursor to the latest id via CAS', async () => {
    mock.cursor = '100'
    mock.historyPages = [page('150', ['t1', 't2'])]
    const res = await syncIncremental('support', '200')
    expect(res).toMatchObject({ cursorHeld: false, cursorExpired: false, threads: 2 })
    expect(mock.indexedThreads.sort()).toEqual(['t1', 't2'])
    expect(mock.cursorWrites).toEqual([{ kind: 'cas', expected: '100', target: '200' }])
  })

  it('holds the cursor entirely when the only page has a transient failure', async () => {
    mock.cursor = '100'
    mock.historyPages = [page('150', ['t1', 't2'])]
    mock.threadErrors.set('t2', new Error('Gmail API 429: rateLimitExceeded'))
    const res = await syncIncremental('support', '200')
    expect(res.cursorHeld).toBe(true)
    // No write at all: the whole span replays next sync.
    expect(mock.cursorWrites).toEqual([])
  })

  it('a permanently-dead thread (404) never wedges the cursor', async () => {
    mock.cursor = '100'
    mock.historyPages = [page('150', ['gone', 'alive'])]
    mock.threadErrors.set('gone', new Error('Gmail API 404: notFound'))
    const res = await syncIncremental('support', '200')
    expect(res.cursorHeld).toBe(false)
    expect(mock.cursorWrites).toEqual([{ kind: 'cas', expected: '100', target: '200' }])
  })

  it('transient failure on page 2 advances only past the clean page 1', async () => {
    mock.cursor = '100'
    mock.historyPages = [page('120', ['a'], '1'), page('140', ['b'])]
    mock.threadErrors.set('b', new Error('Gmail API 500: backend'))
    const res = await syncIncremental('support', '200')
    expect(res.cursorHeld).toBe(true)
    expect(mock.cursorWrites).toEqual([{ kind: 'cas', expected: '100', target: '120' }])
  })

  it('an expired history cursor (404) resets to latest and flags it', async () => {
    mock.cursor = '100'
    mock.historyError = new Error('Gmail API 404: startHistoryId not found')
    const res = await syncIncremental('support', '200')
    expect(res.cursorExpired).toBe(true)
    expect(mock.cursorWrites).toEqual([{ kind: 'cas', expected: '100', target: '200' }])
  })

  it('a transient history.list failure holds the cursor (no reset, no skip)', async () => {
    mock.cursor = '100'
    mock.historyError = new Error('Gmail API 429: quota')
    const res = await syncIncremental('support', '200')
    expect(res.cursorHeld).toBe(true)
    expect(res.cursorExpired).toBe(false)
    expect(mock.cursorWrites).toEqual([])
  })

  it('a network failure (no Gmail status) also holds, never resets', async () => {
    mock.cursor = '100'
    mock.historyError = new Error('fetch failed')
    const res = await syncIncremental('support', '200')
    expect(res.cursorHeld).toBe(true)
    expect(res.cursorExpired).toBe(false)
    expect(mock.cursorWrites).toEqual([])
  })

  it('first run (no cursor) stamps latest without replaying history', async () => {
    mock.cursor = null
    const res = await syncIncremental('support', '200')
    expect(res.threads).toBe(0)
    expect(mock.cursorWrites).toEqual([{ kind: 'upsert', target: '200' }])
  })
})

describe('reindexThreadsAfterAction', () => {
  it('re-indexes each acted-on thread through the one writer', async () => {
    await reindexThreadsAfterAction('support', ['t1', 't2', 't1'])
    expect(mock.indexedThreads.sort()).toEqual(['t1', 't2']) // deduped
  })
  it('does nothing on an empty list', async () => {
    await reindexThreadsAfterAction('support', [])
    expect(mock.indexedThreads).toEqual([])
  })
  it('swallows per-thread failures (push will heal)', async () => {
    mock.threadErrors.set('bad', new Error('Gmail API 429: rate'))
    await expect(reindexThreadsAfterAction('support', ['bad', 'ok'])).resolves.toBeUndefined()
    expect(mock.indexedThreads).toEqual(['ok'])
  })
})
