import { describe, it, expect } from 'vitest'
import { placeWaitingUploads, PERSONAL_UPLOAD_CATEGORY } from '@/lib/portal/own-uploads-waiting'

const doc = (id: string, category: number | null, created_at: string) => ({ id, category, created_at })

describe('placeWaitingUploads', () => {
  const company = [doc('c1', 5, '2026-11-10T10:00:00Z')]
  const mine = [doc('m1', 2, '2026-11-09T10:00:00Z')]

  it('adds an own upload to the company list, newest first, and reports it as waiting', () => {
    const out = placeWaitingUploads({ companyDocs: company, myDocs: mine, waiting: [doc('w1', 5, '2026-11-13T17:35:00Z')], alreadyListedIds: new Set(), hasPersonalList: true })
    expect(out.companyDocs.map(d => d.id)).toEqual(['w1', 'c1'])
    expect(out.myDocs.map(d => d.id)).toEqual(['m1'])
    expect([...out.waitingIds]).toEqual(['w1'])
  })

  it('a personal paper goes to My Documents, never the company list', () => {
    const out = placeWaitingUploads({ companyDocs: company, myDocs: mine, waiting: [doc('w2', PERSONAL_UPLOAD_CATEGORY, '2026-11-13T09:00:00Z')], alreadyListedIds: new Set(), hasPersonalList: true })
    expect(out.companyDocs.map(d => d.id)).toEqual(['c1'])
    expect(out.myDocs.map(d => d.id)).toEqual(['w2', 'm1'])
  })

  it('a team member has no personal list: a personal paper is dropped, not shown in the company list', () => {
    const out = placeWaitingUploads({ companyDocs: company, myDocs: [], waiting: [doc('w2', 2, '2026-11-13T09:00:00Z')], alreadyListedIds: new Set(), hasPersonalList: false })
    expect(out.companyDocs.map(d => d.id)).toEqual(['c1'])
    expect(out.myDocs).toEqual([])
    expect(out.waitingIds.size).toBe(0)
  })

  it('skips a row already listed on the page (no row twice) and does not mark it waiting', () => {
    const out = placeWaitingUploads({ companyDocs: company, myDocs: mine, waiting: [doc('c1', 5, '2026-11-10T10:00:00Z')], alreadyListedIds: new Set(['c1']), hasPersonalList: true })
    expect(out.companyDocs.map(d => d.id)).toEqual(['c1'])
    expect(out.waitingIds.size).toBe(0)
  })

  it('nothing waiting: the lists come back unchanged', () => {
    const out = placeWaitingUploads({ companyDocs: company, myDocs: mine, waiting: [], alreadyListedIds: new Set(), hasPersonalList: true })
    expect(out.companyDocs).toEqual(company)
    expect(out.myDocs).toEqual(mine)
  })

  it('an upload with no category is a company paper', () => {
    const out = placeWaitingUploads({ companyDocs: [], myDocs: [], waiting: [doc('w3', null, '2026-11-13T09:00:00Z')], alreadyListedIds: new Set(), hasPersonalList: true })
    expect(out.companyDocs.map(d => d.id)).toEqual(['w3'])
  })
})
