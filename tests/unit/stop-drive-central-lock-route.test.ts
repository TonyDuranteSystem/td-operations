/**
 * Stop Drive S1d: the central lock, through a REAL route. The staff "delete file" route calls trashFile; here trashFile runs the
 * real guard (assertTargetsNotSwitched + readLockedFolderIds) against fake company rows. Closed folder = refused with the plain
 * message and nothing trashed; a left-on-Drive company's folder = trashed as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const st = vi.hoisted(() => ({ trashed: [] as string[], accounts: [] as Array<{ id: string; status: string; drive_folder_id: string | null; gdrive_folder_url: string | null }> }))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { email: 'luca@tonydurante.us' } } }) } }) }))
vi.mock('@/lib/auth', () => ({ isDashboardUser: () => true }))
vi.mock('@/lib/mcp/action-log', () => ({ logAction: () => {} }))
vi.mock('@/lib/supabase-admin', () => {
  const builder = (table: string) => {
    let statusIn: string[] | null = null
    let folderIn: string[] | null = null
    let notClosed = false
    const b: Record<string, unknown> = {}
    let linkOnly = false
    for (const m of ['select', 'eq', 'order', 'delete']) b[m] = () => b
    b.is = () => { linkOnly = true; return b }
    b.in = (c: string, v: string[]) => { if (c === 'status') statusIn = v; if (c === 'drive_folder_id') folderIn = v; return b }
    b.not = () => { notClosed = true; return b }
    b.maybeSingle = () => Promise.resolve({ data: null, error: null })
    const rowsFor = () => {
      if (table !== 'accounts') return []
      if (linkOnly) return st.accounts.filter((a) => !a.drive_folder_id && a.gdrive_folder_url && !['Closed', 'Cancelled'].includes(a.status))
      if (folderIn) return st.accounts.filter((a) => folderIn!.includes(a.drive_folder_id ?? '') && (!notClosed || !['Closed', 'Cancelled'].includes(a.status)))
      if (statusIn) return st.accounts.filter((a) => statusIn!.includes(a.status))
      return []
    }
    b.range = () => Promise.resolve({ data: rowsFor(), error: null })
    b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rowsFor(), count: 0, error: null }).then(res)
    return b
  }
  return { supabaseAdmin: { from: builder } }
})
vi.mock('@/lib/google-drive', async () => {
  const g = await import('@/lib/crm-store/switched-drive-guard')
  return {
    trashFile: async (id: string) => {
      await g.assertTargetsNotSwitched([id], { lockedFolderIds: g.readLockedFolderIds, parentsOf: async () => [] })
      st.trashed.push(id)
      return { id, name: 'x.pdf' }
    },
  }
})

const call = async (fileId: string) => {
  const { POST } = await import('@/app/api/accounts/[id]/files/delete/route')
  return POST(new NextRequest('http://localhost/api/accounts/a1/files/delete', { method: 'POST', body: JSON.stringify({ fileId }) }), { params: Promise.resolve({ id: 'a1' }) })
}

beforeEach(async () => {
  st.trashed.length = 0
  ;(await import('@/lib/crm-store/switched-drive-guard')).forgetArchivedFolderCache()
  st.accounts = [
    { id: 'c1', status: 'Closed', drive_folder_id: 'F-closed', gdrive_folder_url: null },
    { id: 'r1', status: 'Offboarding', drive_folder_id: 'F-rebis', gdrive_folder_url: null },
    { id: 'c2', status: 'Cancelled', drive_folder_id: null, gdrive_folder_url: 'https://drive.google.com/drive/folders/F-link-closed' },
  ]
})

describe('staff delete-file route + the central lock', () => {
  it("a Closed company's folder is read-only: refused with the plain message, nothing trashed", async () => {
    const res = await call('F-closed')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toMatch(/read-only/)
    expect(st.trashed).toEqual([])
  })
  it('a Cancelled company known only by the older folder link is locked too', async () => {
    expect((await call('F-link-closed')).status).toBeGreaterThanOrEqual(400)
    expect(st.trashed).toEqual([])
  })
  it('a left-on-Drive company (Offboarding) keeps working', async () => {
    const res = await call('F-rebis')
    expect(res.status).toBe(200)
    expect(st.trashed).toEqual(['F-rebis'])
  })
})
