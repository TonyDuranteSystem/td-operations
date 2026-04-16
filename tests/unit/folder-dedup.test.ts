import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabaseAdmin
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(),
        })),
      })),
      update: vi.fn(() => ({
        eq: vi.fn(),
      })),
    })),
  },
}))

// Mock google-drive
const mockCreateFolder = vi.fn()
const mockListFolderAnyDrive = vi.fn()
const mockMoveFile = vi.fn()
vi.mock('@/lib/google-drive', () => ({
  createFolder: (...args: unknown[]) => mockCreateFolder(...args),
  listFolderAnyDrive: (...args: unknown[]) => mockListFolderAnyDrive(...args),
  moveFile: (...args: unknown[]) => mockMoveFile(...args),
}))

import { supabaseAdmin } from '@/lib/supabase-admin'

describe('ensureCompanyFolder — dedup behavior', () => {
  const accountId = '502f86f1-f374-4a9d-b2e3-c3a4b36e8e9b'
  const companyName = 'Test Company LLC'
  const state = 'New Mexico'
  const ownerName = 'John Doe'
  const expectedFolderName = 'Test Company LLC - John Doe'

  // NM state folder ID from drive-folder-utils.ts:22
  const nmStateFolderId = '1tkJjg0HKbIl0uFzvK4zW3rtU14sdCHo4'

  beforeEach(() => {
    vi.clearAllMocks()

    // Default: account has no drive_folder_id
    const mockSingle = vi.fn().mockResolvedValue({ data: { drive_folder_id: null }, error: null })
    const mockEq = vi.fn().mockReturnValue({ single: mockSingle })
    const mockSelect = vi.fn().mockReturnValue({ eq: mockEq })
    vi.mocked(supabaseAdmin.from).mockReturnValue({
      select: mockSelect,
      update: vi.fn().mockReturnValue({ eq: vi.fn() }),
    } as unknown as ReturnType<typeof supabaseAdmin.from>)
  })

  it('links existing folder when exactly one name match exists', async () => {
    const existingFolderId = 'existing-folder-id-123'

    // Parent folder listing returns one matching folder
    mockListFolderAnyDrive.mockResolvedValueOnce({
      files: [
        { id: existingFolderId, name: expectedFolderName, mimeType: 'application/vnd.google-apps.folder' },
      ],
    })
    // Subfolder listing for existing folder (already has subfolders)
    mockListFolderAnyDrive.mockResolvedValueOnce({
      files: [
        { id: 'sub-1', name: '1. Company', mimeType: 'application/vnd.google-apps.folder' },
        { id: 'sub-2', name: '2. Contacts', mimeType: 'application/vnd.google-apps.folder' },
        { id: 'sub-3', name: '3. Tax', mimeType: 'application/vnd.google-apps.folder' },
        { id: 'sub-4', name: '4. Banking', mimeType: 'application/vnd.google-apps.folder' },
        { id: 'sub-5', name: '5. Correspondence', mimeType: 'application/vnd.google-apps.folder' },
      ],
    })

    const { ensureCompanyFolder } = await import('@/lib/drive-folder-utils')
    const result = await ensureCompanyFolder(accountId, companyName, state, ownerName)

    expect(result.folderId).toBe(existingFolderId)
    // createFolder should NOT have been called for the company folder
    expect(mockCreateFolder).not.toHaveBeenCalled()
  })

  it('creates new folder when zero matches exist', async () => {
    const newFolderId = 'new-folder-id-456'

    // Parent folder listing returns no matching folders
    mockListFolderAnyDrive.mockResolvedValueOnce({
      files: [
        { id: 'other-folder', name: 'Other Company LLC', mimeType: 'application/vnd.google-apps.folder' },
      ],
    })
    // createFolder returns new folder
    mockCreateFolder.mockResolvedValueOnce({ id: newFolderId })
    // Subfolder listing (empty — new folder)
    mockListFolderAnyDrive.mockResolvedValueOnce({ files: [] })
    // Create 5 subfolders
    mockCreateFolder.mockResolvedValue({ id: 'sub-new' })

    const { ensureCompanyFolder } = await import('@/lib/drive-folder-utils')
    const result = await ensureCompanyFolder(accountId, companyName, state, ownerName)

    expect(result.folderId).toBe(newFolderId)
    expect(result.created).toBe(true)
    // createFolder called: 1 company folder + 5 subfolders = 6
    expect(mockCreateFolder).toHaveBeenCalledTimes(6)
    expect(mockCreateFolder).toHaveBeenCalledWith(nmStateFolderId, expectedFolderName)
  })

  it('throws error when multiple matches exist', async () => {
    // Parent folder listing returns two matching folders
    mockListFolderAnyDrive.mockResolvedValueOnce({
      files: [
        { id: 'folder-a', name: expectedFolderName, mimeType: 'application/vnd.google-apps.folder' },
        { id: 'folder-b', name: expectedFolderName, mimeType: 'application/vnd.google-apps.folder' },
      ],
    })

    const { ensureCompanyFolder } = await import('@/lib/drive-folder-utils')

    await expect(
      ensureCompanyFolder(accountId, companyName, state, ownerName),
    ).rejects.toThrow(/Multiple Drive folders named/)
  })

  it('skips when account already has drive_folder_id', async () => {
    const existingId = 'already-linked-id'

    // Account already has folder
    const mockSingle = vi.fn().mockResolvedValue({ data: { drive_folder_id: existingId }, error: null })
    const mockEq = vi.fn().mockReturnValue({ single: mockSingle })
    const mockSelect = vi.fn().mockReturnValue({ eq: mockEq })
    vi.mocked(supabaseAdmin.from).mockReturnValue({
      select: mockSelect,
      update: vi.fn().mockReturnValue({ eq: vi.fn() }),
    } as unknown as ReturnType<typeof supabaseAdmin.from>)

    // listFiles for existing folder
    mockListFolderAnyDrive.mockResolvedValueOnce({
      files: [
        { id: 'sub-1', name: '1. Company', mimeType: 'application/vnd.google-apps.folder' },
      ],
    })

    const { ensureCompanyFolder } = await import('@/lib/drive-folder-utils')
    const result = await ensureCompanyFolder(accountId, companyName, state, ownerName)

    expect(result.folderId).toBe(existingId)
    expect(result.created).toBe(false)
    expect(mockCreateFolder).not.toHaveBeenCalled()
  })
})
