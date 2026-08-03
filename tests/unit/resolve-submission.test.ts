/**
 * WHICH row is the client's tax file (2026-08-03).
 *
 * Two competing rules existed and both were wrong:
 *  - `status='completed'` MISSED `reviewed`, so coverage answers and the final
 *    Confirm 404'd for every account in the review loop — the client's answers
 *    were silently never stored. 47 of 79 account-years for 2025 had no
 *    `completed` row at all.
 *  - "newest row of ANY status" let an unfilled `pending`/`opened` form outrank
 *    the real submission and unlock a file that was under review.
 */

import { describe, it, expect } from 'vitest'
import { resolveClientSubmission, resolveEditability, SUBMISSION_DATA_STATUSES } from '@/lib/tax/resolve-submission'

/** Minimal fake matching the query chain the resolver uses. */
function fakeDb(rows: Array<{ status: string; review_status?: string | null; created_at: string; id?: string }>) {
  const calls: Record<string, unknown> = {}
  const q = {
    _rows: rows,
    from() { return q },
    select(sel: string) { calls.select = sel; return q },
    eq(col: string, val: unknown) { calls[col] = val; return q },
    in(col: string, vals: string[]) { calls.inCol = col; q._rows = q._rows.filter(r => vals.includes(r.status)); return q },
    order(_c: string, o: { ascending: boolean }) {
      q._rows = [...q._rows].sort((a, b) => o.ascending
        ? a.created_at.localeCompare(b.created_at)
        : b.created_at.localeCompare(a.created_at))
      return q
    },
    limit(n: number) { q._rows = q._rows.slice(0, n); return q },
    async maybeSingle() { return { data: q._rows[0] ?? null } },
  }
  return { q, calls }
}

describe('resolveClientSubmission — which row counts as the client file', () => {
  it('accepts `reviewed`, not only `completed` — the bug that blocked every review-loop client', async () => {
    const { q } = fakeDb([{ id: 'A', status: 'reviewed', created_at: '2026-04-20' }])
    const row = await resolveClientSubmission<{ id: string }>(q, 'acct', 2025, 'id')
    expect(row?.id).toBe('A')
  })

  it('ignores an unfilled pending form even when it is NEWER than the real submission', async () => {
    const { q } = fakeDb([
      { id: 'REAL', status: 'reviewed', review_status: 'under_review', created_at: '2026-04-17' },
      { id: 'EMPTY', status: 'pending', review_status: null, created_at: '2026-06-01' },
    ])
    const row = await resolveClientSubmission<{ id: string }>(q, 'acct', 2025, 'id')
    expect(row?.id).toBe('REAL')
  })

  it('ignores `opened` too', async () => {
    const { q } = fakeDb([
      { id: 'REAL', status: 'completed', created_at: '2026-01-01' },
      { id: 'EMPTY', status: 'opened', created_at: '2026-09-09' },
    ])
    expect((await resolveClientSubmission<{ id: string }>(q, 'a', 2025, 'id'))?.id).toBe('REAL')
  })

  it('newest wins among rows that DO carry data', async () => {
    const { q } = fakeDb([
      { id: 'OLD', status: 'completed', created_at: '2026-01-01' },
      { id: 'NEW', status: 'reviewed', created_at: '2026-05-05' },
    ])
    expect((await resolveClientSubmission<{ id: string }>(q, 'a', 2025, 'id'))?.id).toBe('NEW')
  })

  it('no data row at all → null (caller decides: 404 or "nothing to protect")', async () => {
    const { q } = fakeDb([{ id: 'EMPTY', status: 'pending', created_at: '2026-01-01' }])
    expect(await resolveClientSubmission(q, 'a', 2025, 'id')).toBeNull()
  })

  it('only completed + reviewed are treated as real data', () => {
    expect([...SUBMISSION_DATA_STATUSES]).toEqual(['completed', 'reviewed'])
  })
})

describe('resolveEditability — lock read uses the SAME row', () => {
  it('a newer empty form can no longer unlock a file that is under review', async () => {
    const { q } = fakeDb([
      { id: 'REAL', status: 'reviewed', review_status: 'under_review', created_at: '2026-04-17' },
      { id: 'EMPTY', status: 'pending', review_status: null, created_at: '2026-06-01' },
    ])
    const r = await resolveEditability(q, 'acct', 2025)
    expect(r.reviewStatus).toBe('under_review')
    expect(r.editable).toBe(false)
  })

  it('resubmitted stays editable (the freeze fix), read off a `reviewed` row', async () => {
    const { q } = fakeDb([{ status: 'reviewed', review_status: 'resubmitted', created_at: '2026-04-17' }])
    const r = await resolveEditability(q, 'acct', 2025)
    expect(r.reviewStatus).toBe('resubmitted')
    expect(r.editable).toBe(true)
  })

  it('confirmed is locked', async () => {
    const { q } = fakeDb([{ status: 'reviewed', review_status: 'confirmed', created_at: '2026-04-17' }])
    expect((await resolveEditability(q, 'a', 2025)).editable).toBe(false)
  })

  it('approved stays editable — the legitimate approve → confirm path must survive', async () => {
    const { q } = fakeDb([{ status: 'completed', review_status: 'approved', created_at: '2026-04-17' }])
    expect((await resolveEditability(q, 'a', 2025)).editable).toBe(true)
  })

  it('legacy row with no review_status is editable', async () => {
    const { q } = fakeDb([{ status: 'reviewed', review_status: null, created_at: '2026-01-01' }])
    expect((await resolveEditability(q, 'a', 2025)).editable).toBe(true)
  })

  it('no submission at all → editable (nothing to protect yet)', async () => {
    const { q } = fakeDb([])
    const r = await resolveEditability(q, 'a', 2025)
    expect(r).toEqual({ editable: true, reviewStatus: null })
  })
})
