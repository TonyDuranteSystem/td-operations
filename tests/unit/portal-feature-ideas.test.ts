import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { checkIdea, bucketIdeaCounts, IDEA_MIN, IDEA_MAX } from '@/lib/portal/feature-ideas'

describe('checkIdea', () => {
  it('accepts a normal idea and trims it', () => {
    expect(checkIdea('  Send an invoice every month automatically  ')).toEqual({ ok: true, idea: 'Send an invoice every month automatically' })
  })
  it('collapses runaway blank lines but keeps paragraphs', () => {
    expect(checkIdea('One\n\n\n\n\nTwo')).toEqual({ ok: true, idea: 'One\n\nTwo' })
  })
  it('rejects empty, whitespace, too short and non-text', () => {
    for (const bad of ['', '   ', 'abc', 'ab\n\n', null, undefined, 42, {}]) expect(checkIdea(bad as unknown).ok).toBe(false)
  })
  it('accepts exactly the minimum and rejects one over the maximum', () => {
    expect(checkIdea('a'.repeat(IDEA_MIN)).ok).toBe(true)
    expect(checkIdea('a'.repeat(IDEA_MAX)).ok).toBe(true)
    const tooLong = checkIdea('a'.repeat(IDEA_MAX + 1))
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.error).toMatch(/too long/)
  })
})

describe('bucketIdeaCounts (the blue dot)', () => {
  it('counts unhandled ideas per company and per person; total counts each once', () => {
    const r = bucketIdeaCounts([
      { account_id: 'A', contact_id: 'P1' },
      { account_id: 'A', contact_id: 'P2' },
      { account_id: 'B', contact_id: 'P1' },
    ])
    expect(r.by_account).toEqual({ A: 2, B: 1 })
    expect(r.by_contact).toEqual({ P1: 2, P2: 1 })
    expect(r.total).toBe(3)
  })
  it('an idea with no company still lights the person thread; none = zero', () => {
    expect(bucketIdeaCounts([{ account_id: null, contact_id: 'P1' }]).by_contact).toEqual({ P1: 1 })
    expect(bucketIdeaCounts([])).toEqual({ by_account: {}, by_contact: {}, total: 0 })
  })
})

// Antonio 2026-10-08: ideas go to the staff "Idea request" tab, NOT into the client's chat.
describe('where an idea goes', () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
  it("the client's box never posts to the chat", () => {
    const card = read('components/portal/feature-request-card.tsx')
    expect(card).toMatch(/\/api\/portal\/feature-ideas/)
    expect(card).not.toMatch(/\/api\/portal\/chat/)
  })
  it('the staff routes are staff-only', () => {
    expect(read('app/api/crm/admin-actions/feature-ideas/route.ts')).toMatch(/isDashboardUser/)
  })
  it('the Portal Chats page has the Idea request tab right after What\'s New', () => {
    const page = read('app/(dashboard)/portal-chats/page.tsx')
    const whatsNew = page.indexOf("setChatViewMode('whatsnew')")
    const ideas = page.indexOf("setChatViewMode('ideas')")
    const todo = page.indexOf("setChatViewMode('todo')")
    expect(whatsNew).toBeGreaterThan(0)
    expect(ideas).toBeGreaterThan(whatsNew)
    expect(todo).toBeGreaterThan(ideas)
  })
})
