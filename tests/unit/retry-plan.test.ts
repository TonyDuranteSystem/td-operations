import { describe, it, expect } from 'vitest'
import { planRetry } from '@/lib/crm-store/retry-plan'

// the Storage page has a client list (left) and an open storage (right) that fail independently; the banner names only the last failure
const storagePage = { embedded: false }
// a Documents tab: one owner, no client list
const documentsTab = { embedded: true, hasList: false }

describe('planRetry — what the red Retry button reloads', () => {
  it('Documents tab: the storage failed before anything loaded → open it again', () => {
    expect(planRetry({ ...documentsTab, failedPart: 'owner', hasOwner: true, hasRoot: false })).toEqual({ owner: 'open', list: false })
  })

  it('Documents tab: a folder failed while the storage is on screen → refresh what is shown (keeps the folder you are in)', () => {
    expect(planRetry({ ...documentsTab, failedPart: 'owner', hasOwner: true, hasRoot: true })).toEqual({ owner: 'refresh', list: false })
  })

  it('Documents tab never asks for a client list', () => {
    for (const hasRoot of [true, false]) {
      expect(planRetry({ ...documentsTab, failedPart: 'owner', hasOwner: true, hasRoot }).list).toBe(false)
    }
  })

  it('Storage page: only the client list failed and a storage is open → reload just the list, no folder is fetched again', () => {
    expect(planRetry({ ...storagePage, failedPart: 'nav', hasOwner: true, hasRoot: true, hasList: false })).toEqual({ owner: null, list: true })
  })

  it('Storage page: only the client list failed and no storage is chosen → reload the list', () => {
    expect(planRetry({ ...storagePage, failedPart: 'nav', hasOwner: false, hasRoot: false, hasList: false })).toEqual({ owner: null, list: true })
  })

  it('Storage page: BOTH failed and the list failed last → repair both (the old Retry left the right side on "Loading…")', () => {
    expect(planRetry({ ...storagePage, failedPart: 'nav', hasOwner: true, hasRoot: false, hasList: false })).toEqual({ owner: 'open', list: true })
  })

  it('Storage page: BOTH failed and the storage failed last → repair both (the old Retry left the left side on "Loading…")', () => {
    expect(planRetry({ ...storagePage, failedPart: 'owner', hasOwner: true, hasRoot: false, hasList: false })).toEqual({ owner: 'open', list: true })
  })

  it('Storage page: a folder failed with the list loaded → refresh only (the refresh reloads the list on its own when needed)', () => {
    expect(planRetry({ ...storagePage, failedPart: 'owner', hasOwner: true, hasRoot: true, hasList: true })).toEqual({ owner: 'refresh', list: false })
  })

  it('Storage page: refreshing the storage already reloads a missing list, so the list is not asked for twice', () => {
    expect(planRetry({ ...storagePage, failedPart: 'owner', hasOwner: true, hasRoot: true, hasList: false })).toEqual({ owner: 'refresh', list: false })
  })

  it('nothing chosen and nothing failed on the list → nothing to do', () => {
    expect(planRetry({ ...storagePage, failedPart: 'owner', hasOwner: false, hasRoot: false, hasList: true })).toEqual({ owner: null, list: false })
  })
})
