import { describe, it, expect, vi } from 'vitest'

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
    b.in = (col: string, vals: string[]) => { if (col === 'status') statusFilter = vals; else if (col === 'id') idFilter = vals; return b }
    b.range = () => {
      let data: unknown[] = []
      if (table === 'store_owners') data = rows.owners
      else if (table === 'accounts') data = rows.accounts.filter((a) => (statusFilter ? statusFilter.includes(a.status) : idFilter ? idFilter.includes(a.id) : true))
      return Promise.resolve({ data, error: null })
    }
    b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: table === 'accounts' ? rows.accounts.filter((a) => (idFilter ? idFilter.includes(a.id) : true)) : [], error: null }).then(res)
    return b
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } }
})

import { readLockedFolderIds, assertTargetsNotSwitched, runAsStoreBackup } from '@/lib/crm-store/switched-drive-guard'

describe('readLockedFolderIds — closed companies are archive', () => {
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
