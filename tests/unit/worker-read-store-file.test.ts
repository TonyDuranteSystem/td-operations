import { describe, it, expect, vi, beforeEach } from 'vitest'

const openDocument = vi.fn()
const downloadFileContent = vi.fn()
const downloadFileBinary = vi.fn()

vi.mock('@/lib/documents/open-document', async (orig) => {
  const real = await orig<typeof import('@/lib/documents/open-document')>()
  return { ...real, openDocument: (p: string) => openDocument(p) }
})
vi.mock('@/lib/google-drive', () => ({
  downloadFileContent: (id: string) => downloadFileContent(id),
  downloadFileBinary: (id: string) => downloadFileBinary(id),
}))

import { readDriveFileForWorker } from '@/lib/ai-agent/worker-tools'

const STORE_ID = 'store:11111111-1111-4111-8111-111111111111'

describe('read_drive_file on a file in the new storage', () => {
  beforeEach(() => {
    openDocument.mockReset()
    downloadFileContent.mockReset()
    downloadFileBinary.mockReset()
  })

  it('opens it through the pointer-aware reader, never asks Drive', async () => {
    openDocument.mockResolvedValue({ buffer: Buffer.from('hello from storage'), mimeType: 'text/plain', fileName: 'note.txt', source: 'store' })
    // A plain-text file has no "kind" the PDF extractor knows; either way Drive must not be touched.
    await readDriveFileForWorker({ file_id: STORE_ID })
    expect(openDocument).toHaveBeenCalledWith(STORE_ID)
    expect(downloadFileContent).not.toHaveBeenCalled()
    expect(downloadFileBinary).not.toHaveBeenCalled()
  })

  it('a real Drive id still goes to Drive', async () => {
    downloadFileContent.mockResolvedValue('drive text')
    const out = await readDriveFileForWorker({ file_id: '1AbCdEfGhIjKlMnOpQrStUvWxYz' })
    expect(downloadFileContent).toHaveBeenCalled()
    expect(openDocument).not.toHaveBeenCalled()
    expect(out).toContain('drive text')
  })
})
