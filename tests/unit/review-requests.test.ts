import { describe, it, expect } from 'vitest'
import {
  MAX_NOTE_CHARS,
  MAX_REQUESTS,
  answerOutcomes,
  appendRound,
  buildClientMessage,
  buildRound,
  canWriteReviewRequests,
  draftCount,
  hasDraftToSend,
  latestRound,
  parseReviewRequests,
  roundHistoryNote,
  setDraftMessage,
  setDraftNote,
  type ReviewRound,
} from '@/lib/tax/review-requests'

const DATA = {
  comp_foreign_accounts_over_10k: 'No',
  bank_accounts_1_bank_name: 'Payset',
  bank_accounts_1_statements: ['tax/a/one.csv'],
  company_name: 'Sample LLC',
}
const AT = '2026-11-07T12:00:00.000Z'

describe('parseReviewRequests — a damaged or missing field reads as "nothing written"', () => {
  it('returns an empty value for null, text, arrays and numbers', () => {
    for (const bad of [null, undefined, 'x', 5, [], true]) {
      expect(parseReviewRequests(bad)).toEqual({ draft: { requests: {}, message: '' }, rounds: [] })
    }
  })

  it('keeps trimmed draft notes and drops empty ones', () => {
    const d = parseReviewRequests({ draft: { requests: { a: '  fix it  ', b: '   ', c: 5 }, message: ' hello ' } })
    expect(d.draft.requests).toEqual({ a: 'fix it' })
    expect(d.draft.message).toBe('hello')
  })

  it('caps a note at the maximum length', () => {
    const d = parseReviewRequests({ draft: { requests: { a: 'x'.repeat(MAX_NOTE_CHARS + 50) } } })
    expect(d.draft.requests.a).toHaveLength(MAX_NOTE_CHARS)
  })

  it('skips rounds and requests that are malformed, and fills a missing label from the key', () => {
    const d = parseReviewRequests({
      rounds: [
        { nope: true },
        { sent_at: AT, by: 'luca', message: null, requests: [{ key: 'comp_debt_changes', note: 'check', was: 'No', was_raw: 'No' }, { key: '', note: 'x' }, { key: 'z', note: '  ' }, 'junk'] },
      ],
    })
    expect(d.rounds).toHaveLength(1)
    expect(d.rounds[0].requests).toHaveLength(1)
    expect(d.rounds[0].requests[0]).toMatchObject({ key: 'comp_debt_changes', label: 'Debt Changes', group: 'Tax Questions', was: 'No' })
  })
})

describe('draft notes', () => {
  it('writes, replaces and clears one note without touching the input', () => {
    const empty = parseReviewRequests(null)
    const one = setDraftNote(empty, 'comp_debt_changes', ' look again ')
    expect(one.draft.requests).toEqual({ comp_debt_changes: 'look again' })
    expect(empty.draft.requests).toEqual({}) // input untouched
    const two = setDraftNote(one, 'comp_debt_changes', 'now this')
    expect(two.draft.requests.comp_debt_changes).toBe('now this')
    const cleared = setDraftNote(two, 'comp_debt_changes', '   ')
    expect(cleared.draft.requests).toEqual({})
  })

  it('counts written notes; a message alone is something to send but not a count', () => {
    let d = parseReviewRequests(null)
    expect(draftCount(d)).toBe(0)
    expect(hasDraftToSend(d)).toBe(false)
    d = setDraftMessage(d, 'general note')
    expect(draftCount(d)).toBe(0)
    expect(hasDraftToSend(d)).toBe(true)
    d = setDraftNote(setDraftMessage(d, ''), 'a', 'x')
    expect(draftCount(d)).toBe(1)
    expect(hasDraftToSend(d)).toBe(true)
  })
})

describe('canWriteReviewRequests — only a submission staff are looking at', () => {
  it.each([
    [null, true],
    ['submitted', true],
    ['resubmitted', true],
    ['under_review', true],
    ['reopened', true],
    ['revision_requested', false],
    ['approved', false],
    ['confirmed', false],
  ])('%s → %s', (status, expected) => {
    expect(canWriteReviewRequests(status as string | null)).toBe(expected)
  })
})

describe('buildRound — the draft becomes one sent round', () => {
  it('remembers each flagged answer as it is now (display text and raw value)', () => {
    const draft = { requests: { comp_foreign_accounts_over_10k: 'check the balance', bank_accounts_1_statements: 'upload December' }, message: 'thanks' }
    const r = buildRound({ draft, submittedData: DATA, by: 'flow-action', at: AT })!
    expect(r.sent_at).toBe(AT)
    expect(r.message).toBe('thanks')
    const q = r.requests.find((x) => x.key === 'comp_foreign_accounts_over_10k')!
    expect(q).toMatchObject({ label: 'Foreign Accounts Over 10k', group: 'Tax Questions', note: 'check the balance', was: 'No', was_raw: 'No' })
    const files = r.requests.find((x) => x.key === 'bank_accounts_1_statements')!
    expect(files).toMatchObject({ group: 'Bank Account 2', was: '1 file', was_raw: ['tax/a/one.csv'] })
  })

  it('drops a request for an answer the submission no longer holds', () => {
    const r = buildRound({ draft: { requests: { gone_key: 'x', company_name: 'rename' }, message: '' }, submittedData: DATA, by: 'a', at: AT })!
    expect(r.requests.map((x) => x.key)).toEqual(['company_name'])
  })

  it('returns null when there is nothing to send, and a message-only round when there is only a message', () => {
    expect(buildRound({ draft: { requests: {}, message: '' }, submittedData: DATA, by: 'a', at: AT })).toBeNull()
    expect(buildRound({ draft: { requests: { gone: 'x' }, message: '' }, submittedData: DATA, by: 'a', at: AT })).toBeNull()
    const m = buildRound({ draft: { requests: {}, message: 'just a note' }, submittedData: DATA, by: 'a', at: AT })!
    expect(m.requests).toEqual([])
    expect(m.message).toBe('just a note')
  })

  it('never builds more than the maximum number of requests', () => {
    const big: Record<string, string> = {}
    const data: Record<string, unknown> = {}
    for (let i = 0; i < MAX_REQUESTS + 20; i++) { big[`k${i}`] = 'n'; data[`k${i}`] = 'v' }
    const r = buildRound({ draft: { requests: big, message: '' }, submittedData: data, by: 'a', at: AT })!
    expect(r.requests).toHaveLength(MAX_REQUESTS)
  })
})

