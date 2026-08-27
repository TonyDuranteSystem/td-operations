import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabaseAdmin with a per-table chain so ensureContactFolder's three
// different lookups (service_deliveries, accounts, contacts) can each
// return their own canned data.
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: vi.fn() },
}))

const mockCreateFolder = vi.fn()
const mockListFolderAnyDrive = vi.fn()
vi.mock('@/lib/google-drive', () => ({
  createFolder: (...args: unknown[]) => mockCreateFolder(...args),
  listFolderAnyDrive: (...args: unknown[]) => mockListFolderAnyDrive(...args),
  moveFile: vi.fn(),
}))

import { supabaseAdmin } from '@/lib/supabase-admin'

// Chainable + thenable mock matching Supabase's query builder shape, scoped
// to one table's canned { data, error } result.
function tableChain(data: unknown, error: unknown = null) {
  const resolved = { data, error }
  const chain: Record<string, unknown> = {
    then: (resolve: (v: typeof resolved) => unknown) => Promise.resolve(resolved).then(resolve),
  }
  for (const m of ['select', 'eq', 'not', 'limit', 'update']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.single = vi.fn(() => Promise.resolve(resolved))
  chain.maybeSingle = vi.fn(() => Promise.resolve(resolved))
  return chain
}

describe('ensureContactFolder — subfolder self-heal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects to the company folder when the contact already has a materialized company, and heals its missing subfolders', async () => {
    const accountId = 'acct-automatiko'
    const companyRootFolderId = 'company-root-folder'

    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'service_deliveries') return tableChain({ account_id: accountId }) as never
      if (table === 'accounts') return tableChain({ drive_folder_id: companyRootFolderId }) as never
      throw new Error(`unexpected table in this branch: ${table}`)
    })

    // Company root is missing 4 of the 5 standard subfolders (only has "2. Contacts")
    mockListFolderAnyDrive.mockResolvedValueOnce({
      files: [{ id: 'contacts-leaf', name: '2. Contacts', mimeType: 'application/vnd.google-apps.folder' }],
    })
    mockCreateFolder.mockResolvedValue({ id: 'new-sub' })

    const { ensureContactFolder } = await import('@/lib/drive-folder-utils')
    const result = await ensureContactFolder('contact-1', 'Dionisie Turcanu')

    expect(result.folderId).toBe(companyRootFolderId)
    expect(result.subfolders['2. Contacts']).toBe('contacts-leaf')
    // The 4 missing standard subfolders get created on the company ROOT,
    // not nested inside the "2. Contacts" leaf.
    expect(mockCreateFolder).toHaveBeenCalledTimes(4)
    for (const call of mockCreateFolder.mock.calls) {
      expect(call[0]).toBe(companyRootFolderId)
    }
  })

  it('self-heals the contact\'s own linked folder when no company is materialized yet', async () => {
    const staleFolderId = 'old-flat-folder'

    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'service_deliveries') return tableChain(null) as never // no linked account
      if (table === 'contacts') return tableChain({ drive_folder_id: staleFolderId, gdrive_folder_url: null }) as never
      throw new Error(`unexpected table in this branch: ${table}`)
    })

    // Old folder has loose files, no subfolders at all (Tacoli-shaped case)
    mockListFolderAnyDrive.mockResolvedValueOnce({
      files: [{ id: 'loose-file', name: 'Passport.png', mimeType: 'image/png' }],
    })
    mockCreateFolder.mockResolvedValue({ id: 'new-sub' })

    const { ensureContactFolder } = await import('@/lib/drive-folder-utils')
    const result = await ensureContactFolder('contact-2', 'Alessandro Tacoli')

    expect(result.folderId).toBe(staleFolderId)
    // All 5 standard subfolders get created since none existed
    expect(mockCreateFolder).toHaveBeenCalledTimes(5)
    expect(Object.keys(result.subfolders)).toContain('2. Contacts')
  })

  it('does not touch Drive when the linked folder already has all 5 standard subfolders', async () => {
    const completeFolderId = 'already-complete'

    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'service_deliveries') return tableChain(null) as never
      if (table === 'contacts') return tableChain({ drive_folder_id: completeFolderId, gdrive_folder_url: null }) as never
      throw new Error(`unexpected table in this branch: ${table}`)
    })

    mockListFolderAnyDrive.mockResolvedValueOnce({
      files: [
        { id: 's1', name: '1. Company', mimeType: 'application/vnd.google-apps.folder' },
        { id: 's2', name: '2. Contacts', mimeType: 'application/vnd.google-apps.folder' },
        { id: 's3', name: '3. Tax', mimeType: 'application/vnd.google-apps.folder' },
        { id: 's4', name: '4. Banking', mimeType: 'application/vnd.google-apps.folder' },
        { id: 's5', name: '5. Correspondence', mimeType: 'application/vnd.google-apps.folder' },
      ],
    })

    const { ensureContactFolder } = await import('@/lib/drive-folder-utils')
    const result = await ensureContactFolder('contact-3', 'Someone Complete')

    expect(result.folderId).toBe(completeFolderId)
    expect(result.subfolders['2. Contacts']).toBe('s2')
    expect(mockCreateFolder).not.toHaveBeenCalled()
  })
})
