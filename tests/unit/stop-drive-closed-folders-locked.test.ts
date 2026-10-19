import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stop Drive S1d: a Closed / Cancelled company's Drive folder is a read-only archive — the central write guard refuses it,
// for EVERY writer, while the one-way backup (runAsStoreBackup) is exempt.
const rows = vi.hoisted(() => ({
  accounts: [] as Array<{ id: string; status: string; drive_folder_id: string | null; gdrive_folder_url: string | null }>,
  owners: [] as Array<{ account_id: string | null; contact_id: string | null; kind: string; service_delivery_id: string | null; study_only: boolean }>,
}))

vi.mock('@/lib/supabase-admin', () => {
  const builder = (table: string) => {
    let statusFilter: string[] | null = null
    let idFilter: string[] | null = null
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = () => b
    b.order = () => b
    let folderFilter: string[] | null = null
    let notClosed = false
    b.in = (col: string, vals: string[]) => { if (col === 'status') statusFilter = vals; else if (col === 'id') idFilter = vals; else if (col === 'drive_folder_id') folderFilter = vals; return b }
    let linkOnly = false
    b.is = () => { linkOnly = true; return b }
    b.not = () => { notClosed = true; return b }
    const answer = () => {
      if (linkOnly) return rows.accounts.filter((a) => !a.drive_folder_id && a.gdrive_folder_url && !['Closed', 'Cancelled'].includes(a.status))
      if (folderFilter) return rows.accounts.filter((a) => folderFilter!.includes(a.drive_folder_id ?? '') && (!notClosed || (a.status != null && !['Closed', 'Cancelled'].includes(a.status))))
      return null
    }
    b.range = () => {
      let data: unknown[] = []
      if (table === 'store_owners') data = rows.owners
      else if (table === 'accounts') data = rows.accounts.filter((a) => (statusFilter ? statusFilter.includes(a.status) : idFilter ? idFilter.includes(a.id) : true))
      return Promise.resolve({ data, error: null })
    }
    b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: table === 'accounts' ? (answer() ?? rows.accounts.filter((a) => (idFilter ? idFilter.includes(a.id) : true))) : [], error: null }).then(res)
    return b
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } }
})

import { readLockedFolderIds, assertTargetsNotSwitched, runAsStoreBackup, forgetArchivedFolderCache } from '@/lib/crm-store/switched-drive-guard'

describe('readLockedFolderIds — closed companies are archive', () => {
  beforeEach(() => forgetArchivedFolderCache())

  it('locks the folder of every Closed and Cancelled company (id and old link form), and no other', async () => {
    rows.owners = []
    rows.accounts = [
      { id: 'a1', status: 'Closed', drive_folder_id: 'F-closed', gdrive_folder_url: null },
      { id: 'a2', status: 'Cancelled', drive_folder_id: null, gdrive_folder_url: 'https://drive.google.com/drive/folders/F-cancelled-link' },
      { id: 'a3', status: 'Offboarding', drive_folder_id: 'F-rebis', gdrive_folder_url: null },
      { id: 'a4', status: 'Active', drive_folder_id: 'F-active-no-storage', gdrive_folder_url: null },
    ]
    const locked = await readLockedFolderIds()
    expect(locked.has('F-closed')).toBe(true)
    expect(locked.has('F-cancelled-link')).toBe(true)
    expect(locked.has('F-rebis')).toBe(false)           // the left-on-Drive companies keep working
    expect(locked.has('F-active-no-storage')).toBe(false)
  })

  it('a write into a closed company\'s folder is refused; a legacy company\'s is not; the backup is exempt', async () => {
    rows.owners = []
    rows.accounts = [{ id: 'a1', status: 'Closed', drive_folder_id: 'F-closed', gdrive_folder_url: null }]
    const deps = { lockedFolderIds: readLockedFolderIds, parentsOf: async () => [] as string[] }
    await expect(assertTargetsNotSwitched(['F-closed'], deps)).rejects.toThrow(/read-only/)
    await expect(assertTargetsNotSwitched(['F-rebis'], deps)).resolves.toBeUndefined()
    await expect(runAsStoreBackup(() => assertTargetsNotSwitched(['F-closed'], deps))).resolves.toBeUndefined()
  })
})

describe('shared folders and the cache', () => {
  beforeEach(() => forgetArchivedFolderCache())
  it('a folder id that a company which is NOT closed also uses stays open (production has 3 such active companies)', async () => {
    rows.owners = []
    rows.accounts = [
      { id: 'a1', status: 'Closed', drive_folder_id: 'F-shared', gdrive_folder_url: null },
      { id: 'a2', status: 'Active', drive_folder_id: 'F-shared', gdrive_folder_url: null },
      { id: 'a3', status: 'Cancelled', drive_folder_id: 'F-own-closed', gdrive_folder_url: null },
    ]
    const locked = await readLockedFolderIds()
    expect(locked.has('F-shared')).toBe(false)
    expect(locked.has('F-own-closed')).toBe(true)
  })
  it('the closed-company read is cached for a minute and re-read after it', async () => {
    rows.owners = []
    rows.accounts = [{ id: 'a1', status: 'Closed', drive_folder_id: 'F-1', gdrive_folder_url: null }]
    expect((await readLockedFolderIds()).has('F-1')).toBe(true)
    rows.accounts = [] // reopened / removed — still locked inside the minute
    expect((await readLockedFolderIds()).has('F-1')).toBe(true)
    forgetArchivedFolderCache()
    expect((await readLockedFolderIds()).has('F-1')).toBe(false)
  })
})

describe('open companies that know their folder only by the older link', () => {
  beforeEach(() => forgetArchivedFolderCache())
  it('a closed folder an open company holds only through its older link (any URL form) stays open', async () => {
    rows.owners = []
    rows.accounts = [
      { id: 'a1', status: 'Closed', drive_folder_id: 'F-x', gdrive_folder_url: null },
      { id: 'a2', status: 'Active', drive_folder_id: null, gdrive_folder_url: 'https://drive.google.com/open?id=F-x' },
    ]
    expect((await readLockedFolderIds()).has('F-x')).toBe(false)
  })
  it('a NULL status is not "open": it never unlocks a closed company\'s folder (fails closed)', async () => {
    rows.owners = []
    rows.accounts = [
      { id: 'a1', status: 'Closed', drive_folder_id: 'F-y', gdrive_folder_url: null },
      { id: 'a2', status: null as unknown as string, drive_folder_id: 'F-y', gdrive_folder_url: null },
    ]
    expect((await readLockedFolderIds()).has('F-y')).toBe(true)
  })
})