describe('appendRound — the story grows, the draft empties', () => {
  it('keeps earlier rounds and clears what was written', () => {
    const first: ReviewRound = { sent_at: '2026-11-01T00:00:00.000Z', by: 'a', message: null, requests: [] }
    const base = { draft: { requests: { x: 'y' }, message: 'm' }, rounds: [first] }
    const second = buildRound({ draft: { requests: { company_name: 'n' }, message: '' }, submittedData: DATA, by: 'a', at: AT })!
    const next = appendRound(base, second)
    expect(next.rounds).toEqual([first, second])
    expect(next.draft).toEqual({ requests: {}, message: '' })
    expect(latestRound(next)).toBe(second)
    expect(latestRound(parseReviewRequests(null))).toBeNull()
  })
})

describe('answerOutcomes — what the client did about each flagged answer', () => {
  const round = buildRound({
    draft: { requests: { comp_foreign_accounts_over_10k: 'a', bank_accounts_1_statements: 'b', company_name: 'c', bank_accounts_1_bank_name: 'd' }, message: '' },
    submittedData: DATA,
    by: 'a',
    at: AT,
  })!

  it('says updated, unchanged and removed', () => {
    const now = {
      comp_foreign_accounts_over_10k: 'Yes',
      bank_accounts_1_statements: ['tax/a/one.csv', 'tax/a/two.csv'],
      company_name: 'Sample LLC',
      // bank_accounts_1_bank_name removed (the row is gone)
    }
    const by = Object.fromEntries(answerOutcomes(round, now).map((q) => [q.key, q]))
    expect(by.comp_foreign_accounts_over_10k).toMatchObject({ outcome: 'updated', was: 'No', now: 'Yes' })
    expect(by.bank_accounts_1_statements).toMatchObject({ outcome: 'updated', was: '1 file', now: '2 files' })
    expect(by.company_name.outcome).toBe('unchanged')
    expect(by.bank_accounts_1_bank_name.outcome).toBe('removed')
  })

  it('a file list with the SAME count but different files is an update (the count text alone would hide it)', () => {
    const now = { ...DATA, bank_accounts_1_statements: ['tax/a/other.csv'] }
    const q = answerOutcomes(round, now).find((x) => x.key === 'bank_accounts_1_statements')!
    expect(q.outcome).toBe('updated')
  })

  it('everything unchanged when the data is identical', () => {
    expect(answerOutcomes(round, DATA).every((q) => q.outcome === 'unchanged')).toBe(true)
  })

  it('an answer that was empty and still is, is unchanged (not "removed")', () => {
    const r = buildRound({ draft: { requests: { note_field: 'fill it' }, message: '' }, submittedData: { note_field: '' }, by: 'a', at: AT })!
    expect(answerOutcomes(r, { note_field: '' })[0].outcome).toBe('unchanged')
  })
})

describe('roundHistoryNote and buildClientMessage', () => {
  const round = buildRound({
    draft: { requests: { comp_foreign_accounts_over_10k: 'check the balance', bank_accounts_1_statements: 'upload December' }, message: 'thank you' },
    submittedData: DATA,
    by: 'a',
    at: AT,
  })!

  it('the history note lists how many requests and which answers', () => {
    expect(roundHistoryNote(round)).toBe('2 requests next to answers: Foreign Accounts Over 10k, Statements (Bank Account 2) — thank you')
    const one = buildRound({ draft: { requests: { company_name: 'x' }, message: '' }, submittedData: DATA, by: 'a', at: AT })!
    expect(roundHistoryNote(one)).toBe('1 request next to answers: Company Name')
    expect(roundHistoryNote({ ...one, requests: [], message: null })).toBe('Changes requested from the flow workspace')
  })

  it('the client message carries every note verbatim, in both languages, with the answer names from the labeller', () => {
    const msg = buildClientMessage(round, (q, locale) => `${locale.toUpperCase()}:${q.label}`)
    expect(msg.en).toContain('needs these changes')
    expect(msg.en).toContain('• EN:Foreign Accounts Over 10k: check the balance')
    expect(msg.en).toContain('• EN:Statements: upload December')
    expect(msg.en).toContain('thank you')
    expect(msg.it).toContain('servono queste modifiche')
    expect(msg.it).toContain('• IT:Foreign Accounts Over 10k: check the balance')
    expect(msg.en.endsWith('resubmit.')).toBe(true)
  })

  it('a message-only round reads as a single change, with no empty list', () => {
    const only = buildRound({ draft: { requests: {}, message: 'please call us' }, submittedData: DATA, by: 'a', at: AT })!
    const msg = buildClientMessage(only, () => 'x')
    expect(msg.en).toContain('needs a change:')
    expect(msg.en).not.toContain('•')
    expect(msg.en).toContain('please call us')
    expect(msg.it).toContain('serve una modifica')
  })
})
